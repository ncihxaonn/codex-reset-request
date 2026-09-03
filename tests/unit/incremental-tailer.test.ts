import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CursorStore, type CursorState } from '../../src/reset/watcher/cursor-store.js';
import { IncrementalTailer } from '../../src/reset/watcher/incremental-tailer.js';
import { LineBuffer } from '../../src/reset/watcher/line-buffer.js';
import { createTemporaryHome, type TemporaryHome } from '../helpers/temporary-home.js';

const homes: TemporaryHome[] = [];

async function fixture() {
  const home = await createTemporaryHome();
  homes.push(home);
  const sessionsDirectory = path.join(home.root, 'codex', 'sessions');
  await mkdir(sessionsDirectory, { recursive: true });
  const records: unknown[] = [];
  const warnings: string[] = [];
  const tailer = new IncrementalTailer({
    sessionsDirectory,
    onRecord(record) {
      records.push(record);
    },
    onWarning(warning) {
      warnings.push(warning.code);
    },
  });
  const state: CursorState = {
    version: 1,
    initializedAt: new Date().toISOString(),
    cursors: {},
  };
  return { home, sessionsDirectory, records, warnings, tailer, state };
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => home.cleanup()));
});

describe('incremental JSONL tailer', () => {
  it('starts an existing rollout at EOF', async () => {
    const { sessionsDirectory, records, tailer, state } = await fixture();
    const filePath = path.join(sessionsDirectory, 'existing.jsonl');
    await writeFile(filePath, '{"old":true}\n', 'utf8');
    const cursor = await tailer.cursorAtEnd(filePath);
    expect(cursor).not.toBeNull();
    if (cursor) {
      state.cursors[cursor.pathHash] = cursor;
    }
    await appendFile(filePath, '{"new":true}\n', 'utf8');

    await tailer.tail(filePath, state);

    expect(records).toEqual([{ new: true }]);
  });

  it('starts a newly observed rollout at byte zero', async () => {
    const { sessionsDirectory, records, tailer, state } = await fixture();
    const filePath = path.join(sessionsDirectory, 'new.jsonl');
    await writeFile(filePath, '{"first":true}\n', 'utf8');

    await tailer.tail(filePath, state);

    expect(records).toEqual([{ first: true }]);
  });

  it('buffers a partial line across appends', async () => {
    const { sessionsDirectory, records, tailer, state } = await fixture();
    const filePath = path.join(sessionsDirectory, 'partial.jsonl');
    await writeFile(filePath, '{"partial":', 'utf8');
    await tailer.tail(filePath, state);
    expect(records).toEqual([]);

    await appendFile(filePath, 'true}\n', 'utf8');
    await tailer.tail(filePath, state);

    expect(records).toEqual([{ partial: true }]);
  });

  it('processes multiple lines from one append', async () => {
    const { sessionsDirectory, records, tailer, state } = await fixture();
    const filePath = path.join(sessionsDirectory, 'multiple.jsonl');
    await writeFile(filePath, '{"one":1}\n{"two":2}\n', 'utf8');

    await tailer.tail(filePath, state);

    expect(records).toEqual([{ one: 1 }, { two: 2 }]);
  });

  it('restarts at zero after truncation', async () => {
    const { sessionsDirectory, records, tailer, state } = await fixture();
    const filePath = path.join(sessionsDirectory, 'truncate.jsonl');
    await writeFile(filePath, '{"longValue":"before-truncation"}\n', 'utf8');
    await tailer.tail(filePath, state);
    records.length = 0;
    await writeFile(filePath, '{"after":true}\n', 'utf8');

    await tailer.tail(filePath, state);

    expect(records).toEqual([{ after: true }]);
  });

  it('restarts at zero when a file is replaced', async () => {
    const { sessionsDirectory, records, tailer, state } = await fixture();
    const filePath = path.join(sessionsDirectory, 'replace.jsonl');
    const replacementPath = path.join(sessionsDirectory, 'replacement.tmp');
    await writeFile(filePath, '{"before":true}\n', 'utf8');
    await tailer.tail(filePath, state);
    records.length = 0;
    await writeFile(replacementPath, '{"replacement":true}\n', 'utf8');
    await rename(replacementPath, filePath);

    await tailer.tail(filePath, state);

    expect(records).toEqual([{ replacement: true }]);
  });

  it('persists only hashed paths and safe basenames', async () => {
    const { home, sessionsDirectory, tailer, state } = await fixture();
    const filePath = path.join(sessionsDirectory, 'safe.jsonl');
    await writeFile(filePath, '{"safe":true}\n', 'utf8');
    await tailer.tail(filePath, state);
    await new CursorStore(home.paths).save(state);

    const serialized = JSON.stringify((await new CursorStore(home.paths).load()).state);
    expect(serialized).not.toContain(sessionsDirectory);
    expect(serialized).toContain('safe.jsonl');
  });

  it('drops oversized lines without exposing their content', () => {
    const buffer = new LineBuffer({ maxLineBytes: 10 });
    const result = buffer.push('12345678901\n{"ok":1}\n');
    expect(result.oversizeLines).toBe(1);
    expect(result.lines.map((line) => line.text)).toEqual(['{"ok":1}']);
  });

  it('propagates downstream callback failures instead of consuming the event', async () => {
    const home = await createTemporaryHome();
    homes.push(home);
    const sessionsDirectory = path.join(home.root, 'codex', 'sessions');
    await mkdir(sessionsDirectory, { recursive: true });
    const state: CursorState = { version: 1, initializedAt: new Date().toISOString(), cursors: {} };
    const filePath = path.join(sessionsDirectory, 'pipeline-error.jsonl');
    await writeFile(filePath, '{"valid":true}\n', 'utf8');
    const tailer = new IncrementalTailer({
      sessionsDirectory,
      onRecord() {
        throw new Error('pipeline-failed');
      },
    });

    await expect(tailer.tail(filePath, state)).rejects.toThrow('pipeline-failed');
    expect(state.cursors).toEqual({});
  });
});
