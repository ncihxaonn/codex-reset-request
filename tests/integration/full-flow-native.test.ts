import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { TwitterClient } from '../../src/lib/twitter-client.js';
import type { TweetData } from '../../src/lib/twitter-client-types.js';
import { readConfiguredCodexRateLimits } from '../../src/reset/codex/app-server-client.js';
import type { UsageLimitCandidate } from '../../src/reset/codex/rollout-types.js';
import { CURRENT_DISCLAIMER_VERSION, createDefaultConfig } from '../../src/reset/config/schema.js';
import { ActionPipeline, type PipelineResult } from '../../src/reset/pipeline/action-pipeline.js';
import { StateStore } from '../../src/reset/state/store.js';
import { CodexSessionWatcher } from '../../src/reset/watcher/codex-session-watcher.js';
import { BirdXReplyProvider, type BirdProviderDependencies } from '../../src/reset/x/bird-provider.js';
import { createFakeAppServer } from '../helpers/fake-app-server.js';
import { canSkipNativeWatcherFailure, withNativeWatcherDeadline } from '../helpers/native-watcher.js';
import { createTemporaryHome, type TemporaryHome } from '../helpers/temporary-home.js';

const homes: TemporaryHome[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(homes.splice(0).map((home) => home.cleanup()));
});

it('runs native append through confirmation and exactly one guarded Bird mutation', async (context) => {
  const home = await createTemporaryHome();
  homes.push(home);
  const sessionsDirectory = path.join(home.root, 'codex', 'sessions');
  const dateDirectory = path.join(sessionsDirectory, '2026', '08', '28');
  await mkdir(dateDirectory, { recursive: true });
  const rolloutFile = path.join(dateDirectory, 'rollout-full-flow.jsonl');
  await writeFile(rolloutFile, '', 'utf8');

  const now = new Date('2026-08-28T12:00:00.000Z');
  const fakeAppServer = createFakeAppServer(home.root, {
    codexHome: path.join(home.root, 'codex'),
    rateResult: {
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 100, resetsAt: Math.floor(now.getTime() / 1_000) + 3_600 },
        secondary: null,
        rateLimitReachedType: null,
      },
      rateLimitsByLimitId: null,
    },
  });
  const config = createDefaultConfig();
  config.codexHome = path.join(home.root, 'codex');
  config.mode = 'auto';
  config.expectedXHandle = 'example';
  config.consent = {
    automaticPostingAccepted: true,
    disclaimerVersion: CURRENT_DISCLAIMER_VERSION,
    acceptedAt: now.toISOString(),
  };
  const store = new StateStore(home.paths);
  const targetTweet: TweetData = {
    id: '100',
    text: 'Codex users can reply reset here',
    author: { username: 'thsottiaux', name: 'Tibo' },
    authorId: '42',
    createdAt: '2026-08-28T11:00:00.000Z',
    isPinned: false,
    isRetweet: false,
    isReply: false,
  };
  const realClient = new TwitterClient({
    cookies: {
      authToken: 'memory-only-auth',
      ct0: 'memory-only-ct0',
      cookieHeader: 'auth_token=memory-only-auth; ct0=memory-only-ct0',
      source: 'test',
    },
    timeoutMs: 1_000,
  });
  const birdClient = {
    getCurrentUser: vi.fn(async () => ({
      success: true as const,
      user: { id: '7', username: 'example', name: 'Example' },
    })),
    getUserIdByUsername: vi.fn(async () => ({
      success: true as const,
      userId: '42',
      username: 'thsottiaux',
    })),
    getUserTweetsPaged: vi.fn(async () => ({ success: true as const, tweets: [targetTweet] })),
    search: vi.fn(async () => ({ success: false as const, error: 'synthetic search unavailable' })),
    replySingleAttempt: realClient.replySingleAttempt.bind(realClient),
  };
  const provider = new BirdXReplyProvider(config, {
    resolveCredentials: async () => ({
      cookies: {
        authToken: 'memory-only-auth',
        ct0: 'memory-only-ct0',
        cookieHeader: 'auth_token=memory-only-auth; ct0=memory-only-ct0',
        source: 'test',
      },
      warnings: [],
    }),
    createClient: () => birdClient,
    now: () => now,
  } satisfies Partial<BirdProviderDependencies>);
  const mutationFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    expect(init?.method).toBe('POST');
    expect(await store.load()).toMatchObject({
      actions: [{ status: 'attempting', mutationStartedAt: now.toISOString() }],
    });
    return new Response(
      JSON.stringify({ data: { create_tweet: { tweet_results: { result: { rest_id: '9001' } } } } }),
      { status: 200 },
    );
  });
  vi.stubGlobal('fetch', mutationFetch);
  const pipeline = new ActionPipeline(store, {
    loadConfiguration: async () => structuredClone(config),
    readRateLimits: async (runtimeConfig) =>
      await readConfiguredCodexRateLimits(runtimeConfig, {
        process: fakeAppServer.process,
        timeoutMs: 4_000,
      }),
    createProvider: () => provider,
    audit: async () => undefined,
    now: () => now,
    resolveCodexHome: () => path.join(home.root, 'codex'),
  });

  const results: PipelineResult[] = [];
  let resolveResult: ((result: PipelineResult) => void) | null = null;
  let rejectResult: ((error: Error) => void) | null = null;
  const nextResult = () =>
    new Promise<PipelineResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
  let resultPromise = nextResult();
  void resultPromise.catch(() => undefined);
  let fatalError: Error | null = null;
  const watcher = new CodexSessionWatcher({
    sessionsDirectory,
    paths: home.paths,
    async onReady() {
      await pipeline.stateMachine.recoverStaleAttempts();
    },
    async onCandidate(candidate: UsageLimitCandidate) {
      const result = await pipeline.handleCandidate(candidate);
      results.push(result);
      resolveResult?.(result);
    },
    onFatal(error) {
      fatalError = error;
      rejectResult?.(error);
    },
  });

  try {
    await watcher.start();
    expect(await fakeAppServer.readRequests()).toEqual([]);
    expect(birdClient.getUserIdByUsername).not.toHaveBeenCalled();
    expect(mutationFetch).not.toHaveBeenCalled();

    const fixture = await readFile(
      path.join(process.cwd(), 'tests', 'fixtures', 'codex', 'structured-usage-limit.jsonl'),
      'utf8',
    );
    await writeFile(path.join(dateDirectory, 'rollout-second-session.jsonl'), fixture, 'utf8');
    expect(await withNativeWatcherDeadline(resultPromise, 'first action')).toMatchObject({ status: 'sent' });
    expect(mutationFetch).toHaveBeenCalledOnce();
    expect(birdClient.getUserIdByUsername).toHaveBeenCalledOnce();
    expect(birdClient.getCurrentUser).toHaveBeenCalledTimes(2);
    expect((await store.load()).actions[0]).toMatchObject({ status: 'sent', replyTweetId: '9001' });
    expect((await fakeAppServer.readRequests()).map((request) => request.method)).toEqual([
      'initialize',
      'initialized',
      'account/rateLimits/read',
    ]);

    resultPromise = nextResult();
    void resultPromise.catch(() => undefined);
    await appendFile(rolloutFile, fixture, 'utf8');
    expect(await withNativeWatcherDeadline(resultPromise, 'same-window guard')).toMatchObject({
      status: 'rate-guarded',
      safeCode: 'same-limit-window',
    });
    expect(mutationFetch).toHaveBeenCalledOnce();
    expect(results).toHaveLength(2);
    expect(fatalError).toBeNull();
  } catch (error) {
    if (canSkipNativeWatcherFailure(error)) {
      context.skip('host sandbox does not permit native filesystem watchers');
      return;
    }
    throw error;
  } finally {
    await watcher.stop();
  }
});
