import path from 'node:path';
import type { ResetRequestPaths } from '../config/paths.js';

export const LAUNCHD_LABEL = 'io.github.ncihxaonn.codex-reset-request';

export interface LaunchdDefinitionInput {
  nodePath: string;
  cliPath: string;
  codexHome: string;
  paths: ResetRequestPaths;
  environmentPath: string;
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function stringEntry(value: string): string {
  return `    <string>${xml(value)}</string>`;
}

export function launchAgentPath(homeDirectory: string): string {
  return path.posix.join(homeDirectory, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

export function launchdServiceTarget(uid: number): string {
  return `gui/${uid}/${LAUNCHD_LABEL}`;
}

export function launchdDomain(uid: number): string {
  return `gui/${uid}`;
}

export function renderLaunchAgent(input: LaunchdDefinitionInput): string {
  const environment = [
    ['CRR_CONFIG_DIR', input.paths.configDir],
    ['CRR_STATE_DIR', input.paths.stateDir],
    ['CRR_LOG_DIR', input.paths.logDir],
    ['CRR_CODEX_HOME', input.codexHome],
    ['PATH', input.environmentPath],
  ] as const;
  const environmentXml = environment
    .flatMap(([name, value]) => [`    <key>${name}</key>`, stringEntry(value)])
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${stringEntry(input.nodePath)}
${stringEntry(input.cliPath)}
    <string>watch</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(path.posix.join(input.paths.logDir, 'service.stdout.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.posix.join(input.paths.logDir, 'service.stderr.log'))}</string>
</dict>
</plist>
`;
}
