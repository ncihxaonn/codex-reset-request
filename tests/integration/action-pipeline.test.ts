import { afterEach, describe, expect, it } from 'vitest';
import type { RateLimitsReadOutcome } from '../../src/reset/codex/app-server-client.js';
import type { UsageLimitCandidate } from '../../src/reset/codex/rollout-types.js';
import { CURRENT_DISCLAIMER_VERSION, createDefaultConfig } from '../../src/reset/config/schema.js';
import { ActionPipeline, type ActionPipelineDependencies } from '../../src/reset/pipeline/action-pipeline.js';
import { createActionId } from '../../src/reset/pipeline/fingerprints.js';
import type { ActionRecord } from '../../src/reset/state/schema.js';
import type { AuditEvent } from '../../src/reset/state/audit-log.js';
import { StateStore } from '../../src/reset/state/store.js';
import { FakeBirdProvider } from '../helpers/fake-bird-provider.js';
import { createTemporaryHome, type TemporaryHome } from '../helpers/temporary-home.js';

const homes: TemporaryHome[] = [];
const NOW = new Date('2026-08-28T12:00:00.000Z');

function confirmedRateLimits(resetsAt = Math.floor(NOW.getTime() / 1_000) + 3_600): RateLimitsReadOutcome {
  return {
    ok: true,
    value: {
      rateLimits: {
        limitId: 'codex',
        rateLimitReachedType: 'usage_limit_exceeded',
        primary: { usedPercent: 100, resetsAt },
      },
    },
  };
}

function candidate(index: number): UsageLimitCandidate {
  return {
    tier: 'structured',
    normalizedRecordType: 'event_msg:error',
    normalizedErrorType: 'usage_limit_exceeded',
    safeFileName: `rollout-${index}.jsonl`,
    fileIdentity: `file-${index}`,
    byteOffset: index,
    observedAt: NOW.toISOString(),
    eventFingerprint: index.toString(16).padStart(64, '0'),
  };
}

async function fixture(options: {
  provider?: FakeBirdProvider;
  mode?: 'dry-run' | 'auto';
  modeBeforeWrite?: 'dry-run' | 'auto';
  rateLimits?: RateLimitsReadOutcome;
  auditFails?: boolean;
  now?: () => Date;
} = {}) {
  const home = await createTemporaryHome();
  homes.push(home);
  const store = new StateStore(home.paths);
  const provider = options.provider ?? new FakeBirdProvider();
  const config = createDefaultConfig();
  config.mode = options.mode ?? 'auto';
  config.expectedXHandle = 'example';
  if (config.mode === 'auto') {
    config.consent = {
      automaticPostingAccepted: true,
      disclaimerVersion: CURRENT_DISCLAIMER_VERSION,
      acceptedAt: NOW.toISOString(),
    };
  }
  const counters = { appServerReads: 0, providerCreations: 0, configReads: 0 };
  const audits: AuditEvent[] = [];
  const dependencies: Partial<ActionPipelineDependencies> = {
    loadConfiguration: async () => {
      counters.configReads += 1;
      const loaded = structuredClone(config);
      if (counters.configReads > 1 && options.modeBeforeWrite) {
        loaded.mode = options.modeBeforeWrite;
      }
      return loaded;
    },
    readRateLimits: async () => {
      counters.appServerReads += 1;
      return options.rateLimits ?? confirmedRateLimits();
    },
    createProvider: () => {
      counters.providerCreations += 1;
      return provider;
    },
    audit: async (event) => {
      if (options.auditFails) {
        throw new Error('synthetic audit failure');
      }
      audits.push(event);
    },
    now: options.now ?? (() => NOW),
    resolveCodexHome: () => '/tmp/fake-codex-home',
  };
  const pipeline = new ActionPipeline(store, dependencies);
  return { store, provider, config, counters, audits, pipeline };
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => home.cleanup()));
});

describe('usage-limit action pipeline', () => {
  it('confirms, selects, persists attempting, and performs exactly one mutation', async () => {
    const { pipeline, store, provider, audits } = await fixture();
    expect(await pipeline.handleCandidate(candidate(1))).toMatchObject({ status: 'sent' });
    expect(provider.calls).toMatchObject({ targetReads: 1, accountReads: 1, mutationAttempts: 1 });
    expect((await store.load()).actions[0]).toMatchObject({
      status: 'sent',
      mutationStartedAt: NOW.toISOString(),
      replyTweetId: '9001',
    });
    expect(JSON.stringify(await store.load())).not.toContain('"replyText":"reset"');
    expect(JSON.stringify(audits)).not.toContain('reset');
  });

  it('deduplicates the same event before network and the same window before X reads', async () => {
    const { pipeline, provider, counters } = await fixture();
    await pipeline.handleCandidate(candidate(1));
    expect(await pipeline.handleCandidate(candidate(1))).toMatchObject({
      status: 'deduplicated',
      safeCode: 'same-event',
    });
    expect(counters.appServerReads).toBe(1);

    expect(await pipeline.handleCandidate(candidate(2))).toMatchObject({
      status: 'rate-guarded',
      safeCode: 'same-limit-window',
    });
    expect(counters.appServerReads).toBe(2);
    expect(provider.calls.targetReads).toBe(1);
    expect(provider.calls.mutationAttempts).toBe(1);
  });

  it('serializes concurrent candidate delivery before duplicate and rate-guard checks', async () => {
    const { pipeline, provider, counters } = await fixture();
    const [first, second] = await Promise.all([
      pipeline.handleCandidate(candidate(1)),
      pipeline.handleCandidate(candidate(1)),
    ]);
    expect(first.status).toBe('sent');
    expect(second.status).toBe('deduplicated');
    expect(counters.appServerReads).toBe(1);
    expect(provider.calls.mutationAttempts).toBe(1);
  });

  it.each(['candidate', 'confirmed', 'target-resolved'] as const)(
    'safely resumes a persisted pre-write %s action after restart',
    async (status) => {
      const setup = await fixture();
      const observed = candidate(1);
      const seeded: ActionRecord = {
        actionId: createActionId(observed.eventFingerprint),
        eventFingerprint: observed.eventFingerprint,
        limitWindowKey: 'a'.repeat(64),
        detectedAt: observed.observedAt,
        confirmedAt: status === 'candidate' ? undefined : observed.observedAt,
        status,
        targetHandle: 'thsottiaux',
        actionKey: status === 'target-resolved' ? 'b'.repeat(64) : undefined,
        targetPostId: status === 'target-resolved' ? '100' : undefined,
        targetPostUrl:
          status === 'target-resolved' ? 'https://x.com/thsottiaux/status/100' : undefined,
        replyTextHash: status === 'target-resolved' ? 'c'.repeat(64) : undefined,
      };
      await setup.store.save({ version: 1, updatedAt: observed.observedAt, actions: [seeded] });
      expect(await setup.pipeline.handleCandidate(observed)).toMatchObject({ status: 'sent' });
      expect(setup.provider.calls.mutationAttempts).toBe(1);
      expect((await setup.store.load()).actions).toHaveLength(1);
    },
  );

  it('rejects a pre-write-looking record that carries a mutation marker', async () => {
    const setup = await fixture();
    const observed = candidate(1);
    await expect(
      setup.store.save({
        version: 1,
        updatedAt: observed.observedAt,
        actions: [
          {
            actionId: createActionId(observed.eventFingerprint),
            eventFingerprint: observed.eventFingerprint,
            limitWindowKey: 'a'.repeat(64),
            detectedAt: observed.observedAt,
            confirmedAt: observed.observedAt,
            status: 'target-resolved',
            targetHandle: 'thsottiaux',
            actionKey: 'b'.repeat(64),
            targetPostId: '100',
            targetPostUrl: 'https://x.com/thsottiaux/status/100',
            replyTextHash: 'c'.repeat(64),
            attemptStartedAt: observed.observedAt,
            mutationStartedAt: observed.observedAt,
          },
        ],
      }),
    ).rejects.toThrow(/pre-write action/i);
    expect(setup.provider.calls.mutationAttempts).toBe(0);
  });

  it('keeps an ambiguous result unknown and never retries it', async () => {
    const provider = new FakeBirdProvider({
      writeResult: {
        status: 'unknown',
        safeCode: 'write-transport-ambiguous',
        targetPostUrl: 'https://x.com/thsottiaux/status/100',
      },
      verificationResult: { status: 'not-verified', safeCode: 'no-match' },
    });
    const { pipeline } = await fixture({ provider });
    expect(await pipeline.handleCandidate(candidate(1))).toMatchObject({ status: 'unknown' });
    expect(await pipeline.handleCandidate(candidate(1))).toMatchObject({ status: 'deduplicated' });
    expect(await pipeline.handleCandidate(candidate(2))).toMatchObject({ status: 'rate-guarded' });
    expect(provider.calls.mutationAttempts).toBe(1);
    expect(provider.calls.verificationReads).toBe(1);
  });

  it('runs confirmation, target selection, and account verification in dry-run without writing', async () => {
    const { pipeline, provider, store } = await fixture({ mode: 'dry-run' });
    expect(await pipeline.handleCandidate(candidate(1))).toMatchObject({ status: 'dry-run', safeCode: 'would-reply' });
    expect(provider.calls).toMatchObject({ targetReads: 1, accountReads: 1, mutationAttempts: 0 });
    expect((await store.load()).actions[0].status).toBe('dry-run');
  });

  it('fails closed when App Server cannot confirm and stays idle with zero network calls', async () => {
    const { pipeline, counters, provider } = await fixture({
      rateLimits: { ok: false, stage: 'rate-limits', code: 'timeout' },
    });
    expect(counters).toEqual({ appServerReads: 0, providerCreations: 0, configReads: 0 });
    expect(provider.calls.targetReads).toBe(0);
    expect(await pipeline.handleCandidate(candidate(1))).toMatchObject({
      status: 'confirmation-failed',
      safeCode: 'timeout',
    });
    expect(counters).toEqual({ appServerReads: 1, providerCreations: 0, configReads: 1 });
    expect(provider.calls.mutationAttempts).toBe(0);
  });

  it('ignores a reached type without a stable saturated reset window', async () => {
    const { pipeline, provider } = await fixture({
      rateLimits: {
        ok: true,
        value: {
          rateLimits: {
            limitId: 'codex',
            rateLimitReachedType: 'usage_limit_exceeded',
          },
        },
      },
    });
    expect(await pipeline.handleCandidate(candidate(1))).toMatchObject({
      status: 'confirmation-failed',
      safeCode: 'not-reached',
    });
    expect(provider.calls.mutationAttempts).toBe(0);
  });

  it('keeps audit failures from changing the durable action result', async () => {
    const { pipeline, store } = await fixture({ auditFails: true });
    expect(await pipeline.handleCandidate(candidate(1))).toMatchObject({ status: 'sent' });
    expect((await store.load()).actions[0].status).toBe('sent');
  });

  it('reloads configuration before writing so disable-auto takes effect immediately', async () => {
    const { pipeline, provider, counters } = await fixture({ modeBeforeWrite: 'dry-run' });
    expect(await pipeline.handleCandidate(candidate(1))).toMatchObject({
      status: 'dry-run',
      safeCode: 'would-reply',
    });
    expect(counters.configReads).toBe(2);
    expect(provider.calls.mutationAttempts).toBe(0);
  });

  it('rejects a changed X account before entering the write state machine', async () => {
    const provider = new FakeBirdProvider({ accountResult: { ok: true, id: '8', handle: 'different' } });
    const { pipeline } = await fixture({ provider });
    expect(await pipeline.handleCandidate(candidate(1))).toMatchObject({
      status: 'wrong-account',
      safeCode: 'wrong-account',
    });
    expect(provider.calls.mutationAttempts).toBe(0);
  });

  it('rechecks auto authorization at the mutation boundary', async () => {
    const setup = await fixture();
    setup.provider.beforeMutationStart = () => {
      setup.config.mode = 'dry-run';
    };
    expect(await setup.pipeline.handleCandidate(candidate(1))).toMatchObject({
      status: 'rejected',
      safeCode: 'write-authorization-revoked',
    });
    expect(setup.provider.calls.mutationAttempts).toBe(0);
    expect((await setup.store.load()).actions[0].mutationStartedAt).toBeUndefined();
  });

  it('does not let rolling write guards truncate the read-only dry-run path', async () => {
    const setup = await fixture();
    expect(await setup.pipeline.handleCandidate(candidate(1))).toMatchObject({ status: 'sent' });
    setup.config.mode = 'dry-run';
    expect(await setup.pipeline.handleCandidate(candidate(2))).toMatchObject({ status: 'dry-run' });
    expect(setup.provider.calls).toMatchObject({ targetReads: 2, accountReads: 2, mutationAttempts: 1 });
  });

  it('checks reset expiry using time captured after the App Server response', async () => {
    const beforeReset = new Date('2026-08-28T12:00:00.000Z');
    const afterReset = new Date('2026-08-28T12:00:02.000Z');
    const times = [beforeReset, afterReset, afterReset];
    const setup = await fixture({
      rateLimits: {
        ok: true,
        value: {
          rateLimits: {
            limitId: 'codex',
            primary: { usedPercent: 100, resetsAt: Math.floor(beforeReset.getTime() / 1_000) + 1 },
            rateLimitReachedType: null,
          },
        },
      },
      now: () => times.shift() ?? afterReset,
    });
    expect(await setup.pipeline.handleCandidate(candidate(1))).toMatchObject({
      status: 'confirmation-failed',
      safeCode: 'not-reached',
    });
    expect(setup.provider.calls.targetReads).toBe(0);
  });
});
