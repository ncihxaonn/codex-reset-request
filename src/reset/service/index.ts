import type { Stats } from 'node:fs';
import { lstat, realpath, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBrowserFirstCredentials } from '../../lib/cookies.js';
import { resolveCodexHome } from '../codex/codex-home.js';
import { loadConfig } from '../config/load.js';
import { ensureAppDirectories, getAppPaths, type ResetRequestPaths } from '../config/paths.js';
import type { ResetRequestConfig } from '../config/schema.js';
import { rejectSymlink, writeFileAtomic } from '../utils/atomic-file.js';
import { runBoundedCommand, type BoundedCommandResult } from '../utils/process.js';
import {
  LAUNCHD_LABEL,
  launchAgentPath,
  launchdDomain,
  launchdServiceTarget,
  renderLaunchAgent,
} from './launchd.js';
import { renderSystemdUnit, SYSTEMD_UNIT_NAME, systemdUnitPath } from './systemd.js';
import { WINDOWS_SERVICE_MESSAGE, WINDOWS_SERVICE_UNSUPPORTED_CODE } from './windows.js';

export type ServiceAction = 'install' | 'start' | 'stop' | 'restart' | 'uninstall' | 'status';

export interface ServiceResult {
  ok: boolean;
  supported: boolean;
  installed: boolean;
  running: boolean;
  code: string;
  message?: string;
  definitionPath?: string;
}

interface ServiceRuntime {
  platform: NodeJS.Platform;
  homeDirectory: string;
  env: NodeJS.ProcessEnv;
  uid: number | null;
  nodePath: string;
  cliPath: string;
  paths: ResetRequestPaths;
  environmentPath: string;
}

interface ManagerState {
  available: boolean;
  loaded: boolean;
  running: boolean;
  safeCode?: string;
}

export interface ServiceDependencies {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  env?: NodeJS.ProcessEnv;
  uid?: number | null;
  nodePath?: string;
  cliPath?: string;
  codexHome?: string;
  paths?: ResetRequestPaths;
  runCommand?(binary: string, args: string[]): Promise<BoundedCommandResult>;
  lstat?(filePath: string): Promise<Stats>;
  realpath?(filePath: string): Promise<string>;
  unlink?(filePath: string): Promise<void>;
  writeDefinition?(filePath: string, value: string): Promise<void>;
  ensureDirectories?(paths: ResetRequestPaths): Promise<void>;
  loadConfiguration?(paths: ResetRequestPaths): Promise<ResetRequestConfig>;
  validateBackgroundCredentials?(config: ResetRequestConfig): Promise<void>;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function unsupported(): ServiceResult {
  return {
    ok: false,
    supported: false,
    installed: false,
    running: false,
    code: WINDOWS_SERVICE_UNSUPPORTED_CODE,
    message: WINDOWS_SERVICE_MESSAGE,
  };
}

function definitionPath(runtime: ServiceRuntime): string {
  if (runtime.platform === 'darwin') {
    return launchAgentPath(runtime.homeDirectory);
  }
  return systemdUnitPath(runtime.homeDirectory, runtime.env);
}

function assertSingleLine(value: string, label: string): void {
  if (value.includes('\0') || value.includes('\r') || value.includes('\n')) {
    throw new Error(`${label} must be a single-line value`);
  }
}

function validateServicePaths(runtime: ServiceRuntime): void {
  const pathApi = runtime.platform === 'win32' ? path.win32 : path.posix;
  const values: Array<[string, string]> = [
    ['Service home directory', runtime.homeDirectory],
    ['Service definition path', definitionPath(runtime)],
    ['Config directory', runtime.paths.configDir],
    ['State directory', runtime.paths.stateDir],
    ['Log directory', runtime.paths.logDir],
    ['Config file', runtime.paths.configFile],
    ['State file', runtime.paths.stateFile],
    ['Cursor file', runtime.paths.cursorFile],
    ['Audit log file', runtime.paths.auditLogFile],
    ['Daemon lock file', runtime.paths.daemonLockFile],
  ];
  for (const [label, value] of values) {
    assertSingleLine(value, label);
    if (!pathApi.isAbsolute(value)) {
      throw new Error(`${label} must be absolute for service management`);
    }
  }
  assertSingleLine(runtime.environmentPath, 'Service PATH');
}

async function regularFileState(
  filePath: string,
  inspect: (target: string) => Promise<Stats>,
): Promise<'regular' | 'missing' | 'unsafe'> {
  try {
    const stats = await inspect(filePath);
    return stats.isFile() && !stats.isSymbolicLink() ? 'regular' : 'unsafe';
  } catch (error) {
    if (isMissing(error)) {
      return 'missing';
    }
    throw error;
  }
}

function runtimeFrom(dependencies: ServiceDependencies): ServiceRuntime {
  const platform = dependencies.platform ?? process.platform;
  const homeDirectory = dependencies.homeDirectory ?? homedir();
  const env = dependencies.env ?? process.env;
  return {
    platform,
    homeDirectory,
    env,
    uid: dependencies.uid === undefined ? (process.getuid?.() ?? null) : dependencies.uid,
    nodePath: dependencies.nodePath ?? process.execPath,
    cliPath: dependencies.cliPath ?? fileURLToPath(new URL('../cli.js', import.meta.url)),
    paths:
      dependencies.paths ??
      getAppPaths({
        platform,
        homeDirectory,
        env,
      }),
    environmentPath: env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  };
}

async function validatedRuntime(
  runtime: ServiceRuntime,
  dependencies: ServiceDependencies,
): Promise<ServiceRuntime> {
  validateServicePaths(runtime);
  const resolveRealpath = dependencies.realpath ?? realpath;
  const inspect = dependencies.lstat ?? lstat;
  const pathApi = runtime.platform === 'win32' ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(runtime.nodePath) || !pathApi.isAbsolute(runtime.cliPath)) {
    throw new Error('Service installation requires absolute Node and built CLI paths');
  }
  assertSingleLine(runtime.nodePath, 'Node path');
  assertSingleLine(runtime.cliPath, 'CLI path');
  const nodePath = await resolveRealpath(runtime.nodePath).catch(() => runtime.nodePath);
  const cliPath = await resolveRealpath(runtime.cliPath).catch(() => runtime.cliPath);
  if (
    (await regularFileState(nodePath, inspect)) !== 'regular' ||
    (await regularFileState(cliPath, inspect)) !== 'regular'
  ) {
    throw new Error('Service installation requires absolute regular Node and built CLI files');
  }
  if (runtime.platform === 'darwin' && (runtime.uid === null || runtime.uid < 0)) {
    throw new Error('A user id is required for launchd installation');
  }
  return { ...runtime, nodePath, cliPath };
}

async function serviceFileInstalled(runtime: ServiceRuntime, dependencies: ServiceDependencies): Promise<boolean> {
  const state = await regularFileState(definitionPath(runtime), dependencies.lstat ?? lstat);
  if (state === 'unsafe') {
    throw new Error('Refusing unsafe service definition path');
  }
  return state === 'regular';
}

function managerUnavailable(result: BoundedCommandResult): ManagerState {
  return {
    available: false,
    loaded: false,
    running: false,
    safeCode: result.safeCode ?? 'manager-query-failed',
  };
}

function launchdOutputIsRunning(stdout: string): boolean {
  return /\bstate\s*=\s*running\b/i.test(stdout) || /\bpid\s*=\s*[1-9]\d*\b/i.test(stdout);
}

async function queryManager(runtime: ServiceRuntime, dependencies: ServiceDependencies): Promise<ManagerState> {
  const run = dependencies.runCommand ?? runBoundedCommand;
  if (runtime.platform === 'darwin') {
    if (runtime.uid === null || runtime.uid < 0) {
      return { available: false, loaded: false, running: false, safeCode: 'service-user-id-unavailable' };
    }
    const result = await run('launchctl', ['print', launchdServiceTarget(runtime.uid)]);
    if (result.ok) {
      return { available: true, loaded: true, running: launchdOutputIsRunning(result.stdout) };
    }
    if (!result.safeCode && (result.exitCode === 3 || result.exitCode === 113)) {
      return { available: true, loaded: false, running: false };
    }
    return managerUnavailable(result);
  }

  const active = await run('systemctl', ['--user', 'is-active', SYSTEMD_UNIT_NAME]);
  if (active.safeCode) {
    return managerUnavailable(active);
  }
  if (active.ok) {
    return { available: true, loaded: true, running: true };
  }
  const activeState = active.stdout.trim().toLowerCase();
  const expectedInactive = new Set(['inactive', 'failed', 'activating', 'deactivating', 'unknown']);
  if (active.exitCode !== 3 && active.exitCode !== 4 && !expectedInactive.has(activeState)) {
    return managerUnavailable(active);
  }

  const enabled = await run('systemctl', ['--user', 'is-enabled', SYSTEMD_UNIT_NAME]);
  if (enabled.safeCode) {
    return managerUnavailable(enabled);
  }
  const enabledState = enabled.stdout.trim().toLowerCase();
  const knownEnabledStates = new Set([
    'enabled',
    'enabled-runtime',
    'linked',
    'linked-runtime',
    'alias',
    'static',
    'indirect',
    'generated',
    'transient',
    'disabled',
    'masked',
    'masked-runtime',
    'not-found',
    'bad',
  ]);
  if (!enabled.ok && !knownEnabledStates.has(enabledState)) {
    return managerUnavailable(enabled);
  }
  return {
    available: true,
    loaded: enabled.ok || (knownEnabledStates.has(enabledState) && !['not-found', 'bad'].includes(enabledState)),
    running: false,
  };
}

function unavailableResult(installed: boolean, filePath: string, manager: ManagerState): ServiceResult {
  return {
    ok: false,
    supported: true,
    installed,
    running: false,
    code: manager.safeCode === 'service-user-id-unavailable' ? manager.safeCode : 'service-status-unavailable',
    message: manager.safeCode,
    definitionPath: filePath,
  };
}

async function status(runtime: ServiceRuntime, dependencies: ServiceDependencies): Promise<ServiceResult> {
  const installed = await serviceFileInstalled(runtime, dependencies);
  const filePath = definitionPath(runtime);
  const manager = await queryManager(runtime, dependencies);
  if (!manager.available) {
    return unavailableResult(installed, filePath, manager);
  }
  let code: string;
  if (manager.running) {
    code = installed ? 'service-running' : 'service-running-definition-missing';
  } else if (manager.loaded) {
    code = installed ? 'service-installed-stopped' : 'service-loaded-definition-missing';
  } else {
    code = installed ? 'service-installed-stopped' : 'service-not-installed';
  }
  return {
    ok: true,
    supported: true,
    installed,
    running: manager.running,
    code,
    definitionPath: filePath,
  };
}

async function validateDefaultBackgroundCredentials(config: ResetRequestConfig): Promise<void> {
  const result = await resolveBrowserFirstCredentials({
    cookieSource: config.cookieSource,
    chromeProfile: config.chromeProfile ?? undefined,
    firefoxProfile: config.firefoxProfile ?? undefined,
  });
  if (!result.cookies.authToken || !result.cookies.ct0) {
    throw new Error('Service installation requires a readable X browser session');
  }
  if (result.cookies.source?.startsWith('env ')) {
    throw new Error('Environment-only X credentials are unsupported for background services');
  }
}

async function install(runtime: ServiceRuntime, dependencies: ServiceDependencies): Promise<ServiceResult> {
  const checked = await validatedRuntime(runtime, dependencies);
  const filePath = definitionPath(checked);
  const installedBefore = await serviceFileInstalled(checked, dependencies);
  const managerBefore = await queryManager(checked, dependencies);
  if (!managerBefore.available) {
    return unavailableResult(installedBefore, filePath, managerBefore);
  }

  const config = await (dependencies.loadConfiguration ?? loadConfig)(checked.paths);
  await (dependencies.validateBackgroundCredentials ?? validateDefaultBackgroundCredentials)(config);
  const codexHome = dependencies.codexHome ?? resolveCodexHome(config, checked.env);
  assertSingleLine(codexHome, 'Codex home');
  const pathApi = checked.platform === 'win32' ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(codexHome)) {
    throw new Error('Codex home must be absolute for service installation');
  }

  await (dependencies.ensureDirectories ?? ensureAppDirectories)(checked.paths);
  const definition =
    checked.platform === 'darwin'
      ? renderLaunchAgent({
          nodePath: checked.nodePath,
          cliPath: checked.cliPath,
          codexHome,
          paths: checked.paths,
          environmentPath: checked.environmentPath,
        })
      : renderSystemdUnit({
          nodePath: checked.nodePath,
          cliPath: checked.cliPath,
          codexHome,
          paths: checked.paths,
          environmentPath: checked.environmentPath,
        });
  const write =
    dependencies.writeDefinition ??
    (async (target: string, value: string) => {
      await writeFileAtomic(target, value, { preserveDirectoryMode: true });
    });
  await write(filePath, definition);

  const run = dependencies.runCommand ?? runBoundedCommand;
  let command: BoundedCommandResult;
  if (checked.platform === 'darwin') {
    const uid = checked.uid;
    if (uid === null || uid < 0) {
      throw new Error('A user id is required for launchd installation');
    }
    const target = launchdServiceTarget(uid);
    if (managerBefore.loaded) {
      const bootout = await run('launchctl', ['bootout', target]);
      if (!bootout.ok) {
        return {
          ok: false,
          supported: true,
          installed: true,
          running: managerBefore.running,
          code: 'service-command-failed',
          definitionPath: filePath,
        };
      }
    }
    command = await run('launchctl', ['bootstrap', launchdDomain(uid), filePath]);
  } else {
    const reload = await run('systemctl', ['--user', 'daemon-reload']);
    if (!reload.ok) {
      command = reload;
    } else {
      const enable = await run('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME]);
      command = enable.ok && managerBefore.running
        ? await run('systemctl', ['--user', 'restart', SYSTEMD_UNIT_NAME])
        : enable;
    }
  }
  return {
    ok: command.ok,
    supported: true,
    installed: true,
    running: command.ok,
    code: command.ok ? 'service-installed-running' : 'service-command-failed',
    definitionPath: filePath,
  };
}

async function lifecycle(
  action: Exclude<ServiceAction, 'install' | 'uninstall' | 'status'>,
  runtime: ServiceRuntime,
  dependencies: ServiceDependencies,
): Promise<ServiceResult> {
  const filePath = definitionPath(runtime);
  const installed = await serviceFileInstalled(runtime, dependencies);
  const manager = await queryManager(runtime, dependencies);
  if (!manager.available) {
    return unavailableResult(installed, filePath, manager);
  }
  if (action !== 'stop' && !installed) {
    return {
      ok: false,
      supported: true,
      installed: false,
      running: manager.running,
      code: 'service-not-installed',
      definitionPath: filePath,
    };
  }

  const run = dependencies.runCommand ?? runBoundedCommand;
  let result: BoundedCommandResult = { ok: true, exitCode: 0, stdout: '' };
  if (runtime.platform === 'darwin') {
    if (runtime.uid === null || runtime.uid < 0) {
      throw new Error('A user id is required for launchd management');
    }
    const target = launchdServiceTarget(runtime.uid);
    if (action === 'stop') {
      if (manager.loaded) {
        result = await run('launchctl', ['bootout', target]);
      }
    } else if (action === 'start') {
      result = manager.loaded
        ? await run('launchctl', ['kickstart', target])
        : await run('launchctl', ['bootstrap', launchdDomain(runtime.uid), filePath]);
    } else {
      result = manager.loaded
        ? await run('launchctl', ['kickstart', '-k', target])
        : await run('launchctl', ['bootstrap', launchdDomain(runtime.uid), filePath]);
    }
  } else if (action === 'stop') {
    if (manager.loaded || installed) {
      result = await run('systemctl', ['--user', 'stop', SYSTEMD_UNIT_NAME]);
    }
  } else {
    result = await run('systemctl', ['--user', action, SYSTEMD_UNIT_NAME]);
  }

  return {
    ok: result.ok,
    supported: true,
    installed,
    running: result.ok && action !== 'stop',
    code: result.ok
      ? action === 'stop'
        ? 'service-stopped'
        : action === 'start'
          ? 'service-started'
          : 'service-restarted'
      : 'service-command-failed',
    definitionPath: filePath,
  };
}

async function uninstallService(runtime: ServiceRuntime, dependencies: ServiceDependencies): Promise<ServiceResult> {
  const filePath = definitionPath(runtime);
  const installed = await serviceFileInstalled(runtime, dependencies);
  const manager = await queryManager(runtime, dependencies);
  if (!manager.available) {
    return unavailableResult(installed, filePath, manager);
  }
  if (!installed && !manager.loaded && !manager.running) {
    return {
      ok: true,
      supported: true,
      installed: false,
      running: false,
      code: 'service-not-installed',
      definitionPath: filePath,
    };
  }

  const run = dependencies.runCommand ?? runBoundedCommand;
  let unloadResult: BoundedCommandResult | null = null;
  if (runtime.platform === 'darwin') {
    if (runtime.uid === null || runtime.uid < 0) {
      throw new Error('A user id is required for launchd management');
    }
    if (manager.loaded) {
      unloadResult = await run('launchctl', ['bootout', launchdServiceTarget(runtime.uid)]);
    }
  } else {
    unloadResult = await run('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT_NAME]);
  }
  if (unloadResult && !unloadResult.ok) {
    return {
      ok: false,
      supported: true,
      installed,
      running: manager.running,
      code: 'service-command-failed',
      definitionPath: filePath,
    };
  }

  if (installed) {
    if (!dependencies.unlink) {
      await rejectSymlink(filePath);
    }
    await (dependencies.unlink ?? unlink)(filePath);
  }
  if (runtime.platform !== 'darwin') {
    const reload = await run('systemctl', ['--user', 'daemon-reload']);
    if (!reload.ok) {
      return {
        ok: false,
        supported: true,
        installed: false,
        running: false,
        code: 'service-command-failed',
        definitionPath: filePath,
      };
    }
  }
  return {
    ok: true,
    supported: true,
    installed: false,
    running: false,
    code: 'service-uninstalled',
    definitionPath: filePath,
  };
}

export async function manageService(
  action: ServiceAction,
  dependencies: ServiceDependencies = {},
): Promise<ServiceResult> {
  const runtime = runtimeFrom(dependencies);
  if (runtime.platform === 'win32') {
    return unsupported();
  }
  if (runtime.platform !== 'darwin' && runtime.platform !== 'linux') {
    return {
      ...unsupported(),
      code: 'platform-service-unsupported',
      message: 'Background service installation is unsupported on this platform; use foreground watch mode.',
    };
  }
  validateServicePaths(runtime);
  if (action === 'status') {
    return await status(runtime, dependencies);
  }
  if (action === 'install') {
    return await install(runtime, dependencies);
  }
  if (action === 'uninstall') {
    return await uninstallService(runtime, dependencies);
  }
  return await lifecycle(action, runtime, dependencies);
}

export async function inspectService(dependencies: ServiceDependencies = {}): Promise<ServiceResult> {
  try {
    return await manageService('status', dependencies);
  } catch {
    return {
      ok: false,
      supported: true,
      installed: false,
      running: false,
      code: 'service-status-unavailable',
    };
  }
}

export { LAUNCHD_LABEL, SYSTEMD_UNIT_NAME };
