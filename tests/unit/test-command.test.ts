import { access } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertLiveXTestEnabled,
  parseOwnedPostUrl,
  runSyntheticTriggerTest,
  runXReadTest,
  runXReplyTest,
  type TestCommandDependencies,
} from '../../src/reset/commands/test.js';
import { createDefaultConfig, type ResetRequestConfig } from '../../src/reset/config/schema.js';
import { createResetRequestProgram } from '../../src/reset/program.js';
import { acquireSingleInstanceLock } from '../../src/reset/state/lock.js';
import { StateStore } from '../../src/reset/state/store.js';
import type { XReplyProvider } from '../../src/reset/x/provider.js';
import { createTemporaryHome, type TemporaryHome } from '../helpers/temporary-home.js';

const homes: TemporaryHome[] = [];

function config(overrides: Partial<ResetRequestConfig> = {}): ResetRequestConfig {
  return {
    ...createDefaultConfig(),
    expectedXHandle: 'alice',
    maxAttemptsPer24Hours: 3,
    ...overrides,
  };
}

function postReader(options: { postId?: string; authorId?: string; handle?: string } = {}) {
  const postId = options.postId ?? '123';
  const authorId = options.authorId ?? '42';
  const handle = options.handle ?? 'alice';
  return {
    getCurrentUser: vi.fn(async () => ({
      success: true,
      user: { id: '42', username: 'alice', name: 'Alice' },
    })),
    getTweet: vi.fn(async () => ({
      success: true,
      tweet: {
        id: postId,
        text: 'private test content that must not be printed',
        authorId,
        author: { username: handle, name: 'Alice' },
        createdAt: '2026-08-28T00:00:00.000Z',
      },
    })),
  };
}

function replyProvider(
  result: 'sent' | 'unknown' = 'sent',
  hooks: {
    beforeStart?(input: Parameters<XReplyProvider['replyOnce']>[0]): Promise<void>;
    afterStart?(input: Parameters<XReplyProvider['replyOnce']>[0]): Promise<void>;
  } = {},
): XReplyProvider {
  return {
    doctor: vi.fn(),
    getCurrentAccount: vi.fn(),
    findTargetPost: vi.fn(),
    replyOnce: vi.fn(async (input) => {
      await hooks.beforeStart?.(input);
      const start = await input.onMutationStart?.();
      if (start && !start.ok) {
        return { status: 'definitive-failure' as const, safeCode: start.safeCode };
      }
      await hooks.afterStart?.(input);
      return result === 'sent'
        ? {
            status: 'sent' as const,
            tweetId: '9001',
            url: 'https://x.com/alice/status/9001',
            verifiedBy: 'mutation-response' as const,
          }
        : {
            status: 'unknown' as const,
            safeCode: 'write-timeout',
            targetPostUrl: 'https://x.com/alice/status/123',
          };
    }),
    verifyReply: vi.fn(async () => ({ status: 'not-verified' as const, safeCode: 'no-match' as const })),
  };
}

async function fixture(provider = replyProvider(), overrides: Partial<TestCommandDependencies> = {}) {
  const home = await createTemporaryHome();
  homes.push(home);
  const currentConfig = config();
  const reader = postReader();
  const dependencies: TestCommandDependencies = {
    env: { CRR_LIVE_X: '1' },
    paths: home.paths,
    now: () => new Date('2026-08-28T01:00:00.000Z'),
    loadConfiguration: vi.fn(async () => currentConfig),
    createPostReader: vi.fn(async () => reader),
    createReplyProvider: vi.fn(() => provider),
    ...overrides,
  };
  return { home, currentConfig, reader, provider, dependencies };
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => home.cleanup()));
});

describe('test command safety gates', () => {
  it('runs the trigger as a synthetic zero-side-effect classifier rehearsal', () => {
    const result = runSyntheticTriggerTest(new Date('2026-08-28T00:00:00.000Z'));
    expect(result).toMatchObject({
      code: 'synthetic-trigger-detected',
      synthetic: true,
      mode: 'dry-run',
      networkRequests: 0,
      mutationAttempts: 0,
      stateWritten: false,
    });
  });

  it('requires the environment gate, write flag, and a non-CI process before any live work', async () => {
    expect(() => assertLiveXTestEnabled({}, false, false)).toThrow(/CRR_LIVE_X=1/);
    expect(() => assertLiveXTestEnabled({ CRR_LIVE_X: '1' }, true, false)).toThrow(/--live/);
    expect(() => assertLiveXTestEnabled({ CRR_LIVE_X: '1', CI: 'true' }, true, true)).toThrow(/disabled in CI/);

    const loadConfiguration = vi.fn();
    await expect(runXReadTest({ env: { CI: 'true', CRR_LIVE_X: '1' }, loadConfiguration })).rejects.toThrow(
      /disabled in CI/,
    );
    await expect(
      runXReplyTest('https://x.com/alice/status/123', false, {
        env: { CRR_LIVE_X: '1' },
        loadConfiguration,
      }),
    ).rejects.toThrow(/--live/);
    expect(loadConfiguration).not.toHaveBeenCalled();
  });

  it.each([
    '123',
    'http://x.com/alice/status/123',
    'https://x.com.evil.example/alice/status/123',
    'https://alice:secret@x.com/alice/status/123',
    'https://x.com:444/alice/status/123',
    'https://x.com/i/web/status/123',
    'https://x.com/alice/status/not-numeric',
  ])('rejects a non-canonical or unsafe post URL: %s', (value) => {
    expect(() => parseOwnedPostUrl(value)).toThrow();
  });

  it('canonicalizes a strict user status URL and allows a harmless share query', () => {
    expect(parseOwnedPostUrl('https://twitter.com/Alice/status/123/?s=20')).toEqual({
      handle: 'alice',
      postId: '123',
      canonicalUrl: 'https://x.com/alice/status/123',
    });
  });
});

describe('live X diagnostics', () => {
  it('performs a gated read of the fixed target and returns safe metadata only', async () => {
    const findTargetPost = vi.fn(async (input: { targetHandle: string }) => ({
      status: 'found' as const,
      post: {
        id: '100',
        authorHandle: input.targetHandle,
        authorId: '7',
        createdAt: '2026-08-28T00:00:00.000Z',
        url: 'https://x.com/thsottiaux/status/100',
        selectionEvidence: {
          source: 'timeline' as const,
          isPinned: false as const,
          isRetweet: false as const,
          isReply: false as const,
        },
      },
    }));
    const result = await runXReadTest({
      env: { CRR_LIVE_X: '1' },
      loadConfiguration: async () => config(),
      createTargetReader: () => ({
        doctor: vi.fn(),
        getCurrentAccount: vi.fn(async () => ({ ok: true as const, id: '42', handle: 'alice' })),
        findTargetPost,
      }),
    });
    expect(findTargetPost).toHaveBeenCalledWith({ targetHandle: 'thsottiaux', maxPostAgeHours: 72 });
    expect(result).toEqual({
      code: 'x-read-ok',
      currentAccount: '@alice',
      targetHandle: '@thsottiaux',
      targetPostUrl: 'https://x.com/thsottiaux/status/100',
    });
    expect(JSON.stringify(result)).not.toMatch(/private test content|auth_token|ct0|cookie/i);
  });

  it('rejects Tibo and fetched ownership mismatches before creating a write provider', async () => {
    const loadConfiguration = vi.fn();
    await expect(
      runXReplyTest('https://x.com/thsottiaux/status/123', true, {
        env: { CRR_LIVE_X: '1' },
        loadConfiguration,
      }),
    ).rejects.toThrow(/never reply/);
    expect(loadConfiguration).not.toHaveBeenCalled();

    const createReplyProvider = vi.fn();
    const setup = await fixture(replyProvider(), {
      createPostReader: async () => postReader({ authorId: '99', handle: 'mallory' }),
      createReplyProvider,
    });
    await expect(runXReplyTest('https://x.com/alice/status/123', true, setup.dependencies)).rejects.toThrow(
      /not verifiably owned/,
    );
    expect(createReplyProvider).not.toHaveBeenCalled();
  });

  it('persists the mutation marker before exactly one write and deduplicates a rerun', async () => {
    let setup: Awaited<ReturnType<typeof fixture>>;
    const provider = replyProvider('sent', {
      beforeStart: async () => {
        const before = (await new StateStore(setup.home.paths).load()).actions[0];
        expect(before).toMatchObject({ status: 'attempting', targetPostId: '123' });
        expect(before.mutationStartedAt).toBeUndefined();
      },
      afterStart: async () => {
        expect((await new StateStore(setup.home.paths).load()).actions[0].mutationStartedAt).toBeDefined();
      },
    });
    setup = await fixture(provider);

    const first = await runXReplyTest('https://x.com/alice/status/123?s=20', true, setup.dependencies);
    const second = await runXReplyTest('https://x.com/alice/status/123', true, setup.dependencies);

    expect(first).toMatchObject({ status: 'sent', replyTweetId: '9001' });
    expect(second).toEqual(first);
    expect(provider.replyOnce).toHaveBeenCalledOnce();
    expect(provider.verifyReply).not.toHaveBeenCalled();
    await expect(access(setup.home.paths.daemonLockFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps an ambiguous result unknown and never writes again', async () => {
    const provider = replyProvider('unknown');
    const setup = await fixture(provider);
    expect(await runXReplyTest('https://x.com/alice/status/123', true, setup.dependencies)).toMatchObject({
      status: 'unknown',
    });
    expect(await runXReplyTest('https://x.com/alice/status/123', true, setup.dependencies)).toMatchObject({
      status: 'unknown',
    });
    expect(provider.replyOnce).toHaveBeenCalledOnce();
    expect(provider.verifyReply).toHaveBeenCalledOnce();
  });

  it('revokes the transport when write-relevant configuration changes at the mutation boundary', async () => {
    const transport = vi.fn();
    const provider = replyProvider('sent', { afterStart: transport });
    const home = await createTemporaryHome();
    homes.push(home);
    const initial = config();
    let reads = 0;
    const dependencies: TestCommandDependencies = {
      env: { CRR_LIVE_X: '1' },
      paths: home.paths,
      now: () => new Date('2026-08-28T01:00:00.000Z'),
      loadConfiguration: async () => {
        reads += 1;
        return reads === 1 ? structuredClone(initial) : config({ maxAttemptsPer24Hours: 0 });
      },
      createPostReader: async () => postReader(),
      createReplyProvider: () => provider,
    };

    const result = await runXReplyTest('https://x.com/alice/status/123', true, dependencies);
    expect(result).toMatchObject({ status: 'definitive-failure', safeCode: 'write-authorization-revoked' });
    expect(transport).not.toHaveBeenCalled();
    expect((await new StateStore(home.paths).load()).actions[0].mutationStartedAt).toBeUndefined();
  });

  it('honors the singleton lock and rolling write guard before any new mutation', async () => {
    const locked = await fixture();
    const held = await acquireSingleInstanceLock(locked.home.paths.daemonLockFile);
    try {
      await expect(runXReplyTest('https://x.com/alice/status/123', true, locked.dependencies)).rejects.toThrow(
        /already running|already held/,
      );
      expect(locked.dependencies.createPostReader).not.toHaveBeenCalled();
    } finally {
      await held.release();
    }

    const firstProvider = replyProvider();
    const limited = await fixture(firstProvider, {
      loadConfiguration: async () => config({ maxAttemptsPer24Hours: 1 }),
    });
    await runXReplyTest('https://x.com/alice/status/123', true, limited.dependencies);
    const secondProvider = replyProvider();
    limited.dependencies.createPostReader = async () => postReader({ postId: '124' });
    limited.dependencies.createReplyProvider = () => secondProvider;
    await expect(runXReplyTest('https://x.com/alice/status/124', true, limited.dependencies)).rejects.toThrow(
      /rolling-24-hour-limit/,
    );
    expect(secondProvider.replyOnce).not.toHaveBeenCalled();
  });
});

describe('test CLI surface', () => {
  it('registers only trigger, x-read, and the doubly gated x-reply surface', () => {
    const test = createResetRequestProgram().commands.find((command) => command.name() === 'test');
    expect(test?.commands.map((command) => command.name())).toEqual(['trigger', 'x-read', 'x-reply']);
    const reply = test?.commands.find((command) => command.name() === 'x-reply');
    expect(reply?.options.map((option) => option.long)).toEqual(['--url', '--live']);
    expect(reply?.options.some((option) => /auth|token|ct0|cookie/i.test(option.long ?? ''))).toBe(false);
  });
});
