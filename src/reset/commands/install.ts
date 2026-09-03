import type { Command } from 'commander';
import { loadConfig } from '../config/load.js';
import { saveConfig } from '../config/save.js';
import type { ResetRequestConfig } from '../config/schema.js';
import { inspectService, manageService, type ServiceAction, type ServiceResult } from '../service/index.js';
import { prepareSetup, type SetupOptions } from './setup.js';

export interface InstallDependencies {
  platform: NodeJS.Platform;
  load(): Promise<ResetRequestConfig>;
  prepare(options: SetupOptions): Promise<ResetRequestConfig>;
  save(config: ResetRequestConfig): Promise<ResetRequestConfig>;
  manage(action: ServiceAction): Promise<ServiceResult>;
  inspect(): Promise<ServiceResult>;
}

const DEFAULT_DEPENDENCIES: InstallDependencies = {
  platform: process.platform,
  load: loadConfig,
  prepare: prepareSetup,
  save: saveConfig,
  manage: manageService,
  inspect: inspectService,
};

export async function runInstall(options: SetupOptions, dependencies: Partial<InstallDependencies> = {}): Promise<void> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  if (deps.platform !== 'darwin' && deps.platform !== 'linux') {
    throw new Error('One-command background installation is unsupported on this platform; run codex-reset-request watch');
  }

  console.log(`This will install and start a background watcher in ${options.mode} mode.`);
  console.log('Automatic X replies require the explicit risk confirmation. No local OS notifications are used.');
  let desiredConfig: ResetRequestConfig;
  const existingConfig = await deps.load();
  const disabledConfig = structuredClone(existingConfig);
  disabledConfig.mode = 'dry-run';
  disabledConfig.consent.automaticPostingAccepted = false;
  await deps.save(disabledConfig);

  desiredConfig = await deps.prepare(options);
  const safeConfig = structuredClone(desiredConfig);
  safeConfig.mode = 'dry-run';
  safeConfig.consent.automaticPostingAccepted = false;
  await deps.save(safeConfig);

  const stopAfterFailure = async (originalError: unknown): Promise<never> => {
    let stopped: ServiceResult;
    try {
      stopped = await deps.manage('stop');
    } catch {
      throw new Error(
        'Background service rollback also failed; automatic replies remain disabled in configuration, but inspect and stop the service manually',
        { cause: originalError },
      );
    }
    if (!stopped.ok) {
      throw new Error(
        `Background service rollback also failed (${stopped.code}); automatic replies remain disabled in configuration, but inspect and stop the service manually`,
        { cause: originalError },
      );
    }
    throw originalError;
  };

  let service: ServiceResult;
  try {
    service = await deps.manage('install');
  } catch (error) {
    return await stopAfterFailure(error);
  }
  if (!service.ok) {
    return await stopAfterFailure(
      new Error(`Background service installation failed (${service.code}); automatic replies remain disabled`),
    );
  }
  let status: ServiceResult;
  try {
    status = await deps.inspect();
  } catch (error) {
    return await stopAfterFailure(error);
  }
  if (!status.ok || !status.running) {
    return await stopAfterFailure(
      new Error(`Background service failed its startup check (${status.code}); automatic replies remain disabled`),
    );
  }

  try {
    await deps.save(desiredConfig);
  } catch (error) {
    return await stopAfterFailure(error);
  }
  console.log('Installed and running. Use codex-reset-request disable-auto to stop automatic replies.');
}

/**
 * The smallest deployment flow: automatic posting is the default only after
 * the user completes the explicit risk confirmation in setup.
 */
export function registerInstallCommand(program: Command): void {
  program
    .command('install')
    .description('Configure automatic replies and install the running user service')
    .option('--mode <mode>', 'dry-run or auto', 'auto')
    .option('--reply-text <text>', 'Reply text, up to 100 Unicode characters')
    .option('--accept-disclaimer', 'Record acceptance without a yes/no prompt')
    .option('--confirmation <text>', 'Exact automatic-posting confirmation text')
    .option('--expected-x-handle <handle>', 'Expected current X account handle')
    .action(
      async (options: {
        mode: string;
        replyText?: string;
        acceptDisclaimer?: boolean;
        confirmation?: string;
        expectedXHandle?: string;
      }) => {
        await runInstall(options);
      },
    );
}
