import { Command } from 'commander';
import { registerConfigCommand } from './commands/config.js';
import { registerDisableAutoCommand } from './commands/disable-auto.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerEnableAutoCommand } from './commands/enable-auto.js';
import { registerInstallCommand } from './commands/install.js';
import { registerLogsCommand } from './commands/logs.js';
import { registerServiceCommand } from './commands/service.js';
import { registerSetupCommand } from './commands/setup.js';
import { registerStatusCommand } from './commands/status.js';
import { registerTestCommand } from './commands/test.js';
import { registerWatchCommand } from './commands/watch.js';

export function createResetRequestProgram(): Command {
  const program = new Command();
  program
    .name('codex-reset-request')
    .description('Event-driven local Codex usage-limit action tool')
    .version('0.1.0-alpha.0');

  registerSetupCommand(program);
  registerInstallCommand(program);
  registerDoctorCommand(program);
  registerStatusCommand(program);
  registerWatchCommand(program);
  registerEnableAutoCommand(program);
  registerDisableAutoCommand(program);
  registerConfigCommand(program);
  registerLogsCommand(program);
  registerServiceCommand(program);
  registerTestCommand(program);
  return program;
}
