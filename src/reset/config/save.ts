import { writeJsonAtomic } from '../utils/atomic-file.js';
import type { ResetRequestPaths } from './paths.js';
import { ensureAppDirectories, getAppPaths } from './paths.js';
import { resetRequestConfigSchema, type ResetRequestConfig } from './schema.js';

export async function saveConfig(
  config: ResetRequestConfig,
  paths: ResetRequestPaths = getAppPaths(),
): Promise<ResetRequestConfig> {
  const validated = resetRequestConfigSchema.parse(config);
  await ensureAppDirectories(paths);
  await writeJsonAtomic(paths.configFile, validated);
  return validated;
}
