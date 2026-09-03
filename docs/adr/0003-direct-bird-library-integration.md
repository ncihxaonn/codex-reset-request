# ADR 0003: Direct Bird library integration

- Status: accepted
- Date: 2026-08-28

## Decision

Import the retained Bird client as an internal TypeScript library. Do not spawn
the `bird` CLI from the core pipeline, add an X API-key client, or introduce a
second posting implementation.

## Rationale and consequences

Direct integration permits typed safe results, current-account checks,
mutation-boundary persistence, and exact one-attempt control without parsing
shell output. The inherited `bird` binary remains for diagnostics. X browser
cookies are still authentication credentials and undocumented GraphQL remains
a compatibility and policy risk.
