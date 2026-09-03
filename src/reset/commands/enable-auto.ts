import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { stdin as input, stdout as output } from 'node:process';
import { readConfiguredCodexRateLimits } from '../codex/app-server-client.js';
import { loadConfig } from '../config/load.js';
import { saveConfig } from '../config/save.js';
import { CURRENT_DISCLAIMER_VERSION } from '../config/schema.js';
import { AUTO_CONFIRMATION } from './setup.js';
import { BirdXReplyProvider } from '../x/bird-provider.js';

export function registerEnableAutoCommand(program: Command): void {
  program
    .command('enable-auto')
    .description('Explicitly opt in to one-shot automatic X replies')
    .option('--confirmation <text>', 'Exact confirmation text')
    .action(async (options: { confirmation?: string }) => {
      console.log('Automatic posting uses your active X browser account and can cause account restrictions or suspension.');
      console.log('The tool cannot guarantee a reset. One ambiguous write is never retried.');

      const config = await loadConfig();
      if (!config.expectedXHandle) {
        throw new Error('Run setup and record the expected X account before enabling auto mode');
      }
      const rateLimits = await readConfiguredCodexRateLimits(config);
      if (!rateLimits.ok) {
        throw new Error(`Codex App Server preflight failed (${rateLimits.code})`);
      }
      const provider = new BirdXReplyProvider(config);
      const currentAccount = await provider.getCurrentAccount();
      if (!currentAccount.ok) {
        throw new Error(`X account preflight failed (${currentAccount.safeCode})`);
      }
      if (currentAccount.handle !== config.expectedXHandle.toLowerCase()) {
        throw new Error('The active X browser account does not match expectedXHandle');
      }
      const target = await provider.findTargetPost({
        targetHandle: config.targetHandle,
        maxPostAgeHours: config.maxPostAgeHours,
      });
      if (target.status !== 'found') {
        throw new Error(`Target-post read preflight failed (${target.safeCode})`);
      }

      const prompt = createInterface({ input, output });
      try {
        const confirmation =
          options.confirmation ?? (await prompt.question(`Type exactly "${AUTO_CONFIRMATION}": `));
        if (confirmation !== AUTO_CONFIRMATION) {
          throw new Error('Automatic posting confirmation did not match exactly');
        }
        config.mode = 'auto';
        config.consent = {
          disclaimerVersion: CURRENT_DISCLAIMER_VERSION,
          acceptedAt: new Date().toISOString(),
          automaticPostingAccepted: true,
        };
        await saveConfig(config);
        console.log('Automatic posting enabled. Runtime preflight checks remain mandatory.');
      } finally {
        prompt.close();
      }
    });
}
