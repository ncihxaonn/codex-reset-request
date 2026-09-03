import { homedir } from 'node:os';
import path from 'node:path';
import { ensurePrivateDirectory } from '../utils/atomic-file.js';

export interface ResetRequestPaths {
  configDir: string;
  stateDir: string;
  logDir: string;
  configFile: string;
  stateFile: string;
  cursorFile: string;
  auditLogFile: string;
  daemonLockFile: string;
}

export interface PathResolutionOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
}

export function getAppPaths(options: PathResolutionOptions = {}): ResetRequestPaths {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  const pathApi = platform === 'win32' ? path.win32 : path.posix;

  let configDir: string;
  let stateDir: string;
  let logDir: string;

  if (platform === 'darwin') {
    const applicationSupport = pathApi.join(homeDirectory, 'Library', 'Application Support', 'codex-reset-request');
    configDir = env.CRR_CONFIG_DIR ?? applicationSupport;
    stateDir = env.CRR_STATE_DIR ?? pathApi.join(applicationSupport, 'state');
    logDir = env.CRR_LOG_DIR ?? pathApi.join(homeDirectory, 'Library', 'Logs', 'codex-reset-request');
  } else if (platform === 'win32') {
    const appData = env.APPDATA ?? pathApi.join(homeDirectory, 'AppData', 'Roaming');
    const localAppData = env.LOCALAPPDATA ?? pathApi.join(homeDirectory, 'AppData', 'Local');
    configDir = env.CRR_CONFIG_DIR ?? pathApi.join(appData, 'codex-reset-request');
    stateDir = env.CRR_STATE_DIR ?? pathApi.join(localAppData, 'codex-reset-request');
    logDir = env.CRR_LOG_DIR ?? pathApi.join(stateDir, 'logs');
  } else {
    configDir =
      env.CRR_CONFIG_DIR ??
      pathApi.join(env.XDG_CONFIG_HOME ?? pathApi.join(homeDirectory, '.config'), 'codex-reset-request');
    stateDir =
      env.CRR_STATE_DIR ??
      pathApi.join(env.XDG_STATE_HOME ?? pathApi.join(homeDirectory, '.local', 'state'), 'codex-reset-request');
    logDir = env.CRR_LOG_DIR ?? pathApi.join(stateDir, 'logs');
  }

  return {
    configDir,
    stateDir,
    logDir,
    configFile: pathApi.join(configDir, 'config.json'),
    stateFile: pathApi.join(stateDir, 'state.json'),
    cursorFile: pathApi.join(stateDir, 'cursors.json'),
    auditLogFile: pathApi.join(logDir, 'audit.jsonl'),
    daemonLockFile: pathApi.join(stateDir, 'watcher.lock'),
  };
}

export async function ensureAppDirectories(paths: ResetRequestPaths): Promise<void> {
  await ensurePrivateDirectory(paths.configDir);
  await ensurePrivateDirectory(paths.stateDir);
  await ensurePrivateDirectory(paths.logDir);
}
