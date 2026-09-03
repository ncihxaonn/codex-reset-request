import type { RateLimitsReadOutcome } from '../codex/app-server-client.js';
import { readConfiguredCodexRateLimits } from '../codex/app-server-client.js';
import { resolveCodexHome } from '../codex/codex-home.js';
import { confirmRateLimit } from '../codex/rate-limit-confirmation.js';
import type { UsageLimitCandidate } from '../codex/rollout-types.js';
import { loadConfig } from '../config/load.js';
import type { ResetRequestPaths } from '../config/paths.js';
import { getAppPaths } from '../config/paths.js';
import { hasCurrentAutomaticPostingConsent, type ResetRequestConfig } from '../config/schema.js';
import { appendAuditEvent, type AuditEvent } from '../state/audit-log.js';
import type { ActionRecord, ActionStatus } from '../state/schema.js';
import { StateStore } from '../state/store.js';
import { sha256 } from '../utils/hash.js';
import { BirdXReplyProvider } from '../x/bird-provider.js';
import type { TargetPostResult, XAccountResult, XReplyProvider } from '../x/provider.js';
import { ActionStateMachine } from './action-state-machine.js';
import { findEventAction, isSafelyResumableBeforeWrite } from './deduplication.js';
import {
  createActionId,
  createActionKey,
  createFallbackLimitWindowKey,
  createLimitWindowKey,
} from './fingerprints.js';
import { evaluateActionRateGuard, evaluatePreTargetRateGuard } from './rate-guard.js';

export interface PipelineResult {
  actionId: string;
  status: ActionStatus | 'deduplicated';
  safeCode?: string;
  targetPostUrl?: string;
  replyUrl?: string;
}

export interface ActionPipelineDependencies {
  loadConfiguration(): Promise<ResetRequestConfig>;
  readRateLimits(config: ResetRequestConfig): Promise<RateLimitsReadOutcome>;
  createProvider(config: ResetRequestConfig): XReplyProvider;
  audit(event: AuditEvent): Promise<void>;
  now(): Date;
  resolveCodexHome(config: ResetRequestConfig): string;
}

function automationInputsEqual(first: ResetRequestConfig, second: ResetRequestConfig): boolean {
  return (
    first.targetHandle === second.targetHandle &&
    first.replyText === second.replyText &&
    first.codexHome === second.codexHome &&
    first.expectedXHandle === second.expectedXHandle &&
    first.cookieSource === second.cookieSource &&
    first.chromeProfile === second.chromeProfile &&
    first.firefoxProfile === second.firefoxProfile &&
    first.maxPostAgeHours === second.maxPostAgeHours &&
    first.maxAttemptsPer24Hours === second.maxAttemptsPer24Hours &&
    first.requireRateLimitConfirmation === second.requireRateLimitConfirmation
  );
}

function toResult(record: ActionRecord): PipelineResult {
  return {
    actionId: record.actionId,
    status: record.status,
    safeCode: record.safeCode,
    targetPostUrl: record.targetPostUrl,
    replyUrl: record.replyUrl,
  };
}

export class ActionPipeline {
  readonly stateMachine: ActionStateMachine;
  private readonly store: StateStore;
  private readonly dependencies: ActionPipelineDependencies;
  private processingQueue: Promise<void> = Promise.resolve();

  constructor(
    store: StateStore = new StateStore(),
    dependencies: Partial<ActionPipelineDependencies> = {},
  ) {
    this.store = store;
    const paths = store.paths;
    this.dependencies = {
      loadConfiguration: () => loadConfig(paths),
      readRateLimits: readConfiguredCodexRateLimits,
      createProvider: (config) => new BirdXReplyProvider(config),
      audit: (event) => appendAuditEvent(event, paths),
      now: () => new Date(),
      resolveCodexHome: (config) => resolveCodexHome(config),
      ...dependencies,
    };
    this.stateMachine = new ActionStateMachine(store, { now: this.dependencies.now });
  }

  private async audit(event: AuditEvent): Promise<void> {
    try {
      await this.dependencies.audit(event);
    } catch {
      // State is the durable source of truth; audit logging is best effort.
    }
  }

  private async replaceAction(actionId: string, update: Partial<ActionRecord>): Promise<ActionRecord> {
    let output: ActionRecord | null = null;
    await this.store.update((state) => {
      const index = state.actions.findIndex((action) => action.actionId === actionId);
      if (index === -1) {
        throw new Error('Action state is missing');
      }
      output = { ...state.actions[index], ...update };
      state.actions[index] = output;
      return undefined;
    });
    if (!output) {
      throw new Error('Action state update failed');
    }
    return output;
  }

  private async finish(actionId: string, status: ActionStatus, safeCode: string): Promise<PipelineResult> {
    const record = await this.replaceAction(actionId, {
      status,
      safeCode,
      completedAt: this.dependencies.now().toISOString(),
    });
    await this.audit({ level: status === 'dry-run' ? 'info' : 'warn', code: safeCode, actionId });
    return toResult(record);
  }

  handleCandidate(candidate: UsageLimitCandidate): Promise<PipelineResult> {
    const result = this.processingQueue.then(async () => await this.processCandidate(candidate));
    this.processingQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async processCandidate(candidate: UsageLimitCandidate): Promise<PipelineResult> {
    const initialConfig = await this.dependencies.loadConfiguration();
    const generatedActionId = createActionId(candidate.eventFingerprint);
    const detectionNow = this.dependencies.now();
    const provisionalLimitWindowKey = createFallbackLimitWindowKey(
      this.dependencies.resolveCodexHome(initialConfig),
      detectionNow,
    );
    const stateBefore = await this.store.load();
    const duplicate = findEventAction(stateBefore, candidate.eventFingerprint);
    const actionId = duplicate?.actionId ?? generatedActionId;
    if (duplicate && !isSafelyResumableBeforeWrite(duplicate)) {
      await this.audit({ level: 'info', code: 'event-deduplicated', actionId: duplicate.actionId });
      return { actionId: duplicate.actionId, status: 'deduplicated', safeCode: 'same-event' };
    }

    const candidateRecord: ActionRecord = {
      actionId,
      eventFingerprint: candidate.eventFingerprint,
      limitWindowKey: provisionalLimitWindowKey,
      detectedAt: candidate.observedAt,
      status: 'candidate',
      targetHandle: initialConfig.targetHandle,
    };
    if (duplicate) {
      await this.replaceAction(duplicate.actionId, {
        ...candidateRecord,
        actionId: duplicate.actionId,
        detectedAt: duplicate.detectedAt,
        actionKey: undefined,
        confirmedAt: undefined,
        attemptStartedAt: undefined,
        mutationStartedAt: undefined,
        completedAt: undefined,
        targetPostId: undefined,
        targetPostUrl: undefined,
        replyTextHash: undefined,
        replyTweetId: undefined,
        replyUrl: undefined,
        verifiedBy: undefined,
        safeCode: undefined,
      });
      await this.audit({ level: 'warn', code: 'pre-write-action-resumed', actionId });
    } else {
      await this.store.update((state) => {
        state.actions.push(candidateRecord);
        return undefined;
      });
    }
    await this.audit({
      level: 'info',
      code: 'usage-limit-candidate',
      actionId,
      detail: { tier: candidate.tier, safeFileName: candidate.safeFileName },
    });
    const rateLimits = await this.dependencies.readRateLimits(initialConfig);
    if (!rateLimits.ok) {
      return await this.finish(actionId, 'confirmation-failed', rateLimits.code);
    }
    const confirmationNow = this.dependencies.now();
    const confirmation = confirmRateLimit(rateLimits.value, confirmationNow);
    if (!confirmation.confirmed) {
      return await this.finish(actionId, 'confirmation-failed', confirmation.safeCode);
    }

    const limitWindowKey = createLimitWindowKey({
      codexHome: this.dependencies.resolveCodexHome(initialConfig),
      limitId: confirmation.limitId ?? confirmation.bucketKey,
      resetsAt: confirmation.resetsAt,
      now: confirmationNow,
    });
    await this.replaceAction(actionId, {
      status: 'confirmed',
      limitWindowKey,
      confirmedAt: this.dependencies.now().toISOString(),
      safeCode: undefined,
    });
    await this.audit({ level: 'info', code: 'usage-limit-confirmed', actionId });
    const preTargetGuard = evaluatePreTargetRateGuard({
      state: await this.store.load(),
      actionId,
      limitWindowKey,
      configuredMaximum: initialConfig.maxAttemptsPer24Hours,
      now: confirmationNow,
    });
    if (initialConfig.mode === 'auto' && !preTargetGuard.allowed) {
      return await this.finish(actionId, 'rate-guarded', preTargetGuard.safeCode);
    }

    const provider = this.dependencies.createProvider(initialConfig);
    let targetResult: TargetPostResult;
    try {
      targetResult = await provider.findTargetPost({
        targetHandle: initialConfig.targetHandle,
        maxPostAgeHours: initialConfig.maxPostAgeHours,
      });
    } catch {
      return await this.finish(actionId, 'target-not-found', 'target-provider-failed');
    }
    if (targetResult.status !== 'found') {
      return await this.finish(actionId, 'target-not-found', targetResult.safeCode);
    }
    const targetPost = targetResult.post;
    const actionKey = createActionKey(limitWindowKey, targetPost.id, initialConfig.replyText);
    const actionGuard = evaluateActionRateGuard({
      state: await this.store.load(),
      actionId,
      actionKey,
      attemptsIn24Hours: preTargetGuard.attemptsIn24Hours,
    });
    if (initialConfig.mode === 'auto' && !actionGuard.allowed) {
      return await this.finish(actionId, 'rate-guarded', actionGuard.safeCode);
    }
    await this.replaceAction(actionId, {
      status: 'target-resolved',
      actionKey,
      targetPostId: targetPost.id,
      targetPostUrl: targetPost.url,
      replyTextHash: sha256(initialConfig.replyText),
      safeCode: undefined,
    });

    let account: XAccountResult;
    try {
      account = await provider.getCurrentAccount();
    } catch {
      return await this.finish(actionId, 'wrong-account', 'account-unavailable');
    }
    if (!account.ok) {
      return await this.finish(actionId, 'wrong-account', account.safeCode);
    }
    if (!initialConfig.expectedXHandle) {
      return await this.finish(actionId, 'wrong-account', 'expected-account-not-recorded');
    }
    const expectedXHandle = initialConfig.expectedXHandle;
    if (account.handle.toLowerCase() !== expectedXHandle.toLowerCase()) {
      return await this.finish(actionId, 'wrong-account', 'wrong-account');
    }

    const latestConfig = await this.dependencies.loadConfiguration();
    if (!automationInputsEqual(initialConfig, latestConfig)) {
      return await this.finish(actionId, 'rejected', 'configuration-changed');
    }
    if (initialConfig.mode === 'dry-run' || latestConfig.mode === 'dry-run') {
      return await this.finish(actionId, 'dry-run', 'would-reply');
    }
    if (
      initialConfig.mode !== 'auto' ||
      latestConfig.mode !== 'auto' ||
      !hasCurrentAutomaticPostingConsent(latestConfig)
    ) {
      return await this.finish(actionId, 'rejected', 'auto-consent-required');
    }

    const finalGuard = evaluatePreTargetRateGuard({
      state: await this.store.load(),
      actionId,
      limitWindowKey,
      configuredMaximum: latestConfig.maxAttemptsPer24Hours,
      now: this.dependencies.now(),
    });
    if (!finalGuard.allowed) {
      return await this.finish(actionId, 'rate-guarded', finalGuard.safeCode);
    }

    const result = await this.stateMachine.execute({
      actionId,
      eventFingerprint: candidate.eventFingerprint,
      limitWindowKey,
      actionKey,
      detectedAt: candidate.observedAt,
      targetHandle: latestConfig.targetHandle,
      targetPost,
      replyText: latestConfig.replyText,
      expectedXHandle,
      provider,
      authorizeMutation: async () => {
        const currentConfig = await this.dependencies.loadConfiguration();
        return (
          currentConfig.mode === 'auto' &&
          hasCurrentAutomaticPostingConsent(currentConfig) &&
          automationInputsEqual(latestConfig, currentConfig)
        );
      },
    });
    if (result.status === 'definitive-failure' && result.safeCode === 'write-authorization-revoked') {
      return await this.finish(actionId, 'rejected', 'write-authorization-revoked');
    }
    await this.audit({
      level: result.status === 'sent' ? 'info' : result.status === 'unknown' ? 'warn' : 'error',
      code: result.status === 'sent' ? 'reply-sent' : result.safeCode ?? 'reply-failed',
      actionId,
    });
    return toResult(result);
  }
}

export function createActionPipeline(paths: ResetRequestPaths = getAppPaths()): ActionPipeline {
  return new ActionPipeline(new StateStore(paths));
}
