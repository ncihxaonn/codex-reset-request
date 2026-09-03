# Production dependency audit

This snapshot records the checks run against `pnpm-lock.yaml` on 2026-09-03.
It is evidence for this source tree, not a guarantee about future advisories.
The recorded tool version is pnpm `11.23.0`.

## Known-vulnerability check

```bash
pnpm audit --prod --audit-level high
```

Result: no known vulnerabilities were reported.

## License inventory

```bash
pnpm licenses list --prod --json
```

The production dependency closure reported only permissive licenses:

- MIT: `@steipete/sweet-cookie`, `commander`, `cssom`, `dom-serializer`,
  `html-escaper`, `htmlparser2`, `json5`, `kleur`,
  `x-client-transaction-id`, and `zod`.
- ISC: `boolbase`, `linkedom`, and `uhyphen`.
- BSD-2-Clause: `css-select`, `css-what`, `domelementtype`, `domhandler`,
  `domutils`, `entities`, and `nth-check`.

Package-level copyright and license files remain authoritative. Anyone shipping
a bundled executable or vendored dependency tree must retain the notices
required by those licenses. Re-run both commands against the exact release
lockfile immediately before publishing.
