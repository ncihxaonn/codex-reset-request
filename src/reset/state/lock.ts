import { randomUUID } from 'node:crypto';
import { chmod, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ensurePrivateDirectory, rejectSymlink } from '../utils/atomic-file.js';

interface LockRecord {
  pid: number;
  startedAt: string;
  token: string;
}

export class LockHeldError extends Error {
  readonly pid: number | null;

  constructor(pid: number | null) {
    super(pid ? `Watcher is already running with PID ${pid}` : 'Watcher lock is already held');
    this.name = 'LockHeldError';
    this.pid = pid;
  }
}

function parseLockRecord(value: string): LockRecord | null {
  try {
    const raw = JSON.parse(value) as Partial<LockRecord>;
    if (typeof raw.pid !== 'number' || typeof raw.startedAt !== 'string' || typeof raw.token !== 'string') {
      return null;
    }
    return { pid: raw.pid, startedAt: raw.startedAt, token: raw.token };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readLock(lockPath: string): Promise<LockRecord | null> {
  try {
    return parseLockRecord(await readFile(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

export interface SingleInstanceLock {
  record: LockRecord;
  release(): Promise<void>;
}

export async function acquireSingleInstanceLock(lockPath: string): Promise<SingleInstanceLock> {
  await ensurePrivateDirectory(path.dirname(lockPath));
  await rejectSymlink(lockPath);

  const record: LockRecord = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: randomUUID(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      if (process.platform !== 'win32') {
        await chmod(lockPath, 0o600);
      }

      let released = false;
      return {
        record,
        async release(): Promise<void> {
          if (released) {
            return;
          }
          const current = await readLock(lockPath);
          if (current?.token === record.token) {
            await unlink(lockPath).catch(() => undefined);
          }
          released = true;
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      const existing = await readLock(lockPath);
      if (attempt === 0 && (!existing || !isProcessAlive(existing.pid))) {
        await unlink(lockPath);
        continue;
      }
      throw new LockHeldError(existing?.pid ?? null);
    }
  }

  throw new LockHeldError(null);
}
