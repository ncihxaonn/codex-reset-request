import { describe, expect, it } from 'vitest';
import type { TweetData } from '../../src/lib/twitter-client-types.js';
import { verifyReplyCandidates } from '../../src/reset/x/reply-verifier.js';

const attemptStartedAt = new Date('2026-08-28T10:00:00.000Z');
const input = {
  currentAccountId: '88',
  currentAccountHandle: 'example',
  targetPostId: '100',
  replyText: 'reset',
  attemptStartedAt,
};

function reply(fields: Partial<TweetData> = {}): TweetData {
  return {
    id: '9001',
    text: 'reset',
    author: { username: 'example', name: 'Example' },
    authorId: '88',
    createdAt: '2026-08-28T10:01:00.000Z',
    inReplyToStatusId: '100',
    ...fields,
  };
}

describe('read-after-write verification', () => {
  it('verifies exactly one structural match', () => {
    expect(verifyReplyCandidates([reply()], input)).toEqual({
      status: 'verified',
      tweetId: '9001',
      url: 'https://x.com/example/status/9001',
    });
  });

  it('leaves multiple matches unknown', () => {
    expect(verifyReplyCandidates([reply(), reply({ id: '9002' })], input)).toEqual({
      status: 'not-verified',
      safeCode: 'multiple-matches',
    });
  });

  it.each([
    { text: 'Reset' },
    { inReplyToStatusId: '101' },
    { authorId: '89' },
    { createdAt: '2026-08-28T09:59:59.000Z' },
    { createdAt: '2026-08-28T10:16:00.000Z' },
    { id: 'not-numeric' },
  ])('rejects a nonmatching candidate: %j', (fields) => {
    expect(verifyReplyCandidates([reply(fields)], input)).toEqual({
      status: 'not-verified',
      safeCode: 'no-match',
    });
  });
});
