# Changesets

Version and changelog management for the brobridge workspace.

The four published packages are **fixed**: they carry one version between
them. `@brobridgejs/client` and `brobridge` speak the wire protocol that
`@brobridgejs/core` defines, so a version pair that has never been tested
together is a support burden nobody asked for.

Adding a changeset:

```bash
pnpm changeset          # describe the change, pick a bump
pnpm changeset version  # apply it to every package.json and CHANGELOG
pnpm release            # build, then publish with provenance
```

See [the changesets docs](https://github.com/changesets/changesets) for the
file format.
