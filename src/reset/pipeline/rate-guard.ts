import { ABSOLUTE_MAX_ATTEMPTS_PER_24_HOURS } from '../config/schema.js';
import type { ActionRecord, ResetState } from '../state/schema.js';
import { findActionKeyAttempt, findLimitWindowAttempt, occupiesWriteGuard } from './deduplication.js';

const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1_000;

export type RateGuardCode =
  | 'same-limit-window'
  | 'same-action'
  | 'rolling-24-hour-limit'
  | 'hard-24-hour-limit';

export type RateGuardResult =
  | { allowed: true; attemptsIn24Hours: number }
  | { allowed: false; safeCode: RateGuardCode; attemptsIn24Hours: number };

function attemptTimestamp(action: ActionRecord): number | null {
  if (!occupiesWriteGuard(action)) {
    return null;
  }
  const timestamp = Date.parse(action.mutationStartedAt ?? action.attemptStartedAt ?? '');
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function countRollingWriteAttempts(state: ResetState, now: Date = new Date()): number {
  const threshold = now.getTime() - ROLLING_WINDOW_MS;
  return state.actions.filter((action) => {
    const timestamp = attemptTimestamp(action);
    // A future timestamp may reflect a backward wall-clock correction. Counting
    // it fails closed instead of letting clock skew erase a real write attempt.
    return timestamp !== null && timestamp >= threshold;
  }).length;
}

export function evaluatePreTargetRateGuard(input: {
  state: ResetState;
  actionId: string;
  limitWindowKey: string;
  configuredMaximum: number;
  now?: Date;
}): RateGuardResult {
  const attemptsIn24Hours = countRollingWriteAttempts(input.state, input.now);
  if (findLimitWindowAttempt(input.state, input.limitWindowKey, input.actionId)) {
    return { allowed: false, safeCode: 'same-limit-window', attemptsIn24Hours };
  }
  if (attemptsIn24Hours >= ABSOLUTE_MAX_ATTEMPTS_PER_24_HOURS) {
    return { allowed: false, safeCode: 'hard-24-hour-limit', attemptsIn24Hours };
  }
  if (attemptsIn24Hours >= input.configuredMaximum) {
    return { allowed: false, safeCode: 'rolling-24-hour-limit', attemptsIn24Hours };
  }
  return { allowed: true, attemptsIn24Hours };
}

export function evaluateActionRateGuard(input: {
  state: ResetState;
  actionId: string;
  actionKey: string;
  attemptsIn24Hours: number;
}): RateGuardResult {
  if (findActionKeyAttempt(input.state, input.actionKey, input.actionId)) {
    return { allowed: false, safeCode: 'same-action', attemptsIn24Hours: input.attemptsIn24Hours };
  }
  return { allowed: true, attemptsIn24Hours: input.attemptsIn24Hours };
}
