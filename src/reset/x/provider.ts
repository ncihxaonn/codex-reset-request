import type { TweetData, TweetMutationStartResult } from '../../lib/twitter-client-types.js';
import type { XWriteResult } from './write-result.js';
export type { XWriteResult } from './write-result.js';

export interface ResetCandidateTweet extends TweetData {
  sourceEntryId?: string;
  isPinned: boolean | null;
  isRetweet: boolean | null;
  isReply: boolean;
  isQuote: boolean;
}

export interface TargetPost {
  id: string;
  authorHandle: string;
  authorId: string;
  createdAt: string;
  url: string;
  selectionEvidence:
    | {
        source: 'timeline' | 'timeline+search';
        isPinned: false;
        isRetweet: false;
        isReply: false;
      }
    | {
        source: 'manual-live-test';
        ownershipVerified: true;
      };
}

export type TargetPostResult =
  | { status: 'found'; post: TargetPost }
  | {
      status: 'not-found';
      safeCode:
        | 'credentials-unavailable'
        | 'target-user-unavailable'
        | 'target-timeline-unavailable'
        | 'target-metadata-ambiguous'
        | 'target-no-eligible-post'
        | 'target-search-ambiguous'
        | 'target-search-mismatch';
    };

export type XAccountResult =
  | { ok: true; id: string; handle: string }
  | { ok: false; safeCode: 'credentials-unavailable' | 'account-unavailable' };

export interface XProviderDoctorResult {
  ok: boolean;
  safeCode: 'x-provider-ready' | 'credentials-unavailable' | 'account-unavailable';
  account?: { id: string; handle: string };
}

export type ReplyVerificationResult =
  | { status: 'verified'; tweetId: string; url: string }
  | { status: 'not-verified'; safeCode: 'no-match' | 'multiple-matches' | 'verification-unavailable' };

export interface XTargetReader {
  doctor(): Promise<XProviderDoctorResult>;
  getCurrentAccount(): Promise<XAccountResult>;
  findTargetPost(input: { targetHandle: string; maxPostAgeHours: number }): Promise<TargetPostResult>;
}

export interface XReplyProvider extends XTargetReader {
  replyOnce(input: {
    targetPost: TargetPost;
    text: string;
    attemptId: string;
    expectedXHandle: string;
    onMutationStart?(): Promise<TweetMutationStartResult>;
  }): Promise<XWriteResult>;
  verifyReply(input: {
    targetPostId: string;
    replyText: string;
    attemptStartedAt: Date;
  }): Promise<ReplyVerificationResult>;
}
