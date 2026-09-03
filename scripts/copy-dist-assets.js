import { access, chmod, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceLib = path.join(projectRoot, 'src', 'lib');
const distLib = path.join(projectRoot, 'dist', 'lib');

await mkdir(distLib, { recursive: true });

for (const asset of ['features.json', 'query-ids.json']) {
  await copyFile(path.join(sourceLib, asset), path.join(distLib, asset));
}

for (const relativeCli of ['cli.js', path.join('reset', 'cli.js')]) {
  const cliPath = path.join(projectRoot, 'dist', relativeCli);
  try {
    await access(cliPath);
    await chmod(cliPath, 0o755);
  } catch {
    // The reset CLI is added in a later implementation commit.
  }
}
