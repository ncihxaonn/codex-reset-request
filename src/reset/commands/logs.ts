import type { Command } from 'commander';
import { readAuditTail } from '../state/audit-log.js';

export function registerLogsCommand(program: Command): void {
  program
    .command('logs')
    .description('Print redacted local audit events')
    .option('--tail <count>', 'Number of entries', '100')
    .action(async (options: { tail: string }) => {
      const count = Number.parseInt(options.tail, 10);
      for (const line of await readAuditTail(count)) {
        console.log(line);
      }
    });
}
