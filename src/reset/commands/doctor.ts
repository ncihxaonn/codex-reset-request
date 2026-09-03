import { watch, type FSWatcher } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
import type { Command } from 'commander';
import { readConfiguredCodexRateLimits } from '../codex/app-server-client.js';
import { resolveCodexSessionsDirectory } from '../codex/codex-home.js';
import { parseCodexVersion } from '../codex/compatibility.js';
import { confirmRateLimit } from '../codex/rate-limit-confirmation.js';
import { loadConfig } from '../config/load.js';
import { getAppPaths } from '../config/paths.js';
import { createDefaultConfig, hasCurrentAutomaticPostingConsent } from '../config/schema.js';
import { acquireSingleInstanceLock, LockHeldError } from '../state/lock.js';
import { StateStore } from '../state/store.js';
import { inspectService, type ServiceResult } from '../service/index.js';
import { runBoundedCommand } from '../utils/process.js';
import { redactForLog } from '../utils/redaction.js';
import { BirdXReplyProvider } from '../x/bird-provider.js';

type DoctorStatus = 'PASS' | 'WARN' | 'FAIL';

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  code: string;
  detail?: string;
}

export function serviceDoctorCheck(service: ServiceResult): DoctorCheck {
  return {
    name: 'Service installation',
    status: !service.supported ? 'WARN' : !service.ok ? 'FAIL' : service.installed && service.running ? 'PASS' : 'WARN',
    code: service.code,
    detail: service.definitionPath ? String(redactForLog(service.definitionPath)) : undefined,
  };
}

async function singleInstanceLockCheck(lockPath: string): Promise<DoctorCheck> {
  try {
    const lock = await acquireSingleInstanceLock(lockPath);
    await lock.release();
    return { name: 'Single-instance lock', status: 'PASS', code: 'lock-functional' };
  } catch (error) {
    if (error instanceof LockHeldError) {
      return { name: 'Single-instance lock', status: 'PASS', code: 'lock-held-by-watcher' };
    }
    return { name: 'Single-instance lock', status: 'FAIL', code: 'lock-unavailable' };
  }
}

async function probeNativeWatcher(directoryPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let nativeWatcher: FSWatcher | null = null;
    let timer: NodeJS.Timeout;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      nativeWatcher?.close();
      resolve(result);
    };
    timer = setTimeout(() => finish(true), 50);
    try {
      nativeWatcher = watch(directoryPath, { persistent: false });
      nativeWatcher.once('error', () => finish(false));
    } catch {
      finish(false);
    }
  });
}

export async function runDoctor(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'Node.js',
    status: nodeMajor >= 22 ? 'PASS' : 'FAIL',
    code: nodeMajor >= 22 ? 'node-supported' : 'node-too-old',
    detail: process.versions.node,
  });

  const pnpm = await runBoundedCommand('pnpm', ['--version']);
  checks.push({
    name: 'pnpm',
    status: pnpm.ok ? 'PASS' : 'WARN',
    code: pnpm.ok ? 'pnpm-available' : 'pnpm-optional-missing',
    detail: pnpm.ok ? pnpm.stdout : undefined,
  });

  const paths = getAppPaths();
  let config = createDefaultConfig();
  try {
    config = await loadConfig(paths);
    checks.push({ name: 'Configuration', status: 'PASS', code: 'config-valid' });
  } catch {
    checks.push({ name: 'Configuration', status: 'FAIL', code: 'config-invalid' });
  }
  try {
    await new StateStore(paths).load();
    checks.push({ name: 'State', status: 'PASS', code: 'state-valid' });
  } catch {
    checks.push({ name: 'State', status: 'FAIL', code: 'state-invalid' });
  }

  const codexVersionCommand = await runBoundedCommand('codex', ['--version']);
  const codexVersion = codexVersionCommand.ok ? parseCodexVersion(codexVersionCommand.stdout) : null;
  checks.push({
    name: 'Codex binary',
    status: codexVersionCommand.ok ? 'PASS' : 'FAIL',
    code: codexVersionCommand.ok ? 'codex-binary-available' : (codexVersionCommand.safeCode ?? 'codex-binary-failed'),
  });
  checks.push({
    name: 'Codex version',
    status: codexVersion?.support === 'tested' ? 'PASS' : codexVersion ? 'WARN' : 'FAIL',
    code: codexVersion ? `codex-version-${codexVersion.support}` : 'codex-version-invalid',
    detail: codexVersion?.rawVersion,
  });

  const sessionsDirectory = resolveCodexSessionsDirectory(config);
  const sessionsStats = await lstat(sessionsDirectory).catch(() => null);
  const sessionsReadable =
    Boolean(sessionsStats?.isDirectory() && !sessionsStats.isSymbolicLink()) &&
    (await access(sessionsDirectory).then(
      () => true,
      () => false,
    ));
  checks.push({
    name: 'Codex sessions',
    status: sessionsReadable ? 'PASS' : 'FAIL',
    code: sessionsReadable ? 'sessions-readable' : 'sessions-unavailable',
  });

  const rateLimits = await readConfiguredCodexRateLimits(config);
  checks.push({
    name: 'Codex App Server',
    status: rateLimits.ok ? 'PASS' : 'FAIL',
    code: rateLimits.ok ? 'app-server-compatible' : rateLimits.code,
  });
  checks.push({
    name: 'Codex login and rate limits',
    status: rateLimits.ok ? 'PASS' : 'FAIL',
    code: rateLimits.ok ? 'rate-limits-readable' : rateLimits.code,
  });
  if (rateLimits.ok) {
    const confirmation = confirmRateLimit(rateLimits.value);
    checks.push({
      name: 'Current usage-limit state',
      status: confirmation.confirmed ? 'PASS' : 'WARN',
      code: confirmation.confirmed ? 'usage-limit-confirmed' : confirmation.safeCode,
    });
  }

  const nativeWatcherAvailable = sessionsReadable && (await probeNativeWatcher(sessionsDirectory));
  checks.push({
    name: 'Native watcher',
    status: nativeWatcherAvailable ? 'PASS' : 'FAIL',
    code: nativeWatcherAvailable ? 'native-watch-available' : 'native-watch-unavailable',
  });
  checks.push({ name: 'Polling disabled', status: 'PASS', code: 'event-driven-watcher-configured' });

  const service = await inspectService();
  checks.push(serviceDoctorCheck(service));
  checks.push(await singleInstanceLockCheck(paths.daemonLockFile));

  const consentReady = config.mode !== 'auto' || hasCurrentAutomaticPostingConsent(config);
  checks.push({
    name: 'Automatic posting consent',
    status: consentReady ? 'PASS' : 'FAIL',
    code: consentReady ? 'consent-valid' : 'consent-required',
  });

  const birdProvider = new BirdXReplyProvider(config);
  const birdDoctor = await birdProvider.doctor();
  checks.push({
    name: 'Bird browser session',
    status: birdDoctor.ok ? 'PASS' : 'FAIL',
    code: birdDoctor.ok ? 'browser-session-readable' : birdDoctor.safeCode,
  });
  checks.push({
    name: 'Current X account',
    status: birdDoctor.ok ? 'PASS' : 'FAIL',
    code: birdDoctor.ok ? 'x-account-readable' : birdDoctor.safeCode,
  });
  if (birdDoctor.ok && birdDoctor.account) {
    const expectedMatches =
      config.expectedXHandle !== null && config.expectedXHandle.toLowerCase() === birdDoctor.account.handle;
    checks.push({
      name: 'Expected X account',
      status: config.expectedXHandle === null ? 'WARN' : expectedMatches ? 'PASS' : 'FAIL',
      code: config.expectedXHandle === null ? 'expected-account-not-recorded' : expectedMatches ? 'account-match' : 'wrong-account',
    });
    const target = await birdProvider.findTargetPost({
      targetHandle: config.targetHandle,
      maxPostAgeHours: config.maxPostAgeHours,
    });
    const accountLookupPassed = target.status === 'found' || target.safeCode !== 'target-user-unavailable';
    checks.push({
      name: 'Target account lookup',
      status: accountLookupPassed ? 'PASS' : 'FAIL',
      code: accountLookupPassed ? 'target-account-readable' : target.safeCode,
    });
    checks.push({
      name: 'Target post read',
      status: target.status === 'found' ? 'PASS' : 'FAIL',
      code: target.status === 'found' ? 'target-post-readable' : target.safeCode,
    });
  } else {
    checks.push({ name: 'Expected X account', status: 'FAIL', code: 'account-unavailable' });
    checks.push({ name: 'Target account lookup', status: 'FAIL', code: 'credentials-unavailable' });
    checks.push({ name: 'Target post read', status: 'FAIL', code: 'credentials-unavailable' });
  }
  return checks;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Run safe local compatibility checks')
    .option('--json', 'Print JSON')
    .action(async (options: { json?: boolean }) => {
      const checks = await runDoctor();
      if (options.json) {
        console.log(JSON.stringify({ checks }, null, 2));
      } else {
        for (const check of checks) {
          console.log(`${check.status} ${check.name}: ${check.code}${check.detail ? ` (${check.detail})` : ''}`);
        }
      }
      if (checks.some((check) => check.status === 'FAIL')) {
        process.exitCode = 1;
      }
    });
}
