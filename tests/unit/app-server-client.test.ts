import { afterEach, describe, expect, it } from 'vitest';
import { buildCodexAppServerEnvironment, readCodexRateLimits } from '../../src/reset/codex/app-server-client.js';
import { createFakeAppServer } from '../helpers/fake-app-server.js';
import { createTemporaryHome, type TemporaryHome } from '../helpers/temporary-home.js';

const homes: TemporaryHome[] = [];

async function fixture() {
  const home = await createTemporaryHome();
  homes.push(home);
  return home;
}

const validRateResult = {
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 100, resetsAt: 1_900_000_000 },
    secondary: null,
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: null,
};

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => home.cleanup()));
});

describe('Codex App Server JSONL client', () => {
  it('passes only allowlisted runtime variables to the Codex subprocess', () => {
    const environment = buildCodexAppServerEnvironment(
      {
        HOME: '/home/user',
        PATH: '/usr/bin',
        AUTH_TOKEN: 'x-secret',
        CT0: 'x-csrf-secret',
        GH_TOKEN: 'github-secret',
        OPENAI_API_KEY: 'api-secret',
      },
      '/home/user/.codex',
    );
    expect(environment).toEqual({ HOME: '/home/user', PATH: '/usr/bin', CODEX_HOME: '/home/user/.codex' });
  });

  it('performs only initialize, initialized, and rateLimits/read', async () => {
    const home = await fixture();
    const fake = createFakeAppServer(home.root, { rateResult: validRateResult });

    const outcome = await readCodexRateLimits({ process: fake.process, timeoutMs: 2_000 });

    expect(outcome).toEqual({ ok: true, value: validRateResult });
    const requests = await fake.readRequests();
    expect(requests).toEqual([
      {
        method: 'initialize',
        id: 0,
        params: {
          clientInfo: {
            name: 'codex_reset_request',
            title: 'Codex Reset Request',
            version: '0.1.0',
          },
        },
      },
      { method: 'initialized', params: {} },
      { method: 'account/rateLimits/read', id: 1 },
    ]);
    expect(requests.some((request) => /thread|turn/i.test(String(request.method)))).toBe(false);
  });

  it.each([
    ['init-error', 'initialize', 'initialize-rejected'],
    ['rate-error', 'rate-limits', 'rate-limits-rejected'],
    ['invalid-json', 'initialize', 'invalid-json'],
    ['wrong-id', 'initialize', 'unexpected-response'],
    ['exit-after-init', 'rate-limits', 'process-exited'],
    ['missing-rate-limits', 'rate-limits', 'rate-limits-schema'],
  ] as const)('returns only safe failure data for %s', async (scenario, stage, code) => {
    const home = await fixture();
    const fake = createFakeAppServer(home.root, { scenario, rateResult: validRateResult });

    const outcome = await readCodexRateLimits({ process: fake.process, timeoutMs: 1_000 });

    expect(outcome).toEqual({ ok: false, stage, code });
    expect(JSON.stringify(outcome)).not.toContain('secret-canary');
    expect(JSON.stringify(outcome)).not.toContain('/secret/canary/home');
  });

  it('uses one total timeout across initialization and rate reading', async () => {
    const home = await fixture();
    const fake = createFakeAppServer(home.root, {
      rateResult: validRateResult,
      initDelayMs: 70,
      rateDelayMs: 70,
    });

    const outcome = await readCodexRateLimits({ process: fake.process, timeoutMs: 110 });

    expect(outcome).toMatchObject({ ok: false, code: 'timeout' });
  });

  it('reports an early process exit without exposing process output', async () => {
    const home = await fixture();
    const fake = createFakeAppServer(home.root, { scenario: 'early-exit' });
    expect(await readCodexRateLimits({ process: fake.process, timeoutMs: 1_000 })).toEqual({
      ok: false,
      stage: 'initialize',
      code: 'process-exited',
    });
  });

  it('fails closed when App Server initializes for a different Codex home', async () => {
    const home = await fixture();
    const fake = createFakeAppServer(home.root, { rateResult: validRateResult, codexHome: '/other/codex' });
    expect(
      await readCodexRateLimits({
        process: fake.process,
        timeoutMs: 1_000,
        expectedCodexHome: '/expected/codex',
      }),
    ).toEqual({ ok: false, stage: 'initialize', code: 'codex-home-mismatch' });
  });

  it('classifies a missing binary safely', async () => {
    const outcome = await readCodexRateLimits({
      process: { command: 'codex-reset-request-definitely-missing-binary', args: [] },
      timeoutMs: 500,
    });
    expect(outcome).toEqual({ ok: false, stage: 'spawn', code: 'binary-not-found' });
  });
});
