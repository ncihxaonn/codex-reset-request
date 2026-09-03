import { describe, expect, it } from 'vitest';
import type { TweetData } from '../../src/lib/twitter-client-types.js';
import { crossCheckTargetPost, selectTargetPost } from '../../src/reset/x/target-selector.js';

const now = new Date('2026-08-28T10:00:00.000Z');
const input = { targetHandle: 'thsottiaux', targetAuthorId: '42', maxPostAgeHours: 72, now };

function tweet(fields: Partial<TweetData> = {}): TweetData {
  return {
    id: '100',
    text: 'Codex users can reply reset here',
    author: { username: 'thsottiaux', name: 'Tibo' },
    authorId: '42',
    createdAt: '2026-08-28T09:00:00.000Z',
    isPinned: false,
    isRetweet: false,
    isReply: false,
    isQuote: false,
    ...fields,
  };
}

describe('target-post selector', () => {
  it('sorts by creation time and allows an original quote tweet', () => {
    const result = selectTargetPost(
      [tweet({ id: '100' }), tweet({ id: '101', createdAt: '2026-08-28T09:30:00.000Z', isQuote: true })],
      input,
    );
    expect(result).toEqual({
      status: 'found',
      post: {
        id: '101',
        authorHandle: 'thsottiaux',
        authorId: '42',
        createdAt: '2026-08-28T09:30:00.000Z',
        url: 'https://x.com/thsottiaux/status/101',
        selectionEvidence: {
          source: 'timeline',
          isPinned: false,
          isRetweet: false,
          isReply: false,
        },
      },
    });
  });

  it.each([
    ['pinned', { isPinned: true }],
    ['retweet', { isRetweet: true }],
    ['reply', { isReply: true, inReplyToStatusId: '7' }],
    ['wrong author id', { authorId: '99' }],
    ['wrong author handle', { author: { username: 'other', name: 'Other' } }],
    ['old post', { createdAt: '2026-08-20T09:00:00.000Z' }],
    ['future post', { createdAt: '2026-08-29T09:00:00.000Z' }],
    ['invalid id', { id: 'not-numeric' }],
    ['invalid timestamp', { createdAt: 'not-a-date' }],
    ['unrelated post', { text: 'A completely unrelated announcement' }],
    ['negated invitation', { text: 'Codex users: do not reply reset to this post' }],
    ['qualified negation', { text: 'Codex: do not, under any circumstances, reply with reset' }],
    ['post-action negation', { text: 'Codex users should reply with anything but reset' }],
    ['contracted post-action negation', { text: "Codex users: reply, but don't use reset" }],
    ['alternative negation', { text: 'Codex users: reply with anything other than reset' }],
    ['leading no', { text: 'Codex users: no reply with reset' }],
    ['trailing no', { text: 'Codex users: reply with reset? No.' }],
  ] as const)('rejects a %s', (_label, fields) => {
    expect(selectTargetPost([tweet(fields)], input)).toEqual({
      status: 'not-found',
      safeCode: 'target-no-eligible-post',
    });
  });

  it.each([{ isPinned: null }, { isRetweet: null }, { isReply: undefined }])(
    'fails closed for uncertain structural metadata: %j',
    (fields) => {
      expect(selectTargetPost([tweet(fields)], input)).toEqual({
        status: 'not-found',
        safeCode: 'target-metadata-ambiguous',
      });
    },
  );

  it('fails closed when timeline and search choose different latest originals', () => {
    const selected = selectTargetPost([tweet({ id: '100' })], input);
    expect(selected.status).toBe('found');
    if (selected.status === 'found') {
      expect(crossCheckTargetPost(selected.post, [tweet({ id: '101' })], input)).toEqual({
        status: 'not-found',
        safeCode: 'target-search-mismatch',
      });
    }
  });

  it('records agreement when timeline and search match', () => {
    const selected = selectTargetPost([tweet({ id: '100' })], input);
    expect(selected.status).toBe('found');
    if (selected.status === 'found') {
      expect(crossCheckTargetPost(selected.post, [tweet({ id: '100' })], input)).toMatchObject({
        status: 'found',
        post: { id: '100', selectionEvidence: { source: 'timeline+search' } },
      });
    }
  });
});
