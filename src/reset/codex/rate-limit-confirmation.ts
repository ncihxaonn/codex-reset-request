import { z } from 'zod';

const rateLimitWindowSchema = z
  .object({
    usedPercent: z.number().finite(),
    windowDurationMins: z.number().finite().nullable().optional(),
    resetsAt: z.number().int().finite().nonnegative().nullable().optional(),
  })
  .passthrough();

const rateLimitSnapshotSchema = z
  .object({
    limitId: z.string().nullable().optional(),
    limitName: z.string().nullable().optional(),
    primary: rateLimitWindowSchema.nullable().optional(),
    secondary: rateLimitWindowSchema.nullable().optional(),
    credits: z.unknown().nullable().optional(),
    individualLimit: z.unknown().nullable().optional(),
    planType: z.string().nullable().optional(),
    rateLimitReachedType: z.string().nullable().optional(),
  })
  .passthrough();

export const rateLimitsResponseSchema = z
  .object({
    rateLimits: rateLimitSnapshotSchema,
    rateLimitsByLimitId: z.record(z.string(), rateLimitSnapshotSchema).nullable().optional(),
  })
  .passthrough();

export type RateLimitWindow = z.infer<typeof rateLimitWindowSchema>;
export type RateLimitSnapshot = z.infer<typeof rateLimitSnapshotSchema>;
export type ParsedRateLimitsResponse = z.infer<typeof rateLimitsResponseSchema>;

export type RateLimitConfirmation =
  | {
      confirmed: true;
      reason: 'window';
      bucketKey: string;
      limitId: string | null;
      matchedWindow: 'primary' | 'secondary';
      resetsAt: number;
    }
  | {
      confirmed: false;
      safeCode: 'not-reached' | 'ambiguous-buckets';
      bucketKey?: string;
      limitId?: string | null;
    };

interface SelectedBucket {
  key: string;
  snapshot: RateLimitSnapshot;
}

function selectBucket(response: ParsedRateLimitsResponse): SelectedBucket | null {
  const entries = Object.entries(response.rateLimitsByLimitId ?? {});
  if (entries.length === 0) {
    return { key: response.rateLimits.limitId ?? 'legacy', snapshot: response.rateLimits };
  }
  if (entries.length === 1) {
    return { key: entries[0][0], snapshot: entries[0][1] };
  }

  const codexBuckets = entries.filter(([key, snapshot]) => key === 'codex' || snapshot.limitId === 'codex');
  if (codexBuckets.length === 1) {
    return { key: codexBuckets[0][0], snapshot: codexBuckets[0][1] };
  }
  if (codexBuckets.length > 1) {
    return null;
  }

  return null;
}

export function parseRateLimitsResponse(value: unknown): ParsedRateLimitsResponse {
  return rateLimitsResponseSchema.parse(value);
}

export function confirmRateLimit(
  response: ParsedRateLimitsResponse,
  now: Date = new Date(),
): RateLimitConfirmation {
  const selected = selectBucket(response);
  if (!selected) {
    return { confirmed: false, safeCode: 'ambiguous-buckets' };
  }

  const nowSeconds = Math.floor(now.getTime() / 1_000);
  for (const windowName of ['primary', 'secondary'] as const) {
    const window = selected.snapshot[windowName];
    if (window && window.usedPercent >= 100 && typeof window.resetsAt === 'number' && window.resetsAt > nowSeconds) {
      return {
        confirmed: true,
        reason: 'window',
        bucketKey: selected.key,
        limitId: selected.snapshot.limitId ?? null,
        matchedWindow: windowName,
        resetsAt: window.resetsAt,
      };
    }
  }

  return {
    confirmed: false,
    safeCode: 'not-reached',
    bucketKey: selected.key,
    limitId: selected.snapshot.limitId ?? null,
  };
}
