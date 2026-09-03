import {
  resolveBrowserFirstCredentials,
  type CookieExtractionResult,
} from '../../lib/cookies.js';
import { normalizeHandle } from '../../lib/normalize-handle.js';
import { TwitterClient } from '../../lib/twitter-client.js';
import type {
  CurrentUserResult,
  SearchResult,
  TweetMutationAttemptOptions,
  TweetMutationAttemptResult,
  TweetMutationStartResult,
  TwitterClientOptions,
} from '../../lib/twitter-client-types.js';
import type { UserLookupResult } from '../../lib/twitter-client-user-lookup.js';
import type { UserTweetsPaginationOptions } from '../../lib/twitter-client-user-tweets.js';
import type { ResetRequestConfig } from '../config/schema.js';
import type {
  TargetPostResult,
  XAccountResult,
  XProviderDoctorResult,
  XReplyProvider,
  XWriteResult,
  ReplyVerificationResult,
  TargetPost,
} from './provider.js';
import { verifyReplyCandidates } from './reply-verifier.js';
import { crossCheckTargetPost, selectTargetPost } from './target-selector.js';

interface BirdReadClient {
  getCurrentUser(): Promise<CurrentUserResult>;
  getUserIdByUsername(username: string): Promise<UserLookupResult>;
  getUserTweetsPaged(userId: string, limit: number, options?: UserTweetsPaginationOptions): Promise<SearchResult>;
  search(query: string, count?: number, options?: { includeRaw?: boolean }): Promise<SearchResult>;
  replySingleAttempt(
    text: string,
    replyToTweetId: string,
    options?: TweetMutationAttemptOptions,
  ): Promise<TweetMutationAttemptResult>;
}

export interface BirdProviderDependencies {
  resolveCredentials(options: {
    cookieSource?: 'auto' | 'safari' | 'chrome' | 'firefox';
    chromeProfile?: string;
    firefoxProfile?: string;
  }): Promise<CookieExtractionResult>;
  createClient(options: TwitterClientOptions): BirdReadClient;
  now(): Date;
}

const DEFAULT_DEPENDENCIES: BirdProviderDependencies = {
  resolveCredentials: resolveBrowserFirstCredentials,
  createClient: (options) => new TwitterClient(options),
  now: () => new Date(),
};

export class BirdXReplyProvider implements XReplyProvider {
  private readonly config: ResetRequestConfig;
  private readonly dependencies: BirdProviderDependencies;

  constructor(config: ResetRequestConfig, dependencies: Partial<BirdProviderDependencies> = {}) {
    this.config = config;
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  }

  private async client(): Promise<BirdReadClient | null> {
    const result = await this.dependencies.resolveCredentials({
      cookieSource: this.config.cookieSource,
      chromeProfile: this.config.chromeProfile ?? undefined,
      firefoxProfile: this.config.firefoxProfile ?? undefined,
    });
    if (!result.cookies.authToken || !result.cookies.ct0) {
      return null;
    }
    return this.dependencies.createClient({ cookies: result.cookies, timeoutMs: 10_000, quoteDepth: 1 });
  }

  async getCurrentAccount(): Promise<XAccountResult> {
    const client = await this.client();
    if (!client) {
      return { ok: false, safeCode: 'credentials-unavailable' };
    }
    const current = await client.getCurrentUser();
    if (!current.success || !current.user || !/^\d+$/.test(current.user.id)) {
      return { ok: false, safeCode: 'account-unavailable' };
    }
    const handle = normalizeHandle(current.user.username);
    if (!handle) {
      return { ok: false, safeCode: 'account-unavailable' };
    }
    return { ok: true, id: current.user.id, handle: handle.toLowerCase() };
  }

  async doctor(): Promise<XProviderDoctorResult> {
    const account = await this.getCurrentAccount();
    if (!account.ok) {
      return { ok: false, safeCode: account.safeCode };
    }
    return {
      ok: true,
      safeCode: 'x-provider-ready',
      account: { id: account.id, handle: account.handle },
    };
  }

  async findTargetPost(input: { targetHandle: string; maxPostAgeHours: number }): Promise<TargetPostResult> {
    const targetHandle = normalizeHandle(input.targetHandle);
    if (!targetHandle) {
      return { status: 'not-found', safeCode: 'target-user-unavailable' };
    }
    const client = await this.client();
    if (!client) {
      return { status: 'not-found', safeCode: 'credentials-unavailable' };
    }

    const user = await client.getUserIdByUsername(targetHandle);
    if (
      !user.success ||
      !user.userId ||
      !/^\d+$/.test(user.userId) ||
      !user.username ||
      user.username.toLowerCase() !== targetHandle.toLowerCase()
    ) {
      return { status: 'not-found', safeCode: 'target-user-unavailable' };
    }

    const timeline = await client.getUserTweetsPaged(user.userId, 20, {
      includeRaw: true,
      maxPages: 1,
      pageDelayMs: 0,
    });
    if (!timeline.success) {
      return { status: 'not-found', safeCode: 'target-timeline-unavailable' };
    }
    const selected = selectTargetPost(timeline.tweets, {
      targetHandle,
      targetAuthorId: user.userId,
      maxPostAgeHours: input.maxPostAgeHours,
      now: this.dependencies.now(),
    });
    if (selected.status !== 'found') {
      return selected;
    }

    const search = await client.search(`from:${targetHandle} -filter:replies -filter:retweets`, 20, {
      includeRaw: true,
    });
    if (!search.success) {
      return selected;
    }
    return crossCheckTargetPost(selected.post, search.tweets, {
      targetHandle,
      targetAuthorId: user.userId,
      maxPostAgeHours: input.maxPostAgeHours,
      now: this.dependencies.now(),
    });
  }

  async replyOnce(input: {
    targetPost: TargetPost;
    text: string;
    attemptId: string;
    expectedXHandle: string;
    onMutationStart?(): Promise<TweetMutationStartResult>;
  }): Promise<XWriteResult> {
    void input.attemptId;
    let client: BirdReadClient | null;
    try {
      client = await this.client();
    } catch {
      return { status: 'definitive-failure', safeCode: 'credentials-unavailable' };
    }
    if (!client) {
      return { status: 'definitive-failure', safeCode: 'credentials-unavailable' };
    }
    let current: CurrentUserResult;
    try {
      current = await client.getCurrentUser();
    } catch {
      return { status: 'definitive-failure', safeCode: 'account-unavailable' };
    }
    const currentHandle = current.user ? normalizeHandle(current.user.username) : null;
    if (
      !current.success ||
      !current.user ||
      !currentHandle ||
      currentHandle.toLowerCase() !== input.expectedXHandle.toLowerCase()
    ) {
      return { status: 'definitive-failure', safeCode: 'wrong-account' };
    }

    let result: TweetMutationAttemptResult;
    try {
      result = await client.replySingleAttempt(input.text, input.targetPost.id, {
        onMutationStart: input.onMutationStart,
      });
    } catch {
      return { status: 'unknown', safeCode: 'write-provider-threw', targetPostUrl: input.targetPost.url };
    }
    if (result.status === 'sent') {
      return {
        status: 'sent',
        tweetId: result.tweetId,
        url: `https://x.com/${currentHandle.toLowerCase()}/status/${result.tweetId}`,
        verifiedBy: 'mutation-response',
      };
    }
    if (result.status === 'definitive-failure') {
      return {
        status: 'definitive-failure',
        safeCode: result.safeCode,
        httpStatus: result.httpStatus,
      };
    }
    return { status: 'unknown', safeCode: result.safeCode, targetPostUrl: input.targetPost.url };
  }

  async verifyReply(input: {
    targetPostId: string;
    replyText: string;
    attemptStartedAt: Date;
  }): Promise<ReplyVerificationResult> {
    const client = await this.client();
    if (!client || !this.config.expectedXHandle) {
      return { status: 'not-verified', safeCode: 'verification-unavailable' };
    }
    try {
      const current = await client.getCurrentUser();
      const currentHandle = current.user ? normalizeHandle(current.user.username) : null;
      if (
        !current.success ||
        !current.user ||
        !currentHandle ||
        currentHandle.toLowerCase() !== this.config.expectedXHandle.toLowerCase()
      ) {
        return { status: 'not-verified', safeCode: 'verification-unavailable' };
      }
      const timeline = await client.getUserTweetsPaged(current.user.id, 20, {
        includeRaw: false,
        maxPages: 1,
        pageDelayMs: 0,
      });
      if (!timeline.success) {
        return { status: 'not-verified', safeCode: 'verification-unavailable' };
      }
      return verifyReplyCandidates(timeline.tweets, {
        currentAccountId: current.user.id,
        currentAccountHandle: currentHandle,
        targetPostId: input.targetPostId,
        replyText: input.replyText,
        attemptStartedAt: input.attemptStartedAt,
      });
    } catch {
      return { status: 'not-verified', safeCode: 'verification-unavailable' };
    }
  }
}
