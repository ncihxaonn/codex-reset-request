# Upstream provenance

- Primary upstream: [`0xEnc0der/bird-x-cli`](https://github.com/0xEnc0der/bird-x-cli)
- Secondary upstream: [`zaydiscold/bird`](https://github.com/zaydiscold/bird)
- Original project: [`jawond/bird`](https://github.com/jawond/bird), originally implemented by Peter Steinberger
- Base commit SHA: `a16f9901717008bf1ab3ea0b715dfd95dedc95b0`
- Local base tag: `upstream-bird-v3-base`
- Base package version: `0.9.0`
- Base README version: `Bird CLI v3.0.0`
- Date forked: `2026-08-28`

The retained copyright lines were cross-checked against each upstream's public
license file: [`jawond/bird`](https://github.com/jawond/bird/blob/main/LICENSE),
[`zaydiscold/bird`](https://github.com/zaydiscold/bird/blob/main/LICENSE), and
[`0xEnc0der/bird-x-cli`](https://github.com/0xEnc0der/bird-x-cli/blob/main/LICENSE).

## Local changes summary

This project retains Bird's browser-cookie credential resolution, read
operations, search, and posting implementation while adding an independent
event-driven Codex usage-limit detector and a deliberately constrained reset
request action. The new action defaults to dry-run, confirms the limit through
the local Codex App Server, verifies the active X account, selects one eligible
target post, and permits at most one mutation attempt per logical action.

The repository version is `0.1.0-alpha.0`; it is not represented as Bird v3.
When syncing Bird, update this file and `docs/compatibility.md`, retain all MIT
notices, and add regression tests for changed GraphQL parsing or mutations.
