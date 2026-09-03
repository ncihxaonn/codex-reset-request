import { createReadStream } from 'node:fs';
import path from 'node:path';
import { sha256 } from '../utils/hash.js';
import type { RolloutObservationContext } from '../codex/rollout-types.js';
import type { CursorState, FileCursor } from './cursor-store.js';
import { readFileIdentity } from './file-identity.js';
import { LineBuffer } from './line-buffer.js';

export interface TailWarning {
  code: 'invalid-json' | 'oversize-line' | 'unsafe-path' | 'file-unavailable';
  safeBasename: string;
}

export interface IncrementalTailerOptions {
  sessionsDirectory: string;
  onRecord(record: unknown, context: RolloutObservationContext): Promise<void> | void;
  onWarning?(warning: TailWarning): Promise<void> | void;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export class IncrementalTailer {
  private readonly sessionsDirectory: string;
  private readonly onRecord: IncrementalTailerOptions['onRecord'];
  private readonly onWarning: NonNullable<IncrementalTailerOptions['onWarning']>;

  constructor(options: IncrementalTailerOptions) {
    this.sessionsDirectory = path.resolve(options.sessionsDirectory);
    this.onRecord = options.onRecord;
    this.onWarning = options.onWarning ?? (() => undefined);
  }

  pathHash(filePath: string): string {
    return sha256(path.resolve(filePath));
  }

  async cursorAtEnd(filePath: string, observedAt: Date = new Date()): Promise<FileCursor | null> {
    const resolved = path.resolve(filePath);
    const safeBasename = path.basename(resolved);
    if (!isInside(this.sessionsDirectory, resolved) || !resolved.endsWith('.jsonl')) {
      await this.onWarning({ code: 'unsafe-path', safeBasename });
      return null;
    }
    try {
      const { identity, stats } = await readFileIdentity(resolved);
      return {
        pathHash: this.pathHash(resolved),
        safeBasename,
        fileIdentity: identity,
        byteOffset: stats.size,
        fileSize: stats.size,
        trailingPartialLine: '',
        lastObservedAt: observedAt.toISOString(),
        mtimeMs: stats.mtimeMs,
        discardingOversizeLine: false,
      };
    } catch {
      await this.onWarning({ code: 'file-unavailable', safeBasename });
      return null;
    }
  }

  async tail(filePath: string, cursorState: CursorState, observedAt: Date = new Date()): Promise<FileCursor | null> {
    const resolved = path.resolve(filePath);
    const safeBasename = path.basename(resolved);
    if (!isInside(this.sessionsDirectory, resolved) || !resolved.endsWith('.jsonl')) {
      await this.onWarning({ code: 'unsafe-path', safeBasename });
      return null;
    }

    let identity: string | null;
    let size: number;
    let mtimeMs: number;
    try {
      const file = await readFileIdentity(resolved);
      identity = file.identity;
      size = file.stats.size;
      mtimeMs = file.stats.mtimeMs;
    } catch {
      await this.onWarning({ code: 'file-unavailable', safeBasename });
      return null;
    }

    const key = this.pathHash(resolved);
    const previous = cursorState.cursors[key];
    const replaced = previous !== undefined && previous.fileIdentity !== identity;
    const truncated = previous !== undefined && size < previous.byteOffset;
    const sameSizeRewrite =
      previous !== undefined && size === previous.byteOffset && previous.mtimeMs !== undefined && mtimeMs > previous.mtimeMs;
    const startOffset = !previous || replaced || truncated || sameSizeRewrite ? 0 : previous.byteOffset;
    const initialPartial = startOffset === 0 ? '' : previous.trailingPartialLine;
    const lineBuffer = new LineBuffer({
      trailingPartialLine: initialPartial,
      discardingOversizeLine: startOffset === 0 ? false : previous?.discardingOversizeLine,
    });
    let lineOffset = Math.max(0, startOffset - Buffer.byteLength(initialPartial, 'utf8'));

    if (size > startOffset) {
      const stream = createReadStream(resolved, {
        start: startOffset,
        end: size - 1,
        encoding: 'utf8',
      });
      for await (const chunk of stream) {
        const result = lineBuffer.push(String(chunk));
        lineOffset += result.discardedBytes;
        for (let index = 0; index < result.oversizeLines; index += 1) {
          await this.onWarning({ code: 'oversize-line', safeBasename });
        }
        for (const line of result.lines) {
          const currentOffset = lineOffset;
          lineOffset += line.consumedBytes;
          if (line.text.trim().length === 0) {
            continue;
          }
          let record: unknown;
          try {
            record = JSON.parse(line.text) as unknown;
          } catch {
            await this.onWarning({ code: 'invalid-json', safeBasename });
            continue;
          }
          await this.onRecord(record, {
            safeFileName: safeBasename,
            fileIdentity: identity,
            pathHash: key,
            byteOffset: currentOffset,
            observedAt,
          });
        }
      }
    }

    const cursor: FileCursor = {
      pathHash: key,
      safeBasename,
      fileIdentity: identity,
      byteOffset: size,
      fileSize: size,
      trailingPartialLine: lineBuffer.trailingPartialLine,
      lastObservedAt: observedAt.toISOString(),
      mtimeMs,
      discardingOversizeLine: lineBuffer.isDiscardingOversizeLine,
    };
    cursorState.cursors[key] = cursor;
    return cursor;
  }
}
