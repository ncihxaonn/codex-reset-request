# Public alpha candidate release checklist

This checklist records evidence rather than aspirations. Do not mark remote
items complete from local results alone.

## Blocking policy and identity checks

- [ ] Replace Bird's non-API X website scripting with an officially supported
      X API/OAuth integration. Current
      [X Automation Rules](https://help.x.com/en/rules-and-policies/x-automation)
      prohibit scripting the X website, and the
      [Terms of Service](https://x.com/en/tos) require X's published interfaces,
      so disclaimers alone are insufficient.
- [ ] Confirm the target account has expressly opted in to automated replies
      and provide the required easy opt-out path before any live third-party
      reply is enabled.
- [ ] Publish only a clean personal-author history; do not expose earlier local
      commits carrying a company Git identity.

Do not create or push the public repository while any item in this section is
unchecked.

## Repository and attribution

- [ ] Public GitHub fork exists and GitHub reports parent
  `0xEnc0der/bird-x-cli`.
- [ ] `origin` points to the public fork; `upstream` points to the primary
  upstream.
- [x] Exact upstream base SHA/tag/version/date are recorded.
- [x] MIT license, Bird history, third-party notices, and both binaries remain.
- [x] Production dependency licenses are inventoried as MIT, ISC, or
      BSD-2-Clause; bundled redistributions must retain package notices. See
      the dated [dependency audit](dependency-audit.md).
- [x] Package identity is `codex-reset-request@0.1.0-alpha.0`, private only to
  prevent accidental npm publication.

## Product safety

- [x] Default mode cannot write.
- [x] Strict classifier and App Server confirmation are required.
- [x] Existing files initialize at EOF; Codex files remain read-only.
- [x] Event/window/action/24-hour guards persist across restarts.
- [x] Mutation intent is persisted before the sole POST.
- [x] Timeout/ambiguous result becomes guarded `unknown`; no write retry exists.
- [x] Current account, target author identity, local consent, and config are
      rechecked. Recipient opt-in remains a separate blocker above.
- [x] Hard maximum is three attempts per rolling 24 hours.
- [x] No polling, cron, timer, telemetry, runtime LLM, or bypass feature exists.
- [x] Logs are redacted and size-bounded; no local OS-notification feature
      exists; prompts and credentials are never included.

## Local verification

- [x] Typecheck, lint, unit/integration tests, and build pass on the final tree.
- [x] Native watcher suite passes when run outside the restricted sandbox.
- [x] Real local Codex App Server rate-limit read has been exercised.
- [x] `bird --help` and `codex-reset-request --help` build and run.
- [x] launchd status query handles the real not-loaded exit code.
- [x] The local secret scan covers full history; no-polling and attribution
  verifiers also pass.
- [x] The production dependency audit reports no known vulnerabilities.
- [ ] One manually authorized reply to a post owned by the user succeeds and is
  recorded as `sent`. Never use Tibo's post for this check.

## Hosted checks

- [ ] CI passes on macOS, Ubuntu, and Windows with Node 22 and required native
  watcher tests.
- [ ] CodeQL passes.
- [ ] secret/polling/attribution verifiers pass in GitHub Actions.
- [ ] Dependabot configuration is active.
- [ ] Branch protection/review settings are considered after the fork exists.
- [ ] GitHub private vulnerability reporting is enabled and available as the
  documented private security/conduct route.

## Documentation and operations

- [x] English and Chinese READMEs explain authentication and no-reset guarantee.
- [x] Disclaimer, privacy, threat model, security, troubleshooting, provenance,
  contributing, code of conduct, and ADRs are present.
- [x] macOS launchd and Linux systemd user services have no timers.
- [x] Windows foreground mode is documented.
- [x] Environment-only X credentials are rejected for managed services.
- [x] Exact data locations, uninstall, and complete removal are documented.

## Deliberate v0.1 backlog

- Windows auto-start installer.
- native Codex UsageLimit hook adapter, if an official stable hook becomes
  available.
- managed/persistent App Server session mode.
- Codex Plugin packaging.
- tray/menu-bar application.
- official earned-reset redemption. This alpha never calls
  `account/rateLimitResetCredit/consume`.
- Homebrew distribution and signed standalone binaries.
- additional X providers.
- web dashboard and remote webhooks.
- npm publication and upgrade channel.
- Support claims for Codex versions other than the tested version.
- Any additional automatic action or target strategy.

These backlog items are not release blockers when clearly documented.
