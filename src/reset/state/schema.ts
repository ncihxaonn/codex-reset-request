import { z } from 'zod';

// `notified` is retained only so existing v1 state can still be read. Current
// code never emits it because local OS notifications are not a product mode.
export const actionStatusSchema = z.enum([
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
]);

export const actionRecordSchema = z
  .object({
    actionId: z.string().min(1),
    eventFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    limitWindowKey: z.string().regex(/^[a-f0-9]{64}$/),
    actionKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    detectedAt: z.iso.datetime(),
    confirmedAt: z.iso.datetime().optional(),
    attemptStartedAt: z.iso.datetime().optional(),
    mutationStartedAt: z.iso.datetime().optional(),
    completedAt: z.iso.datetime().optional(),
    status: actionStatusSchema,
    targetHandle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/),
    targetPostId: z.string().regex(/^\d+$/).optional(),
    targetPostUrl: z.url().optional(),
    replyTextHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    replyTweetId: z.string().regex(/^\d+$/).optional(),
    replyUrl: z.url().optional(),
    verifiedBy: z.enum(['mutation-response', 'read-after-write']).optional(),
    safeCode: z.string().regex(/^[a-z0-9-]+$/).max(100).optional(),
    /** Added only while importing records created by the early, looser v1 schema. */
    legacyImported: z.literal(true).optional(),
  })
  .superRefine((record, context) => {
    const requireFields = (fields: Array<keyof typeof record>, reason: string) => {
      for (const field of fields) {
        if (!record[field]) {
          context.addIssue({ code: 'custom', path: [field], message: `${field} is required ${reason}` });
        }
      }
    };
    const preWriteStatuses = new Set<ActionStatus>(['candidate', 'confirmed', 'target-resolved']);
    const terminalStatuses = new Set<ActionStatus>([
      'dry-run',
      'notified',
      'target-not-found',
      'wrong-account',
      'sent',
      'definitive-failure',
      'unknown',
      'deduplicated',
      'rate-guarded',
      'confirmation-failed',
      'rejected',
    ]);
    if (record.status === 'confirmed') {
      requireFields(['confirmedAt'], 'when confirmed');
    }
    if (record.status === 'target-resolved') {
      requireFields(
        ['confirmedAt', 'actionKey', 'targetPostId', 'targetPostUrl', 'replyTextHash'],
        'when target-resolved',
      );
    }
    if (record.status === 'attempting') {
      requireFields(
        ['actionKey', 'targetPostId', 'targetPostUrl', 'replyTextHash', 'attemptStartedAt'],
        'while attempting',
      );
    }
    if (record.status === 'sent' && !record.legacyImported) {
      requireFields(
        [
          'actionKey',
          'targetPostId',
          'targetPostUrl',
          'replyTextHash',
          'attemptStartedAt',
          'mutationStartedAt',
          'replyTweetId',
          'replyUrl',
          'verifiedBy',
          'completedAt',
        ],
        'when sent',
      );
    }
    if (terminalStatuses.has(record.status)) {
      requireFields(['completedAt'], 'for a terminal action');
    }
    if (
      preWriteStatuses.has(record.status) &&
      (record.attemptStartedAt !== undefined || record.mutationStartedAt !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'A pre-write action cannot carry write-attempt markers',
      });
    }
    if (record.mutationStartedAt && !record.attemptStartedAt) {
      context.addIssue({
        code: 'custom',
        path: ['mutationStartedAt'],
        message: 'mutationStartedAt requires attemptStartedAt',
      });
    }
  });

export const resetStateSchema = z
  .object({
    version: z.literal(1),
    updatedAt: z.iso.datetime(),
    // Never discard an event fingerprint or limit-window write guard: either
    // could turn a replay into a second external mutation. Operators may archive
    // the whole state file only while the watcher is stopped.
    actions: z.array(actionRecordSchema),
  })
  .superRefine((state, context) => {
    const actionIds = new Set<string>();
    const eventFingerprints = new Set<string>();
    state.actions.forEach((action, index) => {
      if (actionIds.has(action.actionId)) {
        context.addIssue({ code: 'custom', path: ['actions', index, 'actionId'], message: 'Duplicate actionId' });
      }
      if (eventFingerprints.has(action.eventFingerprint)) {
        context.addIssue({
          code: 'custom',
          path: ['actions', index, 'eventFingerprint'],
          message: 'Duplicate eventFingerprint',
        });
      }
      actionIds.add(action.actionId);
      eventFingerprints.add(action.eventFingerprint);
    });
  });

export type ActionStatus = z.infer<typeof actionStatusSchema>;
export type ActionRecord = z.infer<typeof actionRecordSchema>;
export type ResetState = z.infer<typeof resetStateSchema>;

export function createEmptyState(now: Date = new Date()): ResetState {
  return { version: 1, updatedAt: now.toISOString(), actions: [] };
}
