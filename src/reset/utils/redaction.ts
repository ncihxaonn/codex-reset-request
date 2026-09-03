import { homedir } from 'node:os';

const SECRET_KEY = /auth[_-]?token|ct0|cookie|authorization|bearer|chatgpt.*token|access[_-]?token/i;
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const LONG_HEX = /\b[a-f0-9]{40,}\b/gi;
const BEARER = /\bBearer\s+[^\s,;]+/gi;
const COOKIE_ASSIGNMENT = /\b(?:auth_token|ct0)=[^\s;]+/gi;

function redactString(value: string): string {
  const home = homedir();
  return value
    .replace(JWT, '[REDACTED_JWT]')
    .replace(LONG_HEX, '[REDACTED_HEX]')
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(COOKIE_ASSIGNMENT, '[REDACTED_COOKIE]')
    .split(home)
    .join('~');
}

export function redactForLog(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactForLog(item));
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redactForLog(nested);
    }
    return output;
  }
  return value;
}
