import { lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDirectory = path.join(projectRoot, 'dist');

const distState = await lstat(distDirectory).catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
if (distState && (!distState.isDirectory() || distState.isSymbolicLink())) {
  throw new Error('Refusing to replace an unsafe dist path');
}
if (distState) {
  await rm(distDirectory, { recursive: true });
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Build subprocess failed (${signal ?? code ?? 'unknown'})`));
      }
    });
  });
}

await run(process.execPath, [path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc')]);
await run(process.execPath, [path.join(projectRoot, 'scripts', 'copy-dist-assets.js')]);
