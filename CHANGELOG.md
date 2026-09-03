# Changelog

## 0.1.0-alpha.0 — Unreleased

### Added

- event-driven native Codex rollout watcher with incremental cursors and no
  polling fallback;
- strict `UsageLimitExceeded` classifier and local Codex App Server
  `account/rateLimits/read` confirmation;
- guarded Bird target selection, active-account verification, one-shot reply,
  read-after-write verification, persistent deduplication, and rolling guards;
- dry-run, explicit auto-consent, doctor, status, redacted logs, service,
  and gated diagnostic commands;
- launchd and systemd user-service management, with Windows foreground support;
- private atomic state, provenance, security, privacy,
  threat-model, compatibility, and bilingual documentation;
- cross-platform CI definitions, CodeQL, dependency updates, schema inspection,
  release-policy verifiers, and privacy-safe support templates.

### Security

- fresh configuration and standalone setup default automatic posting off; the
  one-command installer selects auto only after exact risk confirmation;
- no mutation retries, redirect replay, token logging, telemetry, or runtime LLM
  calls;
- the immutable rolling 24-hour maximum is three attempts;
- an ambiguous write is persisted as `unknown` and is never retried;
- the retained Bird credential check reports presence only and no longer prints
  token prefixes.
- JSON and release-scan reads use opened file handles with identity checks to
  prevent path-swap races.
- raw X news responses are no longer written to a debug file.
- browser cookies are accepted only from exact X/Twitter domains or their
  subdomains; lookalike suffixes are rejected.
- Git worktree metadata is read through a stable, non-symlink file descriptor.

## Upstream Bird history (retained for provenance)

The entries below describe upstream Bird releases; they are not Codex Reset
Request version numbers. See `UPSTREAM.md` for the exact fork base.

### Bird CLI v3.0.0 (2026-06-12)

- Fixed transaction-ID double generation in posting requests.
- Bound `x-client-transaction-id` to the actual request URL path.
- Documented environment-file and HTTP 401 troubleshooting.

### zaydiscold/bird v0.9.0 (2026-06)

- Added `x-client-transaction-id` support, GET/POST header separation, and June
  2026 GraphQL query IDs.

### jawond/bird v0.1.0 (2025-12)

- Initial Bird implementation.
