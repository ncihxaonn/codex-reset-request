import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { stdin as input, stdout as output } from 'node:process';
import {
  readConfiguredCodexRateLimits,
  type RateLimitsReadOutcome,
} from '../codex/app-server-client.js';
import { resolveCodexHome } from '../codex/codex-home.js';
import { loadConfig } from '../config/load.js';
import { saveConfig } from '../config/save.js';
import {
  CURRENT_DISCLAIMER_VERSION,
  normalizeHandleInput,
  resetRequestConfigSchema,
  type RunMode,
  type ResetRequestConfig,
} from '../config/schema.js';
import { BirdXReplyProvider } from '../x/bird-provider.js';
import type { TargetPostResult, XAccountResult } from '../x/provider.js';

const AUTO_CONFIRMATION = 'I UNDERSTAND THE X ACCOUNT RISK';

export interface SetupOptions {
  mode: string;
  expectedXHandle?: string;
  replyText?: string;
  acceptDisclaimer?: boolean;
  confirmation?: string;
}

interface SetupPrompt {
  question(message: string): Promise<string>;
  close(): void;
}

export interface SetupDependencies {
  load(): Promise<ResetRequestConfig>;
  readRateLimits(config: ResetRequestConfig): Promise<RateLimitsReadOutcome>;
  createProvider(config: ResetRequestConfig): {
    getCurrentAccount(): Promise<XAccountResult>;
    findTargetPost(input: { targetHandle: string; maxPostAgeHours: number }): Promise<TargetPostResult>;
  };
  createPrompt(): SetupPrompt;
  resolveCodexHome(config: ResetRequestConfig): string;
  now(): Date;
}

const DEFAULT_DEPENDENCIES: SetupDependencies = {
  load: loadConfig,
  readRateLimits: readConfiguredCodexRateLimits,
  createProvider: (config) => new BirdXReplyProvider(config),
  createPrompt: () => createInterface({ input, output }),
  resolveCodexHome,
  now: () => new Date(),
};

function printDisclaimerSummary(): void {
  console.log('Codex Reset Request is unofficial and cannot reset an account or guarantee a reset.');
  console.log('It uses an existing authenticated X browser session. Automated replies may put that account at risk.');
  console.log('Review DISCLAIMER.md and applicable platform rules before enabling automatic posting.');
}

export async function prepareSetup(
  options: SetupOptions,
  dependencies: Partial<SetupDependencies> = {},
): Promise<ResetRequestConfig> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  if (!['dry-run', 'auto'].includes(options.mode)) {
    throw new Error('Mode must be dry-run or auto');
  }
  if (Number(process.versions.node.split('.')[0]) < 22) {
    throw new Error('Node.js 22 or newer is required');
  }
  const config = await deps.load();
  if (options.replyText !== undefined) {
    config.replyText = options.replyText;
  }
  resetRequestConfigSchema.parse(config);
  const rateLimits = await deps.readRateLimits(config);
  if (!rateLimits.ok) {
    throw new Error(`Codex App Server preflight failed (${rateLimits.code})`);
  }
  const provider = deps.createProvider(config);
  const currentAccount = await provider.getCurrentAccount();
  if (!currentAccount.ok) {
    throw new Error(`X browser-session preflight failed (${currentAccount.safeCode})`);
  }
  if (
    options.expectedXHandle &&
    normalizeHandleInput(options.expectedXHandle).toLowerCase() !== currentAccount.handle.toLowerCase()
  ) {
    throw new Error('The supplied expected X handle does not match the active browser account');
  }
  const target = await provider.findTargetPost({
    targetHandle: config.targetHandle,
    maxPostAgeHours: config.maxPostAgeHours,
  });
  if (target.status !== 'found') {
    throw new Error(`Target-post read preflight failed (${target.safeCode})`);
  }
  console.log(`Preflight passed for the active X account and @${config.targetHandle}.`);
  console.log(`Configured reply text: ${JSON.stringify(config.replyText)}`);
  printDisclaimerSummary();

  const prompt = deps.createPrompt();
  try {
    const accepted =
      options.acceptDisclaimer || (await prompt.question('Type YES to acknowledge the disclaimer: ')).trim() === 'YES';
    if (!accepted) {
      throw new Error('Disclaimer was not accepted; configuration was not changed');
    }

    let automaticPostingAccepted = false;
    if (options.mode === 'auto') {
      const confirmation = options.confirmation ?? (await prompt.question(`Type exactly "${AUTO_CONFIRMATION}": `));
      automaticPostingAccepted = confirmation === AUTO_CONFIRMATION;
      if (!automaticPostingAccepted) {
        throw new Error('Automatic posting confirmation did not match exactly');
      }
    }

    config.mode = options.mode as RunMode;
    config.codexHome = deps.resolveCodexHome(config);
    config.expectedXHandle = currentAccount.handle;
    config.consent = {
      disclaimerVersion: CURRENT_DISCLAIMER_VERSION,
      acceptedAt: deps.now().toISOString(),
      automaticPostingAccepted,
    };
    return config;
  } finally {
    prompt.close();
  }
}

export async function runSetup(options: SetupOptions): Promise<void> {
  const saved = await saveConfig(await prepareSetup(options));
  console.log(`Setup saved. Mode: ${saved.mode}.`);
}

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Create a safe local configuration and record explicit consent')
    .option('--mode <mode>', 'dry-run or auto', 'dry-run')
    .option('--expected-x-handle <handle>', 'Expected current X account handle')
    .option('--reply-text <text>', 'Reply text, up to 100 Unicode characters')
    .option('--accept-disclaimer', 'Record acceptance without a yes/no prompt')
    .option('--confirmation <text>', 'Exact automatic-posting confirmation text')
    .action(async (options: SetupOptions) => await runSetup(options));
}

export { AUTO_CONFIRMATION };
