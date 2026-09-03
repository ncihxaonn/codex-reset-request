import type { TweetData } from '../../lib/twitter-client-types.js';
import type { ReplyVerificationResult } from './provider.js';

export function verifyReplyCandidates(
  tweets: TweetData[],
  input: {
    currentAccountId: string;
    currentAccountHandle: string;
    targetPostId: string;
    replyText: string;
    attemptStartedAt: Date;
  },
): ReplyVerificationResult {
  const earliest = input.attemptStartedAt.getTime();
  const latest = earliest + 15 * 60 * 1_000;
  const matches = tweets.filter((tweet) => {
    const createdAt = tweet.createdAt ? new Date(tweet.createdAt).getTime() : Number.NaN;
    return (
      /^\d+$/.test(tweet.id) &&
      tweet.inReplyToStatusId === input.targetPostId &&
      tweet.text === input.replyText &&
      tweet.authorId === input.currentAccountId &&
      Number.isFinite(createdAt) &&
      createdAt >= earliest &&
      createdAt <= latest
    );
  });
  if (matches.length !== 1) {
    return { status: 'not-verified', safeCode: matches.length === 0 ? 'no-match' : 'multiple-matches' };
  }
  const match = matches[0];
  return {
    status: 'verified',
    tweetId: match.id,
    url: `https://x.com/${input.currentAccountHandle.toLowerCase()}/status/${match.id}`,
  };
}
