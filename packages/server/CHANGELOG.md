# brobridge

## 0.2.2

### Patch Changes

- aab4232: A bridge can mint more than one single-use launch address.
  
  `Bridge.launchUrl()` returns `${origin}/?bt=<token>` with a fresh token each call. Every token is single-use with its own `launchTokenTtlMs` window; at most eight are live, and a ninth drops the oldest. `AuthGuard.mintLaunchToken()` backs it; `bridge.url`, `launchToken` and `tokenSpent` keep their meaning for the token minted at start. A token is minted only on the host's decision, never on a request from the browser.
- @brobridgejs/core@0.2.2

## 0.2.1

### Patch Changes

- Republish with a resolvable `@brobridgejs/core` dependency. The 0.2.0 tarball
  was produced by the npm CLI, which does not rewrite `workspace:^`, so the
  published manifest could not be installed outside this repository. The source
  is unchanged; this release goes out through pnpm, which rewrites the specifier
  to a real range.
- @brobridgejs/core@0.2.1

## 0.2.0

### Minor Changes

- 02e5097: First release: the wire protocol, the host, the browser client and the birpc,
  oRPC and tRPC adapters.
  
  Includes three fixes from the Phase 6 verification audit:
  
  - **Credit is now restored exactly across a resume.** `CREDIT` is unsequenced
    and never replayed, so a grant handed to a dying socket was counted by the
    granting side and never received by the peer — the two views of the stream's
    window then diverged permanently, and a producer whose last grant was the
    lost one waited forever with the connection reporting itself healthy.
    `RESUME.streams[].granted` and `RESUME_ACK.credit[]` now carry cumulative
    grant totals, which are idempotent to apply. `PROTOCOL.md` §5.9, §5.10 and
    §9.4 updated in the same change.
  - A connection refused during the handshake is now told why: the
    connection-level `ERROR` goes out before the close, as `PROTOCOL.md` §6.1
    requires.
  - `PING`, `PONG` and `GOAWAY` are no longer answered before the handshake has
    settled, which had put a frame on the wire ahead of `HELLO_ACK`.

### Patch Changes

- 0f456f2: Reject non-canonical base64url spellings of the launch token and session MAC. Base64 discards the final character's padding bits, so several strings decoded to the same bytes; only the canonical spelling now redeems.
- c230cfe: Point `homepage`, `repository.url` and `bugs.url` at the repository that
  actually builds these packages. npm provenance attests the source repository
  and refuses a manifest that names a different one, so the old URLs would have
  failed the first publish.
- Updated dependencies [c230cfe]
- Updated dependencies [02e5097]
  - @brobridgejs/core@0.2.0
