import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCodexVersion } from '../src/reset/codex/compatibility.js';
import { runBoundedCommand } from '../src/reset/utils/process.js';

type JsonObject = Record<string, unknown>;

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const generatedRoot = path.join(repositoryRoot, '.tmp');
const typescriptTarget = path.join(generatedRoot, 'codex-schema');
const jsonTarget = path.join(generatedRoot, 'codex-json-schema');
const markerName = '.codex-reset-request-generated';
const markerValue = 'codex-reset-request-schema-v1\n';

class SafeSchemaError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function includesStrings(value: unknown, required: string[]): boolean {
  const strings = array(value).filter((item): item is string => typeof item === 'string');
  return required.every((item) => strings.includes(item));
}

async function json(filePath: string): Promise<JsonObject> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    const record = object(parsed);
    if (!record) throw new SafeSchemaError('schema-json-shape');
    return record;
  } catch (error) {
    if (error instanceof SafeSchemaError) throw error;
    throw new SafeSchemaError('schema-json-unreadable');
  }
}

async function validateGeneratedSchemas(typescriptDirectory: string, jsonDirectory: string): Promise<void> {
  const clientRequest = await json(path.join(jsonDirectory, 'ClientRequest.json'));
  const hasRateLimitRequest = array(clientRequest.oneOf).some((candidate) => {
    const branch = object(candidate);
    const properties = object(branch?.properties);
    const method = object(properties?.method);
    const params = object(properties?.params);
    return (
      includesStrings(branch?.required, ['id', 'method']) &&
      method?.type === 'string' &&
      includesStrings(method.enum, ['account/rateLimits/read']) &&
      params?.type === 'null'
    );
  });
  if (!hasRateLimitRequest) throw new SafeSchemaError('client-request-schema-incompatible');

  const initialize = await json(path.join(jsonDirectory, 'v1', 'InitializeResponse.json'));
  const initializeProperties = object(initialize.properties);
  const initializeDefinitions = object(initialize.definitions);
  const absolutePath = object(initializeDefinitions?.AbsolutePathBuf);
  const codexHome = object(initializeProperties?.codexHome);
  const codexHomeRef = object(array(codexHome?.allOf)[0]);
  if (
    !includesStrings(initialize.required, ['codexHome', 'platformFamily', 'platformOs', 'userAgent']) ||
    object(initializeProperties?.userAgent)?.type !== 'string' ||
    object(initializeProperties?.platformFamily)?.type !== 'string' ||
    object(initializeProperties?.platformOs)?.type !== 'string' ||
    codexHomeRef?.$ref !== '#/definitions/AbsolutePathBuf' ||
    absolutePath?.type !== 'string'
  ) {
    throw new SafeSchemaError('initialize-schema-incompatible');
  }

  const rateLimits = await json(path.join(jsonDirectory, 'v2', 'GetAccountRateLimitsResponse.json'));
  const rateProperties = object(rateLimits.properties);
  const rateDefinitions = object(rateLimits.definitions);
  const primaryRateLimits = object(rateProperties?.rateLimits);
  const primaryRateLimitRef = object(array(primaryRateLimits?.allOf)[0]);
  const byLimitId = object(rateProperties?.rateLimitsByLimitId);
  const additionalProperties = object(byLimitId?.additionalProperties);
  const snapshot = object(rateDefinitions?.RateLimitSnapshot);
  const snapshotProperties = object(snapshot?.properties);
  const window = object(rateDefinitions?.RateLimitWindow);
  const windowProperties = object(window?.properties);
  const expectedSnapshotProperties = [
    'limitId',
    'limitName',
    'primary',
    'secondary',
    'credits',
    'individualLimit',
    'planType',
    'rateLimitReachedType',
  ];
  if (
    !includesStrings(rateLimits.required, ['rateLimits']) ||
    primaryRateLimitRef?.$ref !== '#/definitions/RateLimitSnapshot' ||
    !includesStrings(byLimitId?.type, ['object', 'null']) ||
    additionalProperties?.$ref !== '#/definitions/RateLimitSnapshot' ||
    !expectedSnapshotProperties.every((property) => Object.hasOwn(snapshotProperties ?? {}, property)) ||
    !includesStrings(window?.required, ['usedPercent']) ||
    !['usedPercent', 'windowDurationMins', 'resetsAt'].every((property) =>
      Object.hasOwn(windowProperties ?? {}, property),
    ) ||
    object(windowProperties?.usedPercent)?.type !== 'integer' ||
    !includesStrings(object(windowProperties?.resetsAt)?.type, ['integer', 'null'])
  ) {
    throw new SafeSchemaError('rate-limit-schema-incompatible');
  }

  const [clientRequestType, initializeType, rateLimitsType] = await Promise.all([
    readFile(path.join(typescriptDirectory, 'ClientRequest.ts'), 'utf8'),
    readFile(path.join(typescriptDirectory, 'InitializeResponse.ts'), 'utf8'),
    readFile(path.join(typescriptDirectory, 'v2', 'GetAccountRateLimitsResponse.ts'), 'utf8'),
  ]).catch(() => {
    throw new SafeSchemaError('schema-typescript-unreadable');
  });
  const generatedHeader = 'GENERATED CODE! DO NOT MODIFY BY HAND!';
  if (
    !clientRequestType.includes(generatedHeader) ||
    !clientRequestType.includes('"method": "account/rateLimits/read"') ||
    !initializeType.includes(generatedHeader) ||
    !/userAgent:\s*string/.test(initializeType) ||
    !/codexHome:\s*AbsolutePathBuf/.test(initializeType) ||
    !/platformFamily:\s*string/.test(initializeType) ||
    !/platformOs:\s*string/.test(initializeType) ||
    !rateLimitsType.includes(generatedHeader) ||
    !/rateLimits:\s*RateLimitSnapshot/.test(rateLimitsType) ||
    !/rateLimitsByLimitId:\s*\{\s*\[key in string\]\?:\s*RateLimitSnapshot\s*\}\s*\|\s*null/.test(rateLimitsType)
  ) {
    throw new SafeSchemaError('schema-typescript-incompatible');
  }
}

async function generatedFiles(directory: string, prefix = ''): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === markerName) continue;
    const relative = prefix ? path.posix.join(prefix, entry.name) : entry.name;
    const filePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new SafeSchemaError('schema-tree-symlink');
    if (entry.isDirectory()) output.push(...(await generatedFiles(filePath, relative)));
    else if (entry.isFile()) output.push(relative);
  }
  return output.sort();
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  const record = object(value);
  if (!record) return value;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalJson(record[key])]));
}

async function canonicalFile(directory: string, relative: string): Promise<Buffer> {
  const value = await readFile(path.join(directory, ...relative.split('/')), 'utf8');
  if (relative.endsWith('.json')) {
    return Buffer.from(`${JSON.stringify(canonicalJson(JSON.parse(value) as unknown), null, 2)}\n`, 'utf8');
  }
  return Buffer.from(`${value.replaceAll('\r\n', '\n').replace(/\n*$/, '')}\n`, 'utf8');
}

async function treesEqual(generated: string, existing: string): Promise<boolean> {
  const marker = await readFile(path.join(existing, markerName), 'utf8').catch(() => '');
  if (marker !== markerValue) return false;
  const generatedList = await generatedFiles(generated);
  const existingList = await generatedFiles(existing);
  if (generatedList.length !== existingList.length || generatedList.some((file, index) => file !== existingList[index])) {
    return false;
  }
  for (const file of generatedList) {
    const [left, right] = await Promise.all([canonicalFile(generated, file), canonicalFile(existing, file)]);
    if (!left.equals(right)) return false;
  }
  return true;
}

async function prepareStage(source: string, label: string): Promise<string> {
  const stage = path.join(generatedRoot, `.${label}-next-${randomUUID()}`);
  try {
    await cp(source, stage, { recursive: true, force: false, errorOnExist: true });
    await writeFile(path.join(stage, markerName), markerValue, { encoding: 'utf8', mode: 0o600 });
    return stage;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

interface GeneratedReplacement {
  stage: string;
  target: string;
  backup: string | null;
  backedUp: boolean;
  installed: boolean;
}

async function preflightGeneratedTarget(stage: string, target: string): Promise<GeneratedReplacement> {
  const staged = await lstat(stage).catch(() => null);
  if (!staged?.isDirectory() || staged.isSymbolicLink()) {
    throw new SafeSchemaError('schema-stage-unsafe');
  }
  const stageMarker = await readFile(path.join(stage, markerName), 'utf8').catch(() => '');
  if (stageMarker !== markerValue) throw new SafeSchemaError('schema-stage-not-owned');
  const current = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (current && (!current.isDirectory() || current.isSymbolicLink())) {
    throw new SafeSchemaError('schema-target-unsafe');
  }
  if (current) {
    const marker = await readFile(path.join(target, markerName), 'utf8').catch(() => '');
    if (marker !== markerValue) throw new SafeSchemaError('schema-target-not-owned');
  }
  return {
    stage,
    target,
    backup: current ? `${target}.old-${randomUUID()}` : null,
    backedUp: false,
    installed: false,
  };
}

async function rollbackGeneratedReplacements(replacements: GeneratedReplacement[]): Promise<void> {
  let rollbackFailed = false;
  for (const replacement of [...replacements].reverse()) {
    if (replacement.installed) {
      await rm(replacement.target, { recursive: true, force: true }).catch(() => {
        rollbackFailed = true;
      });
      replacement.installed = false;
    }
    if (replacement.backedUp && replacement.backup) {
      await rename(replacement.backup, replacement.target).catch(() => {
        rollbackFailed = true;
      });
      replacement.backedUp = false;
    }
  }
  if (rollbackFailed) throw new SafeSchemaError('schema-rollback-failed');
}

export async function replaceGeneratedDirectories(
  stages: Array<{ stage: string; target: string }>,
): Promise<void> {
  // Validate the whole pair before moving either current tree. Backups are kept
  // until both new trees are installed so a failure cannot leave mixed versions.
  const replacements = await Promise.all(
    stages.map(async ({ stage, target }) => await preflightGeneratedTarget(stage, target)),
  );
  try {
    for (const replacement of replacements) {
      if (!replacement.backup) continue;
      await rename(replacement.target, replacement.backup);
      replacement.backedUp = true;
    }
    for (const replacement of replacements) {
      await rename(replacement.stage, replacement.target);
      replacement.installed = true;
    }
  } catch (error) {
    await rollbackGeneratedReplacements(replacements);
    throw error;
  }
  await Promise.all(
    replacements.map(async ({ backup }) => {
      if (backup) await rm(backup, { recursive: true });
    }),
  );
}

async function generateInto(typescriptDirectory: string, jsonDirectory: string): Promise<string> {
  const versionResult = await runBoundedCommand('codex', ['--version'], { timeoutMs: 10_000 });
  const version = versionResult.ok ? parseCodexVersion(versionResult.stdout)?.rawVersion : null;
  if (!version) throw new SafeSchemaError(versionResult.safeCode ?? 'codex-version-unavailable');
  for (const args of [
    ['app-server', 'generate-ts', '--out', typescriptDirectory],
    ['app-server', 'generate-json-schema', '--out', jsonDirectory],
  ]) {
    const result = await runBoundedCommand('codex', args, { timeoutMs: 120_000, maxOutputBytes: 64 * 1_024 });
    if (!result.ok) throw new SafeSchemaError(result.safeCode ?? 'codex-schema-command-failed');
  }
  return version;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const check = args.length === 1 && args[0] === '--check';
  if (args.length > 1 || (args.length === 1 && !check)) {
    console.error('usage: pnpm run codex:schemas | pnpm run codex:schemas:check');
    process.exitCode = 2;
    return;
  }

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'codex-reset-request-schema-'));
  const temporaryTypescript = path.join(temporaryRoot, 'typescript');
  const temporaryJson = path.join(temporaryRoot, 'json');
  let stages: string[] = [];
  try {
    const version = await generateInto(temporaryTypescript, temporaryJson);
    await validateGeneratedSchemas(temporaryTypescript, temporaryJson);
    if (check) {
      const matches =
        (await treesEqual(temporaryTypescript, typescriptTarget).catch(() => false)) &&
        (await treesEqual(temporaryJson, jsonTarget).catch(() => false));
      if (!matches) throw new SafeSchemaError('generated-schema-drift');
      console.log(JSON.stringify({ ok: true, code: 'generated-schemas-current', codexVersion: version }));
      return;
    }

    const rootState = await lstat(generatedRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (rootState && (!rootState.isDirectory() || rootState.isSymbolicLink())) {
      throw new SafeSchemaError('generated-root-unsafe');
    }
    await mkdir(generatedRoot, { recursive: true, mode: 0o700 });
    const typescriptStage = await prepareStage(temporaryTypescript, 'codex-schema');
    stages = [typescriptStage];
    const jsonStage = await prepareStage(temporaryJson, 'codex-json-schema');
    stages.push(jsonStage);
    await replaceGeneratedDirectories([
      { stage: typescriptStage, target: typescriptTarget },
      { stage: jsonStage, target: jsonTarget },
    ]);
    stages = [];
    console.log(
      JSON.stringify({
        ok: true,
        code: 'generated-schemas-updated',
        codexVersion: version,
        typescriptDirectory: '.tmp/codex-schema',
        jsonDirectory: '.tmp/codex-json-schema',
      }),
    );
  } catch (error) {
    const code = error instanceof SafeSchemaError ? error.code : 'schema-generation-failed';
    console.error(`generate-codex-schemas:${code}`);
    process.exitCode = 1;
  } finally {
    await Promise.all(stages.map(async (stage) => await rm(stage, { recursive: true, force: true })));
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
