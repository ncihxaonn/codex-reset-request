import { readJsonFile, writeJsonAtomic } from '../utils/atomic-file.js';
import type { ResetRequestPaths } from '../config/paths.js';
import { ensureAppDirectories, getAppPaths } from '../config/paths.js';
import { migrateState } from './migrations.js';
import { resetStateSchema, type ResetState } from './schema.js';

export class StateStore {
  readonly paths: ResetRequestPaths;

  constructor(paths: ResetRequestPaths = getAppPaths()) {
    this.paths = paths;
  }

  async load(): Promise<ResetState> {
    return migrateState(await readJsonFile(this.paths.stateFile));
  }

  async save(state: ResetState): Promise<ResetState> {
    const validated = resetStateSchema.parse({
      ...state,
      updatedAt: new Date().toISOString(),
    });
    await ensureAppDirectories(this.paths);
    await writeJsonAtomic(this.paths.stateFile, validated);
    return validated;
  }

  async update(mutator: (state: ResetState) => ResetState | undefined): Promise<ResetState> {
    const current = await this.load();
    const draft = structuredClone(current);
    const result = mutator(draft);
    return this.save(result ?? draft);
  }
}
