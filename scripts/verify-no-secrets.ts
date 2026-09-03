import { spawnSync } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface Finding {
  file: string;
  line: number;
  code: string;
}

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const maximumTextBytes = 4 * 1_024 * 1_024;
const excludedDirectories = new Set(['.git', '.tmp', 'coverage', 'dist', 'node_modules', '.pnpm-store']);

const contentRules: Array<{ code: string; pattern: RegExp }> = [
  { code: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { code: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { code: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{30,}\b/ },
  { code: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { code: 'openai-key', pattern: /\bsk-(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{20,}\b/ },
  { code: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { code: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { code: 'live-payment-key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { code: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{17,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/ },
  { code: 'x-auth-cookie', pattern: /\bauth_token\s*=\s*[a-f0-9]{40,}\b/i },
  {
    code: 'x-auth-literal',
    pattern: /\b(?:auth_token|authToken)['"]?\s*[:=]\s*['"]?[a-f0-9]{40,}['"]?/i,
  },
  { code: 'x-csrf-literal', pattern: /\bct0['"]?\s*[:=]\s*['"]?[a-f0-9]{40,}['"]?/i },
  {
    code: 'named-secret-literal',
    pattern: /\b(?:api[_-]?key|client[_-]?secret|password)\s*[:=]\s*['"][A-Za-z0-9_+./=-]{24,}['"]/i,
  },
  { code: 'credential-in-url', pattern: /https?:\/\/[^\s/:@]+:[^\s/@]{16,}@/i },
];

function normalized(filePath: string): string {
  return filePath.split(path.sep).join('/').replace(/^\.\//, '');
}

function relativePath(filePath: string): string {
  return normalized(path.relative(repositoryRoot, filePath));
}

function sensitivePathCode(file: string): string | null {
  const normalizedFile = normalized(file);
  const basename = path.posix.basename(normalizedFile);
  if (/^\.env(?:\..+)?$/i.test(basename) && !/^\.env\.(?:example|sample|template)$/i.test(basename)) {
    return 'environment-file';
  }
  if (/^(?:auth\.json|cookies?(?:\.(?:sqlite|sqlite3|db|binarycookies))?|login data)$/i.test(basename)) {
    return 'credential-store-file';
  }
  if (/\.(?:key|p12|pfx|pem)$/i.test(basename)) return 'private-key-file';
  if (/(?:^|\/)\.codex\/(?:auth\.json|sessions\/)/i.test(normalizedFile)) return 'codex-credential-or-session-file';
  if (/rollout-.*\.jsonl$/i.test(basename)) return 'real-rollout-file';
  return null;
}

function scanText(file: string, value: string): Finding[] {
  const findings: Finding[] = [];
  for (const [index, line] of value.split(/\r?\n/).entries()) {
    for (const rule of contentRules) {
      if (rule.pattern.test(line)) findings.push({ file: normalized(file), line: index + 1, code: rule.code });
    }
  }
  return findings;
}

export function scanSecretPayload(file: string, bytes: Uint8Array): Finding[] {
  // UTF-8 decoding preserves ASCII credential material even when the payload is
  // otherwise binary or contains NUL bytes. Secret-like bytes must not be able
  // to bypass the gate by changing an extension or adding binary content.
  return scanText(file, Buffer.from(bytes).toString('utf8'));
}

async function workingTreeFiles(directory = repositoryRoot): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excludedDirectories.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      output.push(entryPath);
    } else if (entry.isDirectory()) {
      output.push(...(await workingTreeFiles(entryPath)));
    } else if (entry.isFile()) {
      output.push(entryPath);
    }
  }
  return output.sort();
}

async function scanWorkingTree(): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const filePath of await workingTreeFiles()) {
    const file = relativePath(filePath);
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink()) {
      findings.push({ file, line: 1, code: 'symlink-unscanned' });
      continue;
    }
    const pathCode = sensitivePathCode(file);
    if (pathCode) findings.push({ file, line: 1, code: pathCode });
    if (stats.size > maximumTextBytes) {
      findings.push({ file, line: 1, code: 'oversize-file-unscanned' });
      continue;
    }
    const bytes = await readFile(filePath);
    findings.push(...scanSecretPayload(file, bytes));
  }
  return findings;
}

function git(
  args: string[],
  options: { input?: string; maxBuffer?: number; encoding?: BufferEncoding | 'buffer' } = {},
) {
  return spawnSync('git', args, {
    cwd: repositoryRoot,
    encoding: options.encoding ?? 'utf8',
    input: options.input,
    maxBuffer: options.maxBuffer ?? 16 * 1_024 * 1_024,
    shell: false,
    windowsHide: true,
  });
}

function requireGitText(args: string[], code: string): string {
  const result = git(args);
  if (result.status !== 0 || typeof result.stdout !== 'string') throw new Error(code);
  return result.stdout;
}

function scanHistory(): Finding[] {
  const findings: Finding[] = [];
  const shallow = requireGitText(['rev-parse', '--is-shallow-repository'], 'git-history-unavailable').trim();
  if (shallow !== 'false') throw new Error('git-history-shallow');
  const commits = requireGitText(['rev-list', 'HEAD'], 'git-history-unavailable')
    .split(/\r?\n/)
    .filter(Boolean);
  const messages = requireGitText(['log', '--format=%B%x00', 'HEAD'], 'git-history-unavailable').replaceAll('\0', '\n');
  findings.push(...scanText('history/commit-messages', messages));
  for (const commit of commits) {
    const changed = git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commit]);
    if (changed.status !== 0 || typeof changed.stdout !== 'string') throw new Error('git-history-paths-unavailable');
    for (const file of changed.stdout.split('\0').filter(Boolean)) {
      const pathCode = sensitivePathCode(file);
      if (pathCode) findings.push({ file: `history/${normalized(file)}`, line: 1, code: pathCode });
    }
  }

  const objects = requireGitText(['rev-list', '--objects', 'HEAD'], 'git-history-unavailable')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(' ');
      return { sha: separator === -1 ? line : line.slice(0, separator), file: separator === -1 ? '' : line.slice(separator + 1) };
    });
  const uniqueObjects = [...new Map(objects.map((object) => [object.sha, object])).values()];
  const checked = git(['cat-file', '--batch-check'], { input: `${uniqueObjects.map(({ sha }) => sha).join('\n')}\n` });
  if (checked.status !== 0 || typeof checked.stdout !== 'string') throw new Error('git-history-objects-unavailable');
  const metadata = checked.stdout.split(/\r?\n/).filter(Boolean);
  for (const [index, line] of metadata.entries()) {
    const object = uniqueObjects[index];
    const match = /^([0-9a-f]+)\s+(\w+)\s+(\d+)$/.exec(line);
    if (!object || !match || match[2] !== 'blob') continue;
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size) || size > maximumTextBytes) {
      findings.push({ file: `history/${normalized(object.file || 'unknown')}`, line: 1, code: 'oversize-blob-unscanned' });
      continue;
    }
    const blob = git(['cat-file', 'blob', object.sha], { maxBuffer: maximumTextBytes + 1, encoding: 'buffer' });
    if (blob.status !== 0 || !Buffer.isBuffer(blob.stdout)) throw new Error('git-history-blob-unavailable');
    findings.push(...scanSecretPayload(`history/${normalized(object.file || 'unknown')}`, blob.stdout));
  }
  return findings;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    console.error('usage: pnpm run verify:no-secrets');
    process.exitCode = 2;
    return;
  }
  let findings: Finding[];
  try {
    findings = [...(await scanWorkingTree()), ...scanHistory()];
  } catch (error) {
    const code = error instanceof Error ? error.message : 'secret-scan-failed';
    console.error(`repository:1:${code}`);
    process.exitCode = 1;
    return;
  }
  const unique = [...new Map(findings.map((finding) => [`${finding.file}:${finding.line}:${finding.code}`, finding])).values()]
    .sort((left, right) =>
      `${left.file}:${left.line.toString().padStart(8, '0')}:${left.code}`.localeCompare(
        `${right.file}:${right.line.toString().padStart(8, '0')}:${right.code}`,
      ),
    );
  if (unique.length > 0) {
    for (const finding of unique) console.error(`${finding.file}:${finding.line}:${finding.code}`);
    process.exitCode = 1;
    return;
  }
  console.log('verify-no-secrets: ok');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
