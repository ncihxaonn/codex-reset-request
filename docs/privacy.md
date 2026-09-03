# Privacy

Codex Reset Request is local-first, not entirely offline. It has no telemetry,
analytics, crash-report service, remote configuration, advertising identifier,
or runtime LLM inference call.

## Local data read

The process can read:

- metadata and newly appended bytes in `$CODEX_HOME/sessions/**/*.jsonl`;
- the configured browser's X cookies through Bird's cookie provider;
- its own config, state, cursor, lock, and audit files;
- current process/service metadata needed for `doctor` and lifecycle commands.

It does not open `~/.codex/auth.json`, scan `archived_sessions`, copy a browser
cookie database into the project, or read complete rollout history on first
start. Codex rollout files are never modified.

## Local data written

- `config.json`: validated settings, expected handle, and consent metadata; no
  cookies or tokens.
- `state.json`: hashes, safe IDs/URLs, state-machine status, guard timestamps,
  and safe codes; no reply plaintext.
- `cursors.json`: path hashes, safe basenames, file identity, offsets, and the
  literal unfinished JSONL fragment needed to complete a partial line after
  restart. That fragment is bounded to 2 MiB but can temporarily contain Codex
  user/prompt/source content; protect the cursor file as sensitive local data.
- `audit.jsonl`: redacted event type, status, safe codes, and safe URLs/IDs.
- `watcher.lock`: PID, start time, and a random ownership token.
- service stdout/stderr logs: CLI diagnostic messages with home paths redacted.

Unix application data uses private permissions where supported. JSON input is
size-bounded and symlinks at owned sensitive paths are rejected. State guard
history is retained until the operator explicitly archives/removes the whole
state while the watcher is stopped.

## Network and subprocess activity

Idle watching performs no network request. Activity can occur during setup,
doctor, explicit live diagnostics, or after a confirmed rollout event:

1. a local bounded Codex App Server subprocess uses the existing Codex login to
   read account rate limits;
2. Bird sends X web requests to read the active account, target metadata, and,
   only when explicitly authorized, one reply mutation;
3. an unknown mutation result permits one read-only verification request.

The project does not send data to its own server because no such server exists.
OpenAI/Codex and X remain separate trust boundaries governed by their own
services and policies.

## Logs

Central redaction removes cookie/token labels, authorization values, JWT-like
strings, long credential-like hex strings, and user home paths. Prompt text,
source, shell output, raw response bodies, reply plaintext, and credentials must
never be included. The project has no local OS-notification feature.

Redaction is defense in depth, not permission to log secrets. New code should
pass only allowlisted structured values to logging APIs.

The audit log is append-only and capped at 16 MiB. Service stdout/stderr logs
have no application-managed rotation. Operators control retention and should
rotate/remove exact log files only while the watcher/service is stopped.

App Server confirmation calls initialize and `account/rateLimits/read`; it does
not call `thread/start` or `turn/start` and does not create an inference turn.

## Data control

Use `status` and `logs` to inspect safe local records. Use `disable-auto` before
maintenance. To remove project data, uninstall the user service and delete only
the exact platform paths documented in the README. Never delete `$CODEX_HOME`
as part of project cleanup.
