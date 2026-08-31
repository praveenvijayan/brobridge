# Contributing

## The one rule that shapes everything: spec first

[`PROTOCOL.md`](./PROTOCOL.md) and [`THREAT-MODEL.md`](./THREAT-MODEL.md) are
normative. Code that disagrees with them is a defect — fix the code. A
deliberate behavior change edits the document **in the same commit** as the
code, with a `Spec change:` note in the commit body. Never let them drift.

The same holds in reverse for review: check a change against the spec, not
against the previous code.

## Setup

**Development needs Node 22** (`.nvmrc`): pnpm 11 uses `node:sqlite` and will
not start on anything older. **The published packages support Node >= 20** —
that is the `engines` floor in every `package.json`, and CI runs the whole
suite on it. The two numbers are different on purpose;
`pnpm check:engines` keeps them from drifting apart by accident.

Bun is needed for the Bun-tagged suites.

```bash
pnpm install
pnpm build     # tsc -b, reference order: core -> server/client -> adapters
pnpm test      # vitest, all packages
```

Before pushing:

```bash
pnpm build && pnpm test
pnpm typecheck        # tsc -b plus the tests' own project
pnpm check:engines    # the engines floor, stated the same way everywhere
pnpm publint          # publint + @arethetypeswrong/cli, all packages
pnpm size             # client bundle ratchet (12.5 KiB) — a regression fails
pnpm -F brobridge test:bun
pnpm -F @brobridge/client test:bun
```

`pnpm check:consumer` (packed tarballs in a fresh project) and
`node scripts/bench.mjs` are release-gate checks; run them when touching
packaging or anything on the data path.

## CI

[`.github/workflows/ci.yml`](./.github/workflows/ci.yml) runs on every push to
`main` and every pull request:

| Job | What it covers |
| --- | --- |
| `test` (node 20, 22, 24) | build, typecheck, the full vitest suite |
| `bun` | the Bun-tagged suites for the server and the client |
| `quality` | engines, publint + attw, the client size ratchet, the README examples, the packed-tarball consumer check |
| `bench-smoke` | `scripts/bench.mjs --smoke` — advisory, `continue-on-error` |

Two things about that file are worth knowing before you edit it.

**The `test` job installs and builds on the toolchain Node, then switches to
the matrix Node just for the test run.** It has to: pnpm 11 cannot start on
Node 20, so a job that ran `pnpm install` there could not report anything
about Node 20. The test step runs `node ./node_modules/vitest/vitest.mjs run`
— what `pnpm test` runs, with the matrix's Node executing it.

**`bench-smoke` never gates.** A shared runner's MiB/s and p99 belong to the
runner. `--smoke` cuts the loads down and drops every rate and latency
threshold, keeping the assertions that hold on any machine: no lost bytes, a
paused consumer holding no more than its window, an in-order resume, and a run
that finishes rather than deadlocking. Add a number to the smoke gate and you
have added a flaky test.

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

Changesets flow, run by
[`.github/workflows/release.yml`](./.github/workflows/release.yml) on every
push to `main`:

1. Land your change with a changeset: `pnpm changeset`. The four packages are
   a `fixed` group in `.changeset/config.json` — they release together, on one
   version number, because the protocol they implement is one thing.
2. With changesets present, the release job opens or updates a
   **"Version Packages"** pull request holding the version bumps and the
   CHANGELOG entries. It publishes nothing.
3. Merging that pull request is the next push to `main`. No changesets remain,
   so the same job publishes instead: `pnpm changeset publish`, with npm
   provenance (`id-token: write` plus `NPM_CONFIG_PROVENANCE`), after a build,
   the full test suite and `pnpm publint` have passed in that job. Nothing
   untested reaches the registry.

Two preconditions are manual, once, and the workflow cannot check them for
you:

- the **`@brobridge` scope exists on npm** and the publishing account owns it
  (`brobridge` — the server package — is an unscoped name, so it must be
  claimed too);
- **`NPM_TOKEN`** — an npm *automation* token — is set in the repository
  secrets. Provenance additionally requires that each package's
  `repository.url` matches the repository the workflow runs in; they do, and
  `pnpm publish:dry` is what catches it if that ever stops being true.

## Security issues

Do not open a public issue. See [`SECURITY.md`](./SECURITY.md).
