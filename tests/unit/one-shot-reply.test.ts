import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TwitterClient } from '../../src/lib/twitter-client.js';

function client(timeoutMs?: number): TwitterClient {
  return new TwitterClient({
    cookies: {
      authToken: 'test-auth',
      ct0: 'test-ct0',
      cookieHeader: 'auth_token=test-auth; ct0=test-ct0',
      source: 'test',
    },
    timeoutMs,
  });
}

const originalNodeEnvironment = process.env.NODE_ENV;

beforeEach(() => {
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalNodeEnvironment === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnvironment;
  }
});

describe('Bird one-shot reply mutation', () => {
  it.each([
    [
      'direct result',
      { data: { create_tweet: { tweet_results: { result: { rest_id: '9001' } } } } },
      '9001',
    ],
    [
      'visibility wrapper',
      { data: { create_tweet: { tweet_results: { result: { tweet: { rest_id: '9002' } } } } } },
      '9002',
    ],
  ])('accepts a numeric ID at the exact %s path', async (_label, responseBody, tweetId) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(responseBody), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await client().replySingleAttempt('reset', '100')).toEqual({ status: 'sent', tweetId });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    [401, 'write-http-rejected'],
    [403, 'write-http-rejected'],
    [404, 'write-query-rejected'],
    [422, 'write-http-rejected'],
    [429, 'write-http-rejected'],
  ])('classifies an explicit HTTP %i rejection without retry', async (status, safeCode) => {
    const fetchMock = vi.fn(async () => new Response('rejected-canary', { status }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await client().replySingleAttempt('reset', '100')).toEqual({
      status: 'definitive-failure',
      safeCode,
      httpStatus: status,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([500, 502, 503])('classifies HTTP %i as unknown without retry', async (status) => {
    const fetchMock = vi.fn(async () => new Response('server-canary', { status }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await client().replySingleAttempt('reset', '100')).toEqual({
      status: 'unknown',
      safeCode: 'write-server-ambiguous',
      httpStatus: status,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('classifies a transport failure as unknown without retry', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('connection reset canary');
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await client().replySingleAttempt('reset', '100')).toEqual({
      status: 'unknown',
      safeCode: 'write-transport-ambiguous',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing ID', JSON.stringify({ data: { create_tweet: { tweet_results: { result: {} } } } }), 'write-id-missing'],
    ['malformed JSON', '{not-json', 'write-response-unparseable'],
  ])('classifies a 2xx %s as unknown', async (_label, body, safeCode) => {
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await client().replySingleAttempt('reset', '100')).toEqual({
      status: 'unknown',
      safeCode,
      httpStatus: 200,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not invoke the legacy fallback for GraphQL code 226', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) =>
      new Response(JSON.stringify({ errors: [{ code: 226, message: 'automation canary' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(await client().replySingleAttempt('reset', '100')).toEqual({
      status: 'definitive-failure',
      safeCode: 'write-automation-restricted',
      httpStatus: 200,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/CreateTweet');
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('statuses/update');
  });

  it('accepts an explicit created ID before considering partial GraphQL errors', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: { create_tweet: { tweet_results: { result: { rest_id: '9001' } } } },
          errors: [{ code: 131, message: 'partial resolver error' }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await client().replySingleAttempt('reset', '100')).toEqual({ status: 'sent', tweetId: '9001' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps an unrecognized GraphQL error ambiguous and never falls back', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ errors: [{ code: 131, message: 'internal error' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await client().replySingleAttempt('reset', '100')).toEqual({
      status: 'unknown',
      safeCode: 'write-graphql-ambiguous',
      httpStatus: 200,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not follow a redirect that could replay the POST', async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 307, headers: { location: 'https://x.com/other-write' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await client().replySingleAttempt('reset', '100')).toEqual({
      status: 'unknown',
      safeCode: 'write-redirect-ambiguous',
      httpStatus: 307,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects invalid input before any mutation request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await client().replySingleAttempt('', 'not-an-id')).toEqual({
      status: 'definitive-failure',
      safeCode: 'invalid-write-input',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('persists the mutation marker immediately before the sole write request', async () => {
    const order: string[] = [];
    const fetchMock = vi.fn(async () => {
      order.push('mutation');
      return new Response(
        JSON.stringify({ data: { create_tweet: { tweet_results: { result: { rest_id: '9001' } } } } }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await client().replySingleAttempt('reset', '100', {
        onMutationStart: async () => {
          order.push('persisted');
          return { ok: true };
        },
      }),
    ).toMatchObject({ status: 'sent' });
    expect(order).toEqual(['persisted', 'mutation']);
  });

  it('does not start the mutation when persistence of the write marker fails', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await client().replySingleAttempt('reset', '100', {
        onMutationStart: async () => {
          throw new Error('synthetic persistence failure');
        },
      }),
    ).toEqual({ status: 'definitive-failure', safeCode: 'write-state-persistence-failed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not start the mutation when final write authorization is revoked', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await client().replySingleAttempt('reset', '100', {
        onMutationStart: async () => ({ ok: false, safeCode: 'write-authorization-revoked' }),
      }),
    ).toEqual({ status: 'definitive-failure', safeCode: 'write-authorization-revoked' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('waits for an in-flight persistence hook after timeout and still performs no request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const gate: { resolve?: (value: { ok: true }) => void } = {};
    let hookStarted = false;
    let settled = false;
    const outcome = client(20)
      .replySingleAttempt('reset', '100', {
        onMutationStart: async () => {
          hookStarted = true;
          return await new Promise<{ ok: true }>((resolve) => {
            gate.resolve = resolve;
          });
        },
      })
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(hookStarted).toBe(true));
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    gate.resolve?.({ ok: true });
    expect(await outcome).toEqual({ status: 'unknown', safeCode: 'write-transport-ambiguous' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bounds a stalled mutation response body and leaves the result unknown', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"data":'));
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await client(20).replySingleAttempt('reset', '100')).toEqual({
      status: 'unknown',
      safeCode: 'write-body-timeout',
      httpStatus: 200,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects an oversized mutation response body without unbounded buffering', async () => {
    const fetchMock = vi.fn(async () => new Response('x'.repeat(1_048_577), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await client().replySingleAttempt('reset', '100')).toEqual({
      status: 'unknown',
      safeCode: 'write-response-too-large',
      httpStatus: 200,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
