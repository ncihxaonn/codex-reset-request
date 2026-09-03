import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { ensureAppDirectories, getAppPaths, type ResetRequestPaths } from '../config/paths.js';
import { rejectSymlink } from '../utils/atomic-file.js';
import { redactForLog } from '../utils/redaction.js';

export const MAX_AUDIT_LOG_BYTES = 16 * 1024 * 1024;

async function openValidatedAuditLog(filePath: string, flags: number, mode?: number): Promise<FileHandle> {
  await rejectSymlink(filePath);
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
  const handle = await open(filePath, flags | noFollow, mode);
  try {
    const [stats, pathStats] = await Promise.all([handle.stat(), lstat(filePath)]);
    if (
      !stats.isFile() ||
      !pathStats.isFile() ||
      pathStats.isSymbolicLink() ||
      stats.dev !== pathStats.dev ||
      stats.ino !== pathStats.ino ||
      stats.nlink !== 1 ||
      stats.size > MAX_AUDIT_LOG_BYTES
    ) {
      throw new Error('Invalid audit log file');
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export interface AuditEvent {
  at?: string;
  level: 'info' | 'warn' | 'error';
  code: string;
  actionId?: string;
  detail?: Record<string, unknown>;
}

export async function appendAuditEvent(
  event: AuditEvent,
  paths: ResetRequestPaths = getAppPaths(),
): Promise<void> {
  await ensureAppDirectories(paths);
  const safeEvent = redactForLog({ ...event, at: event.at ?? new Date().toISOString() });
  const serialized = `${JSON.stringify(safeEvent)}\n`;
  const handle = await openValidatedAuditLog(
    paths.auditLogFile,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
    0o600,
  );
  try {
    const stats = await handle.stat();
    if (stats.size + Buffer.byteLength(serialized, 'utf8') > MAX_AUDIT_LOG_BYTES) {
      throw new Error('Audit log size limit exceeded');
    }
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    if (process.platform !== 'win32') {
      await handle.chmod(0o600);
    }
  } finally {
    await handle.close();
  }
}

export async function readAuditTail(
  limit: number,
  paths: ResetRequestPaths = getAppPaths(),
): Promise<string[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error('Tail limit must be between 1 and 10000');
  }
  let handle: FileHandle | null = null;
  try {
    handle = await openValidatedAuditLog(paths.auditLogFile, constants.O_RDONLY);
    const contents = await handle.readFile('utf8');
    return contents.trimEnd().split('\n').filter(Boolean).slice(-limit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
