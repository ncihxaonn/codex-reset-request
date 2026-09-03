import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTweetsFromInstructions } from '../../src/lib/twitter-client-utils.js';
import { createDefaultConfig } from '../../src/reset/config/schema.js';
import { BirdXReplyProvider, type BirdProviderDependencies } from '../../src/reset/x/bird-provider.js';

async function timelineTweets() {
  const fixture = JSON.parse(
    await readFile(path.join(process.cwd(), 'tests', 'fixtures', 'x', 'user-timeline-mixed.json'), 'utf8'),
  ) as {
    data: { user: { result: { timeline: { timeline: { instructions: Parameters<typeof parseTweetsFromInstructions>[0] } } } } };
  };
  return parseTweetsFromInstructions(fixture.data.user.result.timeline.timeline.instructions, {
    quoteDepth: 1,
    includeRaw: true,
  });
}

const credentials = {
  cookies: {
    authToken: 'memory-only-auth',
    ct0: 'memory-only-ct0',
    cookieHeader: 'auth_token=memory-only-auth; ct0=memory-only-ct0',
    source: 'test',
  },
  warnings: [],
};

describe('Bird target provider', () => {
  const resolveCredentials = vi.fn();
  const createClient = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    resolveCredentials.mockReset().mockResolvedValue(credentials);
    createClient.mockReset();
  });

  function provider(client: object) {
    createClient.mockReturnValue(client);
    const dependencies: Partial<BirdProviderDependencies> = {
      resolveCredentials,
      createClient,
      now: () => new Date('2026-08-28T10:00:00.000Z'),
    };
    return new BirdXReplyProvider(createDefaultConfig(), dependencies);
  }

  it('selects the newest eligible timeline post and cross-checks search', async () => {
    const tweets = await timelineTweets();
    const searchFixture = JSON.parse(
      await readFile(path.join(process.cwd(), 'tests', 'fixtures', 'x', 'search-match.json'), 'utf8'),
    ) as { tweets: typeof tweets };
    const client = {
      getCurrentUser: vi.fn(),
      getUserIdByUsername: vi.fn().mockResolvedValue({
        success: true,
        userId: '42',
        username: 'thsottiaux',
      }),
      getUserTweetsPaged: vi.fn().mockResolvedValue({ success: true, tweets }),
      search: vi.fn().mockResolvedValue({ success: true, tweets: searchFixture.tweets }),
    };

    const result = await provider(client).findTargetPost({ targetHandle: 'thsottiaux', maxPostAgeHours: 72 });

    expect(result).toMatchObject({
      status: 'found',
      post: { id: '107', selectionEvidence: { source: 'timeline+search' } },
    });
    expect(client.getUserTweetsPaged).toHaveBeenCalledWith('42', 20, {
      includeRaw: true,
      maxPages: 1,
      pageDelayMs: 0,
    });
    expect(client.search).toHaveBeenCalledWith('from:thsottiaux -filter:replies -filter:retweets', 20, {
      includeRaw: true,
    });
  });

  it('continues from strong timeline evidence when search is unavailable', async () => {
    const tweets = await timelineTweets();
    const client = {
      getCurrentUser: vi.fn(),
      getUserIdByUsername: vi.fn().mockResolvedValue({ success: true, userId: '42', username: 'thsottiaux' }),
      getUserTweetsPaged: vi.fn().mockResolvedValue({ success: true, tweets }),
      search: vi.fn().mockResolvedValue({ success: false, error: 'safe fake failure' }),
    };
    expect(await provider(client).findTargetPost({ targetHandle: 'thsottiaux', maxPostAgeHours: 72 })).toMatchObject({
      status: 'found',
      post: { id: '107', selectionEvidence: { source: 'timeline' } },
    });
  });

  it('fails closed when successful search disagrees', async () => {
    const tweets = await timelineTweets();
    const searchFixture = JSON.parse(
      await readFile(path.join(process.cwd(), 'tests', 'fixtures', 'x', 'search-mismatch.json'), 'utf8'),
    ) as { tweets: typeof tweets };
    const client = {
      getCurrentUser: vi.fn(),
      getUserIdByUsername: vi.fn().mockResolvedValue({ success: true, userId: '42', username: 'thsottiaux' }),
      getUserTweetsPaged: vi.fn().mockResolvedValue({ success: true, tweets }),
      search: vi.fn().mockResolvedValue({ success: true, tweets: searchFixture.tweets }),
    };
    expect(await provider(client).findTargetPost({ targetHandle: 'thsottiaux', maxPostAgeHours: 72 })).toEqual({
      status: 'not-found',
      safeCode: 'target-search-mismatch',
    });
  });

  it('maps missing credentials to a stable code without creating a client', async () => {
    resolveCredentials.mockResolvedValue({
      cookies: { authToken: null, ct0: null, cookieHeader: null, source: null },
      warnings: ['secret-bearing warning must not escape'],
    });
    const result = await provider({}).findTargetPost({ targetHandle: 'thsottiaux', maxPostAgeHours: 72 });
    expect(result).toEqual({ status: 'not-found', safeCode: 'credentials-unavailable' });
    expect(createClient).not.toHaveBeenCalled();
  });

  it('rechecks the active account immediately before writing', async () => {
    const mutation = vi.fn();
    const client = {
      getCurrentUser: vi.fn().mockResolvedValue({
        success: true,
        user: { id: '88', username: 'different', name: 'Different' },
      }),
      getUserIdByUsername: vi.fn(),
      getUserTweetsPaged: vi.fn(),
      search: vi.fn(),
      replySingleAttempt: mutation,
    };
    const result = await provider(client).replyOnce({
      targetPost: {
        id: '100',
        authorHandle: 'thsottiaux',
        authorId: '42',
        createdAt: '2026-08-28T09:00:00.000Z',
        url: 'https://x.com/thsottiaux/status/100',
        selectionEvidence: { source: 'timeline', isPinned: false, isRetweet: false, isReply: false },
      },
      text: 'reset',
      attemptId: 'attempt-1',
      expectedXHandle: 'example',
    });
    expect(result).toEqual({ status: 'definitive-failure', safeCode: 'wrong-account' });
    expect(mutation).not.toHaveBeenCalled();
  });

  it('uses the same freshly authenticated client for account check and one mutation', async () => {
    const order: string[] = [];
    const client = {
      getCurrentUser: vi.fn(async () => {
        order.push('account');
        return { success: true, user: { id: '88', username: 'example', name: 'Example' } };
      }),
      getUserIdByUsername: vi.fn(),
      getUserTweetsPaged: vi.fn(),
      search: vi.fn(),
      replySingleAttempt: vi.fn(async (_text, _targetId, options) => {
        await options?.onMutationStart?.();
        order.push('mutation');
        return { status: 'sent' as const, tweetId: '9001' };
      }),
    };
    const result = await provider(client).replyOnce({
      targetPost: {
        id: '100',
        authorHandle: 'thsottiaux',
        authorId: '42',
        createdAt: '2026-08-28T09:00:00.000Z',
        url: 'https://x.com/thsottiaux/status/100',
        selectionEvidence: { source: 'timeline', isPinned: false, isRetweet: false, isReply: false },
      },
      text: 'reset',
      attemptId: 'attempt-1',
      expectedXHandle: 'example',
      onMutationStart: async () => {
        order.push('persisted');
        return { ok: true };
      },
    });
    expect(result).toEqual({
      status: 'sent',
      tweetId: '9001',
      url: 'https://x.com/example/status/9001',
      verifiedBy: 'mutation-response',
    });
    expect(order).toEqual(['account', 'persisted', 'mutation']);
    expect(client.replySingleAttempt).toHaveBeenCalledOnce();
  });
});
