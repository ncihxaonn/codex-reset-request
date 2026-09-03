import { describe, expect, it } from 'vitest';
import {
  confirmRateLimit,
  parseRateLimitsResponse,
  type RateLimitSnapshot,
} from '../../src/reset/codex/rate-limit-confirmation.js';

const now = new Date('2026-08-28T00:00:00.000Z');
const future = Math.floor(now.getTime() / 1_000) + 3_600;
const past = Math.floor(now.getTime() / 1_000) - 1;

function snapshot(input: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot {
  return {
    limitId: null,
    primary: null,
    secondary: null,
    rateLimitReachedType: null,
    ...input,
  };
}

describe('Codex rate-limit confirmation', () => {
  it('rejects a reached-type response without a saturated reset window', () => {
    const response = parseRateLimitsResponse({
      rateLimits: snapshot({ rateLimitReachedType: 'workspace_member_usage_limit_reached' }),
    });
    expect(confirmRateLimit(response, now)).toMatchObject({ confirmed: false, safeCode: 'not-reached' });
  });

  it('retains a future reset boundary for reached-type window identity', () => {
    const response = parseRateLimitsResponse({
      rateLimits: snapshot({
        rateLimitReachedType: 'rate_limit_reached',
        primary: { usedPercent: 10, resetsAt: future - 1_800 },
        secondary: { usedPercent: 100, resetsAt: future },
      }),
    });
    expect(confirmRateLimit(response, now)).toMatchObject({
      confirmed: true,
      reason: 'window',
      matchedWindow: 'secondary',
      resetsAt: future,
    });
  });

  it('uses the primary reset boundary when both visible windows are saturated', () => {
    const response = parseRateLimitsResponse({
      rateLimits: snapshot({
        rateLimitReachedType: 'rate_limit_reached',
        primary: { usedPercent: 100, resetsAt: future },
        secondary: { usedPercent: 100, resetsAt: future + 3_600 },
      }),
    });
    expect(confirmRateLimit(response, now)).toMatchObject({
      confirmed: true,
      reason: 'window',
      matchedWindow: 'primary',
      resetsAt: future,
    });
  });

  it.each([
    ['primary', { primary: { usedPercent: 100, resetsAt: future } }],
    ['secondary', { secondary: { usedPercent: 101, resetsAt: future } }],
  ] as const)('confirms a saturated future %s window', (matchedWindow, fields) => {
    const response = parseRateLimitsResponse({ rateLimits: snapshot(fields) });
    expect(confirmRateLimit(response, now)).toMatchObject({
      confirmed: true,
      reason: 'window',
      matchedWindow,
      resetsAt: future,
    });
  });

  it.each([
    { usedPercent: 99, resetsAt: future },
    { usedPercent: 100, resetsAt: past },
    { usedPercent: 100, resetsAt: Math.floor(now.getTime() / 1_000) },
    { usedPercent: 100, resetsAt: null },
  ])('does not confirm an incomplete or expired window: %j', (primary) => {
    const response = parseRateLimitsResponse({ rateLimits: snapshot({ primary }) });
    expect(confirmRateLimit(response, now)).toMatchObject({ confirmed: false, safeCode: 'not-reached' });
  });

  it('prefers a unique Codex bucket even when another bucket is reached', () => {
    const response = parseRateLimitsResponse({
      rateLimits: snapshot({ rateLimitReachedType: 'legacy-reached' }),
      rateLimitsByLimitId: {
        codex: snapshot({ limitId: 'codex' }),
        other: snapshot({ limitId: 'other', rateLimitReachedType: 'rate_limit_reached' }),
      },
    });
    expect(confirmRateLimit(response, now)).toEqual({
      confirmed: false,
      safeCode: 'not-reached',
      bucketKey: 'codex',
      limitId: 'codex',
    });
  });

  it('does not select a reached non-Codex bucket from an ambiguous mapping', () => {
    const response = parseRateLimitsResponse({
      rateLimits: snapshot(),
      rateLimitsByLimitId: {
        alpha: snapshot(),
        beta: snapshot({
          rateLimitReachedType: 'future-reached-type',
          primary: { usedPercent: 100, resetsAt: future },
        }),
      },
    });
    expect(confirmRateLimit(response, now)).toEqual({ confirmed: false, safeCode: 'ambiguous-buckets' });
  });

  it('fails closed for multiple reached buckets without a Codex bucket', () => {
    const response = parseRateLimitsResponse({
      rateLimits: snapshot({ rateLimitReachedType: 'legacy-reached' }),
      rateLimitsByLimitId: {
        alpha: snapshot({ rateLimitReachedType: 'reached-a' }),
        beta: snapshot({ rateLimitReachedType: 'reached-b' }),
      },
    });
    expect(confirmRateLimit(response, now)).toEqual({ confirmed: false, safeCode: 'ambiguous-buckets' });
  });

  it('uses the sole mapped bucket and ignores forward-compatible fields', () => {
    const response = parseRateLimitsResponse({
      rateLimits: snapshot(),
      rateLimitsByLimitId: {
        future: {
          ...snapshot({ rateLimitReachedType: 'rate_limit_reached' }),
          rateLimitResetCredits: 50,
        },
      },
      futureTopLevelField: true,
    });
    expect(confirmRateLimit(response, now)).toMatchObject({ confirmed: false, safeCode: 'not-reached' });
  });

  it.each([
    {},
    { rateLimits: null },
    { rateLimits: snapshot(), rateLimitsByLimitId: { broken: 'not-an-object' } },
    { rateLimits: snapshot({ primary: { usedPercent: '100', resetsAt: future } as never }) },
  ])('rejects malformed response data instead of guessing: %j', (value) => {
    expect(() => parseRateLimitsResponse(value)).toThrow();
  });
});
