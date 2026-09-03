import { readJsonFile } from '../utils/atomic-file.js';
import type { ResetRequestPaths } from './paths.js';
import { getAppPaths } from './paths.js';
import { createDefaultConfig, resetRequestConfigSchema, type ResetRequestConfig } from './schema.js';

export async function loadConfig(paths: ResetRequestPaths = getAppPaths()): Promise<ResetRequestConfig> {
  const raw = await readJsonFile(paths.configFile);
  if (raw === null) {
    return createDefaultConfig();
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const migrated = { ...raw } as Record<string, unknown>;
    if (migrated.mode === 'notify') {
      migrated.mode = 'dry-run';
    }
    delete migrated.notifications;
    return resetRequestConfigSchema.parse(migrated);
  }
  return resetRequestConfigSchema.parse(raw);
}
