import { z } from 'zod';
import { createEmptyState, resetStateSchema, type ActionRecord, type ResetState } from './schema.js';

// The first v1 builds accepted a looser action shape. Upgrades must retain those
// records because even incomplete write evidence is a reason to fail closed.
const legacyActionSchema = z.object({
  actionId: z.string().min(1),
  eventFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  limitWindowKey: z.string().regex(/^[a-f0-9]{64}$/),
  actionKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  detectedAt: z.iso.datetime(),
  confirmedAt: z.iso.datetime().optional(),
  attemptStartedAt: z.iso.datetime().optional(),
  mutationStartedAt: z.iso.datetime().optional(),
  completedAt: z.iso.datetime().optional(),
  status: z.enum([
    'candidate',
    'confirmed',
    'target-resolved',
    'dry-run',
    'notified',
    'target-not-found',
    'wrong-account',
    'attempting',
    'sent',
    'definitive-failure',
    'unknown',
    'deduplicated',
    'rate-guarded',
    'confirmation-failed',
    'rejected',
  ]),
  targetHandle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/),
  targetPostId: z.string().regex(/^\d+$/).optional(),
  targetPostUrl: z.url().optional(),
  replyTextHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  replyTweetId: z.string().regex(/^\d+$/).optional(),
  replyUrl: z.url().optional(),
  verifiedBy: z.enum(['mutation-response', 'read-after-write']).optional(),
  safeCode: z.string().regex(/^[a-z0-9-]+$/).max(100).optional(),
});

const legacyStateSchema = z.object({
  version: z.literal(1),
  updatedAt: z.iso.datetime(),
  actions: z.array(legacyActionSchema),
});

type LegacyAction = z.infer<typeof legacyActionSchema>;

function migrationPriority(action: LegacyAction): number {
  if (action.status === 'attempting') return 5;
  if (action.status === 'sent' || action.status === 'unknown') return 4;
  if (action.attemptStartedAt) return 3;
  if (action.completedAt) return 2;
  return 1;
}

function normalizeLegacyHandle(handle: string): string {
  const normalized = handle.replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_]{1,15}$/i.test(normalized) ? normalized : 'unknown';
}

function normalizeLegacyAction(action: LegacyAction): ActionRecord {
  const terminal = !['candidate', 'confirmed', 'target-resolved', 'attempting'].includes(action.status);
  const fallbackTimestamp = action.completedAt ?? action.attemptStartedAt ?? action.detectedAt;
  const incompleteTarget =
    action.status === 'target-resolved' &&
    (!action.confirmedAt || !action.actionKey || !action.targetPostId || !action.targetPostUrl || !action.replyTextHash);
  const unsafePreWrite =
    (action.status === 'candidate' || action.status === 'confirmed' || action.status === 'target-resolved') &&
    (action.attemptStartedAt !== undefined || action.mutationStartedAt !== undefined);
  let status = action.status;
  if (unsafePreWrite || action.status === 'attempting') {
    status = 'unknown';
  } else if (action.status === 'confirmed' && !action.confirmedAt) {
    status = 'candidate';
  } else if (incompleteTarget) {
    status = action.confirmedAt ? 'confirmed' : 'candidate';
  }
  const wasWriteState =
    action.status === 'attempting' ||
    action.status === 'sent' ||
    action.status === 'unknown' ||
    action.mutationStartedAt !== undefined;
  const normalizedSafeCode = /^[a-z0-9-]{1,100}$/.test(action.safeCode ?? '')
    ? action.safeCode
    : 'legacy-state-imported';
  return {
    ...action,
    status,
    targetHandle: normalizeLegacyHandle(action.targetHandle),
    attemptStartedAt:
      wasWriteState || unsafePreWrite ? (action.attemptStartedAt ?? fallbackTimestamp) : action.attemptStartedAt,
    mutationStartedAt: wasWriteState || unsafePreWrite
      ? (action.mutationStartedAt ?? action.attemptStartedAt ?? fallbackTimestamp)
      : undefined,
    completedAt: terminal || status === 'unknown' ? fallbackTimestamp : action.completedAt,
    safeCode: normalizedSafeCode,
    legacyImported: true,
  };
}

function migrateLegacyState(raw: unknown): ResetState {
  const legacy = legacyStateSchema.parse(raw);
  const ordered = [...legacy.actions].sort((left, right) => migrationPriority(right) - migrationPriority(left));
  const actionIds = new Set<string>();
  const eventFingerprints = new Set<string>();
  const selected: LegacyAction[] = [];
  for (const action of ordered) {
    if (actionIds.has(action.actionId) || eventFingerprints.has(action.eventFingerprint)) {
      continue;
    }
    actionIds.add(action.actionId);
    eventFingerprints.add(action.eventFingerprint);
    selected.push(action);
  }
  return resetStateSchema.parse({
    ...legacy,
    actions: selected.map(normalizeLegacyAction),
  });
}

export function migrateState(raw: unknown): ResetState {
  if (raw === null || raw === undefined) {
    return createEmptyState();
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error('State data is not an object');
  }
  const version = (raw as { version?: unknown }).version;
  if (version !== 1) {
    throw new Error(`Unsupported state version: ${String(version)}`);
  }
  const current = resetStateSchema.safeParse(raw);
  return current.success ? current.data : migrateLegacyState(raw);
}
