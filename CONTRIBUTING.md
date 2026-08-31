# Contributing

## The one rule that shapes everything: spec first

[`PROTOCOL.md`](./PROTOCOL.md) and [`THREAT-MODEL.md`](./THREAT-MODEL.md) are
normative. Code that disagrees with them is a defect — fix the code. A
deliberate behavior change edits the document **in the same commit** as the
code, with a `Spec change:` note in the commit body. Never let them drift.

The same holds in reverse for review: check a change against the spec, not
against the previous code.

## Setup

Node >= 20 and pnpm 11; Bun for the Bun-tagged suites.

```bash
pnpm install
pnpm build     # tsc -b, reference order: core -> server/client -> adapters
pnpm test      # vitest, all packages
```

Before pushing:

```bash
pnpm build && pnpm test
pnpm publint          # publint + @arethetypeswrong/cli, all packages
pnpm size             # client bundle ratchet (12.5 KiB) — a regression fails
pnpm -F brobridge test:bun
pnpm -F @brobridge/client test:bun
```

`pnpm check:consumer` (packed tarballs in a fresh project) and
`node scripts/bench.mjs` are release-gate checks; run them when touching
packaging or anything on the data path.

## Ground rules

- **Dependencies.** `@brobridge/core` and `@brobridge/client` have zero
  runtime dependencies — hard rule. Elsewhere, a new runtime dependency
  needs explicit justification in the PR body.
- **TypeScript.** Strict, `exactOptionalPropertyTypes`, no `any` in public
  API. ESM only.
- **Tests.** Every fixed bug gets a regression test. New frame handling or
  option handling gets table-driven tests. Anything security-relevant gets
  its attack row in the hardening suite
  (`packages/server/tests/hardening.test.ts`) and, if new, in
  `THREAT-MODEL.md`.
- **Errors.** Stable discriminants only: `code` for wire faults
  (PROTOCOL.md §12), `reason` for client faults. Never make callers branch
  on message text; messages may change freely.
- **Docs.** Public API carries JSDoc. README examples must compile — CI
  checks them verbatim (`scripts/check-readme-examples.mjs`); mark narrative
  fragments per that script's convention.
- **Commits.** Conventional commits (`feat(core): …`, `fix(server): …`).

## Adapters

Keep each adapter under ~300 lines. If one wants more, the missing primitive
probably belongs in core/server/client — open an issue instead of
duplicating. Target frameworks are optional peer dependencies; an adapter
subpath must never import another framework.

## Releases

Changesets flow:

1. Land your change with a changeset: `pnpm changeset` (pick bump levels;
   the four packages version independently).
2. The release automation opens/updates a "Version Packages" PR that
   accumulates changesets into CHANGELOGs and version bumps.
3. Merging that PR publishes to npm (with provenance) after a full build and
   test pass.

Manual preconditions, once: the npm scope exists and `NPM_TOKEN` is
configured in the repository secrets.

## Security issues

Do not open a public issue. See [`SECURITY.md`](./SECURITY.md).
