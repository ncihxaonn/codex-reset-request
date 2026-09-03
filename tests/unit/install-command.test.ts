import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInstall } from '../../src/reset/commands/install.js';
import { AUTO_CONFIRMATION, prepareSetup } from '../../src/reset/commands/setup.js';
import { createDefaultConfig, type ResetRequestConfig } from '../../src/reset/config/schema.js';
import type { ServiceResult } from '../../src/reset/service/index.js';

const runningService: ServiceResult = {
  ok: true,
  supported: true,
  installed: true,
  running: true,
  code: 'service-running',
};

function autoConfig(): ResetRequestConfig {
  const config = createDefaultConfig();
  config.mode = 'auto';
  config.replyText = 'custom reset request';
  config.expectedXHandle = 'example';
  config.consent = {
    disclaimerVersion: '2026-08-28-v1',
    acceptedAt: '2026-08-28T12:00:00.000Z',
    automaticPostingAccepted: true,
  };
  return config;
}

afterEach(() => vi.restoreAllMocks());

describe('one-command installer', () => {
  it('runs real setup preparation and enables the customized auto config only after startup', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const saved: ResetRequestConfig[] = [];
    await runInstall(
      {
        mode: 'auto',
        replyText: 'Please reset my Codex limit',
        expectedXHandle: 'example',
        acceptDisclaimer: true,
        confirmation: AUTO_CONFIRMATION,
      },
      {
        platform: 'darwin',
        load: async () => createDefaultConfig(),
        prepare: async (options) =>
          await prepareSetup(options, {
            load: async () => createDefaultConfig(),
            readRateLimits: async () => ({ ok: true, value: { rateLimits: { limitId: 'codex' } } }),
            createProvider: () => ({
              getCurrentAccount: async () => ({ ok: true, id: '7', handle: 'example' }),
              findTargetPost: async () => ({
                status: 'found',
                post: {
                  id: '100',
                  authorHandle: 'thsottiaux',
                  authorId: '42',
                  createdAt: '2026-08-28T12:00:00.000Z',
                  url: 'https://x.com/thsottiaux/status/100',
                  selectionEvidence: {
                    source: 'timeline',
                    isPinned: false,
                    isRetweet: false,
                    isReply: false,
                  },
                },
              }),
            }),
            createPrompt: () => ({
              question: async () => {
                throw new Error('The non-interactive install test should not prompt');
              },
              close: () => undefined,
            }),
            resolveCodexHome: () => '/home/example/.codex',
            now: () => new Date('2026-08-28T12:00:00.000Z'),
          }),
        save: async (config) => {
          saved.push(structuredClone(config));
          return config;
        },
        manage: async () => runningService,
        inspect: async () => runningService,
      },
    );

    expect(saved.at(-1)).toMatchObject({
      mode: 'auto',
      replyText: 'Please reset my Codex limit',
      expectedXHandle: 'example',
      consent: { automaticPostingAccepted: true },
    });
  });

  it('keeps posting disabled until the installed service passes its startup check', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const saved: ResetRequestConfig[] = [];
    const actions: string[] = [];
    await runInstall(
      { mode: 'auto', replyText: 'custom reset request' },
      {
        platform: 'darwin',
        load: async () => createDefaultConfig(),
        prepare: async () => autoConfig(),
        save: async (config) => {
          saved.push(structuredClone(config));
          return config;
        },
        manage: async (action) => {
          actions.push(action);
          return runningService;
        },
        inspect: async () => runningService,
      },
    );
    expect(saved.map((config) => [config.mode, config.consent.automaticPostingAccepted])).toEqual([
      ['dry-run', false],
      ['dry-run', false],
      ['auto', true],
    ]);
    expect(actions).toEqual(['install']);
  });

  it('leaves automatic posting disabled when service startup fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const saved: ResetRequestConfig[] = [];
    const actions: string[] = [];
    await expect(
      runInstall(
        { mode: 'auto' },
        {
          platform: 'linux',
          load: async () => createDefaultConfig(),
          prepare: async () => autoConfig(),
          save: async (config) => {
            saved.push(structuredClone(config));
            return config;
          },
          manage: async (action) => {
            actions.push(action);
            return runningService;
          },
          inspect: async () => ({ ...runningService, running: false, code: 'service-installed-stopped' }),
        },
      ),
    ).rejects.toThrow(/automatic replies remain disabled/);
    expect(saved).toHaveLength(2);
    expect(saved).toEqual([
      expect.objectContaining({
        mode: 'dry-run',
        consent: expect.objectContaining({ automaticPostingAccepted: false }),
      }),
      expect.objectContaining({
        mode: 'dry-run',
        consent: expect.objectContaining({ automaticPostingAccepted: false }),
      }),
    ]);
    expect(actions).toEqual(['install', 'stop']);
  });

  it('stops a partially installed service when the manager reports failure', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const actions: string[] = [];
    await expect(
      runInstall(
        { mode: 'auto' },
        {
          platform: 'linux',
          load: async () => createDefaultConfig(),
          prepare: async () => autoConfig(),
          save: async (config) => config,
          manage: async (action) => {
            actions.push(action);
            return action === 'install'
              ? { ...runningService, ok: false, running: false, code: 'service-command-failed' }
              : runningService;
          },
        },
      ),
    ).rejects.toThrow(/automatic replies remain disabled/);
    expect(actions).toEqual(['install', 'stop']);
  });

  it('keeps the already-disabled watcher untouched when setup preparation cannot complete', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const actions: string[] = [];
    await expect(
      runInstall(
        { mode: 'auto' },
        {
          platform: 'linux',
          load: async () => autoConfig(),
          prepare: async () => {
            throw new Error('synthetic preflight failure');
          },
          save: async (config) => config,
          manage: async (action) => {
            actions.push(action);
            return runningService;
          },
        },
      ),
    ).rejects.toThrow(/synthetic preflight failure/);
    expect(actions).toEqual([]);
  });

  it('surfaces a failed service rollback instead of silently swallowing it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const actions: string[] = [];
    await expect(
      runInstall(
        { mode: 'auto' },
        {
          platform: 'linux',
          load: async () => createDefaultConfig(),
          prepare: async () => autoConfig(),
          save: async (config) => config,
          manage: async (action) => {
            actions.push(action);
            return { ...runningService, ok: false, running: false, code: 'service-command-failed' };
          },
        },
      ),
    ).rejects.toThrow(/rollback also failed/);
    expect(actions).toEqual(['install', 'stop']);
  });

  it('stops the service if enabling the final automatic config fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const actions: string[] = [];
    await expect(
      runInstall(
        { mode: 'auto' },
        {
          platform: 'darwin',
          load: async () => createDefaultConfig(),
          prepare: async () => autoConfig(),
          save: async (config) => {
            if (config.mode === 'auto') {
              throw new Error('synthetic final save failure');
            }
            return config;
          },
          manage: async (action) => {
            actions.push(action);
            return runningService;
          },
          inspect: async () => runningService,
        },
      ),
    ).rejects.toThrow(/synthetic final save failure/);
    expect(actions).toEqual(['install', 'stop']);
  });

  it('rejects unsupported platforms before configuration is prepared', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const prepare = vi.fn(async () => autoConfig());
    await expect(runInstall({ mode: 'auto' }, { platform: 'freebsd', prepare })).rejects.toThrow(/unsupported/);
    expect(prepare).not.toHaveBeenCalled();
  });
});
