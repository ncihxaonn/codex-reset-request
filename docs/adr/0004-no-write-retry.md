# ADR 0004: No write retry

- Status: accepted
- Date: 2026-08-28

## Decision

Every logical action can start at most one X mutation transport attempt. Do not
retry timeouts, 5xx responses, malformed responses, redirects, thrown provider
errors, or alternate endpoints. Permit at most one read-only verification after
an ambiguous outcome.

## Rationale and consequences

A timeout does not prove the server rejected a POST. Retrying can duplicate a
public reply. Persisting `attempting` and `mutationStartedAt` before transport,
then retaining `unknown`, favors missed requests over unintended duplicates.
Operators must not clear unknown state to force another automatic write.
