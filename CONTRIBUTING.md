# Contributing

Codex Reset Request welcomes focused contributions that preserve its
event-driven, local-first, fail-closed design.

## Development setup

```bash
git clone https://github.com/ncihxaonn/codex-reset-request.git
cd codex-reset-request
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Use Node.js 22 or newer. Bun is optional and is not part of the ordinary test
or runtime path.

Before changing files, inspect `git status --short --branch` and avoid
overwriting unrelated work. Create a focused branch, keep commits reviewable,
and do not run repository-wide rewrites in a dirty checkout.

## Required checks

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build:dist
pnpm verify:no-polling
pnpm verify:no-secrets
pnpm verify:attribution
```

Native watcher integration tests must use actual filesystem events. They may
skip only when the local sandbox does not permit native watchers; CI requires
them. Do not add polling as a test or runtime fallback.

When the Codex App Server protocol changes, run `pnpm codex:schemas`. This
generates into ignored `.tmp/` directories, validates only the protocol fields
used by the project, and never reads a rollout or login file. Review schema
changes locally; CI intentionally does not require a Codex binary or login.

## Safety invariants

A contribution must not weaken these properties:

- fresh configuration and standalone setup default automatic posting off; the
  installer may select auto only after current explicit consent;
- only allowlisted Codex server-error shapes can become candidates;
- App Server confirmation is required before an automatic action;
- the active X account is verified before every write;
- mutation intent is persisted immediately before the one POST;
- write transport has no retry, redirect replay, alternate endpoint, or
  fallback mutation;
- `unknown` remains guarded and is never automatically retried;
- the rolling 24-hour hard maximum remains three;
- no cron, timer, interval, or polling loop is introduced;
- cookies, tokens, prompts, raw rollout records, and raw error bodies never
  enter logs, fixtures, issues, or snapshots;
- no local OS-notification feature is added;
- Codex session files remain read-only;
- no telemetry, runtime LLM call, CAPTCHA bypass, stealth, proxy rotation,
  multi-account automation, or bulk-reply feature is added.

Changes to X mutations require failure-path tests, including timeouts and
ambiguous responses. Changes to rollout parsing require false-positive tests.
Changes to App Server schemas require captured fixtures that contain no user
content or credentials.

## Live tests

Ordinary tests use fake App Server and Bird network layers. Never run live tests
in CI. A local read requires `CRR_LIVE_X=1`. A live write additionally requires
`--live`, the singleton lock, and a test post owned by the current user:

```bash
CRR_LIVE_X=1 codex-reset-request test x-reply \
  --url https://x.com/<YOUR_HANDLE>/status/<YOUR_POST_ID> \
  --live
```

Do not use Tibo's posts or any third-party post for a live write test. Do not
attach the resulting raw network response to a pull request.

## Bird upstream updates

The repository retains Bird's history and `bird` binary. When syncing upstream:

1. keep `upstream` pointed at `0xEnc0der/bird-x-cli`;
2. retain the MIT license and third-party notices;
3. update `UPSTREAM.md` and `docs/compatibility.md`;
4. run both Bird baseline and Codex Reset Request regression tests;
5. review changed GraphQL requests for accidental write retries or logging.

## Issues and pull requests

Describe behavior with safe codes, operating system, Node/Codex versions, and a
minimal synthetic reproduction. Never paste cookie values, authorization
headers, browser databases, `~/.codex/auth.json`, prompt text, raw rollout
files, home-directory paths, or full unredacted output.

Pull requests should explain the threat-model impact, list tests run, and state
whether any live X action occurred. Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
and report vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue.
