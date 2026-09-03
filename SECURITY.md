# Security policy

## Supported version

The current `0.1.0-alpha.0` branch receives security fixes. This alpha has no
stability or backward-compatibility guarantee.

## Reporting a vulnerability

After the public fork exists, use the repository's private GitHub Security
Advisory flow. Do not open a public issue for a vulnerability and do not send
credentials as proof.

Include only:

- a concise impact statement;
- affected commit and operating system;
- safe reproduction steps using synthetic fixtures;
- relevant safe codes;
- a proposed mitigation, if known.

Never include X cookies, Codex tokens, authorization headers, browser databases,
`~/.codex/auth.json`, raw rollout files, prompts, home paths, JWT-like strings,
or full response bodies. Maintainers may ask for a minimized synthetic test.

## Security boundaries

The project reads local Codex rollout append data and browser cookies, starts a
bounded Codex App Server subprocess, and may send one X web mutation after
explicit opt-in. It does not sandbox Node, Codex, the browser-cookie provider,
or the operating-system service manager. Users must secure the account and
host on which it runs.

The following are treated as security-sensitive regressions:

- a false-positive path that can reach an X write;
- any write retry, fallback mutation, or ambiguous-result replay;
- bypass of consent, expected-account checks, deduplication, the singleton lock,
  or the hard rate ceiling;
- credentials, prompts, source, raw response bodies, or raw rollout records
  entering action state, logs, fixtures, command arguments, or errors. The
  private cursor may hold one bounded unfinished rollout fragment as disclosed
  in `docs/privacy.md`;
- following symlinks outside owned data paths or writing Codex session files;
- passing unrelated X, GitHub, or API-key environment variables into the Codex
  App Server subprocess;
- polling, timer, telemetry, remote configuration, or runtime LLM additions.

Undocumented X endpoints can change independently of this project. A broken
endpoint is normally a compatibility issue; a change that causes an unintended
write, credential disclosure, or replay is a security issue.

## Disclosure

Please allow maintainers a reasonable period to reproduce and prepare a fix
before public disclosure. No bug-bounty program is promised. The software is
provided under the MIT License and the separate disclaimer applies.
