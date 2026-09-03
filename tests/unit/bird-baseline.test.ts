import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getCookiesMock = vi.hoisted(() => vi.fn());
const transactionIdMock = vi.hoisted(() => vi.fn());
const queryIdGetMock = vi.hoisted(() => vi.fn(async () => null));
const queryIdRefreshMock = vi.hoisted(() => vi.fn(async () => null));

vi.mock('@steipete/sweet-cookie', () => ({ getCookies: getCookiesMock }));
vi.mock('x-client-transaction-id', () => ({
  ClientTransaction: {
    create: vi.fn(async () => ({ generateTransactionId: transactionIdMock })),
  },
  handleXMigration: vi.fn(async () => ({})),
}));
vi.mock('../../src/lib/runtime-query-ids.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/runtime-query-ids.js')>();
  return {
    ...actual,
    runtimeQueryIds: {
      getQueryId: queryIdGetMock,
      refresh: queryIdRefreshMock,
    },
  };
});

import { resolveBrowserFirstCredentials, resolveCredentials } from '../../src/lib/cookies.js';
import type { CliContext } from '../../src/cli/shared.js';
import { registerCheckCommand } from '../../src/commands/check.js';
import { createRuntimeQueryIdStore } from '../../src/lib/runtime-query-ids.js';
import { TwitterClientBase } from '../../src/lib/twitter-client-base.js';
import { TwitterClient } from '../../src/lib/twitter-client.js';
import { parseTweetsFromInstructions } from '../../src/lib/twitter-client-utils.js';
import type { CurrentUserResult, GraphqlTweetResult, TwitterClientOptions } from '../../src/lib/twitter-client-types.js';

const originalEnvironment = {
  AUTH_TOKEN: process.env.AUTH_TOKEN,
  TWITTER_AUTH_TOKEN: process.env.TWITTER_AUTH_TOKEN,
  CT0: process.env.CT0,
  TWITTER_CT0: process.env.TWITTER_CT0,
  NODE_ENV: process.env.NODE_ENV,
};

function restoreEnvironment(): void {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

function clearCredentialEnvironment(): void {
  delete process.env.AUTH_TOKEN;
  delete process.env.TWITTER_AUTH_TOKEN;
  delete process.env.CT0;
  delete process.env.TWITTER_CT0;
}

function client(): TwitterClient {
  return new TwitterClient({
    cookies: {
      authToken: 'test-auth-token',
      ct0: 'test-ct0',
      cookieHeader: 'auth_token=test-auth-token; ct0=test-ct0',
      source: 'test',
    },
  });
}

function tweetResult(id: string, text = 'hello'): GraphqlTweetResult {
  return {
    __typename: 'Tweet',
    rest_id: id,
    legacy: {
      full_text: text,
      created_at: 'Thu Aug 27 10:00:00 +0000 2026',
      conversation_id_str: id,
    },
    core: {
      user_results: {
        result: {
          rest_id: '42',
          legacy: { screen_name: 'thsottiaux', name: 'Tibo' },
        },
      },
    },
  };
}

function timelinePayload(id: string): Record<string, unknown> {
  return {
    data: {
      user: {
        result: {
          timeline: {
            timeline: {
              instructions: [
                {
                  type: 'TimelineAddEntries',
                  entries: [
                    {
                      entryId: `tweet-${id}`,
                      content: { itemContent: { tweet_results: { result: tweetResult(id) } } },
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    },
  };
}

function searchPayload(id: string): Record<string, unknown> {
  return {
    data: {
      search_by_raw_query: {
        search_timeline: {
          timeline: {
            instructions: [
              {
                entries: [
                  {
                    content: { itemContent: { tweet_results: { result: tweetResult(id) } } },
                  },
                ],
              },
            ],
          },
        },
      },
    },
  };
}

beforeEach(() => {
  clearCredentialEnvironment();
  process.env.NODE_ENV = 'test';
  vi.restoreAllMocks();
  getCookiesMock.mockReset();
  transactionIdMock.mockReset();
  queryIdGetMock.mockReset().mockResolvedValue(null);
  queryIdRefreshMock.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  restoreEnvironment();
});

describe('Bird credential resolution baseline', () => {
  it('reports credential presence without printing token prefixes', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
      output.push(values.map(String).join(' '));
    });
    const program = new Command();
    registerCheckCommand(
      program,
      {
        p: () => '',
        l: () => '',
        resolveCredentialsFromOptions: async () => ({
          cookies: {
            authToken: 'do-not-print-auth-token',
            ct0: 'do-not-print-csrf-token',
            cookieHeader: null,
            source: 'synthetic test',
          },
          warnings: [],
        }),
      } as unknown as CliContext,
    );

    await program.parseAsync(['node', 'bird', 'check']);

    expect(output.join('\n')).toContain('auth_token: available (value hidden)');
    expect(output.join('\n')).toContain('ct0: available (value hidden)');
    expect(output.join('\n')).not.toContain('do-not-print');
  });

  it('tries browser sources in order and keeps cookie values in memory', async () => {
    getCookiesMock
      .mockResolvedValueOnce({ cookies: [], warnings: [] })
      .mockResolvedValueOnce({
        cookies: [
          { name: 'auth_token', value: 'browser-auth', domain: '.x.com' },
          { name: 'ct0', value: 'browser-ct0', domain: '.x.com' },
        ],
        warnings: [],
      });

    const result = await resolveCredentials({ cookieSource: ['safari', 'chrome'] });

    expect(result.cookies).toMatchObject({
      authToken: 'browser-auth',
      ct0: 'browser-ct0',
      source: 'Chrome default profile',
    });
    expect(getCookiesMock.mock.calls.map(([input]) => input.browsers)).toEqual([['safari'], ['chrome']]);
  });

  it('documents the upstream environment-before-browser priority', async () => {
    process.env.AUTH_TOKEN = 'env-auth';
    process.env.CT0 = 'env-ct0';

    const result = await resolveCredentials({ cookieSource: 'safari' });

    expect(result.cookies.source).toBe('env AUTH_TOKEN');
    expect(getCookiesMock).not.toHaveBeenCalled();
  });

  it('uses browser-first credential priority for reset automation', async () => {
    process.env.AUTH_TOKEN = 'environment-auth';
    process.env.CT0 = 'environment-ct0';
    getCookiesMock.mockResolvedValue({
      cookies: [
        { name: 'auth_token', value: 'browser-auth', domain: '.x.com' },
        { name: 'ct0', value: 'browser-ct0', domain: '.x.com' },
      ],
      warnings: [],
    });

    const result = await resolveBrowserFirstCredentials({ cookieSource: 'safari' });

    expect(result.cookies).toMatchObject({ authToken: 'browser-auth', ct0: 'browser-ct0', source: 'Safari' });
    expect(getCookiesMock).toHaveBeenCalledOnce();
  });
});

describe('Bird read and write baseline', () => {
  it('parses a top-level verify-credentials user ID', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ id_str: '88', screen_name: 'example', name: 'Example' }), { status: 200 }),
      ),
    );
    expect(await client().getCurrentUser()).toEqual({
      success: true,
      user: { id: '88', username: 'example', name: 'Example' },
    });
  });

  it('looks up a user through the GraphQL result shape', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            user: {
              result: {
                __typename: 'User',
                rest_id: '42',
                legacy: { screen_name: 'thsottiaux', name: 'Tibo' },
              },
            },
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await client().getUserIdByUsername('@thsottiaux');

    expect(result).toEqual({ success: true, userId: '42', username: 'thsottiaux', name: 'Tibo' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('parses a user timeline page and preserves raw tweet data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(timelinePayload('100')), { status: 200 })));

    const result = await client().getUserTweetsPaged('42', 1, { includeRaw: true, maxPages: 1, pageDelayMs: 0 });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.tweets[0]).toMatchObject({ id: '100', authorId: '42', author: { username: 'thsottiaux' } });
      expect(result.tweets[0]._raw?.rest_id).toBe('100');
    }
  });

  it('preserves pinned, retweet, reply, quote, wrapper, and entry metadata', async () => {
    const payload = JSON.parse(
      await readFile(path.join(process.cwd(), 'tests', 'fixtures', 'x', 'user-timeline-mixed.json'), 'utf8'),
    ) as {
      data: {
        user: {
          result: { timeline: { timeline: { instructions: Parameters<typeof parseTweetsFromInstructions>[0] } } };
        };
      };
    };

    const tweets = parseTweetsFromInstructions(payload.data.user.result.timeline.timeline.instructions, {
      quoteDepth: 1,
      includeRaw: true,
    });

    expect(tweets.find((tweet) => tweet.id === '110')).toMatchObject({
      isPinned: true,
      sourceInstructionType: 'TimelinePinEntry',
    });
    expect(tweets.find((tweet) => tweet.id === '109')).toMatchObject({ isRetweet: true });
    expect(tweets.find((tweet) => tweet.id === '108')).toMatchObject({ isReply: true });
    expect(tweets.find((tweet) => tweet.id === '107')).toMatchObject({ isQuote: true, isRetweet: false });
    expect(tweets.find((tweet) => tweet.id === '106')).toMatchObject({
      tweetWrapperTypename: 'TweetWithVisibilityResults',
      tweetResultTypename: 'Tweet',
      isPinned: false,
      isRetweet: false,
    });
  });

  it('parses latest-search results', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(searchPayload('101')), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await client().search('from:thsottiaux -filter:replies -filter:retweets', 1);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.tweets.map((tweet) => tweet.id)).toEqual(['101']);
    }
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST');
  });

  it('returns the explicit tweet ID from a successful reply mutation', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({ data: { create_tweet: { tweet_results: { result: { rest_id: '9001' } } } } }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await client().reply('reset', '100');

    expect(result).toEqual({ success: true, tweetId: '9001' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.method).toBe('POST');
    expect(JSON.parse(String(request.body))).toMatchObject({
      variables: { tweet_text: 'reset', reply: { in_reply_to_tweet_id: '100' } },
    });
  });
});

describe('Bird transaction and query ID baseline', () => {
  it('binds one generated transaction ID to the actual request URL path', async () => {
    process.env.NODE_ENV = 'production';
    transactionIdMock.mockResolvedValue('url-bound-transaction');
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    class ExposedClient extends TwitterClientBase {
      protected async getCurrentUser(): Promise<CurrentUserResult> {
        return { success: false };
      }

      async post(url: string): Promise<Record<string, string>> {
        const headers = this.getHeaders();
        await this.fetchWithTimeout(url, { method: 'POST', headers });
        return headers;
      }
    }

    const options: TwitterClientOptions = {
      cookies: {
        authToken: 'test-auth-token',
        ct0: 'test-ct0',
        cookieHeader: null,
        source: 'test',
      },
    };
    const headers = await new ExposedClient(options).post('https://x.com/i/api/graphql/query/CreateTweet');

    expect(transactionIdMock).toHaveBeenCalledOnce();
    expect(transactionIdMock).toHaveBeenCalledWith('POST', '/i/api/graphql/query/CreateTweet');
    expect(headers['x-client-transaction-id']).toBe('url-bound-transaction');
  });

  it('runs final write authorization after async transaction preparation and immediately before fetch', async () => {
    process.env.NODE_ENV = 'production';
    const transactionGate: { release?: (value: string) => void } = {};
    transactionIdMock.mockImplementation(
      async () =>
        await new Promise<string>((resolve) => {
          transactionGate.release = resolve;
        }),
    );
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    let autoEnabled = true;
    let authorizationChecks = 0;

    class ExposedClient extends TwitterClientBase {
      protected async getCurrentUser(): Promise<CurrentUserResult> {
        return { success: false };
      }

      async guardedPost(url: string): Promise<void> {
        await this.fetchWithTimeout(url, { method: 'POST', headers: this.getHeaders() }, async () => {
          authorizationChecks += 1;
          if (!autoEnabled) {
            throw new Error('authorization revoked');
          }
        });
      }
    }

    const options: TwitterClientOptions = {
      cookies: { authToken: 'test-auth-token', ct0: 'test-ct0', cookieHeader: null, source: 'test' },
    };
    const outcome = new ExposedClient(options)
      .guardedPost('https://x.com/i/api/graphql/query/CreateTweet')
      .then(
        () => null,
        (error: unknown) => error,
      );
    await vi.waitFor(() => expect(transactionIdMock).toHaveBeenCalledOnce());
    expect(authorizationChecks).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    autoEnabled = false;
    transactionGate.release?.('prepared-transaction');
    expect(await outcome).toBeInstanceOf(Error);
    expect(authorizationChecks).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('discovers, caches, and reloads a runtime query ID', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'bird-query-ids-'));
    const cachePath = path.join(temporaryDirectory, 'query-ids.json');
    const bundleUrl = 'https://abs.twimg.com/responsive-web/client-web/main.abc123.js';
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === bundleUrl) {
        return new Response('e.exports={queryId:"fresh-id",operationName:"CreateTweet"}', { status: 200 });
      }
      return new Response(`<script src="${bundleUrl}"></script>`, { status: 200 });
    }) as typeof fetch;

    try {
      const store = createRuntimeQueryIdStore({ cachePath, fetchImpl, ttlMs: 60_000 });
      await store.refresh(['CreateTweet'], { force: true });

      expect(await store.getQueryId('CreateTweet')).toBe('fresh-id');
      expect(JSON.parse(await readFile(cachePath, 'utf8')).ids).toEqual({ CreateTweet: 'fresh-id' });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
