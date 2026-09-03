import { watch, type Dirent, type FSWatcher, type Stats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { UsageLimitCandidate } from '../codex/rollout-types.js';
import { extractUsageLimitCandidate } from '../codex/rollout-classifier.js';
import type { ResetRequestPaths } from '../config/paths.js';
import { getAppPaths } from '../config/paths.js';
import { acquireSingleInstanceLock, type SingleInstanceLock } from '../state/lock.js';
import { sha256 } from '../utils/hash.js';
import { CursorStore, type CursorState } from './cursor-store.js';
import { IncrementalTailer, type TailWarning } from './incremental-tailer.js';

function isPathGone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function discoverRolloutFiles(directoryPath: string, tolerateMissing = false): Promise<string[]> {
  const output: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (tolerateMissing && isPathGone(error)) {
      return output;
    }
    throw error;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const absolutePath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await discoverRolloutFiles(absolutePath, true)));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      output.push(absolutePath);
    }
  }
  return output;
}

export interface CodexSessionWatcherOptions {
  sessionsDirectory: string;
  paths?: ResetRequestPaths;
  onCandidate(candidate: UsageLimitCandidate): Promise<void> | void;
  onWarning?(warning: TailWarning): Promise<void> | void;
  onFatal?(error: Error): Promise<void> | void;
  onReady?(): Promise<void> | void;
}

export class CodexSessionWatcher {
  private readonly sessionsDirectory: string;
  private readonly paths: ResetRequestPaths;
  private readonly cursorStore: CursorStore;
  private readonly tailer: IncrementalTailer;
  private readonly onFatal: NonNullable<CodexSessionWatcherOptions['onFatal']>;
  private readonly onReady: NonNullable<CodexSessionWatcherOptions['onReady']>;
  private cursorState: CursorState | null = null;
  private directoryWatchers = new Map<string, FSWatcher>();
  private lock: SingleInstanceLock | null = null;
  private pendingEvents = new Set<string>();
  private drainPromise: Promise<void> | null = null;
  private stopping = false;
  private started = false;
  private startupError: Error | null = null;

  constructor(options: CodexSessionWatcherOptions) {
    this.sessionsDirectory = path.resolve(options.sessionsDirectory);
    this.paths = options.paths ?? getAppPaths();
    this.cursorStore = new CursorStore(this.paths);
    this.tailer = new IncrementalTailer({
      sessionsDirectory: this.sessionsDirectory,
      onWarning: options.onWarning,
      onRecord: async (record, context) => {
        const candidate = extractUsageLimitCandidate(record, context);
        if (candidate) {
          await options.onCandidate(candidate);
        }
      },
    });
    this.onFatal = options.onFatal ?? (() => undefined);
    this.onReady = options.onReady ?? (() => undefined);
  }

  async start(): Promise<void> {
    if (this.stopping) {
      throw new Error('Stopped watcher instances cannot be restarted');
    }
    if (this.started || this.directoryWatchers.size > 0) {
      throw new Error('Watcher is already started');
    }
    const sessionsStats = await lstat(this.sessionsDirectory).catch(() => null);
    if (!sessionsStats?.isDirectory() || sessionsStats.isSymbolicLink()) {
      throw new Error('Codex sessions directory is unavailable or unsafe');
    }

    this.lock = await acquireSingleInstanceLock(this.paths.daemonLockFile);
    try {
      const loaded = await this.cursorStore.load();
      this.cursorState = loaded.state;
      const sessionsRootHash = sha256(this.sessionsDirectory);
      const sessionsRootChanged =
        loaded.existed && this.cursorState.sessionsRootHash !== sessionsRootHash;
      if (sessionsRootChanged) {
        this.cursorState.cursors = {};
        this.cursorState.initializedAt = new Date().toISOString();
      }
      this.cursorState.sessionsRootHash = sessionsRootHash;
      const existingFiles = await discoverRolloutFiles(this.sessionsDirectory);
      this.pruneMissingCursors(existingFiles);
      for (const filePath of existingFiles) {
        const endCursor = await this.tailer.cursorAtEnd(filePath);
        if (!endCursor) {
          continue;
        }
        if (!loaded.existed || sessionsRootChanged) {
          this.cursorState.cursors[endCursor.pathHash] = endCursor;
        }
      }
      await this.cursorStore.save(this.cursorState);
      await this.onReady();

      await this.attachDirectoryTree(this.sessionsDirectory);
      await new Promise<void>((resolve) => setImmediate(resolve));
      this.assertNoStartupError();
      this.pendingEvents.add('');
      await this.drainEvents();
      this.assertNoStartupError();
      this.started = true;
    } catch (error) {
      for (const directoryWatcher of this.directoryWatchers.values()) {
        directoryWatcher.close();
      }
      this.directoryWatchers.clear();
      await this.lock.release();
      this.lock = null;
      throw error;
    }
  }

  private async attachDirectoryTree(directoryPath: string): Promise<void> {
    const resolved = path.resolve(directoryPath);
    if (this.directoryWatchers.has(resolved) || this.stopping) {
      return;
    }
    let stats: Stats;
    try {
      stats = await lstat(resolved);
    } catch (error) {
      if (isPathGone(error)) {
        return;
      }
      throw error;
    }
    if (!stats?.isDirectory() || stats.isSymbolicLink() || this.stopping) {
      return;
    }

    let directoryWatcher: FSWatcher;
    try {
      directoryWatcher = watch(resolved, { persistent: true }, (_eventType, filename) => {
        const absolute = filename ? path.join(resolved, filename.toString()) : resolved;
        const relative = path.relative(this.sessionsDirectory, absolute);
        this.enqueueEvent(relative);
        void lstat(absolute)
          .then(async (entryStats) => {
            if (entryStats.isDirectory() && !entryStats.isSymbolicLink()) {
              await this.attachDirectoryTree(absolute);
            }
          })
          .catch(async (error: unknown) => {
            if (isPathGone(error)) {
              this.detachDirectoryTree(absolute);
              return;
            }
            const attachError = error instanceof Error ? error : new Error(String(error));
            if (!this.started) {
              this.startupError = attachError;
            } else {
              await this.handleFatal(attachError);
            }
          });
      });
    } catch (error) {
      throw new Error(`Native watcher unavailable: ${(error as Error).message}`);
    }
    directoryWatcher.on('error', (error) => {
      if (!this.started) {
        this.startupError = error;
        return;
      }
      void this.handleFatal(error);
    });
    directoryWatcher.on('close', () => {
      if (this.directoryWatchers.get(resolved) === directoryWatcher) {
        this.directoryWatchers.delete(resolved);
      }
    });
    this.directoryWatchers.set(resolved, directoryWatcher);

    const entries = await readdir(resolved, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await this.attachDirectoryTree(path.join(resolved, entry.name));
      }
    }
  }

  private enqueueEvent(relativePath: string): void {
    if (this.stopping) {
      return;
    }
    this.pendingEvents.add(relativePath);
    if (!this.started) {
      return;
    }
    if (!this.drainPromise) {
      this.drainPromise = this.drainEvents()
        .catch(async (error: unknown) => {
          await this.onFatal(error instanceof Error ? error : new Error(String(error)));
        })
        .finally(() => {
          this.drainPromise = null;
          if (this.pendingEvents.size > 0 && !this.stopping) {
            this.enqueueEvent('');
          }
        });
    }
  }

  private detachDirectoryTree(directoryPath: string): void {
    const resolved = path.resolve(directoryPath);
    const prefix = `${resolved}${path.sep}`;
    for (const [watchedPath, directoryWatcher] of this.directoryWatchers) {
      if (watchedPath === resolved || watchedPath.startsWith(prefix)) {
        this.directoryWatchers.delete(watchedPath);
        directoryWatcher.close();
      }
    }
  }

  private async drainEvents(): Promise<void> {
    const events = [...this.pendingEvents];
    this.pendingEvents.clear();
    for (const relativePath of events) {
      await this.processEvent(relativePath);
    }
    if (this.pendingEvents.size > 0) {
      await this.drainEvents();
    }
  }

  private async processEvent(relativePath: string): Promise<void> {
    if (!this.cursorState) {
      return;
    }
    const candidatePath = path.resolve(this.sessionsDirectory, relativePath);
    let pathsToTail: string[];
    const stats = relativePath ? await lstat(candidatePath).catch(() => null) : null;
    if (stats?.isFile() && candidatePath.endsWith('.jsonl')) {
      pathsToTail = [candidatePath];
    } else {
      pathsToTail = await discoverRolloutFiles(this.sessionsDirectory);
      this.pruneMissingCursors(pathsToTail);
    }

    for (const filePath of pathsToTail) {
      await this.tailer.tail(filePath, this.cursorState);
    }
    await this.cursorStore.save(this.cursorState);
  }

  private pruneMissingCursors(existingFiles: string[]): void {
    if (!this.cursorState) {
      return;
    }
    const liveHashes = new Set(existingFiles.map((filePath) => this.tailer.pathHash(filePath)));
    for (const pathHash of Object.keys(this.cursorState.cursors)) {
      if (!liveHashes.has(pathHash)) {
        delete this.cursorState.cursors[pathHash];
      }
    }
  }

  private async handleFatal(error: Error): Promise<void> {
    await this.stop();
    await this.onFatal(error);
  }

  private assertNoStartupError(): void {
    const startupError = this.startupError;
    if (startupError) {
      throw new Error(`Native watcher unavailable: ${startupError.message}`);
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    for (const directoryWatcher of this.directoryWatchers.values()) {
      directoryWatcher.close();
    }
    this.directoryWatchers.clear();
    this.started = false;
    await this.drainPromise;
    this.pendingEvents.clear();
    await this.lock?.release();
    this.lock = null;
  }
}
