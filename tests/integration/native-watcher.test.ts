import { appendFile, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { UsageLimitCandidate } from '../../src/reset/codex/rollout-types.js';
import { CodexSessionWatcher } from '../../src/reset/watcher/codex-session-watcher.js';
import { CursorStore } from '../../src/reset/watcher/cursor-store.js';
import { canSkipNativeWatcherFailure, withNativeWatcherDeadline } from '../helpers/native-watcher.js';
import { createTemporaryHome, type TemporaryHome } from '../helpers/temporary-home.js';

const homes: TemporaryHome[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => home.cleanup()));
});

it('ignores old events, wakes on append, and discovers a new date directory', async (context) => {
  const home = await createTemporaryHome();
  homes.push(home);
  const sessionsDirectory = path.join(home.root, 'codex', 'sessions');
  const originalDirectory = path.join(sessionsDirectory, '2026', '08', '28');
  await mkdir(originalDirectory, { recursive: true });
  const existingFile = path.join(originalDirectory, 'rollout-existing.jsonl');
  const structuredFixture = await readFile(
    path.join(process.cwd(), 'tests', 'fixtures', 'codex', 'structured-usage-limit.jsonl'),
    'utf8',
  );
  await writeFile(existingFile, structuredFixture, 'utf8');

  const candidates: UsageLimitCandidate[] = [];
  let resolveCandidate: ((candidate: UsageLimitCandidate) => void) | null = null;
  const nextCandidate = () =>
    new Promise<UsageLimitCandidate>((resolve) => {
      resolveCandidate = resolve;
    });
  let candidatePromise = nextCandidate();
  let resolveFatal: ((error: Error) => void) | null = null;
  const fatalPromise = new Promise<Error>((resolve) => {
    resolveFatal = resolve;
  });
  const candidateOrFatal = () =>
    Promise.race([
      candidatePromise,
      fatalPromise.then((error) => {
        throw error;
      }),
    ]);
  const watcher = new CodexSessionWatcher({
    sessionsDirectory,
    paths: home.paths,
    onCandidate(candidate) {
      candidates.push(candidate);
      resolveCandidate?.(candidate);
    },
    onFatal(error) {
      resolveFatal?.(error);
    },
  });

  try {
    await watcher.start();
    await appendFile(existingFile, '{"type":"event_msg","payload":{"type":"log","message":"safe"}}\n', 'utf8');
    expect(candidates).toHaveLength(0);

    await appendFile(existingFile, structuredFixture, 'utf8');
    const appended = await withNativeWatcherDeadline(candidateOrFatal(), 'existing-file append');
    expect(appended.tier).toBe('structured');
    expect(candidates).toHaveLength(1);

    candidatePromise = nextCandidate();
    const newDirectory = path.join(sessionsDirectory, '2026', '08', '29');
    await mkdir(newDirectory, { recursive: true });
    await writeFile(path.join(newDirectory, 'rollout-new.jsonl'), structuredFixture, 'utf8');
    const created = await withNativeWatcherDeadline(candidateOrFatal(), 'new-date-directory');
    expect(created.safeFileName).toBe('rollout-new.jsonl');
    expect(candidates).toHaveLength(2);
  } catch (error) {
    if (canSkipNativeWatcherFailure(error)) {
      context.skip('host sandbox does not permit native filesystem watchers');
      return;
    }
    throw error;
  } finally {
    await watcher.stop();
  }
});

it('catches up new, replaced, and onReady-race rollouts after restart', async (context) => {
  const home = await createTemporaryHome();
  homes.push(home);
  const sessionsDirectory = path.join(home.root, 'codex', 'sessions');
  const dateDirectory = path.join(sessionsDirectory, '2026', '08', '28');
  await mkdir(dateDirectory, { recursive: true });
  const originalFile = path.join(dateDirectory, 'rollout-original.jsonl');
  await writeFile(originalFile, '', 'utf8');

  const first = new CodexSessionWatcher({
    sessionsDirectory,
    paths: home.paths,
    onCandidate() {
      throw new Error('first startup must not process history');
    },
  });
  let second: CodexSessionWatcher | null = null;
  try {
    await first.start();
    await first.stop();

    const fixture = await readFile(
      path.join(process.cwd(), 'tests', 'fixtures', 'codex', 'structured-usage-limit.jsonl'),
      'utf8',
    );
    const replacement = path.join(dateDirectory, 'rollout-replacement.tmp');
    await writeFile(replacement, fixture, 'utf8');
    await rename(replacement, originalFile);
    await writeFile(path.join(dateDirectory, 'rollout-created-offline.jsonl'), fixture, 'utf8');

    const candidates: UsageLimitCandidate[] = [];
    second = new CodexSessionWatcher({
      sessionsDirectory,
      paths: home.paths,
      async onReady() {
        await writeFile(path.join(dateDirectory, 'rollout-on-ready.jsonl'), fixture, 'utf8');
      },
      onCandidate(candidate) {
        candidates.push(candidate);
      },
    });
    await second.start();
    expect(candidates.map((candidate) => candidate.safeFileName).sort()).toEqual([
      'rollout-created-offline.jsonl',
      'rollout-on-ready.jsonl',
      'rollout-original.jsonl',
    ]);
  } catch (error) {
    if (canSkipNativeWatcherFailure(error)) {
      context.skip('host sandbox does not permit native filesystem watchers');
      return;
    }
    throw error;
  } finally {
    await second?.stop();
    await first.stop();
  }
});

it('restarts from byte zero after an offline truncate', async (context) => {
  const home = await createTemporaryHome();
  homes.push(home);
  const sessionsDirectory = path.join(home.root, 'codex', 'sessions');
  const dateDirectory = path.join(sessionsDirectory, '2026', '08', '28');
  await mkdir(dateDirectory, { recursive: true });
  const rolloutFile = path.join(dateDirectory, 'rollout-truncated.jsonl');
  const safeLine = `${JSON.stringify({ type: 'event_msg', payload: { type: 'log', message: 'safe' } })}\n`;
  await writeFile(rolloutFile, safeLine.repeat(100), 'utf8');

  const first = new CodexSessionWatcher({ sessionsDirectory, paths: home.paths, onCandidate: () => undefined });
  let second: CodexSessionWatcher | null = null;
  try {
    await first.start();
    await first.stop();
    const fixture = await readFile(
      path.join(process.cwd(), 'tests', 'fixtures', 'codex', 'structured-usage-limit.jsonl'),
      'utf8',
    );
    await writeFile(rolloutFile, fixture, 'utf8');
    const candidates: UsageLimitCandidate[] = [];
    second = new CodexSessionWatcher({
      sessionsDirectory,
      paths: home.paths,
      onCandidate(candidate) {
        candidates.push(candidate);
      },
    });
    await second.start();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].byteOffset).toBe(0);
  } catch (error) {
    if (canSkipNativeWatcherFailure(error)) {
      context.skip('host sandbox does not permit native filesystem watchers');
      return;
    }
    throw error;
  } finally {
    await second?.stop();
    await first.stop();
  }
});

it('seeds pre-existing history at EOF when the watched Codex home changes', async (context) => {
  const home = await createTemporaryHome();
  homes.push(home);
  const fixture = await readFile(
    path.join(process.cwd(), 'tests', 'fixtures', 'codex', 'structured-usage-limit.jsonl'),
    'utf8',
  );
  const firstSessions = path.join(home.root, 'codex-a', 'sessions');
  const secondSessions = path.join(home.root, 'codex-b', 'sessions');
  await mkdir(path.join(firstSessions, '2026', '08', '28'), { recursive: true });
  await mkdir(path.join(secondSessions, '2026', '08', '28'), { recursive: true });
  await writeFile(path.join(firstSessions, '2026', '08', '28', 'rollout-old-a.jsonl'), fixture, 'utf8');
  await writeFile(path.join(secondSessions, '2026', '08', '28', 'rollout-old-b.jsonl'), fixture, 'utf8');

  const candidates: UsageLimitCandidate[] = [];
  const first = new CodexSessionWatcher({
    sessionsDirectory: firstSessions,
    paths: home.paths,
    onCandidate(candidate) {
      candidates.push(candidate);
    },
  });
  let second: CodexSessionWatcher | null = null;
  try {
    await first.start();
    await first.stop();
    second = new CodexSessionWatcher({
      sessionsDirectory: secondSessions,
      paths: home.paths,
      onCandidate(candidate) {
        candidates.push(candidate);
      },
    });
    await second.start();
    expect(candidates).toEqual([]);
  } catch (error) {
    if (canSkipNativeWatcherFailure(error)) {
      context.skip('host sandbox does not permit native filesystem watchers');
      return;
    }
    throw error;
  } finally {
    await second?.stop();
    await first.stop();
  }
});

it('survives a normal rollout deletion and continues watching subsequent files', async (context) => {
  const home = await createTemporaryHome();
  homes.push(home);
  const sessionsDirectory = path.join(home.root, 'codex', 'sessions');
  const dateDirectory = path.join(sessionsDirectory, '2026', '08', '28');
  await mkdir(dateDirectory, { recursive: true });
  const deletedFile = path.join(dateDirectory, 'rollout-deleted.jsonl');
  await writeFile(deletedFile, '', 'utf8');

  let fatalError: Error | null = null;
  let resolveCandidate: ((candidate: UsageLimitCandidate) => void) | null = null;
  const candidatePromise = new Promise<UsageLimitCandidate>((resolve) => {
    resolveCandidate = resolve;
  });
  const watcher = new CodexSessionWatcher({
    sessionsDirectory,
    paths: home.paths,
    onCandidate(candidate) {
      resolveCandidate?.(candidate);
    },
    onFatal(error) {
      fatalError = error;
    },
  });

  try {
    await watcher.start();
    await unlink(deletedFile);
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    const fixture = await readFile(
      path.join(process.cwd(), 'tests', 'fixtures', 'codex', 'structured-usage-limit.jsonl'),
      'utf8',
    );
    await writeFile(path.join(dateDirectory, 'rollout-after-delete.jsonl'), fixture, 'utf8');
    expect((await withNativeWatcherDeadline(candidatePromise, 'post-delete event')).safeFileName).toBe(
      'rollout-after-delete.jsonl',
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      Object.values((await new CursorStore(home.paths).load()).state.cursors).map((cursor) => cursor.safeBasename),
    ).not.toContain('rollout-deleted.jsonl');
    expect(fatalError).toBeNull();
  } catch (error) {
    if (canSkipNativeWatcherFailure(error)) {
      context.skip('host sandbox does not permit native filesystem watchers');
      return;
    }
    throw error;
  } finally {
    await watcher.stop();
  }
});

it('reattaches after a date directory is deleted and recreated at the same path', async (context) => {
  const home = await createTemporaryHome();
  homes.push(home);
  const sessionsDirectory = path.join(home.root, 'codex', 'sessions');
  const dateDirectory = path.join(sessionsDirectory, '2026', '08', '28');
  await mkdir(dateDirectory, { recursive: true });
  await writeFile(path.join(dateDirectory, 'rollout-before-delete.jsonl'), '', 'utf8');

  let fatalError: Error | null = null;
  let resolveCandidate: ((candidate: UsageLimitCandidate) => void) | null = null;
  const candidatePromise = new Promise<UsageLimitCandidate>((resolve) => {
    resolveCandidate = resolve;
  });
  const watcher = new CodexSessionWatcher({
    sessionsDirectory,
    paths: home.paths,
    onCandidate(candidate) {
      resolveCandidate?.(candidate);
    },
    onFatal(error) {
      fatalError = error;
    },
  });

  try {
    await watcher.start();
    await rm(dateDirectory, { recursive: true });
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await mkdir(dateDirectory, { recursive: true });
    const recreatedFile = path.join(dateDirectory, 'rollout-recreated.jsonl');
    await writeFile(recreatedFile, '', 'utf8');
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    const fixture = await readFile(
      path.join(process.cwd(), 'tests', 'fixtures', 'codex', 'structured-usage-limit.jsonl'),
      'utf8',
    );
    await appendFile(recreatedFile, fixture, 'utf8');
    expect((await withNativeWatcherDeadline(candidatePromise, 'same-path directory recreation')).safeFileName).toBe(
      'rollout-recreated.jsonl',
    );
    expect(fatalError).toBeNull();
  } catch (error) {
    if (canSkipNativeWatcherFailure(error)) {
      context.skip('host sandbox does not permit native filesystem watchers');
      return;
    }
    throw error;
  } finally {
    await watcher.stop();
  }
});
