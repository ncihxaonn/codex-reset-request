# Troubleshooting

Start with safe diagnostics:

```bash
codex-reset-request doctor
codex-reset-request status --json
codex-reset-request service status --json
codex-reset-request logs --tail 100
```

Share only safe codes. Do not paste full rollout lines, prompts, cookies,
authorization headers, browser databases, home paths, or raw GraphQL/App Server
responses into an issue.

## App Server or Codex failures

- `binary-not-found`: ensure `codex --version` works for the same user and PATH.
- `codex-version-untested`: the binary parsed, but is not the alpha's tested
  `0.140.0`.
- `codex-home-mismatch`: `CRR_CODEX_HOME`, config, and the service definition do
  not resolve to the same home; run setup and reinstall the service.
- `initialize-*` or `rate-limits-schema`: the App Server protocol changed or the
  response is ambiguous. Upgrade only after compatibility is reviewed; do not
  bypass confirmation.
- `timeout` or `process-exited`: run Codex interactively, confirm login, then
  retry the read-only doctor check.

## Native watcher unavailable

Confirm the resolved sessions directory exists, is a real directory rather
than a symlink, and is readable. Sandboxes, network mounts, file-provider
folders, and containers may not expose native events. Move Codex sessions to a
supported local filesystem or use a compatible host. There is deliberately no
polling fallback.

## X browser session unavailable

Log in to `https://x.com` in the configured browser/profile and run `doctor`
from the same OS user. macOS may request keychain/browser access. A managed
service requires browser-readable cookies and rejects an environment-only
credential pair. Never put cookie values in the plist/unit, config, an issue,
or a shell command argument.

If foreground reads pass but the service fails, stop the service, check OS
permissions for the service context, repeat setup, and reinstall. The service
definition pins absolute paths and does not inherit shell aliases.

## Service lifecycle

- `service-status-unavailable`: launchctl/systemd could not be queried; this is
  different from an installed-but-stopped service.
- `service-running-definition-missing`: the manager still has a live job but
  its definition disappeared. `service stop` or `service uninstall` will target
  the known job without deleting unrelated files.
- `service-installed-stopped`: use `service start` and inspect safe service logs.
- after moving Node or the checkout: rebuild and run `service install` again.
- Linux user services require a working user systemd manager/session.
- Windows v0.1 must use foreground `watch`.

No service command creates a timer or cron entry.

## Action did not post

This can be correct. Check the latest safe code for dry-run mode, confirmation
failure, target ambiguity, account mismatch, revoked consent,
same event/window/action, rolling limit, or hard limit. Do not clear state to
force a post. The project cannot guarantee a target post or a reset response.

## Action is `unknown`

Do not retry. `unknown` means transport may have reached X but a unique result
could not be proven. The state permanently occupies the relevant guards. Check
the current account manually and leave the record intact.

## State file too large

JSON data is capped at 4 MiB before atomic replacement, so the last valid file
remains in place when a write would exceed the ceiling. Stop the watcher and
uninstall/stop the service, make a complete private archive of the state
directory, and inspect safe metadata. Guard records are intentionally never
auto-evicted. Removing or editing them can enable duplicate writes; do so only
as an explicit operator decision with auto mode disabled.

## Live test refused

`x-read` requires `CRR_LIVE_X=1`. `x-reply` also requires `--live`, a strict
user-owned status URL, a setup-pinned account match, fetched author ownership,
the singleton lock, and available rolling capacity. CI and `@thsottiaux` are
always rejected. Stop the watcher before a live write test and use a post owned
by the current account.
