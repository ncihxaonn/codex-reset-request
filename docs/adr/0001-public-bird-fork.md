# ADR 0001: Public Bird fork

- Status: accepted
- Date: 2026-08-28

## Decision

Publish Codex Reset Request as a public fork of `0xEnc0der/bird-x-cli`; retain
Git history, the `bird` binary, MIT license, upstream notices, and a precise base
SHA. Until authentication permits fork creation, complete the implementation
locally without claiming a public repository exists. Use a separate package
identity/version and `codex-reset-request` binary.

## Rationale and consequences

The action depends on Bird's browser-cookie and X web client. A real fork makes
the derivation and changes auditable and avoids copying code without history.
Upstream changes must be reviewed for mutation/retry and privacy regressions.
The project is not Bird v3, an official Bird release, or endorsed by upstream.
