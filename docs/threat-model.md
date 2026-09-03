# Threat model

## Security goals

The primary safety goal is preventing an unintended or repeated X write from a
false Codex signal, ambiguous transport result, wrong account, race, restart,
or configuration change. Secondary goals are keeping credentials and raw user
content out of action state, logs, and unsafe output, and avoiding writes
outside owned paths. The private cursor exception for an unfinished rollout
fragment is disclosed in `privacy.md`.

## Assets

- the user's X and Codex authenticated sessions;
- the authority to post from the current X account;
- Codex rollout and auth data;
- local config, guard state, cursor integrity, and audit history;
- filesystem and service-manager integrity.

## Trust boundaries

- Codex CLI/App Server and its evolving JSON-RPC schema;
- X web GraphQL endpoints and responses;
- Bird and the browser-cookie provider;
- local filesystem events, metadata, and permissions;
- launchd/systemd and the host user account;
- operator-supplied config and live-test URL.

## Threats and mitigations

| Threat | Mitigation |
| --- | --- |
| Prompt/tool text imitates a quota error | Classify only allowlisted server-error record paths; no recursive scanning |
| Generic 429 becomes an account-quota action | 429 alone is rejected; App Server bucket confirmation is mandatory |
| Old rollout triggers immediately | First-run cursors start existing files at EOF |
| Coalesced events lose data | Event wakes an offset-to-EOF incremental catch-up |
| Wrong X account posts | Current ID/handle checked during preflight and again immediately before mutation |
| Target spoofing | Target author ID, handle, post shape, recency, and timeline/search evidence validated |
| Live-test URL spoofing | Strict HTTPS host/path plus fetched author ID and current-account ownership check |
| Duplicate event/window/action | Persistent stable hashes and fail-closed state migration |
| Concurrent daemons or CLI write | Exclusive `wx` singleton lock and serialized state machine |
| Crash around POST | `attempting` and `mutationStartedAt` persisted first; restart becomes `unknown` |
| Timeout/redirect/5xx causes replay | One POST, manual redirect handling, no retry/fallback; one read-only verification only |
| Config/consent changes before write | Configuration and authorization reloaded at mutation boundary |
| Excess automated activity | Configured rolling guard and immutable hard maximum of three per 24 hours |
| Cookie/token disclosure | Browser-first in-memory resolution, no secret persistence, allowlisted output, redaction |
| Symlink/path attack | Absolute service paths, regular-file checks, sensitive symlink rejection, atomic rename |
| Runaway subprocess | argv spawn without shell, timeout, output cap, graceful then forced termination |
| Manager/file drift leaves daemon alive | Query manager independently and unload/disable known jobs even if definition is missing |

## Explicitly out of scope

The project does not attempt CAPTCHA or anti-bot bypass, stealth/fingerprint
spoofing, proxy rotation, multi-account operation, bulk replies, randomized
spam text, automatic reply deletion, unlimited retry, or platform-safeguard
evasion. It does not protect a fully compromised host or account.

## Residual risks

- X can change endpoints, response shapes, terms, or enforcement.
- A valid automatic reply may still be unwanted, duplicated outside this
  project's control, removed, rate-limited, or lead to account restriction.
- A compromised browser session, Node dependency, Codex binary, or user account
  is outside the process boundary.
- Native filesystem notifications can be unavailable or behave differently on
  unusual mounts; the process then stops instead of polling.
- Local users/processes with equivalent account privileges may read or alter
  files despite application-level permissions.
- The requested reset may never be acted upon. This tool has no reset authority.

Review [DISCLAIMER.md](../DISCLAIMER.md) and [SECURITY.md](../SECURITY.md) before
enabling automatic posting.
