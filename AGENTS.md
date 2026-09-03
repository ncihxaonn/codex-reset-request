# AGENTS.md

- Never commit real Codex rollout files.
- Never commit browser cookies, auth_token, ct0, or Codex credentials.
- Never print prompts, source code, tool output, cookies, or auth tokens.
- Never add periodic quota polling.
- Never retry an ambiguous X write.
- One logical action may perform at most one X mutation attempt.
- Never add CAPTCHA bypass, stealth, fingerprint spoofing, or proxy rotation.
- Keep all subprocess arguments as arrays; do not invoke through a shell.
- Preserve all upstream MIT attribution.
- Update UPSTREAM.md and docs/compatibility.md when syncing Bird.
- Add tests for every Codex schema or X GraphQL parser change.
- Run typecheck, lint, tests, build, and security checks before committing.
- Do not publish an npm package without an explicit instruction.
- Do not create a private repository.
- Do not describe the project as official, compliant, safe, or guaranteed.
