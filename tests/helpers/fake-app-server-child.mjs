import { appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const scenario = process.env.FAKE_APP_SERVER_SCENARIO ?? 'happy';
const logFile = process.env.FAKE_APP_SERVER_LOG;
const initDelay = Number(process.env.FAKE_APP_SERVER_INIT_DELAY ?? 0);
const rateDelay = Number(process.env.FAKE_APP_SERVER_RATE_DELAY ?? 0);
const result = JSON.parse(process.env.FAKE_APP_SERVER_RATE_RESULT ?? '{}');

if (scenario === 'early-exit') {
  process.exit(7);
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const send = (message, crlf = false) => {
  process.stdout.write(`${JSON.stringify(message)}${crlf ? '\r\n' : '\n'}`);
};

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (logFile) {
    await appendFile(logFile, `${JSON.stringify(message)}\n`, 'utf8');
  }

  if (scenario === 'timeout') {
    continue;
  }
  if (message.method === 'initialize') {
    await delay(initDelay);
    if (scenario === 'invalid-json') {
      process.stdout.write('{not-json\n');
      continue;
    }
    if (scenario === 'wrong-id') {
      send({ id: 99, result: {} });
      continue;
    }
    if (scenario === 'init-error') {
      send({ id: 0, error: { code: -32_000, message: 'secret-canary-in-rpc-error' } });
      continue;
    }
    send({ method: 'account/rateLimits/updated', params: { ignored: true } }, true);
    const response = JSON.stringify({
      id: 0,
      result: {
        userAgent: 'fake-codex',
        codexHome: process.env.FAKE_APP_SERVER_CODEX_HOME ?? '/secret/canary/home',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    });
    process.stdout.write(response.slice(0, 17));
    process.stdout.write(`${response.slice(17)}\r\n`);
    if (scenario === 'exit-after-init') {
      process.exit(3);
    }
    continue;
  }
  if (message.method === 'account/rateLimits/read') {
    await delay(rateDelay);
    if (scenario === 'rate-error') {
      process.stderr.write('authorization: Bearer secret-canary\n');
      send({ id: 1, error: { code: -32_001, message: 'secret-canary-rate-error' } });
      continue;
    }
    if (scenario === 'missing-rate-limits') {
      send({ id: 1, result: {} });
      continue;
    }
    process.stderr.write('non-fatal fake App Server warning with secret-canary\n');
    process.stdout.write(
      `${JSON.stringify({ method: 'unrelated/notification', params: {} })}\n${JSON.stringify({ id: 1, result })}\n`,
    );
  }
}
