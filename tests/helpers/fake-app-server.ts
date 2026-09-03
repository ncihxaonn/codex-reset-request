import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildCodexAppServerEnvironment,
  type AppServerProcessSpec,
} from '../../src/reset/codex/app-server-client.js';

export interface FakeAppServer {
  process: AppServerProcessSpec;
  readRequests(): Promise<Array<Record<string, unknown>>>;
}

export function createFakeAppServer(
  root: string,
  input: {
    scenario?: string;
    rateResult?: unknown;
    initDelayMs?: number;
    rateDelayMs?: number;
    codexHome?: string;
  } = {},
): FakeAppServer {
  const logFile = path.join(root, `fake-app-server-${crypto.randomUUID()}.jsonl`);
  const codexHome = input.codexHome ?? '/secret/canary/home';
  return {
    process: {
      command: process.execPath,
      args: [path.join(process.cwd(), 'tests', 'helpers', 'fake-app-server-child.mjs')],
      environment: {
        ...buildCodexAppServerEnvironment(process.env, codexHome),
        FAKE_APP_SERVER_SCENARIO: input.scenario ?? 'happy',
        FAKE_APP_SERVER_LOG: logFile,
        FAKE_APP_SERVER_RATE_RESULT: JSON.stringify(input.rateResult ?? {}),
        FAKE_APP_SERVER_INIT_DELAY: String(input.initDelayMs ?? 0),
        FAKE_APP_SERVER_RATE_DELAY: String(input.rateDelayMs ?? 0),
        FAKE_APP_SERVER_CODEX_HOME: codexHome,
      },
    },
    async readRequests(): Promise<Array<Record<string, unknown>>> {
      const contents = await readFile(logFile, 'utf8').catch(() => '');
      return contents
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}
