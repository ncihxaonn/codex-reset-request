import { sha256 } from '../utils/hash.js';
import type { RolloutObservationContext, UsageLimitCandidate } from './rollout-types.js';

const STRUCTURED_USAGE_LIMIT_VALUES = new Set([
  'UsageLimitExceeded',
  'usageLimitExceeded',
  'usage_limit_exceeded',
]);

const FALLBACK_PATTERNS = [
  /you(?:'|’)ve hit your usage limit/i,
  /usage limit (?:has been )?(?:reached|exceeded)/i,
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function structuredErrorType(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  for (const key of ['type', 'kind', 'code']) {
    if (typeof record[key] === 'string') {
      return record[key];
    }
  }
  return null;
}

export function extractUsageLimitCandidate(
  record: unknown,
  context: RolloutObservationContext,
): UsageLimitCandidate | null {
  const topLevel = asRecord(record);
  if (topLevel?.type !== 'event_msg') {
    return null;
  }
  const payload = asRecord(topLevel.payload);
  if (payload?.type !== 'error' && payload?.type !== 'stream_error') {
    return null;
  }

  const normalizedRecordType = `event_msg:${payload.type}` as UsageLimitCandidate['normalizedRecordType'];
  const metadataValue = structuredErrorType(payload.codex_error_info ?? payload.codexErrorInfo);
  let tier: UsageLimitCandidate['tier'] | null = null;

  if (metadataValue && STRUCTURED_USAGE_LIMIT_VALUES.has(metadataValue)) {
    tier = 'structured';
  } else if (
    typeof payload.message === 'string' &&
    FALLBACK_PATTERNS.some((pattern) => pattern.test(payload.message as string))
  ) {
    tier = 'text-fallback';
  }

  if (!tier) {
    return null;
  }

  const normalizedErrorType = 'usage_limit_exceeded' as const;
  return {
    tier,
    normalizedRecordType,
    normalizedErrorType,
    safeFileName: context.safeFileName,
    fileIdentity: context.fileIdentity,
    byteOffset: context.byteOffset,
    observedAt: context.observedAt.toISOString(),
    eventFingerprint: sha256(
      context.fileIdentity ?? context.pathHash ?? context.safeFileName,
      context.byteOffset,
      normalizedRecordType,
      normalizedErrorType,
    ),
  };
}
