import type { Command } from 'commander';
import { resolveBrowserFirstCredentials } from '../../lib/cookies.js';
import { normalizeHandle } from '../../lib/normalize-handle.js';
import { TwitterClient } from '../../lib/twitter-client.js';
import type {
  CurrentUserResult,
  GetTweetResult,
} from '../../lib/twitter-client-types.js';
import { extractUsageLimitCandidate } from '../codex/rollout-classifier.js';
import { loadConfig } from '../config/load.js';
import { getAppPaths, type ResetRequestPaths } from '../config/paths.js';
import type { ResetRequestConfig } from '../config/schema.js';
import { ActionStateMachine } from '../pipeline/action-state-machine.js';
import { createActionId, createActionKey } from '../pipeline/fingerprints.js';
import { evaluateActionRateGuard, evaluatePreTargetRateGuard } from '../pipeline/rate-guard.js';
import { acquireSingleInstanceLock, type SingleInstanceLock } from '../state/lock.js';
import type { ActionRecord } from '../state/schema.js';
import { StateStore } from '../state/store.js';
import { sha256 } from '../utils/hash.js';
import { BirdXReplyProvider } from '../x/bird-provider.js';
import type { TargetPost, XReplyProvider, XTargetReader } from '../x/provider.js';

const LIVE_ENVIRONMENT_VARIABLE = 'CRR_LIVE_X';
const PROTECTED_TEST_TARGET = 'thsottiaux';

export interface ParsedOwnedPostUrl {
  handle: string;
  postId: string;
  canonicalUrl: string;
}

interface LiveTestPostReader {
  getCurrentUser(): Promise<CurrentUserResult>;
  getTweet(tweetId: string): Promise<GetTweetResult>;
}

export interface TestCommandDependencies {
  env?: NodeJS.ProcessEnv;
  paths?: ResetRequestPaths;
  now?(): Date;
  loadConfiguration?(): Promise<ResetRequestConfig>;
  createTargetReader?(config: ResetRequestConfig): XTargetReader;
  createReplyProvider?(config: ResetRequestConfig): XReplyProvider;
  createPostReader?(config: ResetRequestConfig): Promise<LiveTestPostReader>;
  createStateStore?(paths: ResetRequestPaths): StateStore;
  acquireLock?(lockPath: string): Promise<SingleInstanceLock>;
}

function dependenciesFrom(partial: TestCommandDependencies): Required<TestCommandDependencies> {
  const paths = partial.paths ?? getAppPaths();
  return {
    env: partial.env ?? process.env,
    paths,
    now: partial.now ?? (() => new Date()),
    loadConfiguration: partial.loadConfiguration ?? (async () => await loadConfig(paths)),
    createTargetReader: partial.createTargetReader ?? ((config) => new BirdXReplyProvider(config)),
    createReplyProvider: partial.createReplyProvider ?? ((config) => new BirdXReplyProvider(config)),
    createPostReader:
      partial.createPostReader ??
      (async (config) => {
        const credentials = await resolveBrowserFirstCredentials({
          cookieSource: config.cookieSource,
          chromeProfile: config.chromeProfile ?? undefined,
          firefoxProfile: config.firefoxProfile ?? undefined,
        });
        if (!credentials.cookies.authToken || !credentials.cookies.ct0) {
          throw new Error('X browser-session credentials are unavailable');
        }
        return new TwitterClient({ cookies: credentials.cookies, timeoutMs: 10_000, quoteDepth: 1 });
      }),
    createStateStore: partial.createStateStore ?? ((resolvedPaths) => new StateStore(resolvedPaths)),
    acquireLock: partial.acquireLock ?? acquireSingleInstanceLock,
  };
}

export function assertLiveXTestEnabled(env: NodeJS.ProcessEnv, liveFlagRequired: boolean, live: boolean): void {
  if (env.CI) {
    throw new Error('Live X tests are disabled in CI');
  }
  if (env[LIVE_ENVIRONMENT_VARIABLE] !== '1') {
    throw new Error(`Set ${LIVE_ENVIRONMENT_VARIABLE}=1 to enable a live X test`);
  }
  if (liveFlagRequired && !live) {
    throw new Error('The live reply test also requires --live');
  }
}

export function parseOwnedPostUrl(value: string): ParsedOwnedPostUrl {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Expected an HTTPS X status URL for a user-owned test post');
  }
  const hostname = parsed.hostname.toLowerCase();
  const allowedHost = ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(hostname);
  if (
    parsed.protocol !== 'https:' ||
    !allowedHost ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== ''
  ) {
    throw new Error('Expected an HTTPS x.com or twitter.com status URL without credentials or a port');
  }
  const match = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?$/.exec(parsed.pathname);
  const handle = normalizeHandle(match?.[1]);
  const postId = match?.[2];
  if (!handle || !postId) {
    throw new Error('Expected a canonical /<handle>/status/<numeric-id> URL');
  }
  return {
    handle: handle.toLowerCase(),
    postId,
    canonicalUrl: `https://x.com/${handle.toLowerCase()}/status/${postId}`,
  };
}

export function runSyntheticTriggerTest(now: Date = new Date()): Record<string, unknown> {
  const candidate = extractUsageLimitCandidate(
    {
      type: 'event_msg',
      payload: { type: 'error', codex_error_info: 'UsageLimitExceeded' },
    },
    {
      safeFileName: 'synthetic-diagnostic.jsonl',
      fileIdentity: 'synthetic-diagnostic',
      byteOffset: 0,
      observedAt: now,
    },
  );
  if (!candidate) {
    throw new Error('Synthetic trigger classifier self-test failed');
  }
  return {
    ok: true,
    code: 'synthetic-trigger-detected',
    synthetic: true,
    mode: 'dry-run',
    normalizedErrorType: candidate.normalizedErrorType,
    networkRequests: 0,
    mutationAttempts: 0,
    stateWritten: false,
    notice: 'Synthetic diagnostic only; no Codex or X action occurred.',
  };
}

export async function runXReadTest(
  partial: TestCommandDependencies = {},
): Promise<{ code: string; currentAccount: string; targetHandle: string; targetPostUrl: string }> {
  const dependencies = dependenciesFrom(partial);
  assertLiveXTestEnabled(dependencies.env, false, false);
  const config = await dependencies.loadConfiguration();
  const reader = dependencies.createTargetReader(config);
  const account = await reader.getCurrentAccount();
  if (!account.ok) {
    throw new Error(`X account read failed (${account.safeCode})`);
  }
  const target = await reader.findTargetPost({
    targetHandle: PROTECTED_TEST_TARGET,
    maxPostAgeHours: config.maxPostAgeHours,
  });
  if (target.status !== 'found') {
    throw new Error(`X target read failed (${target.safeCode})`);
  }
  return {
    code: 'x-read-ok',
    currentAccount: `@${account.handle}`,
    targetHandle: `@${PROTECTED_TEST_TARGET}`,
    targetPostUrl: target.post.url,
  };
}

function validatedCurrentAccount(current: CurrentUserResult, expectedHandle: string | null): { id: string; handle: string } {
  const handle = normalizeHandle(current.user?.username)?.toLowerCase() ?? null;
  if (!current.success || !current.user || !/^\d+$/.test(current.user.id) || !handle) {
    throw new Error('Current X account metadata is unavailable');
  }
  if (!expectedHandle || handle !== expectedHandle.toLowerCase()) {
    throw new Error('Current X account does not match the account recorded by setup');
  }
  return { id: current.user.id, handle };
}

function manualWriteInputs(config: ResetRequestConfig): Record<string, unknown> {
  return {
    expectedXHandle: config.expectedXHandle,
    replyText: config.replyText,
    cookieSource: config.cookieSource,
    chromeProfile: config.chromeProfile,
    firefoxProfile: config.firefoxProfile,
    maxAttemptsPer24Hours: config.maxAttemptsPer24Hours,
  };
}

function manualWriteInputsEqual(
  current: ResetRequestConfig,
  initial: Record<string, unknown>,
): boolean {
  const currentInputs = manualWriteInputs(current);
  return Object.keys(initial).every((key) => currentInputs[key] === initial[key]);
}

function validateOwnedPost(
  result: GetTweetResult,
  parsed: ParsedOwnedPostUrl,
  current: { id: string; handle: string },
): TargetPost {
  const authorHandle = normalizeHandle(result.tweet?.author.username)?.toLowerCase() ?? null;
  if (
    !result.success ||
    !result.tweet ||
    result.tweet.id !== parsed.postId ||
    result.tweet.authorId !== current.id ||
    authorHandle !== current.handle ||
    parsed.handle !== current.handle
  ) {
    throw new Error('The supplied post is not verifiably owned by the current X account');
  }
  if (authorHandle === PROTECTED_TEST_TARGET) {
    throw new Error('Live tests must never reply to @thsottiaux');
  }
  return {
    id: parsed.postId,
    authorHandle,
    authorId: current.id,
    createdAt: result.tweet.createdAt ?? new Date(0).toISOString(),
    url: parsed.canonicalUrl,
    selectionEvidence: { source: 'manual-live-test', ownershipVerified: true },
  };
}

export async function runXReplyTest(
  url: string,
  live: boolean,
  partial: TestCommandDependencies = {},
): Promise<ActionRecord> {
  const dependencies = dependenciesFrom(partial);
  assertLiveXTestEnabled(dependencies.env, true, live);
  const parsed = parseOwnedPostUrl(url);
  if (parsed.handle === PROTECTED_TEST_TARGET) {
    throw new Error('Live tests must never reply to @thsottiaux');
  }

  const config = await dependencies.loadConfiguration();
  const initialWriteInputs = manualWriteInputs(config);
  const lock = await dependencies.acquireLock(dependencies.paths.daemonLockFile);
  try {
    const postReader = await dependencies.createPostReader(config);
    const current = validatedCurrentAccount(await postReader.getCurrentUser(), config.expectedXHandle);
    const targetPost = validateOwnedPost(await postReader.getTweet(parsed.postId), parsed, current);
    const eventFingerprint = sha256('manual-live-test-event', parsed.canonicalUrl, config.replyText);
    const actionId = createActionId(eventFingerprint);
    const limitWindowKey = sha256('manual-live-test-window', parsed.canonicalUrl);
    const actionKey = createActionKey(limitWindowKey, parsed.postId, config.replyText);
    const store = dependencies.createStateStore(dependencies.paths);
    const state = await store.load();
    if (!state.actions.some((action) => action.actionId === actionId)) {
      const preTargetGuard = evaluatePreTargetRateGuard({
        state,
        actionId,
        limitWindowKey,
        configuredMaximum: config.maxAttemptsPer24Hours,
        now: dependencies.now(),
      });
      if (!preTargetGuard.allowed) {
        throw new Error(`Live reply test blocked (${preTargetGuard.safeCode})`);
      }
      const actionGuard = evaluateActionRateGuard({
        state,
        actionId,
        actionKey,
        attemptsIn24Hours: preTargetGuard.attemptsIn24Hours,
      });
      if (!actionGuard.allowed) {
        throw new Error(`Live reply test blocked (${actionGuard.safeCode})`);
      }
    }

    const provider = dependencies.createReplyProvider(config);
    const machine = new ActionStateMachine(store, { now: dependencies.now });
    return await machine.execute({
      actionId,
      eventFingerprint,
      limitWindowKey,
      actionKey,
      detectedAt: dependencies.now().toISOString(),
      targetHandle: current.handle,
      targetPost,
      replyText: config.replyText,
      expectedXHandle: current.handle,
      provider,
      authorizeMutation: async () => {
        if (dependencies.env.CI || dependencies.env[LIVE_ENVIRONMENT_VARIABLE] !== '1' || !live) {
          return false;
        }
        const currentConfig = await dependencies.loadConfiguration();
        return manualWriteInputsEqual(currentConfig, initialWriteInputs);
      },
    });
  } finally {
    await lock.release();
  }
}

export function registerTestCommand(program: Command): void {
  const test = program.command('test').description('Run explicitly gated diagnostics');
  test
    .command('trigger')
    .description('Run a synthetic local classifier rehearsal with no network or state writes')
    .action(() => {
      console.log(JSON.stringify(runSyntheticTriggerTest(), null, 2));
    });
  test
    .command('x-read')
    .description('Run an explicitly enabled, read-only X integration test')
    .action(async () => {
      console.log(JSON.stringify(await runXReadTest(), null, 2));
    });
  test
    .command('x-reply')
    .description('Send one guarded reply to a post owned by the current X account')
    .requiredOption('--url <url>', 'HTTPS URL of a user-owned X test post')
    .option('--live', 'Acknowledge that this command performs one real X write')
    .action(async (options: { url: string; live?: boolean }) => {
      const result = await runXReplyTest(options.url, options.live === true);
      console.log(
        JSON.stringify(
          {
            code: `x-reply-${result.status}`,
            actionId: result.actionId,
            status: result.status,
            replyUrl: result.replyUrl,
            safeCode: result.safeCode,
          },
          null,
          2,
        ),
      );
      if (result.status !== 'sent') {
        process.exitCode = 1;
      }
    });
}
