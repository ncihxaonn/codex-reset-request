import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const baseCommit = 'a16f9901717008bf1ab3ea0b715dfd95dedc95b0';
const baseTag = 'upstream-bird-v3-base';

interface Check {
  code: string;
  ok: boolean;
}

function git(args: string[]) {
  return spawnSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1_024 * 1_024,
    shell: false,
    windowsHide: true,
  });
}

async function text(file: string): Promise<string> {
  return await readFile(path.join(repositoryRoot, file), 'utf8');
}

function includesAll(value: string, fragments: string[]): boolean {
  return fragments.every((fragment) => value.includes(fragment));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    console.error('usage: pnpm run verify:attribution');
    process.exitCode = 2;
    return;
  }

  const [license, upstream, notices, readme, chineseReadme, packageRaw] = await Promise.all([
    text('LICENSE'),
    text('UPSTREAM.md'),
    text('THIRD_PARTY_NOTICES.md'),
    text('README.md'),
    text('README.zh-CN.md'),
    text('package.json'),
  ]);
  const packageJson = JSON.parse(packageRaw) as {
    name?: unknown;
    version?: unknown;
    private?: unknown;
    license?: unknown;
    bin?: Record<string, unknown>;
    files?: unknown;
  };
  const packagedFiles = Array.isArray(packageJson.files) ? packageJson.files : [];
  const checks: Check[] = [
    {
      code: 'license-notices',
      ok: includesAll(license, [
        'MIT License',
        'Copyright (c) 2024 Peter Steinberger (steipete)',
        'Copyright (c) 2025 Peter Steinberger',
        'Copyright (c) 2026 0xEnc0der',
        'Copyright (c) 2026 Codex Reset Request contributors',
        'Permission is hereby granted, free of charge',
        'The above copyright notice and this permission notice shall be included',
        'THE SOFTWARE IS PROVIDED "AS IS"',
      ]),
    },
    {
      code: 'upstream-provenance',
      ok: includesAll(upstream, [
        'https://github.com/0xEnc0der/bird-x-cli',
        'https://github.com/zaydiscold/bird',
        'https://github.com/jawond/bird',
        'Peter Steinberger',
        baseCommit,
        baseTag,
        'Base package version: `0.9.0`',
        'Base README version: `Bird CLI v3.0.0`',
        'Date forked: `2026-08-28`',
      ]),
    },
    {
      code: 'third-party-notices',
      ok: includesAll(notices, [
        'Peter Steinberger',
        'zaydiscold/bird',
        '0xEnc0der/bird-x-cli',
        'MIT License',
        'independent project',
        'not endorsed',
      ]),
    },
    {
      code: 'readme-attribution',
      ok: [readme, chineseReadme].every((value) =>
        includesAll(value, ['0xEnc0der/bird-x-cli', 'zaydiscold/bird', 'jawond/bird', 'UPSTREAM.md', 'THIRD_PARTY_NOTICES.md', 'LICENSE']),
      ),
    },
    {
      code: 'package-identity',
      ok:
        packageJson.name === 'codex-reset-request' &&
        packageJson.version === '0.1.0-alpha.0' &&
        packageJson.private === true &&
        packageJson.license === 'MIT' &&
        packageJson.bin?.bird === 'dist/cli.js' &&
        packageJson.bin?.['codex-reset-request'] === 'dist/reset/cli.js',
    },
    {
      code: 'packaged-attribution',
      ok: ['LICENSE', 'README.md', 'DISCLAIMER.md', 'UPSTREAM.md', 'THIRD_PARTY_NOTICES.md'].every((file) =>
        packagedFiles.includes(file),
      ),
    },
  ];

  const shallow = git(['rev-parse', '--is-shallow-repository']);
  checks.push({ code: 'full-git-history', ok: shallow.status === 0 && shallow.stdout.trim() === 'false' });
  const baseObject = git(['cat-file', '-e', `${baseCommit}^{commit}`]);
  checks.push({ code: 'base-object', ok: baseObject.status === 0 });
  const tag = git(['rev-parse', `${baseTag}^{commit}`]);
  checks.push({ code: 'base-tag', ok: tag.status === 0 && tag.stdout.trim() === baseCommit });
  const ancestor = git(['merge-base', '--is-ancestor', baseCommit, 'HEAD']);
  checks.push({ code: 'base-ancestry', ok: ancestor.status === 0 });

  const failed = checks.filter((check) => !check.ok).map((check) => check.code).sort();
  if (failed.length > 0) {
    for (const code of failed) console.error(`repository:1:${code}`);
    process.exitCode = 1;
    return;
  }
  console.log('verify-attribution: ok');
}

await main();
