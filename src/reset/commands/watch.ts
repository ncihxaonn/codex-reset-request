import type { Command } from 'commander';
import { loadConfig } from '../config/load.js';
import { getAppPaths } from '../config/paths.js';
import { resolveCodexHome, resolveCodexSessionsDirectory } from '../codex/codex-home.js';
import { ActionPipeline } from '../pipeline/action-pipeline.js';
import { appendAuditEvent } from '../state/audit-log.js';
import { StateStore } from '../state/store.js';
import { CodexSessionWatcher } from '../watcher/codex-session-watcher.js';

function waitForTerminationSignal(): { promise: Promise<void>; cleanup(): void } {
  let resolvePromise: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  const handler = () => resolvePromise?.();
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
  return {
    promise,
    cleanup(): void {
      process.off('SIGINT', handler);
      process.off('SIGTERM', handler);
    },
  };
}

export function registerWatchCommand(program: Command): void {
  program
    .command('watch')
    .description('Watch Codex rollout appends using native filesystem events')
    .action(async () => {
      const paths = getAppPaths();
      const config = await loadConfig(paths);
      const watchedCodexHome = resolveCodexHome(config);
      const pipeline = new ActionPipeline(new StateStore(paths), {
        loadConfiguration: async () => {
          const current = await loadConfig(paths);
          if (resolveCodexHome(current) !== watchedCodexHome) {
            throw new Error('Codex home changed; restart the watcher before processing more events');
          }
          return current;
        },
      });
      let rejectFatal: ((error: Error) => void) | null = null;
      const fatal = new Promise<never>((_resolve, reject) => {
        rejectFatal = reject;
      });
      const watcher = new CodexSessionWatcher({
        sessionsDirectory: resolveCodexSessionsDirectory(config),
        paths,
        async onReady() {
          const recovered = await pipeline.stateMachine.recoverStaleAttempts();
          if (recovered > 0) {
            await appendAuditEvent(
              { level: 'warn', code: 'stale-attempts-recovered', detail: { count: recovered } },
              paths,
            );
          }
        },
        async onCandidate(candidate) {
          const result = await pipeline.handleCandidate(candidate);
          console.log(
            `Usage-limit action ${result.status}${result.safeCode ? ` (${result.safeCode})` : ''}.`,
          );
        },
        async onWarning(warning) {
          await appendAuditEvent({ level: 'warn', code: warning.code, detail: { file: warning.safeBasename } }, paths);
        },
        onFatal(error) {
          rejectFatal?.(error);
        },
      });

      const signal = waitForTerminationSignal();
      try {
        await watcher.start();
        await appendAuditEvent({ level: 'info', code: 'watcher-started' }, paths);
        console.log('Watching Codex sessions with native filesystem events. No polling is active.');
        await Promise.race([signal.promise, fatal]);
      } finally {
        signal.cleanup();
        await watcher.stop();
        await appendAuditEvent({ level: 'info', code: 'watcher-stopped' }, paths);
      }
    });
}
