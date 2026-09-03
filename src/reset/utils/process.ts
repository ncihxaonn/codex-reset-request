import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface BoundedCommandResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  safeCode?: 'binary-not-found' | 'spawn-failed' | 'timeout' | 'output-too-large';
}

function waitForExit(child: ChildProcessWithoutNullStreams, milliseconds: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, milliseconds);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

export async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.stdin.end();
  if (await waitForExit(child, 100)) {
    return;
  }
  child.kill('SIGTERM');
  if (await waitForExit(child, 250)) {
    return;
  }
  child.kill('SIGKILL');
  await waitForExit(child, 250);
}

export async function runBoundedCommand(
  binary: string,
  args: string[],
  options: { timeoutMs?: number; maxOutputBytes?: number; environment?: NodeJS.ProcessEnv } = {},
): Promise<BoundedCommandResult> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1_024;
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(binary, args, {
      env: options.environment ?? process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch {
    return { ok: false, exitCode: null, stdout: '', safeCode: 'spawn-failed' };
  }

  child.stdin.end();
  let stdout = '';
  let stdoutBytes = 0;
  let outputTooLarge = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    const chunkBytes = Buffer.byteLength(chunk, 'utf8');
    stdoutBytes += chunkBytes;
    if (stdoutBytes <= maxOutputBytes) {
      stdout += chunk;
    } else {
      outputTooLarge = true;
    }
  });
  child.stderr.resume();

  return await new Promise<BoundedCommandResult>((resolve) => {
    let settled = false;
    const finish = (result: BoundedCommandResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      void terminateChild(child).finally(() => {
        resolve({ ok: false, exitCode: child.exitCode, stdout: '', safeCode: 'timeout' });
      });
    }, timeoutMs);
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        exitCode: null,
        stdout: '',
        safeCode: error.code === 'ENOENT' ? 'binary-not-found' : 'spawn-failed',
      });
    });
    child.once('close', (exitCode) => {
      if (outputTooLarge) {
        finish({ ok: false, exitCode, stdout: '', safeCode: 'output-too-large' });
      } else {
        finish({ ok: exitCode === 0, exitCode, stdout: stdout.trim() });
      }
    });
  });
}
