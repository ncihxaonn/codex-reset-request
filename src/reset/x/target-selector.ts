import type { TweetData } from '../../lib/twitter-client-types.js';
import type { TargetPost, TargetPostResult } from './provider.js';

const NUMERIC_ID = /^\d+$/;

interface TargetSelectionInput {
  targetHandle: string;
  targetAuthorId: string;
  maxPostAgeHours: number;
  now?: Date;
}

interface ValidatedTweet {
  tweet: TweetData;
  createdAt: Date;
}

function containsResetReplyInvitation(text: string): boolean {
  if (!/\bcodex\b/i.test(text)) {
    return false;
  }
  const invitation = /\b(?:please\s+)?(?:reply|comment|respond)\b[\s\S]{0,40}\b(?:with\s+)?reset\b/i;
  const negative = /\b(?:do\s+not|don't|dont|never|cannot|can't|cant|no|not|without|avoid(?:\s+using)?|refrain\s+from|anything\s+(?:but|other\s+than)|other\s+than|except)\b/i;
  return invitation.test(text) && !negative.test(text);
}

function validateBaseTweet(tweet: TweetData, input: TargetSelectionInput): ValidatedTweet | null {
  if (!NUMERIC_ID.test(tweet.id) || !NUMERIC_ID.test(input.targetAuthorId)) {
    return null;
  }
  if (tweet.authorId !== input.targetAuthorId) {
    return null;
  }
  if (tweet.author.username.toLowerCase() !== input.targetHandle.toLowerCase()) {
    return null;
  }
  if (!containsResetReplyInvitation(tweet.text)) {
    return null;
  }
  if (!tweet.createdAt) {
    return null;
  }
  const createdAt = new Date(tweet.createdAt);
  if (!Number.isFinite(createdAt.getTime())) {
    return null;
  }
  const now = input.now ?? new Date();
  const ageMs = now.getTime() - createdAt.getTime();
  if (ageMs < 0 || ageMs > input.maxPostAgeHours * 60 * 60 * 1_000) {
    return null;
  }
  return { tweet, createdAt };
}

function latest(tweets: ValidatedTweet[]): ValidatedTweet | null {
  return (
    tweets.sort((left, right) => {
      const timeDifference = right.createdAt.getTime() - left.createdAt.getTime();
      if (timeDifference !== 0) {
        return timeDifference;
      }
      const rightId = BigInt(right.tweet.id);
      const leftId = BigInt(left.tweet.id);
      return rightId === leftId ? 0 : rightId > leftId ? 1 : -1;
    })[0] ?? null
  );
}

export function selectTargetPost(tweets: TweetData[], input: TargetSelectionInput): TargetPostResult {
  const eligible: ValidatedTweet[] = [];
  let hasAmbiguousMetadata = false;

  for (const tweet of tweets) {
    const validated = validateBaseTweet(tweet, input);
    if (!validated) {
      continue;
    }
    if (
      typeof tweet.isPinned !== 'boolean' ||
      typeof tweet.isRetweet !== 'boolean' ||
      typeof tweet.isReply !== 'boolean'
    ) {
      hasAmbiguousMetadata = true;
      continue;
    }
    if (tweet.isPinned || tweet.isRetweet || tweet.isReply) {
      continue;
    }
    eligible.push(validated);
  }

  if (hasAmbiguousMetadata) {
    return { status: 'not-found', safeCode: 'target-metadata-ambiguous' };
  }
  const selected = latest(eligible);
  if (!selected) {
    return { status: 'not-found', safeCode: 'target-no-eligible-post' };
  }

  const canonicalHandle = input.targetHandle.toLowerCase();
  const post: TargetPost = {
    id: selected.tweet.id,
    authorHandle: canonicalHandle,
    authorId: input.targetAuthorId,
    createdAt: selected.createdAt.toISOString(),
    url: `https://x.com/${canonicalHandle}/status/${selected.tweet.id}`,
    selectionEvidence: {
      source: 'timeline',
      isPinned: false,
      isRetweet: false,
      isReply: false,
    },
  };
  return { status: 'found', post };
}

export function crossCheckTargetPost(
  post: TargetPost,
  searchTweets: TweetData[],
  input: TargetSelectionInput,
): TargetPostResult {
  const candidates: ValidatedTweet[] = [];
  let ambiguous = false;
  for (const tweet of searchTweets) {
    const validated = validateBaseTweet(tweet, input);
    if (!validated) {
      continue;
    }
    if (typeof tweet.isRetweet !== 'boolean' || typeof tweet.isReply !== 'boolean') {
      ambiguous = true;
      continue;
    }
    if (!tweet.isRetweet && !tweet.isReply) {
      candidates.push(validated);
    }
  }
  if (ambiguous) {
    return { status: 'not-found', safeCode: 'target-search-ambiguous' };
  }
  const searchLatest = latest(candidates);
  if (!searchLatest || searchLatest.tweet.id !== post.id) {
    return { status: 'not-found', safeCode: 'target-search-mismatch' };
  }
  return {
    status: 'found',
    post: {
      ...post,
      selectionEvidence: {
        source: 'timeline+search',
        isPinned: false,
        isRetweet: false,
        isReply: false,
      },
    },
  };
}
