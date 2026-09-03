import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { replaceGeneratedDirectories } from '../../scripts/generate-codex-schemas.js';
import { inspectProductionSource } from '../../scripts/verify-no-polling.js';
import { scanSecretPayload } from '../../scripts/verify-no-secrets.js';

describe('release safeguards', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map(async (directory) => await rm(directory, { recursive: true })));
  });

  it('finds X credentials in JSON-shaped and binary payloads regardless of filename', () => {
    const token = 'a'.repeat(40);
    const json = scanSecretPayload('Dockerfile', Buffer.from(`{"auth_token":"${token}"}`));
    const binary = scanSecretPayload(
      'deploy.sh',
      Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`auth_token=${token}`), Buffer.from([0])]),
    );

    expect(json.map(({ code }) => code)).toContain('x-auth-literal');
    expect(binary.map(({ code }) => code)).toContain('x-auth-cookie');
  });

  it('does not treat documented credential placeholders as live secrets', () => {
    const findings = scanSecretPayload(
      'README.md',
      Buffer.from('{"auth_token":"<YOUR_X_AUTH_TOKEN>","ct0":"<YOUR_X_CSRF_TOKEN>"}'),
    );

    expect(findings).toEqual([]);
  });

  it('rejects polling aliases, computed calls, and every usePolling property form in JavaScript', () => {
    const source = `
      import cron from 'node-cron';
      const repeat = setInterval;
      const computed = globalThis['setInterval'];
      const usePolling = true;
      const opts = { usePolling };
      opts.usePolling = true;
      const other = { ['usePolling']: false };
      cron.schedule('* * * * *', task);
      repeat(task, 1000);
      computed(task, 1000);
    `;
    const inspected = inspectProductionSource(path.resolve('src/reset/polling-bypass.js'), source);
    const codes = new Set(inspected.findings.map(({ code }) => code));

    expect(codes).toContain('periodic-interval-reference');
    expect(codes).toContain('polling-option-enabled');
    expect(codes).toContain('cron-runtime-reference');
    expect(codes).toContain('cron-runtime-string');
  });

  it('allows explicit false polling options', () => {
    const source = `
      const usePolling = false;
      watch(target, { usePolling: false });
      watch(other, { ['usePolling']: usePolling });
      options.usePolling = false;
    `;
    const inspected = inspectProductionSource(path.resolve('src/reset/native-watch.js'), source);

    expect(inspected.findings).toEqual([]);
  });

  it('resolves shorthand polling options in their lexical scope', () => {
    const source = `
      const usePolling = true;
      function unrelated() {
        const usePolling = false;
        return usePolling;
      }
      watch(target, { usePolling });
    `;
    const inspected = inspectProductionSource(path.resolve('src/reset/scoped-polling.js'), source);

    expect(inspected.findings.map(({ code }) => code)).toContain('polling-option-enabled');
  });

  it('resolves shorthand polling options in a shared switch-case scope', () => {
    const source = `
      switch (mode) {
        case 'native':
          const usePolling = true;
          watch(target, { usePolling });
          break;
      }
    `;
    const inspected = inspectProductionSource(path.resolve('src/reset/switch-polling.js'), source);

    expect(inspected.findings.map(({ code }) => code)).toContain('polling-option-enabled');
  });

  it('unwraps transparent TypeScript expressions around polling booleans', () => {
    const source = `
      const usePolling = true as const;
      watch(target, { usePolling });
      watch(other, { usePolling: true satisfies boolean });
    `;
    const inspected = inspectProductionSource(path.resolve('src/reset/wrapped-polling.ts'), source);

    expect(inspected.findings.filter(({ code }) => code === 'polling-option-enabled')).toHaveLength(2);
  });

  it('preflights both generated schema targets before replacing either one', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codex-reset-request-transaction-test-'));
    temporaryRoots.push(root);
    const typescriptStage = path.join(root, 'typescript-stage');
    const jsonStage = path.join(root, 'json-stage');
    const typescriptTarget = path.join(root, 'typescript-target');
    const jsonTarget = path.join(root, 'json-target');
    const marker = '.codex-reset-request-generated';
    const markerValue = 'codex-reset-request-schema-v1\n';
    await Promise.all(
      [typescriptStage, jsonStage, typescriptTarget, jsonTarget].map(async (directory) => {
        await mkdir(directory);
      }),
    );
    await Promise.all([
      writeFile(path.join(typescriptStage, marker), markerValue),
      writeFile(path.join(jsonStage, marker), markerValue),
      writeFile(path.join(typescriptTarget, marker), markerValue),
      writeFile(path.join(typescriptTarget, 'version.txt'), 'old-typescript'),
      writeFile(path.join(jsonTarget, 'version.txt'), 'unowned-json'),
    ]);

    await expect(
      replaceGeneratedDirectories([
        { stage: typescriptStage, target: typescriptTarget },
        { stage: jsonStage, target: jsonTarget },
      ]),
    ).rejects.toThrow('schema-target-not-owned');
    await expect(readFile(path.join(typescriptTarget, 'version.txt'), 'utf8')).resolves.toBe('old-typescript');
  });

  it('restores both generated schema targets when the second install fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codex-reset-request-rollback-test-'));
    temporaryRoots.push(root);
    const typescriptStage = path.join(root, 'typescript-stage');
    const jsonStage = path.join(typescriptStage, 'json-stage');
    const typescriptTarget = path.join(root, 'typescript-target');
    const jsonTarget = path.join(root, 'json-target');
    const marker = '.codex-reset-request-generated';
    const markerValue = 'codex-reset-request-schema-v1\n';
    await mkdir(jsonStage, { recursive: true });
    await Promise.all([mkdir(typescriptTarget), mkdir(jsonTarget)]);
    await Promise.all([
      writeFile(path.join(typescriptStage, marker), markerValue),
      writeFile(path.join(jsonStage, marker), markerValue),
      writeFile(path.join(typescriptTarget, marker), markerValue),
      writeFile(path.join(jsonTarget, marker), markerValue),
      writeFile(path.join(typescriptTarget, 'version.txt'), 'old-typescript'),
      writeFile(path.join(jsonTarget, 'version.txt'), 'old-json'),
    ]);

    await expect(
      replaceGeneratedDirectories([
        { stage: typescriptStage, target: typescriptTarget },
        { stage: jsonStage, target: jsonTarget },
      ]),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(typescriptTarget, 'version.txt'), 'utf8')).resolves.toBe('old-typescript');
    await expect(readFile(path.join(jsonTarget, 'version.txt'), 'utf8')).resolves.toBe('old-json');
  });
});
