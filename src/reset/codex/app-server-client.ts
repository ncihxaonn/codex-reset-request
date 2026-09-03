import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { ResetRequestConfig } from '../config/schema.js';
import { LineBuffer, MAX_JSONL_LINE_BYTES } from '../watcher/line-buffer.js';
import { terminateChild } from '../utils/process.js';
import { resolveCodexHome } from './codex-home.js';
import {
  AppServerSafeError,
  type AppServerFailureCode,
  type AppServerStage,
} from './compatibility.js';
import {
  parseRateLimitsResponse,
  type ParsedRateLimitsResponse,
} from './rate-limit-confirmation.js';

const APP_VERSION = '0.1.0';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_PROTOCOL_BYTES = 4 * 1_024 * 1_024;
const MAX_PROTOCOL_MESSAGES = 10_000;

const initializeResultSchema = z
  .object({
    userAgent: z.string(),
    codexHome: z.string(),
    platformFamily: z.string(),
    platformOs: z.string(),
  })
  .passthrough();

interface PendingResponse {
  resolve(value: Record<string, unknown>): void;
}

export interface AppServerProcessSpec {
  command: string;
  args: string[];
  environment?: NodeJS.ProcessEnv;
}

export interface ReadRateLimitsOptions {
  process?: AppServerProcessSpec;
  timeoutMs?: number;
  expectedCodexHome?: string;
}

export type RateLimitsReadOutcome =
  | { ok: true; value: ParsedRateLimitsResponse }
  | { ok: false; stage: AppServerStage; code: AppServerFailureCode };

const CODEX_ENV_ALLOWLIST = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'NO_COLOR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy', 'SystemRoot', 'ComSpec',
  'PATHEXT', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'USERNAME', 'HOMEDRIVE', 'HOMEPATH',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
]);

export function buildCodexAppServerEnvironment(
  environment: NodeJS.ProcessEnv,
  codexHome: string,
): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = { CODEX_HOME: codexHome };
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && CODEX_ENV_ALLOWLIST.has(key)) {
      safe[key] = value;
    }
  }
  return safe;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameCodexHome(first: string, second: string): boolean {
  const normalizedFirst = path.resolve(first);
  const normalizedSecond = path.resolve(second);
  return process.platform === 'win32'
    ? normalizedFirst.toLowerCase() === normalizedSecond.toLowerCase()
    : normalizedFirst === normalizedSecond;
}

function responseResult(
  response: Record<string, unknown>,
  stage: 'initialize' | 'rate-limits',
): unknown {
  const hasResult = Object.hasOwn(response, 'result');
  const hasError = Object.hasOwn(response, 'error');
  if (hasResult === hasError) {
    throw new AppServerSafeError('unexpected-response', stage);
  }
  if (hasError) {
    throw new AppServerSafeError(
      stage === 'initialize' ? 'initialize-rejected' : 'rate-limits-rejected',
      stage,
    );
  }
  return response.result;
}

export async function readCodexRateLimits(options: ReadRateLimitsOptions = {}): Promise<RateLimitsReadOutcome> {
  const defaultEnvironment = buildCodexAppServerEnvironment(
    process.env,
    options.expectedCodexHome ?? process.env.CODEX_HOME ?? path.join(homedir(), '.codex'),
  );
  const processSpec = options.process ?? {
    command: 'codex',
    args: ['app-server'],
    environment: defaultEnvironment,
  };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let stage: AppServerStage = 'spawn';
  let child: ChildProcessWithoutNullStreams | null = null;
  let completed = false;
  let rejectFatal: ((error: AppServerSafeError) => void) | null = null;
  const fatal = new Promise<never>((_resolve, reject) => {
    rejectFatal = reject;
  });
  void fatal.catch(() => undefined);

  const fail = (error: AppServerSafeError) => {
    if (!completed) {
      rejectFatal?.(error);
    }
  };

  let timeout: NodeJS.Timeout | null = null;
  try {
    try {
      child = spawn(processSpec.command, processSpec.args, {
        env: processSpec.environment ?? defaultEnvironment,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      throw new AppServerSafeError('spawn-failed', 'spawn');
    }

    timeout = setTimeout(() => fail(new AppServerSafeError('timeout', stage)), timeoutMs);
    const pending = new Map<number, PendingResponse>();
    const completedIds = new Set<number>();
    const lineBuffer = new LineBuffer({ maxLineBytes: MAX_JSONL_LINE_BYTES });
    let protocolBytes = 0;
    let protocolMessages = 0;

    const processProtocolMessage = (value: unknown) => {
      if (!isRecord(value)) {
        fail(new AppServerSafeError('unexpected-response', stage));
        return;
      }
      if (!Object.hasOwn(value, 'id')) {
        if (typeof value.method === 'string') {
          return;
        }
        fail(new AppServerSafeError('unexpected-response', stage));
        return;
      }
      if (typeof value.id !== 'number' || !Number.isInteger(value.id)) {
        fail(new AppServerSafeError('unexpected-response', stage));
        return;
      }
      const waiter = pending.get(value.id);
      if (!waiter || completedIds.has(value.id) || typeof value.method === 'string') {
        fail(new AppServerSafeError('unexpected-response', stage));
        return;
      }
      pending.delete(value.id);
      completedIds.add(value.id);
      waiter.resolve(value);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      protocolBytes += Buffer.byteLength(chunk, 'utf8');
      if (protocolBytes > MAX_PROTOCOL_BYTES) {
        fail(new AppServerSafeError('response-too-large', stage));
        return;
      }
      const parsed = lineBuffer.push(chunk);
      if (parsed.oversizeLines > 0) {
        fail(new AppServerSafeError('response-too-large', stage));
        return;
      }
      for (const line of parsed.lines) {
        if (line.text.trim().length === 0) {
          continue;
        }
        protocolMessages += 1;
        if (protocolMessages > MAX_PROTOCOL_MESSAGES) {
          fail(new AppServerSafeError('response-too-large', stage));
          return;
        }
        try {
          processProtocolMessage(JSON.parse(line.text) as unknown);
        } catch {
          fail(new AppServerSafeError('invalid-json', stage));
          return;
        }
      }
    });
    child.stdout.once('end', () => {
      if (!completed && lineBuffer.trailingPartialLine.trim().length > 0) {
        fail(new AppServerSafeError('invalid-json', stage));
      }
    });
    child.stderr.resume();
    child.once('error', (error: NodeJS.ErrnoException) => {
      fail(new AppServerSafeError(error.code === 'ENOENT' ? 'binary-not-found' : 'spawn-failed', 'spawn'));
    });
    child.once('exit', () => {
      if (!completed) {
        fail(new AppServerSafeError('process-exited', stage));
      }
    });
    child.stdin.once('error', () => {
      fail(new AppServerSafeError('process-exited', stage));
    });

    const writeMessage = async (message: Record<string, unknown>): Promise<void> => {
      if (!child) {
        throw new AppServerSafeError('process-exited', stage);
      }
      const serialized = `${JSON.stringify(message)}\n`;
      const write = new Promise<void>((resolve, reject) => {
        child?.stdin.write(serialized, (error) => {
          if (error) {
            reject(new AppServerSafeError('process-exited', stage));
          } else {
            resolve();
          }
        });
      });
      await Promise.race([write, fatal]);
    };

    const request = async (id: number, message: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const response = new Promise<Record<string, unknown>>((resolve) => {
        pending.set(id, { resolve });
      });
      await writeMessage(message);
      return await Promise.race([response, fatal]);
    };

    stage = 'initialize';
    const initializeResponse = await request(0, {
      method: 'initialize',
      id: 0,
      params: {
        clientInfo: {
          name: 'codex_reset_request',
          title: 'Codex Reset Request',
          version: APP_VERSION,
        },
      },
    });
    try {
      const initializeResult = initializeResultSchema.parse(
        responseResult(initializeResponse, 'initialize'),
      );
      if (
        options.expectedCodexHome &&
        !sameCodexHome(initializeResult.codexHome, options.expectedCodexHome)
      ) {
        throw new AppServerSafeError('codex-home-mismatch', 'initialize');
      }
    } catch (error) {
      if (error instanceof AppServerSafeError) {
        throw error;
      }
      throw new AppServerSafeError('initialize-schema', 'initialize');
    }

    stage = 'rate-limits';
    await writeMessage({ method: 'initialized', params: {} });
    const rateLimitsResponse = await request(1, { method: 'account/rateLimits/read', id: 1 });
    let value: ParsedRateLimitsResponse;
    try {
      value = parseRateLimitsResponse(responseResult(rateLimitsResponse, 'rate-limits'));
    } catch (error) {
      if (error instanceof AppServerSafeError) {
        throw error;
      }
      throw new AppServerSafeError('rate-limits-schema', 'rate-limits');
    }

    completed = true;
    return { ok: true, value };
  } catch (error) {
    const safeError =
      error instanceof AppServerSafeError ? error : new AppServerSafeError('unexpected-response', stage);
    completed = true;
    return { ok: false, stage: safeError.stage, code: safeError.code };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    if (child) {
      await terminateChild(child);
    }
  }
}

export async function readConfiguredCodexRateLimits(
  config: ResetRequestConfig,
  options: Omit<ReadRateLimitsOptions, 'expectedCodexHome'> = {},
): Promise<RateLimitsReadOutcome> {
  const codexHome = resolveCodexHome(config);
  return await readCodexRateLimits({
    ...options,
    process: options.process ?? {
      command: 'codex',
      args: ['app-server'],
      environment: buildCodexAppServerEnvironment(process.env, codexHome),
    },
    expectedCodexHome: codexHome,
  });
}
