# ADR 0005: App Server confirmation

- Status: accepted
- Date: 2026-08-28

## Decision

A rollout candidate alone cannot authorize an automatic action. Start a
short-lived bounded local Codex App Server, initialize it, call
`account/rateLimits/read`, validate the allowlisted schema and Codex home, and
require a confirmed exhausted bucket.

## Rationale and consequences

Rollout formats can change and text can be misleading. App Server confirmation
adds an independent structured check using the existing Codex login without an
API key or inference call. Spawning it only after an event preserves idle
zero-network behavior. Timeout, version/schema ambiguity, process failure, or
home mismatch prevents the action.
