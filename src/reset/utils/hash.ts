import { createHash } from 'node:crypto';

export function sha256(...parts: Array<string | number | null | undefined>): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(String(part ?? ''));
    hash.update('\0');
  }
  return hash.digest('hex');
}
