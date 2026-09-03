import type { Command } from 'commander';
import { loadConfig } from '../config/load.js';
import { saveConfig } from '../config/save.js';

export function registerDisableAutoCommand(program: Command): void {
  program
    .command('disable-auto')
    .description('Disable automatic posting and continue in dry-run mode')
    .action(async () => {
      const config = await loadConfig();
      config.mode = 'dry-run';
      config.consent.automaticPostingAccepted = false;
      await saveConfig(config);
      console.log('Automatic posting disabled. Mode: dry-run.');
    });
}
