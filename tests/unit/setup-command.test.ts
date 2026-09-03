import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '../../src/reset/config/schema.js';
import {
  AUTO_CONFIRMATION,
  prepareSetup,
  type SetupDependencies,
} from '../../src/reset/commands/setup.js';

const NOW = new Date('2026-08-28T12:00:00.000Z');

function dependencies(): SetupDependencies {
  return {
    load: async () => createDefaultConfig(),
    readRateLimits: async () => ({
      ok: true,
      value: {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 100, resetsAt: Math.floor(NOW.getTime() / 1_000) + 3_600 },
        },
      },
    }),
    createProvider: () => ({
      getCurrentAccount: async () => ({ ok: true, id: '7', handle: 'example' }),
      findTargetPost: async () => ({
        status: 'found',
        post: {
          id: '100',
          authorHandle: 'thsottiaux',
          authorId: '42',
          createdAt: NOW.toISOString(),
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
        throw new Error('The non-interactive test should not prompt');
      },
      close: () => undefined,
    }),
    resolveCodexHome: () => '/home/example/.codex',
    now: () => NOW,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('setup command', () => {
  it('previews and stores customized reply text before recording automatic consent', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((message?: unknown) => output.push(String(message)));

    const config = await prepareSetup(
      {
        mode: 'auto',
        replyText: 'Please reset my Codex limit',
        acceptDisclaimer: true,
        confirmation: AUTO_CONFIRMATION,
      },
      dependencies(),
    );

    expect(config).toMatchObject({
      mode: 'auto',
      replyText: 'Please reset my Codex limit',
      codexHome: '/home/example/.codex',
      expectedXHandle: 'example',
      consent: { automaticPostingAccepted: true, acceptedAt: NOW.toISOString() },
    });
    expect(config).not.toHaveProperty('notifications');
    expect(output.indexOf('Configured reply text: "Please reset my Codex limit"')).toBeLessThan(
      output.findIndex((line) => line.includes('unofficial')),
    );
  });

  it('rejects invalid custom reply text before network preflight', async () => {
    const deps = dependencies();
    deps.readRateLimits = vi.fn(deps.readRateLimits);
    await expect(
      prepareSetup(
        { mode: 'auto', replyText: '   ', acceptDisclaimer: true, confirmation: AUTO_CONFIRMATION },
        deps,
      ),
    ).rejects.toThrow(/must not be empty/);
    expect(deps.readRateLimits).not.toHaveBeenCalled();
  });

  it('rejects a non-exact interactive automatic-posting confirmation', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const deps = dependencies();
    const close = vi.fn();
    deps.createPrompt = () => ({
      question: async (message) => (message.includes('Type YES') ? 'YES' : 'I understand the X account risk'),
      close,
    });

    await expect(prepareSetup({ mode: 'auto' }, deps)).rejects.toThrow(/did not match exactly/);
    expect(close).toHaveBeenCalledOnce();
  });

  it('compares the expected X handle without case sensitivity', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const config = await prepareSetup(
      {
        mode: 'dry-run',
        expectedXHandle: '@Example',
        acceptDisclaimer: true,
      },
      dependencies(),
    );
    expect(config.expectedXHandle).toBe('example');
  });
});
