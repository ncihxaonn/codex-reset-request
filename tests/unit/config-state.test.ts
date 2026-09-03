import { chmod, link, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/reset/config/load.js';
import { ensureAppDirectories, getAppPaths } from '../../src/reset/config/paths.js';
import { saveConfig } from '../../src/reset/config/save.js';
import {
  CURRENT_DISCLAIMER_VERSION,
  createDefaultConfig,
  hasCurrentAutomaticPostingConsent,
  resetRequestConfigSchema,
} from '../../src/reset/config/schema.js';
import { setConfigValue } from '../../src/reset/commands/config.js';
import { acquireSingleInstanceLock, LockHeldError } from '../../src/reset/state/lock.js';
import { createEmptyState } from '../../src/reset/state/schema.js';
import { StateStore } from '../../src/reset/state/store.js';
import {
  appendAuditEvent,
  MAX_AUDIT_LOG_BYTES,
  readAuditTail,
} from '../../src/reset/state/audit-log.js';
import { MAX_JSON_FILE_BYTES } from '../../src/reset/utils/atomic-file.js';
import { redactForLog } from '../../src/reset/utils/redaction.js';
import { createTemporaryHome, type TemporaryHome } from '../helpers/temporary-home.js';

const homes: TemporaryHome[] = [];

async function temporaryHome(): Promise<TemporaryHome> {
  const home = await createTemporaryHome();
  homes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => home.cleanup()));
});

describe('configuration', () => {
  it('uses the required safe defaults', () => {
    expect(createDefaultConfig()).toMatchObject({
      mode: 'dry-run',
      targetHandle: 'thsottiaux',
      replyText: 'reset',
      requireRateLimitConfirmation: true,
      maxPostAgeHours: 72,
      maxAttemptsPer24Hours: 1,
      consent: { automaticPostingAccepted: false },
    });
  });

  it('validates handles, Unicode length, control characters, and hard attempt bounds', () => {
    expect(() => resetRequestConfigSchema.parse({ ...createDefaultConfig(), targetHandle: 'https://x.com/a' })).toThrow();
    expect(() => resetRequestConfigSchema.parse({ ...createDefaultConfig(), replyText: 'x'.repeat(101) })).toThrow();
    expect(() => resetRequestConfigSchema.parse({ ...createDefaultConfig(), replyText: '   ' })).toThrow();
    expect(() => resetRequestConfigSchema.parse({ ...createDefaultConfig(), replyText: 'reset\n' })).toThrow();
    expect(() => resetRequestConfigSchema.parse({ ...createDefaultConfig(), maxAttemptsPer24Hours: 4 })).toThrow();
    expect(() => resetRequestConfigSchema.parse({ ...createDefaultConfig(), mode: 'notify' })).toThrow();
    expect(resetRequestConfigSchema.parse({ ...createDefaultConfig(), replyText: '🪶'.repeat(100) }).replyText).toHaveLength(200);
  });

  it('does not allow config set to bypass automatic-posting consent', () => {
    expect(() => setConfigValue(createDefaultConfig(), 'mode', 'auto')).toThrow(/enable-auto/);
    expect(() => setConfigValue(createDefaultConfig(), 'mode', 'notify')).toThrow(/not supported/);
    expect(setConfigValue(createDefaultConfig(), 'targetHandle', '@thsottiaux').targetHandle).toBe('thsottiaux');
    expect(setConfigValue(createDefaultConfig(), 'targetHandle', '@ThSoTtIaUx').targetHandle).toBe('thsottiaux');
    expect(() => setConfigValue(createDefaultConfig(), 'requireRateLimitConfirmation', 'false')).toThrow(
      /Unsupported/,
    );
  });

  it('invalidates auto mode when the disclaimer version changes', () => {
    const config = createDefaultConfig();
    config.mode = 'auto';
    config.expectedXHandle = 'example';
    config.consent = {
      disclaimerVersion: 'old-version',
      acceptedAt: new Date().toISOString(),
      automaticPostingAccepted: true,
    };
    expect(hasCurrentAutomaticPostingConsent(config)).toBe(false);
    config.consent.disclaimerVersion = CURRENT_DISCLAIMER_VERSION;
    expect(hasCurrentAutomaticPostingConsent(config)).toBe(true);
  });

  it('saves validated config atomically with private Unix permissions', async () => {
    const home = await temporaryHome();
    const config = createDefaultConfig();
    await saveConfig(config, home.paths);

    expect((await loadConfig(home.paths)).mode).toBe('dry-run');
    if (process.platform !== 'win32') {
      expect((await stat(home.paths.configDir)).mode & 0o777).toBe(0o700);
      expect((await stat(home.paths.configFile)).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses to load configuration through a symbolic link', async () => {
    const home = await temporaryHome();
    await ensureAppDirectories(home.paths);
    const outside = `${home.root}/outside-config.json`;
    await writeFile(outside, JSON.stringify(createDefaultConfig()), 'utf8');
    await symlink(outside, home.paths.configFile);

    await expect(loadConfig(home.paths)).rejects.toThrow(/invalid local data file/i);
  });

  it('migrates legacy notify configuration to dry-run without local notification settings', async () => {
    const home = await temporaryHome();
    await ensureAppDirectories(home.paths);
    await writeFile(
      home.paths.configFile,
      `${JSON.stringify({
        ...createDefaultConfig(),
        mode: 'notify',
        notifications: { detection: true, success: true, failure: true, unknown: true },
      })}\n`,
      'utf8',
    );

    const migrated = await loadConfig(home.paths);
    expect(migrated.mode).toBe('dry-run');
    expect(migrated).not.toHaveProperty('notifications');
  });

  it('uses platform-standard paths and explicit test overrides', () => {
    const linux = getAppPaths({
      platform: 'linux',
      homeDirectory: '/home/tester',
      env: { XDG_CONFIG_HOME: '/config', XDG_STATE_HOME: '/state' },
    });
    expect(linux.configDir).toBe('/config/codex-reset-request');
    expect(linux.stateDir).toBe('/state/codex-reset-request');

    const macos = getAppPaths({
      platform: 'darwin',
      homeDirectory: '/Users/tester',
      env: {},
    });
    expect(macos.configDir).toBe('/Users/tester/Library/Application Support/codex-reset-request');
    expect(macos.logDir).toBe('/Users/tester/Library/Logs/codex-reset-request');

    const windows = getAppPaths({
      platform: 'win32',
      homeDirectory: String.raw`C:\Users\tester`,
      env: {
        APPDATA: String.raw`D:\Profiles\Roaming`,
        LOCALAPPDATA: String.raw`D:\Profiles\Local`,
      },
    });
    expect(windows.configDir).toBe(String.raw`D:\Profiles\Roaming\codex-reset-request`);
    expect(windows.stateDir).toBe(String.raw`D:\Profiles\Local\codex-reset-request`);
    expect(windows.configFile).toBe(String.raw`D:\Profiles\Roaming\codex-reset-request\config.json`);

    const overridden = getAppPaths({
      platform: 'darwin',
      homeDirectory: '/Users/tester',
      env: { CRR_CONFIG_DIR: '/tmp/config', CRR_STATE_DIR: '/tmp/state', CRR_LOG_DIR: '/tmp/logs' },
    });
    expect(overridden).toMatchObject({ configDir: '/tmp/config', stateDir: '/tmp/state', logDir: '/tmp/logs' });
  });
});

describe('state and locking', () => {
  it('recovers the committed atomic state while ignoring an orphan temporary file', async () => {
    const home = await temporaryHome();
    const store = new StateStore(home.paths);
    const state = createEmptyState();
    await store.save(state);
    await writeFile(`${home.paths.stateFile}.orphan.tmp`, '{invalid', 'utf8');

    expect(await store.load()).toMatchObject({ version: 1, actions: [] });
  });

  it('prevents a second live instance and permits reacquisition after release', async () => {
    const home = await temporaryHome();
    const first = await acquireSingleInstanceLock(home.paths.daemonLockFile);
    await expect(acquireSingleInstanceLock(home.paths.daemonLockFile)).rejects.toBeInstanceOf(LockHeldError);
    await first.release();
    const second = await acquireSingleInstanceLock(home.paths.daemonLockFile);
    await second.release();
  });

  it('replaces a stale lock without sending a signal', async () => {
    const home = await temporaryHome();
    await ensureAppDirectories(home.paths);
    await writeFile(
      home.paths.daemonLockFile,
      `${JSON.stringify({ pid: 2_147_483_647, startedAt: new Date(0).toISOString(), token: 'stale' })}\n`,
      { mode: 0o600 },
    );
    if (process.platform !== 'win32') {
      await chmod(home.paths.daemonLockFile, 0o600);
    }
    const lock = await acquireSingleInstanceLock(home.paths.daemonLockFile);
    expect(lock.record.pid).toBe(process.pid);
    await lock.release();
  });

  it('rejects duplicate action identities without evicting durable deduplication history', async () => {
    const home = await temporaryHome();
    const store = new StateStore(home.paths);
    const completedAt = new Date().toISOString();
    const actions = Array.from({ length: 1_501 }, (_value, index) => ({
      actionId: `action-${index}`,
      eventFingerprint: index.toString(16).padStart(64, '0'),
      limitWindowKey: (index + 10_000).toString(16).padStart(64, '0'),
      detectedAt: completedAt,
      completedAt,
      status: 'dry-run' as const,
      targetHandle: 'thsottiaux',
      safeCode: 'would-reply',
    }));
    await store.save({ version: 1, updatedAt: completedAt, actions });
    expect((await store.load()).actions).toHaveLength(actions.length);

    const duplicate = actions.at(-1);
    if (!duplicate) {
      throw new Error('Expected a generated action');
    }
    await expect(
      store.save({ version: 1, updatedAt: completedAt, actions: [duplicate, { ...duplicate }] }),
    ).rejects.toThrow(/Duplicate/);
  });

  it('migrates loose early-v1 sent records conservatively instead of dropping their guard', async () => {
    const home = await temporaryHome();
    const store = new StateStore(home.paths);
    const timestamp = new Date().toISOString();
    await ensureAppDirectories(home.paths);
    await writeFile(
      home.paths.stateFile,
      `${JSON.stringify({
        version: 1,
        updatedAt: timestamp,
        actions: [
          {
            actionId: 'legacy-action',
            eventFingerprint: 'a'.repeat(64),
            limitWindowKey: 'b'.repeat(64),
            detectedAt: timestamp,
            status: 'sent',
            targetHandle: 'Example',
          },
        ],
      })}\n`,
      'utf8',
    );

    expect((await store.load()).actions[0]).toMatchObject({
      status: 'sent',
      targetHandle: 'example',
      mutationStartedAt: timestamp,
      completedAt: timestamp,
      legacyImported: true,
    });
  });

  it.each([
    {
      label: 'notified terminal',
      action: { status: 'notified' as const },
      expected: { status: 'notified', completedAt: expect.any(String) },
    },
    {
      label: 'incomplete target-resolved',
      action: { status: 'target-resolved' as const, confirmedAt: '2026-08-28T12:00:00.000Z' },
      expected: { status: 'confirmed', confirmedAt: '2026-08-28T12:00:00.000Z' },
    },
    {
      label: 'mutation-marked candidate',
      action: {
        status: 'candidate' as const,
        attemptStartedAt: '2026-08-28T12:00:00.000Z',
        mutationStartedAt: '2026-08-28T12:00:01.000Z',
      },
      expected: {
        status: 'unknown',
        mutationStartedAt: '2026-08-28T12:00:01.000Z',
        completedAt: expect.any(String),
      },
    },
  ])('migrates an early-v1 $label record without losing safety evidence', async ({ action, expected }) => {
    const home = await temporaryHome();
    const store = new StateStore(home.paths);
    const timestamp = '2026-08-28T12:00:00.000Z';
    await ensureAppDirectories(home.paths);
    await writeFile(
      home.paths.stateFile,
      `${JSON.stringify({
        version: 1,
        updatedAt: timestamp,
        actions: [
          {
            actionId: `legacy-${action.status}`,
            eventFingerprint: 'c'.repeat(64),
            limitWindowKey: 'd'.repeat(64),
            detectedAt: timestamp,
            targetHandle: 'Example',
            ...action,
          },
        ],
      })}\n`,
      'utf8',
    );

    expect((await store.load()).actions[0]).toMatchObject({ ...expected, legacyImported: true });
  });

  it('refuses an oversized state before atomic replacement and keeps the prior state readable', async () => {
    const home = await temporaryHome();
    const store = new StateStore(home.paths);
    const empty = createEmptyState();
    await store.save(empty);
    const timestamp = new Date().toISOString();
    await expect(
      store.save({
        version: 1,
        updatedAt: timestamp,
        actions: [
          {
            actionId: 'x'.repeat(MAX_JSON_FILE_BYTES),
            eventFingerprint: 'e'.repeat(64),
            limitWindowKey: 'f'.repeat(64),
            detectedAt: timestamp,
            completedAt: timestamp,
            status: 'dry-run',
            targetHandle: 'thsottiaux',
          },
        ],
      }),
    ).rejects.toThrow(/too large/i);
    expect(await store.load()).toMatchObject({ version: 1, actions: [] });
  });
});

describe('log redaction', () => {
  it('refuses a symbolic-link audit log for writes and reads', async () => {
    const home = await temporaryHome();
    await ensureAppDirectories(home.paths);
    const outside = `${home.root}/outside.log`;
    await writeFile(outside, 'outside\n', 'utf8');
    await symlink(outside, home.paths.auditLogFile);
    await expect(appendAuditEvent({ level: 'info', code: 'test' }, home.paths)).rejects.toThrow(/symbolic link/i);
    await expect(readAuditTail(10, home.paths)).rejects.toThrow(/symbolic link/i);
  });

  it('refuses a hard-linked audit log', async () => {
    const home = await temporaryHome();
    await ensureAppDirectories(home.paths);
    const outside = `${home.root}/outside-hard-link.log`;
    await writeFile(outside, 'outside\n', 'utf8');
    await link(outside, home.paths.auditLogFile);
    await expect(appendAuditEvent({ level: 'info', code: 'test' }, home.paths)).rejects.toThrow(
      /invalid audit log/i,
    );
    await expect(readAuditTail(10, home.paths)).rejects.toThrow(/invalid audit log/i);
  });

  it('refuses to append to an oversized audit log', async () => {
    const home = await temporaryHome();
    await ensureAppDirectories(home.paths);
    await writeFile(home.paths.auditLogFile, '', 'utf8');
    await truncate(home.paths.auditLogFile, MAX_AUDIT_LOG_BYTES + 1);
    await expect(appendAuditEvent({ level: 'info', code: 'test' }, home.paths)).rejects.toThrow(
      /invalid audit log/i,
    );
  });

  it('redacts credential keys, cookies, bearer values, JWTs, and long hex strings', () => {
    const value = redactForLog({
      auth_token: 'secret',
      message:
        'auth_token=secret; ct0=secret Bearer abc.def eyJaaaaaaaaaaa.bbbbbbbbbbb.ccccccccccc 0123456789abcdef0123456789abcdef01234567',
    });
    expect(JSON.stringify(value)).not.toContain('secret');
    expect(JSON.stringify(value)).not.toContain('0123456789abcdef');
    expect(redactForLog(`${homedir()}/Library/example`)).toBe('~/Library/example');
  });
});
