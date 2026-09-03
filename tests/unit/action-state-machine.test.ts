import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionStateMachine, type ExecuteReplyInput } from '../../src/reset/pipeline/action-state-machine.js';
import type { ActionRecord } from '../../src/reset/state/schema.js';
import { StateStore } from '../../src/reset/state/store.js';
import type { XReplyProvider } from '../../src/reset/x/provider.js';
import { createTemporaryHome, type TemporaryHome } from '../helpers/temporary-home.js';

const homes: TemporaryHome[] = [];
const targetPost = {
  id: '100',
  authorHandle: 'thsottiaux',
  authorId: '42',
  createdAt: '2026-08-28T09:00:00.000Z',
  url: 'https://x.com/thsottiaux/status/100',
  selectionEvidence: {
    source: 'timeline' as const,
    isPinned: false as const,
    isRetweet: false as const,
    isReply: false as const,
  },
};

async function fixture() {
  const home = await createTemporaryHome();
  homes.push(home);
  const store = new StateStore(home.paths);
  const times = [
    new Date('2026-08-28T10:00:00.000Z'),
    new Date('2026-08-28T10:00:01.000Z'),
    new Date('2026-08-28T10:00:02.000Z'),
    new Date('2026-08-28T10:00:03.000Z'),
  ];
  const machine = new ActionStateMachine(store, { now: () => times.shift() ?? new Date('2026-08-28T10:00:04.000Z') });
  return { home, store, machine };
}

function provider(overrides: Partial<XReplyProvider> = {}): XReplyProvider {
  return {
    doctor: vi.fn(),
    getCurrentAccount: vi.fn(),
    findTargetPost: vi.fn(),
    replyOnce: vi.fn(async (input) => {
      await input.onMutationStart?.();
      return {
        status: 'sent' as const,
        tweetId: '9001',
        url: 'https://x.com/example/status/9001',
        verifiedBy: 'mutation-response' as const,
      };
    }),
    verifyReply: vi.fn(),
    ...overrides,
  };
}

function input(replyProvider: XReplyProvider): ExecuteReplyInput {
  return {
    actionId: 'action-1',
    eventFingerprint: 'a'.repeat(64),
    limitWindowKey: 'b'.repeat(64),
    actionKey: 'c'.repeat(64),
    detectedAt: '2026-08-28T09:59:00.000Z',
    targetHandle: 'thsottiaux',
    targetPost,
    replyText: 'reset',
    expectedXHandle: 'example',
    provider: replyProvider,
  };
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => home.cleanup()));
});

describe('one-shot action state machine', () => {
  it('persists attempting before the one mutation and then records sent', async () => {
    const { store, machine } = await fixture();
    const write = vi.fn(async (writeInput: Parameters<XReplyProvider['replyOnce']>[0]) => {
      const beforeMutation = (await store.load()).actions[0];
      expect(beforeMutation).toMatchObject({ status: 'attempting', targetPostId: '100' });
      expect(beforeMutation.mutationStartedAt).toBeUndefined();
      expect(JSON.stringify(beforeMutation)).not.toContain('reset');
      await writeInput.onMutationStart?.();
      expect((await store.load()).actions[0].mutationStartedAt).toBeDefined();
      return {
        status: 'sent' as const,
        tweetId: '9001',
        url: 'https://x.com/example/status/9001',
        verifiedBy: 'mutation-response' as const,
      };
    });
    const replyProvider = provider({ replyOnce: write });

    const result = await machine.execute(input(replyProvider));

    expect(result).toMatchObject({
      status: 'sent',
      replyTweetId: '9001',
      verifiedBy: 'mutation-response',
    });
    expect(write).toHaveBeenCalledOnce();
    expect(replyProvider.verifyReply).not.toHaveBeenCalled();
  });

  it('serializes concurrent claims for one action so only one mutation can start', async () => {
    const { machine } = await fixture();
    const replyProvider = provider();
    const [first, second] = await Promise.all([
      machine.execute(input(replyProvider)),
      machine.execute(input(replyProvider)),
    ]);
    expect(first.status).toBe('sent');
    expect(second.status).toBe('sent');
    expect(replyProvider.replyOnce).toHaveBeenCalledOnce();
  });

  it('persists unknown before one read-only verification and can verify sent', async () => {
    const { store, machine } = await fixture();
    const replyProvider = provider({
      replyOnce: vi.fn(async (writeInput) => {
        await writeInput.onMutationStart?.();
        return { status: 'unknown' as const, safeCode: 'write-timeout', targetPostUrl: targetPost.url };
      }),
      verifyReply: vi.fn(async () => {
        expect((await store.load()).actions[0].status).toBe('unknown');
        return {
          status: 'verified' as const,
          tweetId: '9001',
          url: 'https://x.com/example/status/9001',
        };
      }),
    });

    const result = await machine.execute(input(replyProvider));

    expect(result).toMatchObject({ status: 'sent', verifiedBy: 'read-after-write' });
    expect(replyProvider.replyOnce).toHaveBeenCalledOnce();
    expect(replyProvider.verifyReply).toHaveBeenCalledOnce();
  });

  it('keeps zero or multiple verification matches unknown and never writes again', async () => {
    const { machine } = await fixture();
    const replyProvider = provider({
      replyOnce: vi.fn(async (writeInput) => {
        await writeInput.onMutationStart?.();
        return { status: 'unknown' as const, safeCode: 'write-timeout', targetPostUrl: targetPost.url };
      }),
      verifyReply: vi.fn(async () => ({ status: 'not-verified' as const, safeCode: 'multiple-matches' as const })),
    });

    expect(await machine.execute(input(replyProvider))).toMatchObject({ status: 'unknown' });
    expect(await machine.execute(input(replyProvider))).toMatchObject({ status: 'unknown' });
    expect(replyProvider.replyOnce).toHaveBeenCalledOnce();
    expect(replyProvider.verifyReply).toHaveBeenCalledOnce();
  });

  it('does not verify or retry a definitive failure', async () => {
    const { machine } = await fixture();
    const replyProvider = provider({
      replyOnce: vi.fn(async () => ({ status: 'definitive-failure' as const, safeCode: 'wrong-account' })),
    });
    expect(await machine.execute(input(replyProvider))).toMatchObject({
      status: 'definitive-failure',
      safeCode: 'wrong-account',
    });
    expect(replyProvider.replyOnce).toHaveBeenCalledOnce();
    expect(replyProvider.verifyReply).not.toHaveBeenCalled();
  });

  it('converts stale attempting to unknown without any provider call', async () => {
    const { store, machine } = await fixture();
    const stale: ActionRecord = {
      actionId: 'action-1',
      eventFingerprint: 'a'.repeat(64),
      limitWindowKey: 'b'.repeat(64),
      actionKey: 'c'.repeat(64),
      detectedAt: '2026-08-28T09:59:00.000Z',
      status: 'attempting',
      targetHandle: 'thsottiaux',
      targetPostId: '100',
      targetPostUrl: targetPost.url,
      replyTextHash: 'd'.repeat(64),
      attemptStartedAt: '2026-08-28T10:00:00.000Z',
    };
    await store.save({ version: 1, updatedAt: stale.detectedAt, actions: [stale] });
    const replyProvider = provider();

    expect(await machine.execute(input(replyProvider))).toMatchObject({
      status: 'unknown',
      safeCode: 'restart-ambiguous',
    });
    expect(replyProvider.replyOnce).not.toHaveBeenCalled();
    expect(replyProvider.verifyReply).not.toHaveBeenCalled();
  });

  it('recovers all stale attempts under a supervisor-held startup hook', async () => {
    const { store, machine } = await fixture();
    const seed = input(provider());
    await store.save({
      version: 1,
      updatedAt: seed.detectedAt,
      actions: [
        {
          actionId: seed.actionId,
          eventFingerprint: seed.eventFingerprint,
          limitWindowKey: seed.limitWindowKey,
          actionKey: seed.actionKey,
          detectedAt: seed.detectedAt,
          status: 'attempting',
          targetHandle: seed.targetHandle,
          targetPostId: targetPost.id,
          targetPostUrl: targetPost.url,
          replyTextHash: 'd'.repeat(64),
          attemptStartedAt: seed.detectedAt,
        },
      ],
    });
    expect(await machine.recoverStaleAttempts()).toBe(1);
    expect((await store.load()).actions[0]).toMatchObject({ status: 'unknown', safeCode: 'restart-ambiguous' });
  });
});
