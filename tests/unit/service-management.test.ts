import type { Stats } from 'node:fs';
import { homedir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoundedCommandResult } from '../../src/reset/utils/process.js';

const resolveCredentialsMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/cookies.js', () => ({ resolveBrowserFirstCredentials: resolveCredentialsMock }));

import { serviceDoctorCheck } from '../../src/reset/commands/doctor.js';
import { getAppPaths } from '../../src/reset/config/paths.js';
import { createResetRequestProgram } from '../../src/reset/program.js';
import { manageService } from '../../src/reset/service/index.js';
import { LAUNCHD_LABEL, launchAgentPath, renderLaunchAgent } from '../../src/reset/service/launchd.js';
import { renderSystemdUnit, SYSTEMD_UNIT_NAME, systemdUnitPath } from '../../src/reset/service/systemd.js';

function regularStats(): Stats {
  return { isFile: () => true, isSymbolicLink: () => false } as Stats;
}

function symlinkStats(): Stats {
  return { isFile: () => false, isSymbolicLink: () => true } as Stats;
}

async function missingStats(): Promise<Stats> {
  throw Object.assign(new Error('missing'), { code: 'ENOENT' });
}

function commandResult(
  ok = true,
  stdout = '',
  exitCode: number | null = ok ? 0 : 1,
  safeCode?: BoundedCommandResult['safeCode'],
): BoundedCommandResult {
  return safeCode ? { ok, exitCode, stdout, safeCode } : { ok, exitCode, stdout };
}

function launchdMissing(): BoundedCommandResult {
  return commandResult(false, '', 113);
}

function launchdLoaded(running = true): BoundedCommandResult {
  return commandResult(true, running ? 'state = running\npid = 123' : 'state = waiting');
}

function systemdInactive(): BoundedCommandResult {
  return commandResult(false, 'inactive', 3);
}

function systemdNotFound(): BoundedCommandResult {
  return commandResult(false, 'not-found', 1);
}

function posixRuntime(platform: 'darwin' | 'linux') {
  const homeDirectory = platform === 'darwin' ? '/Users/tester' : '/home/tester';
  return {
    platform,
    homeDirectory,
    nodePath: '/usr/local/bin/node',
    cliPath: `${homeDirectory}/codex-reset-request/dist/reset/cli.js`,
    codexHome: `${homeDirectory}/.codex`,
    paths: getAppPaths({ platform, homeDirectory, env: {} }),
    lstat: async () => regularStats(),
    realpath: async (value: string) => value,
  } as const;
}

afterEach(() => {
  resolveCredentialsMock.mockReset();
});

describe('service definitions', () => {
  it('renders an owner-qualified launchd agent with absolute pinned paths and restart-on-failure only', () => {
    const paths = getAppPaths({ platform: 'darwin', homeDirectory: '/Users/A & B', env: {} });
    const definition = renderLaunchAgent({
      nodePath: '/opt/node 22/bin/node',
      cliPath: '/opt/Codex & Reset/dist/reset/cli.js',
      codexHome: '/Users/A & B/.codex',
      paths,
      environmentPath: '/opt/homebrew/bin:/usr/bin:/bin',
    });
    expect(LAUNCHD_LABEL).toBe('io.github.ncihxaonn.codex-reset-request');
    expect(definition).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(definition).toContain('<key>RunAtLoad</key>');
    expect(definition).toContain('<key>KeepAlive</key>');
    expect(definition).toContain('<key>SuccessfulExit</key>');
    expect(definition).toContain('<false/>');
    expect(definition).toContain('/opt/node 22/bin/node');
    expect(definition).toContain('/opt/Codex &amp; Reset/dist/reset/cli.js');
    expect(definition).toContain('<key>CRR_CONFIG_DIR</key>');
    expect(definition).toContain('<key>CRR_CODEX_HOME</key>');
    expect(definition).toContain('/Users/A &amp; B/.codex');
    expect(definition).toContain(paths.stateDir.replaceAll('&', '&amp;'));
    expect(definition).not.toMatch(/StartInterval|CalendarInterval|pnpm|npm|shell/i);
  });

  it('renders a systemd user service without a timer or shell expansion', () => {
    const paths = getAppPaths({
      platform: 'linux',
      homeDirectory: '/home/test user',
      env: { XDG_CONFIG_HOME: '/home/test user/.config' },
    });
    const definition = renderSystemdUnit({
      nodePath: '/opt/node % build/node',
      cliPath: '/home/test user/app/$release/cli.js',
      codexHome: '/home/test user/.codex',
      paths,
      environmentPath: '/usr/local/bin:/usr/bin:/bin',
    });
    expect(definition).toContain('Type=simple');
    expect(definition).toContain('ExecStart=:"/opt/node %% build/node" "/home/test user/app/$release/cli.js" watch');
    expect(definition).toContain('Restart=on-failure');
    expect(definition).toContain('RestartSec=5');
    expect(definition).toContain(`Environment="CRR_LOG_DIR=${paths.logDir}"`);
    expect(definition).toContain('Environment="CRR_CODEX_HOME=/home/test user/.codex"');
    expect(definition).not.toMatch(/\.timer|OnCalendar|OnUnitActiveSec|setInterval|while\s*\(/i);
  });

  it('rejects control characters in systemd values', () => {
    const paths = getAppPaths({ platform: 'linux', homeDirectory: '/home/test', env: {} });
    expect(() =>
      renderSystemdUnit({
        nodePath: '/usr/bin/node\nmalicious',
        cliPath: '/opt/app/cli.js',
        codexHome: '/home/test/.codex',
        paths,
        environmentPath: '/usr/bin',
      }),
    ).toThrow(/single-line/);
  });
});

describe('service installation', () => {
  it('atomically defines and bootstraps the macOS user agent with argv arrays', async () => {
    const runtime = posixRuntime('darwin');
    const commands: Array<[string, string[]]> = [];
    const written = { filePath: '', value: '' };
    const result = await manageService('install', {
      ...runtime,
      uid: 501,
      env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin' },
      ensureDirectories: async () => undefined,
      validateBackgroundCredentials: async () => undefined,
      writeDefinition: async (filePath, value) => {
        written.filePath = filePath;
        written.value = value;
      },
      runCommand: async (binary, args) => {
        commands.push([binary, args]);
        return args[0] === 'print' ? launchdMissing() : commandResult();
      },
    });
    expect(result).toMatchObject({ ok: true, installed: true, running: true });
    expect(written).toMatchObject({ filePath: launchAgentPath(runtime.homeDirectory) });
    expect(written.value).toContain(runtime.nodePath);
    expect(written.value).toContain(`<string>${runtime.codexHome}</string>`);
    expect(commands).toEqual([
      ['launchctl', ['print', `gui/501/${LAUNCHD_LABEL}`]],
      ['launchctl', ['bootstrap', 'gui/501', launchAgentPath(runtime.homeDirectory)]],
    ]);
  });

  it('reloads, enables, and starts a new Linux user service without a timer', async () => {
    const runtime = posixRuntime('linux');
    const commands: Array<[string, string[]]> = [];
    let definition = '';
    const result = await manageService('install', {
      ...runtime,
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        CRR_CODEX_HOME: runtime.codexHome,
      },
      ensureDirectories: async () => undefined,
      validateBackgroundCredentials: async () => undefined,
      writeDefinition: async (_filePath, value) => {
        definition = value;
      },
      runCommand: async (binary, args) => {
        commands.push([binary, args]);
        if (args[1] === 'is-active') return systemdInactive();
        if (args[1] === 'is-enabled') return systemdNotFound();
        return commandResult();
      },
    });
    expect(result).toMatchObject({ ok: true, code: 'service-installed-running' });
    expect(definition).toContain('Restart=on-failure');
    expect(definition).toContain(`CRR_CODEX_HOME=${runtime.codexHome}`);
    expect(commands).toEqual([
      ['systemctl', ['--user', 'is-active', SYSTEMD_UNIT_NAME]],
      ['systemctl', ['--user', 'is-enabled', SYSTEMD_UNIT_NAME]],
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME]],
    ]);
  });

  it('restarts an already-active Linux service after replacing its definition', async () => {
    const runtime = posixRuntime('linux');
    const commands: Array<[string, string[]]> = [];
    const result = await manageService('install', {
      ...runtime,
      validateBackgroundCredentials: async () => undefined,
      ensureDirectories: async () => undefined,
      writeDefinition: async () => undefined,
      runCommand: async (binary, args) => {
        commands.push([binary, args]);
        return commandResult(true, args[1] === 'is-active' ? 'active' : '');
      },
    });
    expect(result.ok).toBe(true);
    expect(commands).toEqual([
      ['systemctl', ['--user', 'is-active', SYSTEMD_UNIT_NAME]],
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME]],
      ['systemctl', ['--user', 'restart', SYSTEMD_UNIT_NAME]],
    ]);
  });

  it('rejects environment-only X credentials without persisting them', async () => {
    const runtime = posixRuntime('darwin');
    resolveCredentialsMock.mockResolvedValue({
      cookies: { authToken: 'secret', ct0: 'secret', cookieHeader: 'secret', source: 'env AUTH_TOKEN' },
      warnings: [],
    });
    const writeDefinition = vi.fn();
    await expect(
      manageService('install', {
        ...runtime,
        uid: 501,
        writeDefinition,
        runCommand: async () => launchdMissing(),
      }),
    ).rejects.toThrow(/Environment-only X credentials/);
    expect(writeDefinition).not.toHaveBeenCalled();
  });
});

describe('service lifecycle and drift handling', () => {
  it.each(['start', 'stop', 'restart'] as const)('uses exact systemctl argv for %s', async (action) => {
    const commands: Array<[string, string[]]> = [];
    const result = await manageService(action, {
      platform: 'linux',
      homeDirectory: '/home/test',
      lstat: async () => regularStats(),
      runCommand: async (binary, args) => {
        commands.push([binary, args]);
        return commandResult(true, args[1] === 'is-active' ? 'active' : '');
      },
    });
    expect(result.ok).toBe(true);
    expect(commands).toEqual([
      ['systemctl', ['--user', 'is-active', SYSTEMD_UNIT_NAME]],
      ['systemctl', ['--user', action, SYSTEMD_UNIT_NAME]],
    ]);
  });

  it('stops launchd by unloading the KeepAlive job', async () => {
    const commands: Array<[string, string[]]> = [];
    const target = `gui/501/${LAUNCHD_LABEL}`;
    const result = await manageService('stop', {
      platform: 'darwin',
      homeDirectory: '/Users/test',
      uid: 501,
      lstat: async () => regularStats(),
      runCommand: async (binary, args) => {
        commands.push([binary, args]);
        return args[0] === 'print' ? launchdLoaded() : commandResult();
      },
    });
    expect(result).toMatchObject({ ok: true, running: false, code: 'service-stopped' });
    expect(commands).toEqual([
      ['launchctl', ['print', target]],
      ['launchctl', ['bootout', target]],
    ]);
  });

  it.each([
    ['start', false, ['bootstrap', 'gui/501', launchAgentPath('/Users/test')]],
    ['start', true, ['kickstart', `gui/501/${LAUNCHD_LABEL}`]],
    ['restart', false, ['bootstrap', 'gui/501', launchAgentPath('/Users/test')]],
    ['restart', true, ['kickstart', '-k', `gui/501/${LAUNCHD_LABEL}`]],
  ] as const)('%s recovers the expected launchd loaded=%s state', async (action, loaded, expectedArgs) => {
    const commands: Array<[string, string[]]> = [];
    const result = await manageService(action, {
      platform: 'darwin',
      homeDirectory: '/Users/test',
      uid: 501,
      lstat: async () => regularStats(),
      runCommand: async (binary, args) => {
        commands.push([binary, args]);
        return args[0] === 'print' ? (loaded ? launchdLoaded() : launchdMissing()) : commandResult();
      },
    });
    expect(result.ok).toBe(true);
    expect(commands[1]).toEqual(['launchctl', [...expectedArgs]]);
  });

  it('distinguishes loaded-but-inactive launchd state from running', async () => {
    const result = await manageService('status', {
      platform: 'darwin',
      homeDirectory: '/Users/test',
      uid: 501,
      lstat: async () => regularStats(),
      runCommand: async () => launchdLoaded(false),
    });
    expect(result).toMatchObject({ ok: true, installed: true, running: false, code: 'service-installed-stopped' });
  });

  it('reports a running manager job whose definition disappeared', async () => {
    const result = await manageService('status', {
      platform: 'darwin',
      homeDirectory: '/Users/test',
      uid: 501,
      lstat: missingStats,
      runCommand: async () => launchdLoaded(),
    });
    expect(result).toMatchObject({
      ok: true,
      installed: false,
      running: true,
      code: 'service-running-definition-missing',
    });
  });

  it('unloads a running launchd job even when its definition disappeared', async () => {
    const commands: Array<[string, string[]]> = [];
    const remove = vi.fn();
    const target = `gui/501/${LAUNCHD_LABEL}`;
    const result = await manageService('uninstall', {
      platform: 'darwin',
      homeDirectory: '/Users/test',
      uid: 501,
      lstat: missingStats,
      unlink: remove,
      runCommand: async (binary, args) => {
        commands.push([binary, args]);
        return args[0] === 'print' ? launchdLoaded() : commandResult();
      },
    });
    expect(result).toMatchObject({ ok: true, installed: false, running: false, code: 'service-uninstalled' });
    expect(commands).toEqual([
      ['launchctl', ['print', target]],
      ['launchctl', ['bootout', target]],
    ]);
    expect(remove).not.toHaveBeenCalled();
  });

  it('stops an active Linux unit even when its definition disappeared', async () => {
    const commands: Array<[string, string[]]> = [];
    const result = await manageService('stop', {
      platform: 'linux',
      homeDirectory: '/home/test',
      lstat: missingStats,
      runCommand: async (binary, args) => {
        commands.push([binary, args]);
        return commandResult(true, args[1] === 'is-active' ? 'active' : '');
      },
    });
    expect(result).toMatchObject({ ok: true, installed: false, running: false, code: 'service-stopped' });
    expect(commands).toEqual([
      ['systemctl', ['--user', 'is-active', SYSTEMD_UNIT_NAME]],
      ['systemctl', ['--user', 'stop', SYSTEMD_UNIT_NAME]],
    ]);
  });

  it('stops a Linux unit that is still activating', async () => {
    const commands: Array<[string, string[]]> = [];
    const result = await manageService('stop', {
      platform: 'linux',
      homeDirectory: '/home/test',
      lstat: async () => regularStats(),
      runCommand: async (binary, args) => {
        commands.push([binary, args]);
        if (args[1] === 'is-active') return commandResult(false, 'activating', 3);
        if (args[1] === 'is-enabled') return commandResult(true, 'enabled');
        return commandResult();
      },
    });
    expect(result).toMatchObject({ ok: true, running: false, code: 'service-stopped' });
    expect(commands).toEqual([
      ['systemctl', ['--user', 'is-active', SYSTEMD_UNIT_NAME]],
      ['systemctl', ['--user', 'is-enabled', SYSTEMD_UNIT_NAME]],
      ['systemctl', ['--user', 'stop', SYSTEMD_UNIT_NAME]],
    ]);
  });

  it('disables before deleting the exact Linux unit and then reloads', async () => {
    const commands: Array<[string, string[]]> = [];
    const removed: string[] = [];
    const unitPath = systemdUnitPath('/home/test', {});
    const result = await manageService('uninstall', {
      platform: 'linux',
      homeDirectory: '/home/test',
      env: {},
      lstat: async () => regularStats(),
      unlink: async (filePath) => {
        removed.push(filePath);
      },
      runCommand: async (binary, args) => {
        commands.push([binary, args]);
        return commandResult(true, args[1] === 'is-active' ? 'active' : '');
      },
    });
    expect(result).toMatchObject({ ok: true, code: 'service-uninstalled' });
    expect(removed).toEqual([unitPath]);
    expect(commands).toEqual([
      ['systemctl', ['--user', 'is-active', SYSTEMD_UNIT_NAME]],
      ['systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT_NAME]],
      ['systemctl', ['--user', 'daemon-reload']],
    ]);
  });

  it('fails status closed when the service manager cannot be queried', async () => {
    const result = await manageService('status', {
      platform: 'linux',
      homeDirectory: '/home/test',
      lstat: async () => regularStats(),
      runCommand: async () => commandResult(false, '', null, 'timeout'),
    });
    expect(result).toMatchObject({ ok: false, installed: true, running: false, code: 'service-status-unavailable' });
    expect(serviceDoctorCheck(result)).toMatchObject({ status: 'FAIL', code: 'service-status-unavailable' });
  });
});

describe('service safety and CLI surface', () => {
  it('returns explicit Windows unsupported results without touching commands or files', async () => {
    const runCommand = vi.fn();
    const writeDefinition = vi.fn();
    const remove = vi.fn();
    for (const action of ['install', 'start', 'stop', 'restart', 'uninstall', 'status'] as const) {
      expect(
        await manageService(action, {
          platform: 'win32',
          runCommand,
          writeDefinition,
          unlink: remove,
        }),
      ).toMatchObject({ ok: false, supported: false, code: 'windows-service-unsupported' });
    }
    expect(runCommand).not.toHaveBeenCalled();
    expect(writeDefinition).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(
      serviceDoctorCheck({
        ok: false,
        supported: false,
        installed: false,
        running: false,
        code: 'windows-service-unsupported',
      }),
    ).toMatchObject({ status: 'WARN', code: 'windows-service-unsupported' });
    expect(
      serviceDoctorCheck({
        ok: true,
        supported: true,
        installed: true,
        running: true,
        code: 'service-running',
        definitionPath: `${homedir()}/Library/LaunchAgents/test.plist`,
      }).detail,
    ).not.toContain(homedir());
  });

  it('fails closed on unsafe definitions, relative runtime paths, and relative app paths', async () => {
    await expect(
      manageService('status', {
        platform: 'linux',
        homeDirectory: '/home/test',
        lstat: async () => symlinkStats(),
      }),
    ).rejects.toThrow(/unsafe/);
    await expect(
      manageService('install', {
        platform: 'linux',
        homeDirectory: '/home/test',
        nodePath: 'relative-node',
        cliPath: '/opt/app/cli.js',
      }),
    ).rejects.toThrow(/absolute/);
    await expect(
      manageService('status', {
        platform: 'linux',
        homeDirectory: '/home/test',
        env: { CRR_CONFIG_DIR: 'relative-config' },
      }),
    ).rejects.toThrow(/absolute/);
    await expect(
      manageService('status', {
        platform: 'linux',
        homeDirectory: '/home/test',
        env: { XDG_CONFIG_HOME: 'relative-xdg' },
      }),
    ).rejects.toThrow(/absolute/);
  });

  it('registers all required service subcommands', () => {
    const service = createResetRequestProgram().commands.find((command) => command.name() === 'service');
    expect(service?.commands.map((command) => command.name())).toEqual([
      'install',
      'start',
      'stop',
      'restart',
      'uninstall',
      'status',
    ]);
  });

  it('registers the one-command installation flow', () => {
    const install = createResetRequestProgram().commands.find((command) => command.name() === 'install');
    expect(install?.description()).toContain('automatic replies');
    expect(install?.options.find((option) => option.long === '--mode')?.defaultValue).toBe('auto');
    expect(install?.options.map((option) => option.long)).toEqual([
      '--mode',
      '--reply-text',
      '--accept-disclaimer',
      '--confirmation',
      '--expected-x-handle',
    ]);
  });
});
