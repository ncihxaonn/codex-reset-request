import type { StateStore } from '../state/store.js';
import type { ActionRecord, ActionStatus } from '../state/schema.js';
import { sha256 } from '../utils/hash.js';
import type { TargetPost, XReplyProvider, XWriteResult } from '../x/provider.js';

const TERMINAL_STATUSES = new Set<ActionStatus>([
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

export interface ExecuteReplyInput {
  actionId: string;
  eventFingerprint: string;
  limitWindowKey: string;
  actionKey: string;
  detectedAt: string;
  targetHandle: string;
  targetPost: TargetPost;
  replyText: string;
  expectedXHandle: string;
  provider: XReplyProvider;
  authorizeMutation?(): Promise<boolean>;
}

function trustedSafeCode(value: string, fallback: string): string {
  return /^[a-z0-9-]{1,100}$/.test(value) ? value : fallback;
}

export class ActionStateMachine {
  private readonly store: StateStore;
  private readonly now: () => Date;
  private executionQueue: Promise<void> = Promise.resolve();

  constructor(store: StateStore, options: { now?: () => Date } = {}) {
    this.store = store;
    this.now = options.now ?? (() => new Date());
  }

  private async replaceAction(record: ActionRecord): Promise<ActionRecord> {
    await this.store.update((state) => {
      const index = state.actions.findIndex((action) => action.actionId === record.actionId);
      if (index === -1) {
        state.actions.push(record);
      } else {
        state.actions[index] = record;
      }
      return undefined;
    });
    return record;
  }

  async recoverStaleAttempts(): Promise<number> {
    let recovered = 0;
    const completedAt = this.now().toISOString();
    await this.store.update((state) => {
      state.actions = state.actions.map((action) => {
        if (action.status !== 'attempting') {
          return action;
        }
        recovered += 1;
        return {
          ...action,
          status: 'unknown',
          safeCode: 'restart-ambiguous',
          completedAt,
        };
      });
      return undefined;
    });
    return recovered;
  }

  execute(input: ExecuteReplyInput): Promise<ActionRecord> {
    const result = this.executionQueue.then(async () => await this.executeOnce(input));
    this.executionQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async executeOnce(input: ExecuteReplyInput): Promise<ActionRecord> {
    const state = await this.store.load();
    const existing = state.actions.find((action) => action.actionId === input.actionId);
    if (existing?.status === 'attempting') {
      const recovered: ActionRecord = {
        ...existing,
        status: 'unknown',
        safeCode: 'restart-ambiguous',
        completedAt: this.now().toISOString(),
      };
      return await this.replaceAction(recovered);
    }
    if (existing && TERMINAL_STATUSES.has(existing.status)) {
      return existing;
    }

    const attemptStartedAt = this.now();
    let attempting: ActionRecord = {
      actionId: input.actionId,
      eventFingerprint: input.eventFingerprint,
      limitWindowKey: input.limitWindowKey,
      actionKey: input.actionKey,
      detectedAt: existing?.detectedAt ?? input.detectedAt,
      confirmedAt: existing?.confirmedAt,
      status: 'attempting',
      targetHandle: input.targetHandle.toLowerCase(),
      targetPostId: input.targetPost.id,
      targetPostUrl: input.targetPost.url,
      replyTextHash: sha256(input.replyText),
      attemptStartedAt: attemptStartedAt.toISOString(),
    };
    await this.replaceAction(attempting);

    let writeResult: XWriteResult;
    try {
      writeResult = await input.provider.replyOnce({
        targetPost: input.targetPost,
        text: input.replyText,
        attemptId: input.actionId,
        expectedXHandle: input.expectedXHandle,
        onMutationStart: async () => {
          if (input.authorizeMutation && !(await input.authorizeMutation())) {
            return { ok: false, safeCode: 'write-authorization-revoked' };
          }
          const mutationStarting: ActionRecord = {
            ...attempting,
            mutationStartedAt: this.now().toISOString(),
          };
          await this.replaceAction(mutationStarting);
          attempting = mutationStarting;
          return { ok: true };
        },
      });
    } catch {
      writeResult = {
        status: 'unknown',
        safeCode: 'write-provider-threw',
        targetPostUrl: input.targetPost.url,
      };
    }

    if (writeResult.status === 'sent') {
      return await this.replaceAction({
        ...attempting,
        status: 'sent',
        replyTweetId: writeResult.tweetId,
        replyUrl: writeResult.url,
        verifiedBy: writeResult.verifiedBy,
        completedAt: this.now().toISOString(),
      });
    }
    if (writeResult.status === 'definitive-failure') {
      return await this.replaceAction({
        ...attempting,
        status: 'definitive-failure',
        safeCode: trustedSafeCode(writeResult.safeCode, 'write-rejected'),
        completedAt: this.now().toISOString(),
      });
    }

    const unknown = await this.replaceAction({
      ...attempting,
      status: 'unknown',
      safeCode: trustedSafeCode(writeResult.safeCode, 'write-result-unknown'),
      completedAt: this.now().toISOString(),
    });
    try {
      const verification = await input.provider.verifyReply({
        targetPostId: input.targetPost.id,
        replyText: input.replyText,
        attemptStartedAt,
      });
      if (verification.status === 'verified') {
        return await this.replaceAction({
          ...unknown,
          status: 'sent',
          replyTweetId: verification.tweetId,
          replyUrl: verification.url,
          verifiedBy: 'read-after-write',
          safeCode: undefined,
          completedAt: this.now().toISOString(),
        });
      }
    } catch {
      // A read-only verification failure leaves the action unknown.
    }
    return unknown;
  }
}
