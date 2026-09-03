import { z } from 'zod';

export const CURRENT_DISCLAIMER_VERSION = '2026-08-28-v1';
export const ABSOLUTE_MAX_ATTEMPTS_PER_24_HOURS = 3;

const handleSchema = z
  .string()
  .min(1)
  .max(15)
  .regex(/^[A-Za-z0-9_]+$/, 'Expected one X handle without @ or a URL')
  .transform((value) => value.toLowerCase());

const replyTextSchema = z.string().superRefine((value, context) => {
  if (value.trim().length === 0) {
    context.addIssue({ code: 'custom', message: 'Reply text must not be empty' });
  }
  if ([...value].length > 100) {
    context.addIssue({ code: 'custom', message: 'Reply text must contain at most 100 Unicode code points' });
  }
  if (
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  ) {
    context.addIssue({ code: 'custom', message: 'Reply text must not contain control characters' });
  }
});

export const resetRequestConfigSchema = z.object({
  version: z.literal(1),
  codexHome: z.string().min(1).nullable(),
  mode: z.enum(['dry-run', 'auto']),
  targetHandle: handleSchema,
  replyText: replyTextSchema,
  expectedXHandle: handleSchema.nullable(),
  cookieSource: z.enum(['auto', 'safari', 'chrome', 'firefox']),
  chromeProfile: z.string().min(1).nullable(),
  firefoxProfile: z.string().min(1).nullable(),
  requireRateLimitConfirmation: z.literal(true),
  maxPostAgeHours: z.number().int().min(1).max(168),
  maxAttemptsPer24Hours: z.number().int().min(0).max(ABSOLUTE_MAX_ATTEMPTS_PER_24_HOURS),
  consent: z.object({
    disclaimerVersion: z.string().min(1).nullable(),
    acceptedAt: z.iso.datetime().nullable(),
    automaticPostingAccepted: z.boolean(),
  }),
});

export type RunMode = z.infer<typeof resetRequestConfigSchema>['mode'];
export type ResetRequestConfig = z.infer<typeof resetRequestConfigSchema>;

export function createDefaultConfig(): ResetRequestConfig {
  return {
    version: 1,
    codexHome: null,
    mode: 'dry-run',
    targetHandle: 'thsottiaux',
    replyText: 'reset',
    expectedXHandle: null,
    cookieSource: 'auto',
    chromeProfile: null,
    firefoxProfile: null,
    requireRateLimitConfirmation: true,
    maxPostAgeHours: 72,
    maxAttemptsPer24Hours: 1,
    consent: {
      disclaimerVersion: null,
      acceptedAt: null,
      automaticPostingAccepted: false,
    },
  };
}

export const DEFAULT_CONFIG = createDefaultConfig();

export function hasCurrentAutomaticPostingConsent(config: ResetRequestConfig): boolean {
  return (
    config.mode === 'auto' &&
    config.consent.automaticPostingAccepted &&
    config.consent.disclaimerVersion === CURRENT_DISCLAIMER_VERSION &&
    config.consent.acceptedAt !== null &&
    config.expectedXHandle !== null
  );
}

export function normalizeHandleInput(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes('://') || trimmed.includes('/') || trimmed.includes(',')) {
    throw new Error('Expected one X handle, not a URL or list');
  }
  return (trimmed.startsWith('@') ? trimmed.slice(1) : trimmed).toLowerCase();
}
