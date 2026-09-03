const DEFAULT_NATIVE_WATCHER_DEADLINE_MS = process.env.CI ? 15_000 : 10_000;

export async function withNativeWatcherDeadline<T>(
  promise: Promise<T>,
  label: string,
  milliseconds = DEFAULT_NATIVE_WATCHER_DEADLINE_MS,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`native watcher test timed out: ${label}`)), milliseconds);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export function canSkipNativeWatcherFailure(
  error: unknown,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.CRR_REQUIRE_NATIVE_WATCH === '1' || !(error instanceof Error)) {
    return false;
  }
  return /^Native watcher unavailable:/i.test(error.message) && /\b(?:EMFILE|ENFILE|ENOSPC)\b/.test(error.message);
}
