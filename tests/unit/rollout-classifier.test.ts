import { describe, expect, it } from 'vitest';
import { extractUsageLimitCandidate } from '../../src/reset/codex/rollout-classifier.js';
import type { RolloutObservationContext } from '../../src/reset/codex/rollout-types.js';

const context: RolloutObservationContext = {
  safeFileName: 'rollout-safe.jsonl',
  fileIdentity: '1:2',
  byteOffset: 100,
  observedAt: new Date('2026-08-28T00:00:00.000Z'),
};

function classify(record: unknown) {
  return extractUsageLimitCandidate(record, context);
}

describe('strict Codex rollout classifier', () => {
  it.each(['UsageLimitExceeded', 'usageLimitExceeded', 'usage_limit_exceeded'])(
    'accepts structured usage metadata at the allowlisted path: %s',
    (value) => {
      const candidate = classify({
        type: 'event_msg',
        payload: { type: 'error', codex_error_info: value, message: 'redacted' },
      });
      expect(candidate).toMatchObject({
        tier: 'structured',
        normalizedRecordType: 'event_msg:error',
        normalizedErrorType: 'usage_limit_exceeded',
        byteOffset: 100,
      });
      expect(candidate?.eventFingerprint).toMatch(/^[a-f0-9]{64}$/);
    },
  );

  it.each([
    "You've hit your usage limit",
    'You’ve hit your usage limit',
    'Usage limit reached',
    'Usage limit has been exceeded',
  ])('accepts a conservative error-message fallback: %s', (message) => {
    expect(classify({ type: 'event_msg', payload: { type: 'stream_error', message } })).toMatchObject({
      tier: 'text-fallback',
      normalizedRecordType: 'event_msg:stream_error',
    });
  });

  it.each([
    { type: 'response_item', payload: { type: 'user_message', content: 'UsageLimitExceeded' } },
    { type: 'response_item', payload: { type: 'assistant_message', content: 'usage_limit_exceeded' } },
    { type: 'event_msg', payload: { type: 'tool_output', output: "You've hit your usage limit" } },
    { type: 'event_msg', payload: { type: 'command_output', stdout: 'Usage limit exceeded' } },
    { type: 'event_msg', payload: { type: 'log', message: "You've hit your usage limit" } },
  ])('ignores non-server-error records even when their content matches', (record) => {
    expect(classify(record)).toBeNull();
  });

  it.each(['429', 'HTTP 429', 'rate limit', 'too many requests', 'quota', 'limit'])(
    'does not treat a generic signal as account usage exhaustion: %s',
    (message) => {
      expect(classify({ type: 'event_msg', payload: { type: 'error', message } })).toBeNull();
    },
  );

  it('does not recursively scan nested metadata or arbitrary strings', () => {
    expect(
      classify({
        type: 'event_msg',
        payload: {
          type: 'error',
          message: 'request failed',
          nested: { codex_error_info: 'usage_limit_exceeded', text: 'Usage limit exceeded' },
        },
      }),
    ).toBeNull();
  });
});
