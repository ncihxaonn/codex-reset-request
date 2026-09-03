# Architecture

Codex Reset Request is a single Node.js process around the retained Bird
library. It is not a Codex plugin, hosted service, cron job, or runtime agent.

## Event and action flow

```text
$CODEX_HOME/sessions/**/*.jsonl (read only)
                  │ native fs.watch events
                  ▼
          incremental tailer + cursor
                  │ complete new JSONL records
                  ▼
         strict rollout classifier
                  │ UsageLimit candidate
                  ▼
     temporary local Codex App Server
                  │ account/rateLimits/read
                  ▼
      deduplication + rolling rate guard
                  │ allowed confirmed action
                  ▼
         retained Bird X provider
       ┌──────────┼───────────┐
       │          │           │
 current user  target read  one reply POST
       │          │           │
       └──── account/author ───┘
              verification
                  │
                  ▼
       atomic state + redacted audit
```

The OS file event is only a wake-up signal. Correctness comes from comparing
saved byte offsets with current file metadata and reading the missing range.
There is no scheduled polling interval or timeout loop. A wake-up can cover
multiple appended records; coalesced events are safe because the tailer catches
up to EOF.

## Components

- `watcher/`: native recursive directory watching, catch-up discovery, file
  identity, byte cursors, partial-line buffering, and single-instance lock.
- `codex/`: strict rollout classification, Codex home resolution, CLI
  compatibility, bounded App Server JSON-RPC, and rate-limit confirmation.
- `pipeline/`: stable event/window/action fingerprints, persistent guards,
  mode handling, mutation-boundary authorization, and one-shot state machine.
- `x/`: narrow provider interface, eligible target selection, current-account
  check, one mutation attempt, and read-only verification.
- `state/`: validated atomic JSON, migrations, lock, and redacted JSONL audit.
- `service/`: launchd/systemd user-service definitions and lifecycle queries.

The inherited Bird commands and library remain under `src/commands` and
`src/lib`. The new CLI is isolated under `src/reset` but imports Bird as a
library, avoiding runtime shell calls to `bird`.

## Startup and cursors

On first startup, the watcher enumerates existing session JSONL metadata and
stores each current EOF without reading history. A file created afterward is
read from byte zero. A saved cursor contains only a path hash, safe basename,
file identity, byte offset, size, trailing partial line, and observation time.

Truncation or file-identity replacement resets parsing conservatively. Deleted
files are pruned from active cursor state. New date directories and sessions
are discovered through native events plus event-driven catch-up scans. Codex
files are never written.

## Candidate and confirmation boundary

The classifier accepts only `event_msg` records whose payload is `error` or
`stream_error`, with an allowlisted structured usage-limit value or a narrow
fallback phrase at the expected message field. It does not recursively search
user, assistant, tool, command, log, or arbitrary nested content. HTTP 429 alone
is not a quota signal.

For every accepted candidate, a bounded short-lived `codex app-server`
subprocess must initialize successfully and return a compatible
`account/rateLimits/read` response for the same resolved Codex home. Missing or
ambiguous buckets, timeouts, schema changes, and home mismatch fail closed.
The confirmation client does not call `thread/start` or `turn/start`; it creates
no Codex conversation or inference turn. The subprocess receives a minimal
runtime environment allowlist plus the resolved `CODEX_HOME`; unrelated X,
GitHub, and API-key variables are not inherited.

## Durable one-write state machine

```text
candidate → confirmed → target-resolved → attempting
                                             │
                                  persist mutationStartedAt
                                             │
                                  exactly one transport POST
                                  ┌──────────┼──────────┐
                                  ▼          ▼          ▼
                                sent   definitive   unknown
                                         failure       │
                                               one read-only check
```

`attempting` is stored before entering the provider. `mutationStartedAt` is
stored immediately before transport. Startup converts a stale `attempting`
record to `unknown`; neither status can be automatically retried. Redirects are
not followed for writes, and the Bird mutation method has no retry or fallback.

Event, limit-window, action, and rolling-24-hour guards are persisted. Guard
history is not silently evicted. The configured limit defaults to one and the
hard maximum is three attempts in any rolling 24 hours.

## Runtime and service boundaries

The service definition contains absolute Node, built CLI, Codex home, config,
state, and log paths plus a captured non-secret PATH. It never contains X
cookies. Environment-only X credentials are refused for background install.
launchd uses RunAtLoad plus restart-on-failure and systemd uses
`Restart=on-failure`; neither uses a timer.

All subprocesses use argv arrays without a shell, bounded output, timeouts, and
termination escalation. Logs accept only safe structured fields and the
project sends no local OS notifications. See [threat-model.md](threat-model.md)
for residual risks.
