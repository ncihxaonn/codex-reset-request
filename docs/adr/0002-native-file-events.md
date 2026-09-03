# ADR 0002: Native file events

- Status: accepted
- Date: 2026-08-28

## Decision

Use operating-system file events to wake an incremental cursor-based tailer.
Do not add interval polling, cron, launchd `StartInterval`/`CalendarInterval`,
or systemd timers. If native watching is unavailable, fail with a clear
diagnostic. A launchd restart throttle is process supervision, not scheduling.

## Rationale and consequences

The tool should be idle until a local Codex append occurs. File events can be
coalesced, so correctness must come from offsets, identities, and EOF catch-up,
not from one-event-per-write assumptions. Some sandboxes and network filesystems
are unsupported rather than receiving a silent polling fallback.
