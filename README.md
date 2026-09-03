# Codex Reset Request — Codex Usage Limits Monitor

An event-driven local Codex usage limits monitor. It detects a confirmed Codex
usage-limit or rate-limit event and can optionally submit one customizable
reset request through Bird using the user's existing authenticated X browser
session.

- No polling
- No X API key
- No OpenAI API key
- No runtime LLM calls
- Explicit opt-in required for automatic posting

This tool does not reset your Codex account and does not guarantee that anyone
will provide a reset.

> **Public development alpha — source available for review, not an endorsement
> of live automatic posting.** X's current Automation Rules prohibit scripting
> the X website; this Bird-derived build uses undocumented web GraphQL rather
> than the official X API. Keep `dry-run` mode unless you have independently
> resolved the live-operation requirements in [DISCLAIMER.md](DISCLAIMER.md)
> and the [release checklist](docs/public-release-checklist.md#live-operation-policy-blockers).

[简体中文](README.zh-CN.md)

## How it works

```text
Codex rollout append
        ↓
Native filesystem event
        ↓
Strict UsageLimit classifier
        ↓
Codex App Server confirmation
        ↓
Deduplication + rate guard
        ↓
Bird target selection
        ↓
Expected X account verification
        ↓
One mutation attempt
        ↓
sent / definitive failure / unknown
```

The watcher sleeps until the operating system reports a file change. It tails
only newly appended rollout JSONL bytes, accepts narrowly structured Codex
usage-limit errors, then starts a short-lived local Codex App Server process to
confirm `account/rateLimits/read`. Only a confirmed event can proceed from the
pipeline to X selection/action stages. Idle watching performs no X requests,
App Server calls, or LLM calls.

On first start, existing rollout files are bookmarked at EOF, so historical
errors do not trigger an action. New rollout files begin at byte zero. Partial
lines, truncation, replacement, new date directories, restarts, and duplicate
limit windows are handled conservatively.

See [architecture](docs/architecture.md) and the five
[architecture decisions](docs/adr/0001-public-bird-fork.md).

## Requirements

- Node.js 22 or newer
- pnpm (Corepack is suitable)
- a working Codex CLI login; `0.140.0` is the version tested for this alpha
- an X login in Safari, Chrome, or Firefox readable by Bird
- macOS or Linux for managed background service installation
- Windows is supported in foreground with `watch`; auto-start is not supported
  in v0.1

No developer API key is required. Browser cookies and the Codex login are local
authentication credentials; this project does not claim to work without
authentication. Bun is optional only for the inherited standalone Bird build
and is not needed for normal installation or runtime.

## Acknowledgements and license

Small but important attribution: this repository is derived from the public
[`0xEnc0der/bird-x-cli`](https://github.com/0xEnc0der/bird-x-cli) repository,
with MIT attribution retained. Its secondary upstream is
[`zaydiscold/bird`](https://github.com/zaydiscold/bird), derived from the
original `jawond/bird` implementation by Peter Steinberger.

The exact base is `a16f9901717008bf1ab3ea0b715dfd95dedc95b0`. See
[UPSTREAM.md](UPSTREAM.md), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md),
and [LICENSE](LICENSE). The inherited `bird` binary remains available for
diagnostics; `codex-reset-request` is the separate guarded workflow.

## Installation from source

The alpha is intentionally not published to npm.

```bash
git clone https://github.com/ncihxaonn/codex-reset-request.git
cd codex-reset-request
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm link --global
```

Confirm both binaries:

```bash
codex-reset-request --help
bird --help
```

Re-run `pnpm build` after pulling source changes. Service definitions point to
the absolute built CLI and Node binary present at installation time, so run
`codex-reset-request service install` again after moving the checkout or
changing Node installations.

## Authentication requirements

### Codex

Run `codex` normally and complete its login before setup. The tool reads local
rollout files below `$CODEX_HOME/sessions` and talks to a temporary local Codex
App Server subprocess. It never opens `~/.codex/auth.json`, modifies a Codex
session, or requests an OpenAI API key.

The confirmation client calls initialize and `account/rateLimits/read`; it does
not call `thread/start` or `turn/start` and therefore does not create a Codex
conversation or inference turn.

Codex home resolution is:

```text
CRR_CODEX_HOME → config.codexHome → CODEX_HOME → ~/.codex
```

Setup pins the effective path into config so a background service watches the
same home that passed preflight.

### X browser session

Log in to `x.com` in the configured Safari, Chrome, or Firefox profile. Bird
reads `auth_token` and `ct0` through its local browser-cookie provider. Values
are used in memory and are not written to Codex Reset Request config, state, or
logs.

Foreground Bird compatibility can resolve environment credentials, but the
managed background service deliberately rejects an environment-only X
credential pair: launchd/systemd should not embed secrets, and service managers
do not reliably inherit the installer's shell environment.

## One-command installation (macOS and Linux)

After installing the CLI from source, this one command runs the preflight,
records consent, and installs and starts the event-driven user service with
automatic X replies enabled:

```bash
codex-reset-request install
```

Choose your own reply content with `--reply-text`. Automatic replies still
require the explicit risk confirmation; disable them any time with
`codex-reset-request disable-auto`. The project has no local OS-notification
feature.

```bash
codex-reset-request install --reply-text "Please reset my Codex limit"
```

On Windows, use `setup` then run `watch` in a foreground terminal.

## Setup

Start with the non-writing default:

```bash
codex-reset-request setup
```

Setup checks Node, Codex App Server rate-limit access, the active X account, and
the readable target post; displays the disclaimer; records the expected X
handle; and saves `dry-run` unless another mode was explicitly requested.

Modes:

- `dry-run`: detects and confirms events, but never posts.
- `auto`: permits the guarded reply only after the exact risk confirmation.

To enable automatic posting, use the dedicated flow:

```bash
codex-reset-request enable-auto
```

It repeats the App Server, account, and target reads and requires the exact
confirmation text `I UNDERSTAND THE X ACCOUNT RISK`. A changed disclaimer
version, wrong account, revoked consent, config change at the mutation boundary,
deduplication match, or rate guard prevents the write.

Disable immediately without deleting other configuration:

```bash
codex-reset-request disable-auto
```

Run in the foreground before installing a service:

```bash
codex-reset-request watch
```

This is the normal way to observe dry-run behavior in a terminal.
Stop it with `Ctrl-C`; shutdown flushes cursors/audit state and releases the
singleton lock.

## Diagnostics

```bash
codex-reset-request doctor
codex-reset-request status
codex-reset-request status --json
codex-reset-request logs --tail 100
```

`doctor` reports `PASS`, `WARN`, or `FAIL` for runtime, Codex compatibility,
sessions, App Server confirmation, X reads, native file watching, event-driven
operation, config/state, service state, single-instance lock, and consent.
Output uses safe codes and does not print cookie values, tokens, prompts, raw
rollout records, or raw GraphQL bodies.

The local synthetic trigger performs no network or state writes:

```bash
codex-reset-request test trigger
```

Live X diagnostics are never used by CI. A read requires an explicit process
gate:

```bash
CRR_LIVE_X=1 codex-reset-request test x-read
```

This read-only check reads the active X account plus public account and post
metadata for the hard-coded safe target `@thsottiaux`. It performs no write.

A write is restricted to a test post owned by the current X account. Stop the
watcher first so the test can acquire its singleton lock:

```bash
CRR_LIVE_X=1 codex-reset-request test x-reply \
  --url https://x.com/<YOUR_HANDLE>/status/<YOUR_POST_ID> \
  --live
```

The command fetches the post, checks author ID and handle against the current
and setup-pinned account, explicitly refuses `@thsottiaux`, applies the same
rolling guard, persists the mutation marker, and permits one POST. An ambiguous
result remains `unknown` after at most one read-only verification and is never
retried.

## Background service

Build, complete setup, and make sure browser cookies—not environment-only
credentials—are readable. Then install and start the event-driven user service:

```bash
codex-reset-request service install
codex-reset-request service status
```

Lifecycle commands:

```bash
codex-reset-request service start
codex-reset-request service stop
codex-reset-request service restart
codex-reset-request service uninstall
```

On macOS this manages
`~/Library/LaunchAgents/io.github.ncihxaonn.codex-reset-request.plist`. On Linux
it manages the XDG user unit
`~/.config/systemd/user/codex-reset-request.service`. Neither implementation
creates a scheduled `StartInterval`, `CalendarInterval`, systemd timer, or cron
entry. launchd's `ThrottleInterval=5` is restart backoff, not quota polling.
`stop` suppresses the current managed process; `uninstall` unloads/disables it
before removing the exact definition. Manager/file drift is reported rather
than silently ignored.

Windows service subcommands return a clear unsupported result. Use:

```powershell
codex-reset-request watch
```

## Configuration

```bash
codex-reset-request config show
codex-reset-request config set maxAttemptsPer24Hours 1
codex-reset-request config reset
```

Use `enable-auto` rather than setting `mode=auto` directly. The configured
write ceiling can be 0–3; the immutable hard maximum is three attempts in any
rolling 24 hours. The default is one. Records with `attempting`, `unknown`, or a
mutation marker continue to occupy guards across restarts.

## Data locations

| Platform | Config | State | Logs |
| --- | --- | --- | --- |
| macOS | `~/Library/Application Support/codex-reset-request/config.json` | `~/Library/Application Support/codex-reset-request/state/` | `~/Library/Logs/codex-reset-request/` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/codex-reset-request/config.json` | `${XDG_STATE_HOME:-~/.local/state}/codex-reset-request/` | state directory + `/logs/` |
| Windows | `%APPDATA%\codex-reset-request\config.json` | `%LOCALAPPDATA%\codex-reset-request\` | state directory + `\logs\` |

`CRR_CONFIG_DIR`, `CRR_STATE_DIR`, and `CRR_LOG_DIR` override these locations.
Service installation requires every override to be absolute. Unix application
directories use mode `0700`; config, state, cursor, audit, lock, and service
definition files use mode `0600` where supported.

State and cursor JSON files have a 4 MiB safety ceiling. Guard history is never
silently evicted because removing it could permit a duplicate write. If the
ceiling is reached, stop the watcher, archive the complete state directory, and
only then make an explicit operator decision; see
[troubleshooting](docs/troubleshooting.md).

The redacted audit log is capped at 16 MiB. Service stdout/stderr logs have no
application-managed rotation. Review, rotate, or remove exact log files while
the watcher/service is stopped according to local policy.

## Privacy and security

The project has no telemetry, analytics, crash-report service, remote storage,
proxy rotation, or runtime LLM call. It reads only newly appended Codex rollout
bytes and local browser cookies needed for X authentication. Redacted audit
events remain local.

Data is not entirely offline: setup, doctor, explicit live tests, and a
confirmed action can make X web requests; App Server confirmation uses a local
Codex subprocess that relies on the existing Codex login. See
[privacy](docs/privacy.md), [threat model](docs/threat-model.md), and
[security policy](SECURITY.md).

No local OS notifications are sent; status stays in the CLI, state, and
redacted local logs.

Bird uses undocumented X web GraphQL endpoints. Publishing the source does not
make live automation permissible. X's current
[Automation Rules](https://help.x.com/en/rules-and-policies/x-automation)
prohibit non-API scripting of the X website, so this implementation is not
suitable for live automatic use as written. A disclaimer does not cure that
conflict. Read the complete [disclaimer](DISCLAIMER.md).

## Uninstall and complete data removal

First disable auto mode and unload the service:

```bash
codex-reset-request disable-auto
codex-reset-request service uninstall
pnpm remove --global codex-reset-request
```

The source checkout and application data are intentionally not deleted by the
uninstaller. After confirming the service is stopped, remove only the exact
config, state, and log paths listed above using your operating system's file
manager. Remove the source checkout separately if it is no longer needed. Do
not delete `$CODEX_HOME`: it belongs to Codex and is never owned by this tool.

## Known limitations and compatibility

- The tool submits a request; it cannot reset or grant Codex usage.
- It never calls `account/rateLimitResetCredit/consume`; official reset-credit
  redemption is outside v0.1.
- The v0.1 action targets one configured account and one reply text.
- Undocumented X endpoints and response shapes can change without notice.
- Codex `0.140.0` is tested; other versions are reported as untested and fail
  closed on incompatible App Server schemas.
- Native watcher availability depends on the host filesystem. There is no
  polling fallback.
- macOS and Linux have managed user services; Windows is foreground-only.
- Sleep/wake and rapid file changes are caught up from saved byte offsets, but
  no latency guarantee is made for every filesystem.
- A disclaimer does not override X rules, workplace policy, or applicable law.

See the detailed [compatibility matrix](docs/compatibility.md) and
[troubleshooting guide](docs/troubleshooting.md).

## Contributing

Contributions are welcome within the deliberately narrow, local-first scope.
Read [CONTRIBUTING.md](CONTRIBUTING.md) and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Do not attach credentials, browser
databases, raw rollout files, prompt text, or unredacted error bodies to an
issue. Live write tests must target a post owned by the tester and remain opt-in.
