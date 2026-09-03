import type { Stats } from 'node:fs';
import { lstat } from 'node:fs/promises';

export function identityFromStats(stats: Stats): string | null {
  if (Number.isFinite(stats.dev) && Number.isFinite(stats.ino) && (stats.dev !== 0 || stats.ino !== 0)) {
    return `${stats.dev}:${stats.ino}`;
  }
  return null;
}

export async function readFileIdentity(filePath: string): Promise<{ identity: string | null; stats: Stats }> {
  const stats = await lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('Rollout path is not a regular file');
  }
  return { identity: identityFromStats(stats), stats };
}
