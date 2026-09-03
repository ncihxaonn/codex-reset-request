import path from 'node:path';
import type { ResetRequestPaths } from '../config/paths.js';

export const SYSTEMD_UNIT_NAME = 'codex-reset-request.service';

export interface SystemdDefinitionInput {
  nodePath: string;
  cliPath: string;
  codexHome: string;
  paths: ResetRequestPaths;
  environmentPath: string;
}

function assertSingleLine(value: string): void {
  if (value.includes('\0') || value.includes('\r') || value.includes('\n')) {
    throw new Error('Service definition values must be single-line strings');
  }
}

function systemdQuoted(value: string): string {
  assertSingleLine(value);
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
}

export function systemdUnitPath(homeDirectory: string, env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME ?? path.posix.join(homeDirectory, '.config');
  return path.posix.join(configHome, 'systemd', 'user', SYSTEMD_UNIT_NAME);
}

export function renderSystemdUnit(input: SystemdDefinitionInput): string {
  const environment = [
    ['CRR_CONFIG_DIR', input.paths.configDir],
    ['CRR_STATE_DIR', input.paths.stateDir],
    ['CRR_LOG_DIR', input.paths.logDir],
    ['CRR_CODEX_HOME', input.codexHome],
    ['PATH', input.environmentPath],
  ] as const;
  for (const value of [input.nodePath, input.cliPath, ...environment.map((entry) => entry[1])]) {
    assertSingleLine(value);
  }
  return `[Unit]
Description=Codex Reset Request event-driven watcher

[Service]
Type=simple
ExecStart=:${systemdQuoted(input.nodePath)} ${systemdQuoted(input.cliPath)} watch
${environment.map(([name, value]) => `Environment=${systemdQuoted(`${name}=${value}`)}`).join('\n')}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}
