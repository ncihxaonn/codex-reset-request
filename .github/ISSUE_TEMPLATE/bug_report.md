---
name: Bug report
about: Report a reproducible Codex Reset Request or retained Bird CLI problem
title: '[BUG] '
labels: bug
assignees: ''
---

> For a vulnerability or sensitive conduct report, stop and use the private
> route in [SECURITY.md](../../SECURITY.md). Never put credentials or private
> data in a public issue.

**Safety check**

- [ ] I removed cookies, tokens, authorization headers, browser databases/profile
  paths, `~/.codex/auth.json`, prompt/source/tool text, raw rollout records, raw
  network bodies, home-directory paths, and full unredacted output. I did not
  attach `config.json`, `state.json`, `cursors.json`, `audit.jsonl`, watcher
  locks, or service logs.

**Component**

`codex-reset-request` / retained `bird` CLI / documentation / other

**Safe summary**

A concise description without account data or private content.

**Safe codes**

Transcribe only the relevant safe codes from `doctor`, `status`, or service
status. Do not paste complete output.

**Minimal synthetic reproduction**

List commands and synthetic inputs only. Do not attach real rollout files,
browser data, or raw responses.

**Expected behavior**

What you expected to happen.

**Actual behavior**

What happened? Use safe codes; do not include full error output.

**Environment**

- OS and version:
- Node version:
- pnpm version:
- `codex-reset-request` version:
- Codex CLI version:
- retained `bird` version, if relevant:
- run mode (`dry-run` or `auto`):
- foreground / launchd / systemd:

**Live activity**

State whether any live X read or write occurred. If a write occurred, state
only whether it targeted your own post and the final safe status; do not attach
credentials or raw responses.
