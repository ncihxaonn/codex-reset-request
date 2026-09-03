import type { Command } from 'commander';
import { manageService, type ServiceAction } from '../service/index.js';
import { redactForLog } from '../utils/redaction.js';

const ACTIONS: ServiceAction[] = ['install', 'start', 'stop', 'restart', 'uninstall', 'status'];

export function registerServiceCommand(program: Command): void {
  const service = program.command('service').description('Manage the event-driven user background service');
  for (const action of ACTIONS) {
    service
      .command(action)
      .description(`${action[0]?.toUpperCase()}${action.slice(1)} the user service`)
      .option('--json', 'Print JSON')
      .action(async (options: { json?: boolean }) => {
        const result = await manageService(action);
        const safeResult = redactForLog(result) as typeof result;
        if (options.json) {
          console.log(JSON.stringify(safeResult, null, 2));
        } else {
          console.log(`${safeResult.code}${safeResult.definitionPath ? `: ${safeResult.definitionPath}` : ''}`);
          if (safeResult.message) {
            console.log(safeResult.message);
          }
        }
        if (!result.ok) {
          process.exitCode = 1;
        }
      });
  }
}
