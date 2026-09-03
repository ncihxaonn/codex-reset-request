import { z } from 'zod';
import type { ResetRequestPaths } from '../config/paths.js';
import { ensureAppDirectories, getAppPaths } from '../config/paths.js';
import { readJsonFile, writeJsonAtomic } from '../utils/atomic-file.js';

export const fileCursorSchema = z.object({
  pathHash: z.string().regex(/^[a-f0-9]{64}$/),
  safeBasename: z.string().min(1).max(255),
  fileIdentity: z.string().nullable(),
  byteOffset: z.number().int().nonnegative(),
  fileSize: z.number().int().nonnegative(),
  trailingPartialLine: z.string(),
  lastObservedAt: z.iso.datetime(),
  mtimeMs: z.number().nonnegative().optional(),
  discardingOversizeLine: z.boolean().optional(),
});

const cursorStateSchema = z.object({
  version: z.literal(1),
  initializedAt: z.iso.datetime(),
  sessionsRootHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  cursors: z.record(z.string(), fileCursorSchema),
});

export type FileCursor = z.infer<typeof fileCursorSchema>;
export type CursorState = z.infer<typeof cursorStateSchema>;

export interface LoadedCursorState {
  existed: boolean;
  state: CursorState;
}

export class CursorStore {
  readonly paths: ResetRequestPaths;

  constructor(paths: ResetRequestPaths = getAppPaths()) {
    this.paths = paths;
  }

  async load(): Promise<LoadedCursorState> {
    const raw = await readJsonFile(this.paths.cursorFile);
    if (raw === null) {
      return {
        existed: false,
        state: { version: 1, initializedAt: new Date().toISOString(), cursors: {} },
      };
    }
    return { existed: true, state: cursorStateSchema.parse(raw) };
  }

  async save(state: CursorState): Promise<void> {
    await ensureAppDirectories(this.paths);
    await writeJsonAtomic(this.paths.cursorFile, cursorStateSchema.parse(state));
  }
}
