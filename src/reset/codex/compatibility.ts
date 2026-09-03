export const TESTED_CODEX_VERSION = '0.140.0';

export type AppServerStage = 'spawn' | 'initialize' | 'rate-limits';

export type AppServerFailureCode =
  | 'binary-not-found'
  | 'spawn-failed'
  | 'timeout'
  | 'process-exited'
  | 'stdin-failed'
  | 'invalid-json'
  | 'response-too-large'
  | 'unexpected-response'
  | 'initialize-rejected'
  | 'initialize-schema'
  | 'codex-home-mismatch'
  | 'rate-limits-rejected'
  | 'rate-limits-schema';

export interface ParsedCodexVersion {
  rawVersion: string;
  major: number;
  minor: number;
  patch: number;
  support: 'tested' | 'untested';
}

export function parseCodexVersion(value: string): ParsedCodexVersion | null {
  const match = value.trim().match(/(?:codex-cli\s+)?(\d+)\.(\d+)\.(\d+)/i);
  if (!match) {
    return null;
  }
  const rawVersion = `${match[1]}.${match[2]}.${match[3]}`;
  return {
    rawVersion,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    support: rawVersion === TESTED_CODEX_VERSION ? 'tested' : 'untested',
  };
}

export class AppServerSafeError extends Error {
  readonly code: AppServerFailureCode;
  readonly stage: AppServerStage;

  constructor(code: AppServerFailureCode, stage: AppServerStage) {
    super(code);
    this.name = 'AppServerSafeError';
    this.code = code;
    this.stage = stage;
  }
}
