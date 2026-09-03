import type { Command } from 'commander';
import { loadConfig } from '../config/load.js';
import {
  ABSOLUTE_MAX_ATTEMPTS_PER_24_HOURS,
  hasCurrentAutomaticPostingConsent,
} from '../config/schema.js';
import { countRollingWriteAttempts } from '../pipeline/rate-guard.js';
import { StateStore } from '../state/store.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show local mode, consent, and latest safe action status')
    .option('--json', 'Print JSON')
    .action(async (options: { json?: boolean }) => {
      const config = await loadConfig();
      const state = await new StateStore().load();
      const lastAction = state.actions.at(-1);
      const status = {
        mode: config.mode,
        automaticPostingReady: hasCurrentAutomaticPostingConsent(config),
        expectedXHandle: config.expectedXHandle,
        targetHandle: config.targetHandle,
        actionCount: state.actions.length,
        attemptsInLast24Hours: countRollingWriteAttempts(state),
        configuredMaximumPer24Hours: config.maxAttemptsPer24Hours,
        absoluteMaximumPer24Hours: ABSOLUTE_MAX_ATTEMPTS_PER_24_HOURS,
        lastAction: lastAction
          ? {
              actionId: lastAction.actionId,
              status: lastAction.status,
              detectedAt: lastAction.detectedAt,
              completedAt: lastAction.completedAt,
              safeCode: lastAction.safeCode,
              targetPostUrl: lastAction.targetPostUrl,
              replyUrl: lastAction.replyUrl,
            }
          : null,
      };
      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }
      console.log(`Mode: ${status.mode}`);
      console.log(`Automatic posting ready: ${status.automaticPostingReady ? 'yes' : 'no'}`);
      console.log(`Expected X account: ${status.expectedXHandle ? `@${status.expectedXHandle}` : 'not recorded'}`);
      console.log(`Actions: ${status.actionCount}`);
      console.log(
        `Write attempts (rolling 24h): ${status.attemptsInLast24Hours}/${status.configuredMaximumPer24Hours} (hard maximum ${status.absoluteMaximumPer24Hours})`,
      );
      console.log(`Latest: ${status.lastAction?.status ?? 'none'}`);
    });
}
