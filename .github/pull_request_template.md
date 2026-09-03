## Summary

What changed, and why?

## Threat-model impact

Describe any effect on rollout classification, App Server schemas, X
reads/writes, target selection, consent, deduplication, rate guards, state
recovery, logs, subprocesses, filesystem paths, or services.
Write `None` only after checking.

## Verification

- [ ] `pnpm run typecheck`
- [ ] `pnpm run lint`
- [ ] `pnpm run test`
- [ ] `pnpm run build:dist`
- [ ] `pnpm run verify:no-polling`
- [ ] `pnpm run verify:no-secrets`
- [ ] `pnpm run verify:attribution`
- [ ] Native watcher tests ran without a skip, or CI is expected to provide the
  required host evidence.

List any additional focused tests.

## Safety invariants

- [ ] Fresh configuration and `setup` remain dry-run by default; `install`
  selects automatic posting only after current explicit consent and a running
  service check.
- [ ] No local OS-notification feature was added.
- [ ] One logical action can perform at most one X mutation attempt; ambiguous
  results never retry.
- [ ] Account, target, consent, configuration, deduplication, lock, and hard rate
  guards remain fail closed.
- [ ] No periodic quota/X polling, cron/timer, telemetry, runtime LLM,
  CAPTCHA/stealth/proxy bypass, or bulk/multi-account behavior was added.
- [ ] Subprocesses use argv arrays without a shell.
- [ ] No credentials, private rollout data, prompt/source/tool text, raw response
  body, browser data, home path, or unredacted output is included.

## Live X activity

- [ ] No live X operation occurred.
- [ ] A read-only live test occurred; describe only safe metadata below.
- [ ] One explicitly authorized write to my own test post occurred; record only
  the final safe status below.

## Documentation and provenance

- [ ] User-facing behavior, privacy/security implications, and compatibility
  notes are updated where applicable.
- [ ] Bird syncs update `UPSTREAM.md` and `docs/compatibility.md` and preserve MIT
  attribution, or this is not a Bird sync.
