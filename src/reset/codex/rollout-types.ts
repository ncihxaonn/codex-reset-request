export interface RolloutObservationContext {
  safeFileName: string;
  fileIdentity: string | null;
  pathHash?: string;
  byteOffset: number;
  observedAt: Date;
}

export interface UsageLimitCandidate {
  tier: 'structured' | 'text-fallback';
  normalizedRecordType: 'event_msg:error' | 'event_msg:stream_error';
  normalizedErrorType: 'usage_limit_exceeded';
  safeFileName: string;
  fileIdentity: string | null;
  byteOffset: number;
  observedAt: string;
  eventFingerprint: string;
}
