import type { ActionRecord, ResetState } from '../state/schema.js';

export function findEventAction(state: ResetState, eventFingerprint: string): ActionRecord | null {
  return state.actions.find((action) => action.eventFingerprint === eventFingerprint) ?? null;
}

export function isSafelyResumableBeforeWrite(action: ActionRecord): boolean {
  return (
    (action.status === 'candidate' ||
      action.status === 'confirmed' ||
      action.status === 'target-resolved') &&
    action.attemptStartedAt === undefined &&
    action.mutationStartedAt === undefined &&
    !occupiesWriteGuard(action)
  );
}

export function occupiesWriteGuard(action: ActionRecord): boolean {
  return (
    action.status === 'attempting' ||
    action.status === 'sent' ||
    action.status === 'unknown' ||
    action.mutationStartedAt !== undefined
  );
}

export function findLimitWindowAttempt(
  state: ResetState,
  limitWindowKey: string,
  excludeActionId?: string,
): ActionRecord | null {
  return (
    state.actions.find(
      (action) =>
        action.actionId !== excludeActionId &&
        action.limitWindowKey === limitWindowKey &&
        occupiesWriteGuard(action),
    ) ?? null
  );
}

export function findActionKeyAttempt(
  state: ResetState,
  actionKey: string,
  excludeActionId?: string,
): ActionRecord | null {
  return (
    state.actions.find(
      (action) =>
        action.actionId !== excludeActionId && action.actionKey === actionKey && occupiesWriteGuard(action),
    ) ?? null
  );
}
