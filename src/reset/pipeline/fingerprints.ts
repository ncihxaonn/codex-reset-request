import path from 'node:path';
import { sha256 } from '../utils/hash.js';

export interface LimitWindowFingerprintInput {
  codexHome: string;
  limitId: string | null;
  resetsAt: number | null;
  now?: Date;
  platform?: NodeJS.Platform;
}

export function codexHomeIdentity(
  codexHome: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const resolved = platform === 'win32' ? path.win32.resolve(codexHome) : path.resolve(codexHome);
  return sha256(platform === 'win32' ? resolved.toLowerCase() : resolved);
}

export function normalizeReplyText(replyText: string): string {
  return replyText.normalize('NFC').trim();
}

export function createFallbackLimitWindowKey(
  codexHome: string,
  now: Date = new Date(),
  platform: NodeJS.Platform = process.platform,
): string {
  return sha256(codexHomeIdentity(codexHome, platform), 'usage-limit', now.toISOString().slice(0, 10));
}

export function createLimitWindowKey(input: LimitWindowFingerprintInput): string {
  const hasStableWindowIdentity = input.resetsAt !== null;
  if (!hasStableWindowIdentity) {
    return createFallbackLimitWindowKey(input.codexHome, input.now, input.platform);
  }
  return sha256(
    codexHomeIdentity(input.codexHome, input.platform),
    input.limitId,
    input.resetsAt,
  );
}

export function createActionKey(limitWindowKey: string, targetPostId: string, replyText: string): string {
  return sha256(limitWindowKey, targetPostId, normalizeReplyText(replyText));
}

export function createActionId(eventFingerprint: string): string {
  return sha256('usage-limit-action', eventFingerprint);
}
