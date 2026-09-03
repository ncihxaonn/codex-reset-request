import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export const MAX_JSON_FILE_BYTES = 4 * 1024 * 1024;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

export async function rejectSymlink(targetPath: string): Promise<void> {
  try {
    const stats = await lstat(targetPath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing symbolic link at ${path.basename(targetPath)}`);
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
}

export async function ensurePrivateDirectory(directoryPath: string): Promise<void> {
  await rejectSymlink(directoryPath);
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await chmod(directoryPath, 0o700);
  }
}

export async function writeFileAtomic(
  filePath: string,
  value: string,
  options: { preserveDirectoryMode?: boolean } = {},
): Promise<void> {
  const directoryPath = path.dirname(filePath);
  if (options.preserveDirectoryMode) {
    await rejectSymlink(directoryPath);
    await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  } else {
    await ensurePrivateDirectory(directoryPath);
  }
  await rejectSymlink(filePath);

  const temporaryPath = path.join(
    directoryPath,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;

  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(value, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, filePath);
    if (process.platform !== 'win32') {
      await chmod(filePath, 0o600);
    }

    try {
      const directoryHandle = await open(directoryPath, constants.O_RDONLY);
      await directoryHandle.sync();
      await directoryHandle.close();
    } catch {
      // Directory fsync is not supported on every platform/filesystem.
    }
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_JSON_FILE_BYTES) {
    throw new Error(`Local data file is too large: ${path.basename(filePath)}`);
  }
  await writeFileAtomic(filePath, serialized);
}

export async function readJsonFile(filePath: string): Promise<unknown | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    handle = await open(filePath, constants.O_RDONLY | noFollow);
    const [openedStats, pathStats] = await Promise.all([handle.stat(), lstat(filePath)]);
    if (
      pathStats.isSymbolicLink() ||
      !openedStats.isFile() ||
      openedStats.dev !== pathStats.dev ||
      openedStats.ino !== pathStats.ino ||
      openedStats.size > MAX_JSON_FILE_BYTES
    ) {
      throw new Error(`Invalid local data file: ${path.basename(filePath)}`);
    }
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ELOOP') {
      throw new Error(`Invalid local data file: ${path.basename(filePath)}`);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
