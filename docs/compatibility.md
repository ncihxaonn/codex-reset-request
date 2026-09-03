# Compatibility

This document distinguishes code support from environments actually verified
for the public alpha.

## Runtime matrix

| Component | Support | Alpha evidence |
| --- | --- | --- |
| Node.js | `>=22` | `22.18.0` used for local verification |
| pnpm | development/install | `11.23.0` used locally |
| Codex CLI | schema-checked, fail closed | `0.140.0` tested locally |
| macOS | foreground + launchd user service | native watcher/App Server/status exercised locally; lifecycle logic unit-tested |
| Linux | foreground + systemd user service | unit-tested; CI matrix required before release |
| Windows | foreground watcher | code paths unit-tested; Windows-host CI required before release |
| Windows auto-start | unsupported in v0.1 | returns an explicit warning |
| Bun | optional inherited binary build only | not required or installed locally |

The Codex App Server protocol is documented by OpenAI at
<https://learn.chatgpt.com/docs/app-server>. This project validates only the
small initialize and `account/rateLimits/read` response surface it uses. A Codex
version other than `0.140.0` is reported as untested; incompatible or ambiguous
responses stop the action rather than being guessed.

Maintainers can run `pnpm codex:schemas` to generate both TypeScript and JSON
protocol trees under ignored `.tmp/` paths. The script validates the exact
initialize and rate-limit fields consumed by this project, canonicalizes JSON
before drift comparison, and does not read Codex sessions or authentication.

## Browser credentials

Bird attempts Safari, Chrome, and Firefox browser-cookie sources (or one
explicitly configured source). Platform/keychain restrictions can prevent a
background process from reading a session that is readable in an interactive
shell. Complete setup and `doctor`, then confirm service status on the same user
account. Managed services reject credentials available only through shell
environment variables.

## Filesystems

The watcher requires native filesystem notifications. Local APFS, common Linux
filesystems, and Windows foreground semantics are the intended targets. Some
network mounts, container bind mounts, sandboxed hosts, or file-provider layers
may not expose usable events. Startup fails clearly; it never falls back to
polling.

## X web compatibility

The retained Bird client uses undocumented X web GraphQL operations and browser
cookies. Endpoint identifiers, response shapes, and automation policy can
change without notice. Read compatibility does not guarantee write
compatibility. Every update to GraphQL parsing or mutations requires baseline,
one-shot, timeout, and malformed-response tests.

## Service definitions

- macOS: launchd user agent, RunAtLoad, restart-on-failure, no scheduled
  StartInterval/CalendarInterval (`ThrottleInterval` is restart backoff).
- Linux: systemd user unit, `Restart=on-failure`, no timer.
- Windows: run `codex-reset-request watch` in a foreground terminal.

Moving the source checkout, Node binary, config paths, or Codex home requires a
fresh `service install` so the absolute definition is replaced and the active
service restarted.
