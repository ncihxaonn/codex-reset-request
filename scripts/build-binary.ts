import { readFile } from 'node:fs/promises';
import { runBoundedCommand } from '../src/reset/utils/process.js';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
  version?: unknown;
};
const version = typeof packageJson.version === 'string' ? packageJson.version : 'unknown';
const git = await runBoundedCommand('git', ['rev-parse', '--short=8', 'HEAD'], { timeoutMs: 5_000 });
const gitSha = git.ok && /^[0-9a-f]{8}$/i.test(git.stdout) ? git.stdout : 'unknown';
const result = await runBoundedCommand(
  'bun',
  ['build', '--compile', '--minify', '--env=BIRD_*', 'src/cli.ts', '--outfile', 'bird'],
  {
    timeoutMs: 120_000,
    environment: { ...process.env, BIRD_VERSION: version, BIRD_GIT_SHA: gitSha },
  },
);

if (!result.ok) {
  console.error(`build-binary:${result.safeCode ?? 'bun-build-failed'}`);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, code: 'bird-binary-built', output: 'bird' }));
}
