import { describe, expect, it } from 'vitest';
import {
  createActionKey,
  codexHomeIdentity,
  createFallbackLimitWindowKey,
  createLimitWindowKey,
} from '../../src/reset/pipeline/fingerprints.js';
import {
  countRollingWriteAttempts,
  evaluateActionRateGuard,
  evaluatePreTargetRateGuard,
} from '../../src/reset/pipeline/rate-guard.js';
import { createEmptyState, type ActionRecord, type ResetState } from '../../src/reset/state/schema.js';

const NOW = new Date('2026-08-28T12:00:00.000Z');

function action(
  index: number,
  overrides: Partial<ActionRecord> = {},
): ActionRecord {
  return {
    actionId: `action-${index}`,
    eventFingerprint: index.toString(16).padStart(64, '0'),
    limitWindowKey: `${index + 10}`.padStart(64, '0'),
    actionKey: `${index + 20}`.padStart(64, '0'),
    detectedAt: new Date(NOW.getTime() - index * 1_000).toISOString(),
    attemptStartedAt: new Date(NOW.getTime() - index * 60_000).toISOString(),
    status: 'sent',
    targetHandle: 'thsottiaux',
    targetPostId: `${100 + index}`,
    targetPostUrl: `https://x.com/thsottiaux/status/${100 + index}`,
    replyTextHash: 'a'.repeat(64),
    replyTweetId: `${9000 + index}`,
    replyUrl: `https://x.com/example/status/${9000 + index}`,
    verifiedBy: 'mutation-response',
    completedAt: NOW.toISOString(),
    ...overrides,
  };
}

function state(actions: ActionRecord[]): ResetState {
  return { ...createEmptyState(NOW), actions };
}

describe('action fingerprints', () => {
  it('creates stable window keys without reading Codex credentials', () => {
    const first = createLimitWindowKey({
      codexHome: '/Users/example/.codex',
      limitId: 'codex',
      resetsAt: 1_777_777_777,
    });
    expect(first).toHaveLength(64);
    expect(
      createLimitWindowKey({
        codexHome: '/Users/example/.codex',
        limitId: 'codex',
        resetsAt: 1_777_777_777,
      }),
    ).toBe(first);
    expect(
      createLimitWindowKey({
        codexHome: '/Users/example/.codex',
        limitId: 'codex',
        resetsAt: 1_777_777_778,
      }),
    ).not.toBe(first);
  });

  it('canonicalizes case-insensitive Windows Codex home paths', () => {
    expect(codexHomeIdentity('C:\\Users\\Example\\.codex', 'win32')).toBe(
      codexHomeIdentity('c:\\users\\example\\.CODEX', 'win32'),
    );
  });

  it('falls back to one UTC-day window and normalizes action reply text', () => {
    const morning = new Date('2026-08-28T00:00:01.000Z');
    const evening = new Date('2026-08-28T23:59:59.000Z');
    expect(createFallbackLimitWindowKey('/tmp/codex', morning)).toBe(
      createFallbackLimitWindowKey('/tmp/codex', evening),
    );
    expect(createFallbackLimitWindowKey('/tmp/codex', evening)).not.toBe(
      createFallbackLimitWindowKey('/tmp/codex', new Date('2026-08-29T00:00:00.000Z')),
    );
    expect(createActionKey('a'.repeat(64), '100', ' reset ')).toBe(
      createActionKey('a'.repeat(64), '100', 'reset'),
    );
    expect(createActionKey('a'.repeat(64), '100', 're\u0301set')).toBe(
      createActionKey('a'.repeat(64), '100', 'r\u00e9set'),
    );
    expect(
      createLimitWindowKey({
        codexHome: '/tmp/codex',
        limitId: 'codex',
        resetsAt: null,
        now: morning,
      }),
    ).toBe(createFallbackLimitWindowKey('/tmp/codex', morning));
  });
});

describe('write guards', () => {
  it('blocks the same limit window and the same action key', () => {
    const prior = action(1);
    expect(
      evaluatePreTargetRateGuard({
        state: state([prior]),
        actionId: 'new',
        limitWindowKey: prior.limitWindowKey,
        configuredMaximum: 3,
        now: NOW,
      }),
    ).toMatchObject({ allowed: false, safeCode: 'same-limit-window' });
    expect(
      evaluateActionRateGuard({
        state: state([prior]),
        actionId: 'new',
        actionKey: prior.actionKey ?? '',
        attemptsIn24Hours: 1,
      }),
    ).toMatchObject({ allowed: false, safeCode: 'same-action' });
  });

  it('enforces the configured rolling maximum and non-configurable hard maximum', () => {
    expect(
      evaluatePreTargetRateGuard({
        state: state([action(1)]),
        actionId: 'new',
        limitWindowKey: 'f'.repeat(64),
        configuredMaximum: 1,
        now: NOW,
      }),
    ).toMatchObject({ allowed: false, safeCode: 'rolling-24-hour-limit' });
    expect(
      evaluatePreTargetRateGuard({
        state: state([action(1), action(2), action(3)]),
        actionId: 'new',
        limitWindowKey: 'f'.repeat(64),
        configuredMaximum: 3,
        now: NOW,
      }),
    ).toMatchObject({ allowed: false, safeCode: 'hard-24-hour-limit' });
  });

  it('counts ambiguous writes but not failures known to occur before mutation', () => {
    const beforeRequest = action(1, {
      status: 'definitive-failure',
      mutationStartedAt: undefined,
      replyTweetId: undefined,
      replyUrl: undefined,
      verifiedBy: undefined,
    });
    const afterRequest = action(2, {
      status: 'definitive-failure',
      mutationStartedAt: new Date(NOW.getTime() - 2_000).toISOString(),
      replyTweetId: undefined,
      replyUrl: undefined,
      verifiedBy: undefined,
    });
    const stale = action(3, {
      status: 'unknown',
      attemptStartedAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1_000).toISOString(),
      replyTweetId: undefined,
      replyUrl: undefined,
      verifiedBy: undefined,
    });
    expect(countRollingWriteAttempts(state([beforeRequest, afterRequest, stale]), NOW)).toBe(1);
  });

  it('fails closed when a backward clock correction leaves a write timestamp in the future', () => {
    const futureWrite = action(1, {
      mutationStartedAt: new Date(NOW.getTime() + 60 * 60 * 1_000).toISOString(),
      attemptStartedAt: new Date(NOW.getTime() + 60 * 60 * 1_000).toISOString(),
    });
    expect(countRollingWriteAttempts(state([futureWrite]), NOW)).toBe(1);
    expect(
      evaluatePreTargetRateGuard({
        state: state([futureWrite]),
        actionId: 'new',
        limitWindowKey: 'f'.repeat(64),
        configuredMaximum: 1,
        now: NOW,
      }),
    ).toMatchObject({ allowed: false, safeCode: 'rolling-24-hour-limit' });
  });
});
