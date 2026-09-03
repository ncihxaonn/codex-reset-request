import { homedir } from 'node:os';
import path from 'node:path';
import type { ResetRequestConfig } from '../config/schema.js';

export function resolveCodexHome(config: ResetRequestConfig, env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.CRR_CODEX_HOME ?? config.codexHome ?? env.CODEX_HOME ?? path.join(homedir(), '.codex'));
}

export function resolveCodexSessionsDirectory(
  config: ResetRequestConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveCodexHome(config, env), 'sessions');
}
