import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getAppPaths, type ResetRequestPaths } from '../../src/reset/config/paths.js';

export interface TemporaryHome {
  root: string;
  paths: ResetRequestPaths;
  cleanup(): Promise<void>;
}

export async function createTemporaryHome(): Promise<TemporaryHome> {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-reset-request-'));
  const paths = getAppPaths({
    platform: process.platform,
    homeDirectory: root,
    env: {
      CRR_CONFIG_DIR: path.join(root, 'config'),
      CRR_STATE_DIR: path.join(root, 'state'),
      CRR_LOG_DIR: path.join(root, 'logs'),
    },
  });
  return {
    root,
    paths,
    async cleanup(): Promise<void> {
      await rm(root, { recursive: true, force: true });
    },
  };
}
