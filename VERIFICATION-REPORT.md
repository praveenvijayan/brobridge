# brobridge verification report

Phase 6: an adversarial audit of everything Phases 1–5 built, plus release
readiness. This document is the evidence, section by section, including the
things it did not manage to verify and why.

Audited at commit `643260d` (`feat(adapters)`), on macOS 15 / arm64.

## Summary

| Section | Verdict |
| --- | --- |
| 1. Spec conformance | **Pass**, after 2 fixes and 13 new tests |
| 2. Security re-test | **Pass**, after 1 fix and 7 new tests |
| 3. Cross-runtime matrix | **Pass** on Node 20, Node 22, Node 24, Bun 1.4 — see §3 |
| 4. Performance | **3 of 4 targets met.** Isolation holds; its p99 figure misses at the default window — see §4.2 |
| 5. API / DX | **Pass**, after 2 README fixes and a new check |
| 6. Release readiness | **Pass** |

**Three defects were found and fixed**, one of them serious:

1. A stream could **deadlock permanently after a reconnect**, silently, with
   the connection reporting itself healthy (§2.4). Root cause was a credit
   accounting divergence; the fix required a protocol change.
2. A connection refused during the handshake was closed **without the
   connection-level `ERROR`** `PROTOCOL.md` §6.1 requires (§1.2).
3. An endpoint **answered `PING` before the handshake settled**, putting a
   frame on the wire ahead of `HELLO_ACK` (§1.2).

Test count went from **301 to 321**. All suites are green on every runtime in
the matrix.

---

## 1. Spec conformance audit

`PROTOCOL.md` contains 83 lines carrying a **MUST**/**MUST NOT**. Two of them
are the RFC-2119 boilerplate and the "implementations MUST NOT deviate"
preamble, leaving 81 normative requirements. Each was traced to the code that
implements it and the test that covers it.

### 1.1 The table

`codec.test.ts` (59 cases), `mux.test.ts` (25), `resume.test.ts` (18),
`edge-cases.test.ts` (30) and the new `conformance.test.ts` (13) are the
core suites; `trust.test.ts` (33), `auth.test.ts` (13) and
`adversarial.test.ts` (17) cover the server's half.

| § | Requirement | Implemented | Covered by |
| --- | --- | --- | --- |
| 1.1 | Control payloads are UTF-8 JSON; reject otherwise | `codec.ts:415`, `:423` | `codec` "rejects a control payload that is not valid UTF-8" |
| 1.1 | `DATA` payloads pass through untouched | `codec.ts:336` | `mux` "passes DATA payloads through untouched, including non-UTF-8 bytes" |
| 2 | Endpoint stops sending after a connection-level `ERROR` | `mux.ts:1699` (`#failConnection`) | `edge-cases` "closes when the peer sends a connection-scoped ERROR" |
| 3 | `version` MUST be 1 | `codec.ts:106`, `:266` | `codec` "rejects an unsupported wire version" |
| 3 | Reserved byte 0 on send, ignored on receive | `codec.ts:109`, `:255–261` | **new** `conformance` "writes zero in the reserved byte…" |
| 3 | `length` MUST NOT exceed `maxFrameSize` | `codec.ts:96`, `:272` | `codec` "rejects an oversized length before allocating for it" |
| 3.1 | `FIN` only on `DATA` | `mux.ts:379` (set only for `DATA`) | `conformance` (flags), `mux` FIN cases |
| 3.1 | Reserved flag bits ignored, not rejected | `codec.ts:258` (flags passed through) | **new** `conformance` "ignores unknown flag bits…" |
| 3.2 | Decoder accepts any chunk split, any frames per chunk | `codec.ts:203–247` | `codec` "survives encode → arbitrary chunk split → decode"; **new** `conformance` "carries a stream whose every frame is split across carrier messages" |
| 3.2 | Reject `version != 1`, close | `codec.ts:266`, `sessions.ts:120` | `codec`, **new** `conformance` §6.1 case |
| 3.2 | Reject oversized `length` **before** buffering | `codec.ts:271` precedes `:222` | `codec` "rejects an oversized length before allocating for it" |
| 3.2 | Reject unknown `type` | `codec.ts:278` | `codec` "rejects an unknown frame type" |
| 3.2 | Malformed input is a typed value, never a throw | `codec.ts` returns `ProtocolError` throughout | `codec` fuzz: "never throws on random bytes" (10k buffers) |
| 4 | `streamId` scope per frame type | `codec.ts:284`, `:290` | `codec` "rejects a stream frame addressed to streamId 0" / "…a connection frame addressed to a stream" |
| 4 | `seq` ignored on unsequenced frames | `mux.ts` (only `#onData`/`#onEnd` consult `seq`) | **new** `conformance` "ignores seq on an unsequenced frame" |
| 4.1 | `streamId` 0 never used by `OPEN` | `codec.ts:284` | `codec` (as above) |
| 4.1 | Identifiers increase, never reused | `mux.ts:1417` | `edge-cases` "refuses to reuse a stream identifier" |
| 4.1 | `GOAWAY STREAM_ID_EXHAUSTED` on exhaustion | `mux.ts:1076` | **not reachable in a test** — see §1.3 |
| 4.1 | `OPEN` with receiver's own parity is a connection fault | `mux.ts:1411` | `mux` "treats an OPEN with the receiver own parity as a connection fault" |
| 5 | Required fields absent/mistyped → `PROTOCOL_VIOLATION` | `codec.ts:434–670` (per-type readers) | `codec` "accepts every optional member at its documented type" + per-type cases |
| 5 | Unknown members ignored | `codec.ts` readers pick named members only | `codec` "ignores unknown members so a version-1 peer survives an extension" |
| 5.7 | `ERROR.message` carries no secrets | `server/src/redact.ts` | `adversarial` "keeps the launch token and cookie material out of diagnostics (§5.14)" |
| 5.7 | Connection-scoped `ERROR` is followed by a close | `mux.ts:1699–1702` | `edge-cases` "closes when the peer sends a connection-scoped ERROR" |
| 5.11 | `RESUME_FAIL` means start a fresh session | `mux.ts:1683` | `resume` "answers RESUME for an unknown session with RESUME_FAIL and allows a fresh HELLO" |
| 6.1 | First frame is `HELLO` or `RESUME` | `sessions.ts:127–149` | `mux` "rejects a first frame that is neither HELLO nor RESUME" |
| 6.1 | **Anything else → connection-level `ERROR`, then close** | `sessions.ts:102–115` | **FIXED** — see §1.2. **new** `conformance` "answers a first frame that is neither HELLO nor RESUME with a connection-level ERROR, then closes" |
| 6.1 | Client sends nothing before `HELLO_ACK`/`RESUME_ACK` | `mux.ts:1309`, `:1319`, `:1326` | **FIXED** — see §1.2. **new** `conformance` "puts no frame on the wire before the handshake settles, not even a PONG" |
| 6.1 | One session per connection | `mux.ts:1489`, `:1578` | `edge-cases` "rejects a second HELLO…", "rejects RESUME once a session is already established" |
| 6.1 | Version intersection, else `ERROR` + close | `mux.ts:1500–1512` | `mux` "refuses a peer whose version set does not overlap" |
| 6.1 | Effective limits are the pairwise minimum | `mux.ts:1560` (`#negotiate`) | `mux` "takes the smaller of the two advertised stream limits" |
| 6.1 | Never send past the peer's `maxFrameSize` | `mux.ts` `maxDataPayload` | **new** `conformance` "never puts a frame larger than the peer advertised on the wire" |
| 6.1 | `sessionId` ≥ 128 bits CSPRNG, never reused | `mux.ts:94–107` | `sessions` "produces 128 bits of hex"; **new** `conformance` "mints a fresh, unguessable session identifier per session" |
| 6.1 | `HELLO` carries no authority | `server/src/gateway.ts` (auth precedes accept) | `integration` "refuses an upgrade without a cookie, without completing the handshake" |
| 6.1 | Non-upgrade `GET /ws` → 426 | `gateway.ts:152` | `client/integration` "gets 426 from the live host when the caller is authenticated" |
| 7.3 | Legal frames per state | `mux.ts:474–500` (`handleFrame`) | `edge-cases` (7 state cases) |
| 7.4 | `DATA`/`END`/`OPEN_ACK` for idle/reaped → `STREAM_CLOSED` | `mux.ts:1335` | `mux` "answers a frame for an unknown stream with STREAM_CLOSED" |
| 7.4 | `CREDIT`/`CANCEL`/`ERROR` for such a stream discarded | `mux.ts:1364–1370` | `edge-cases` "discards CREDIT, CANCEL and ERROR for an unknown stream" |
| 7.5 | On `CANCEL`: stop producing, release buffers, no `END` | `mux.ts:646` (`#fail`) | **new** `conformance` "stops producing and sends no END once a CANCEL arrives" |
| 7.5 | `closed` releases buffered payload | `mux.ts:648–650` | `mux` "releases buffered payload and stops the producer" |
| 7.5 | No new streams after `GOAWAY` | `mux.ts:1063` | `mux` "stops new streams after the peer sends GOAWAY" |
| 8.1 | `OPEN_ACK.credit` minus optimistic bytes | `mux.ts:517–521` | `edge-cases` "exposes both credit windows and resolves opened on OPEN_ACK" |
| 8.1 | Never emit `DATA` past `available`; split, never reorder | `mux.ts:369–392` | `mux` "blocks a writer at zero credit and resumes it exactly when credit arrives" |
| 8.1 | Never grant past 2³¹−1 | `mux.ts:620` | `edge-cases` "rejects a CREDIT grant that would overflow the window" |
| 8.2 | Over-credit → stream `ERROR`, connection survives, bytes discarded | `mux.ts:575–585` | `mux` "tears down only the offending stream when a peer overruns its credit" |
| 8.2 | `maxFlowViolations` → connection `ERROR` | `mux.ts:1346` | `mux` "closes the connection after too many flow-control violations" |
| 8.2 | `CREDIT` ≤ 0 or non-integer → `FLOW_CONTROL_ERROR` | `mux.ts:611` | `mux` "rejects a non-positive CREDIT increment at stream level" |
| 8.3 | Never buffer more than `available` per stream | `mux.ts:588` | **new** `conformance` "never buffers more undelivered payload than the credit it granted"; **new** `hardening` "holds no more than the credit it granted, across every stream at once" |
| 9.1 | First sequenced frame is `seq = 1` | `resume.ts:31–66` | `resume` "starts at zero so the first sequenced frame carries seq 1" |
| 9.1 | No wrap-around; `SEQ_EXHAUSTED` | `resume.ts:57`, `mux.ts:343` | `resume` "refuses to wrap the u32 space"; mux wiring **not reachable in a test** — see §1.3 |
| 9.1 | Live gap → stream `PROTOCOL_VIOLATION` | `resume.ts:110` | `resume` "delivers frames in order and rejects a gap on a live connection" |
| 9.1 | During replay, discard `seq <= lastSeq` | `resume.ts:109` | `resume` "discards an already-processed frame during replay instead of erroring" |
| 9.2 | Ring bounded by bytes **and** frames | `resume.ts:220–236` | `resume` "evicts the oldest frame when the frame bound bites first" / "…the byte bound…" |
| 9.2 | Replayed frames set `REPLAY`, keep `seq` | `resume.ts:190` | `resume` "marks replayed frames with the REPLAY flag and keeps their seq" |
| 9.3 | Authenticate first, resume second | `server/src/manager.ts:139` (host per cookie identity) | `server/sessions` "refuses to resume a session that belongs to another identity" |
| 9.3 | `sessionId` not accepted across identities | `manager.ts:139` | as above |
| 9.3 | Session retained for `sessionTtlMs`, then discarded | `core/sessions.ts:161` | `resume` "reaps a session once it has been detached longer than the TTL" |
| 9.3 | No `HELLO` after `RESUME_ACK` | `mux.ts:1489` | `edge-cases` "rejects a second HELLO on an established connection" |
| 9.4 | `SNAPSHOT_REQUIRED` surfaces as a distinct typed error | `mux.ts:1737` (`SnapshotRequiredError`) | `resume` "reports SNAPSHOT_REQUIRED when the cursor aged out"; `client/integration` "reports an aged-out cursor as SnapshotRequiredError, never as a gap" |
| 9.4 | Unlisted streams cancelled server-side | `mux.ts:1625` | `resume` "cancels streams the client did not list in RESUME" |
| 9.4 | **Credit restored exactly across a resume** | `mux.ts:496`, `:1605`, `:1670` | **NEW REQUIREMENT** — see §2.4. **new** `conformance` "leaves both sides agreeing on the window after a grant died with the socket" |
| 10 | Unary request must fit initial credit | `mux.ts:1092` (`call`) | `mux` "round-trips a request and a response over a transient stream" |
| 10 | `CANCEL` stops the work, no response after | `mux.ts:646` | `trpc` e2e "stops the host producer when the consumer unsubscribes" |
| 10.1 | `openStream` in fallback mode fails with a named error | `client/src/client.ts` | `client/integration` "names the reason instead of degrading a stream silently" |
| 11 | Server `PING`s every `heartbeatMs` | `server/src/manager.ts:176` | `client/socket` "kills a connection that has gone silent" (the timeout half) |
| 11 | Answer `PING` with `PONG`, nonce verbatim | `mux.ts:1310` | `mux` "answers PING with a PONG echoing the nonce" |
| 11 | Silence past `heartbeatTimeoutMs` is death | `manager.ts:186`, `client/src/socket.ts` | `client/socket` "kills a connection that has gone silent" / "rearms the watchdog on every frame" |
| 11 | `PING`/`PONG` not blocked by flow control | unsequenced, uncharged (`mux.ts:1310`) | **new** `conformance` "keeps PING answerable while a stream sits at zero credit" |
| 11.1 | Backoff 500 ms → 10 s, full jitter | `client/src/backoff.ts` | `client/unit` "is full jitter over a doubling ceiling, capped at the maximum" |
| 11.1 | 401/403 on upgrade is terminal, no tight loop | `client/src/socket.ts` | `client/integration` "is terminal when the host refuses the connection" |
| 12 | `INTERNAL_ERROR` leaks nothing to a browser peer | `server/src/redact.ts` | `integration` "reduces an unexpected handler fault to INTERNAL_ERROR without leaking detail" |
| 12 | `ERROR` strings carry no tokens, cookies or MACs | `redact.ts` | `adversarial` "keeps the launch token and cookie material out of diagnostics" |
| 13 | Both peers honour negotiated limits | `mux.ts:1560` | `mux` "takes the smaller of the two advertised stream limits" |
| 13 | Never advertise above the hard max; reject a peer that does | `mux.ts:857`, `:1550` | `edge-cases` "rejects a server that advertises a maxFrameSize above the hard maximum" |
| 14 | Ignore unknown members and unknown flag bits | `codec.ts` readers; `:258` | `codec` "ignores unknown members…"; **new** `conformance` "ignores unknown flag bits…" |

### 1.2 Deviations found and fixed

**(a) A refused handshake closed without saying why.**
`PROTOCOL.md` §6.1: *"The server MUST reject any other frame received before
that point with a connection-level `ERROR` carrying `PROTOCOL_VIOLATION`,
then close."* `SessionHost.accept` closed the carrier but sent no `ERROR`, so
a client saw a bare socket teardown and could not tell a protocol refusal from
a network fault. §3.2's "reject and close" cases had the same hole.

Fixed in `packages/core/src/sessions.ts` (`refuse()`, `:95–115`): the
connection-level `ERROR` goes out, then the close. Covered by
`conformance.test.ts` "answers a first frame that is neither HELLO nor RESUME
with a connection-level ERROR, then closes".

**(b) `PING` was answered before the handshake settled.**
`#handleFrame` dispatched `PING`, `PONG` and `GOAWAY` regardless of endpoint
state, so a peer that pinged first got a `PONG` — a frame on the wire ahead of
`HELLO_ACK`, which §6.1 forbids the client to send.

Fixed in `packages/core/src/mux.ts:1306–1327`: all three now go through
`#requireHandshake`. Covered by `conformance.test.ts` "puts no frame on the
wire before the handshake settles, not even a PONG".

A third defect — a credit divergence that could deadlock a stream — was found
by the §4 benchmarks rather than by this audit, and is written up in §2.4.

### 1.3 MUSTs verified by inspection only

Two requirements are correct in code but cannot be exercised by a test without
either a 2³¹-iteration loop or a test-only seam in the production API. Both are
stated here rather than papered over:

- **§4.1 `GOAWAY` with `STREAM_ID_EXHAUSTED`** (`mux.ts:1071–1079`). Reaching
  it needs ~1.07 × 10⁹ `openStream` calls on one connection.
- **§9.1 stream-level `SEQ_EXHAUSTED`** (`mux.ts:339–352`). Reaching it needs
  2³² sequenced frames on one stream.

The pure counters underneath both *are* tested (`resume` "refuses to wrap the
u32 space"; `SeqCounter.exhausted`). What is untested is the wiring from the
counter to the frame. Adding a seam to the public surface purely to test them
was judged a worse trade than saying so here.

---

## 2. Security re-test

### 2.1 The attack catalogue against a live listener

`packages/server/tests/adversarial.test.ts` replays every row of
`THREAT-MODEL.md` §5 against a running server using **hand-written HTTP on a
raw TCP socket**, not `fetch` — because `fetch` will not send a `Host` that
disagrees with the connection, and that disagreement is the attack.

| Threat | Case | Result |
| --- | --- | --- |
| §5.1 DNS rebinding | `Host: evil.test:<port>` on a real loopback connection | 403, empty body, before any handler |
| §5.2 `Host` normalisation | `0x7f.0.0.1`, `0177.0.0.1`, `2130706433`, `127.0.0.1.`, `127.000.000.001`, `127.0.0.1:0<port>`, `[::ffff:127.0.0.1]`, `localhost`, `user@127.0.0.1`, bare `127.0.0.1` | all 403 |
| §5.2 duplicate `Host` | two headers, **even when they agree** | 403 |
| §5.2 absolute-form request line | `GET http://host/ws HTTP/1.1` | 403 |
| §5.2 authority form | `CONNECT` | refused |
| §5.3 CSRF | cross-site request carrying a valid cookie | 403 |
| §5.4 cross-origin WebSocket | upgrade with a foreign `Origin` | refused without completing the handshake |
| §5.4/§7.3 unauthenticated upgrade | no cookie | refused, handshake never completed |
| §5.6 token replay | launch token presented a second time | 403 |
| §5.7 brute force | guessing loop | rate-limited, `Retry-After` |
| §5.7/§5.8 cookie forgery | tampered MAC, session id, timestamp; cookie from another port | 403 each |
| §5.11 slowloris | headers never finished | dropped on the deadline |
| §5.11 header flood | oversized header block | capped |
| §5.12 non-loopback | bind without the opt-in | refused |
| §5.13 path handling | anything off the three-route table | 404, disk never touched |
| §5.14 leakage | diagnostics after a failure | no token, no cookie material |
| §9 invariant 10 | absent vs malformed vs wrong credential | byte-identical responses |

New in this phase (`packages/server/tests/hardening.test.ts`):

| Case | Result |
| --- | --- |
| `Content-Length` **and** `Transfer-Encoding: chunked` on `/rpc` | refused |
| `Host` padded with the whitespace RFC 9110 §5.5 allows | accepted as the same authority (correct — see note) |
| `Host` that only *looks* right: `…:port.`, `127.0.0.1 :port`, trailing space, `#`, `/`, comma-joined | all refused |
| absolute-form request line on the **upgrade** path | no 101 |

> Note on whitespace: an early draft of this test asserted that a `Host` with
> leading whitespace be refused. That expectation was wrong, not the code —
> RFC 9110 §5.5 makes surrounding whitespace part of the framing, not of the
> value. Refusing it would break conformant clients while stopping nothing,
> since the compared value is identical either way. The test now pins the
> correct behaviour in both directions.

### 2.2 DNS-rebinding simulation

Covered above (§5.1 row): a genuine TCP connection to `127.0.0.1` carrying
`Host: evil.test:<port>` — exactly the shape of a rebound request — is refused
with 403 and an empty body, decided by `trust.ts` before routing, before any
body read, and before authentication.

### 2.3 Memory exhaustion

`hardening.test.ts` "holds no more than the credit it granted, across every
stream at once": 24 concurrent streams, a route that accepts each stream and
never reads it, every writer pushing 512 KiB into a 32 KiB window.

```
parked streams          24 of 24
total undelivered       ≤ 24 × 32 KiB (the §8.3 bound)
heap growth             bounded by that window, not by the bytes offered
```

Two neighbouring bounds are also pinned: one stream past `maxStreams` is
refused without dropping the connection, and a producer that outruns a small
`resumeWindow` cannot pin more than the window.

At the 100 MiB scale (§4.1) the heap grew **8.4 MiB** while 100 MiB streamed
through — the receive window and the replay ring, not the payload.

### 2.4 The defect this section found: a stream could deadlock forever

Found while benchmarking 50 concurrent streams. Under repeated socket loss,
**13 of 49 streams stopped permanently** — no bytes for 60+ seconds, while
`client.state` read `open` and no error reached the application. A silent,
permanent stall is worse than a failure, because nothing tells the app to
recover.

**Root cause.** `CREDIT` is unsequenced and therefore never replayed
(`PROTOCOL.md` §9.4). When a grant is written to a socket that is dying but has
not yet reported closed, the granting side has *already* debited `#ungranted`
and credited `#peerCredit` — while the peer never receives the frame. The two
views of `available` then differ by that amount for the rest of the session.
Re-granting cannot repair it: the granting side no longer believes it owes
anything. When the lost grant is the last one a consumer will ever issue, the
producer waits forever.

Reproduced deterministically by killing the pipe at the instant the first
`CREDIT` is written:

```
before fix:  server sendCredit 2048   client peerCredit 4096   (diverged)
after  fix:  server sendCredit 4096   client peerCredit 4096   (agree)
```

and end to end, on the 50-stream load that first showed it:

```
before fix:  36 of 49 complete, 13 stalled permanently (60 s, zero progress)
after  fix:  49 of 49 complete
```

**The fix required a protocol change**, made in the same commit as the code, as
the phase rules require. Re-sending an *increment* is unsafe — if the peer did
receive it, the peer ends up over-granted and the receiver would flag an
innocent sender for a flow-control violation. So the handshake now carries
**cumulative** totals, which are idempotent to apply:

- `RESUME.streams[].granted` — the client's cumulative grant per stream
  (`PROTOCOL.md` §5.9).
- `RESUME_ACK.credit[]` — the server's, for the other direction (§5.10).
- On receiving either, an endpoint sets
  `available = peer.granted − (bytes it has sent)` (§9.4).

Both members are OPTIONAL on the wire, so a peer that omits them gets the old
behaviour rather than a decode failure. Implementation:
`mux.ts:496` (`resyncSendCredit`), `:1605` (server), `:1670` (client);
`codec.ts` validates both; `types.ts` adds `StreamGrant`.

Regression tests: `conformance.test.ts` "leaves both sides agreeing on the
window after a grant died with the socket" and "carries the cumulative grant in
RESUME and answers with its own".

### 2.5 Token hygiene

| Check | Evidence |
| --- | --- |
| Bootstrap `303` strips `?bt=` | `integration` "burns the token, sets the cookie and redirects the token out of history" |
| A token presented alongside a valid cookie is also stripped | `integration` "strips a token that is presented again alongside a valid cookie" |
| `Referrer-Policy: no-referrer` on served responses | `adversarial.test.ts:309` asserts the header |
| `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` | `gateway.ts:66–70` |
| Client never retains or re-sends the token | `client/integration` "sends the launch token on exactly one request and retains it nowhere" |
| Token is single-use | `auth` "works exactly once" |

### 2.6 Dependency surface

```
$ pnpm audit --prod
No known vulnerabilities found
```

(`npm audit --omit=dev` is not usable here — the workspace has no
`package-lock.json`. `pnpm audit --prod` queries the same advisory database
against the pnpm lockfile.)

Runtime dependencies, as published:

| Package | Runtime deps |
| --- | --- |
| `@brobridge/core` | **none** |
| `@brobridge/client` | `@brobridge/core` only |
| `brobridge` | `@brobridge/core`, `ws` |
| `@brobridge/adapters` | `@brobridge/core`; frameworks are peer deps |

`@brobridge/client` carries exactly one dependency, and it is the workspace's
own dependency-free protocol core. **Zero third-party** runtime dependencies in
both `core` and `client`, which is the rule's intent — but stated precisely
here rather than rounded to "zero".

---

## 3. Cross-runtime matrix

| Runtime | Suite | Result |
| --- | --- | --- |
| Node 22.23.1 | full (`pnpm test`) | **24 files, 321 tests, all pass** |
| Node 24.15.0 | full (`pnpm test`) | **24 files, 321 tests, all pass** |
| Bun 1.4.0 | `packages/server/tests-bun` | **5 pass, 0 fail** |
| Bun 1.4.0 | `packages/client/tests-bun` | **4 pass, 0 fail** |
| Node 20.20.2 | full (vitest) | **24 files, 320 pass, 1 skipped** |

### Node 20 — closed in Phase 7

This section originally recorded Node 20, the declared `engines` floor, as
**not run**. It has now been run, on Node 20.20.2, and it is a cell in CI. Three
things had to be fixed first, and the first of them is the reason the floor is
easy to get wrong:

1. **pnpm 11 does not start on Node 20.** It requires `node:sqlite`, which
   arrives in Node 22 — `pnpm build` on Node 20 dies with
   `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite`. This
   says nothing about brobridge and everything about the toolchain, so both
   the local run and the CI job install and build on Node 22 and then run
   vitest with Node 20. The distinction is now written down: `.nvmrc` is the
   development toolchain (22), `engines` is what the published packages
   support (>= 20), and `scripts/check-engines.mjs` keeps them from drifting.

2. **`packages/client/tests/options.test.ts` assumed a global `WebSocket`.**
   Node 20 has no such global (it lands in Node 22), so `resolveOptions({})`
   threw before the defaults could be asserted. The suite now installs its own
   stub globals rather than borrowing whatever the host runtime has — the
   assertions are unchanged, and the last case still deletes them to check the
   diagnostics.

3. **`packages/client/tests/browser.test.ts` spawned the demo with
   `--experimental-strip-types`**, which needs Node >= 22.6. On Node 20 the
   child exited immediately and the suite failed after a 30-second start-up
   timeout. It now checks the runtime first and skips with that as the reason,
   the same way it already skipped when no Chromium was installed. The skipped
   test in the table above is this one; it runs on Node 22 and 24, where the
   count is the full 321.

The result: **320 pass, 1 skipped on Node 20**, and no product code needed
changing — the argument in the original text held, but it is now a test result.

The browser half is covered inside the Node runs: `client/tests/browser.test.ts`
drives the demo page in real Chromium through Playwright — call, stream, and a
resume across a socket the page kills.

---

## 4. Performance

Measured by `scripts/bench.mjs` over a **real loopback WebSocket** between a
real `brobridge` host and the real `@brobridge/client` — not an in-memory pipe —
so the numbers include framing, the socket and credit accounting. Node 22.23.1,
macOS 15, arm64. Reproduce with `node scripts/bench.mjs` (or `--json`).

### 4.1 PTY firehose — **met**

100 MiB of 1–4 KiB chunks through one stream.

| | Target | Measured |
| --- | --- | --- |
| Throughput | ≥ 300 MiB/s | **379.3 MiB/s** |
| Frame loss | none | **0** — 104 857 600 of 104 857 600 bytes |
| Heap | stable | **+8.4 MiB** while 100 MiB streamed through |

### 4.2 Stream isolation with a paused consumer — **property met, latency figure missed**

50 streams; stream 0's consumer never reads; the other 49 are timed.

| | Target | Measured |
| --- | --- | --- |
| Paused stream buffers only its window | ≤ 64 KiB | **exactly 65 536 B** |
| Others complete | all | **49 of 49** |
| p99 inter-chunk latency | < 5 ms | **6.2 ms** |
| p50 | — | 0.11 ms |

The isolation claim — a stalled consumer costs the others nothing — **holds
exactly**. The benchmark now runs a control arm to prove it, and the control is
the decisive number:

| Arm | p99 |
| --- | --- |
| 50 streams, one paused (the test) | 6.2 ms |
| 49 streams, **none paused** (control) | **8.1 ms** |
| 50 streams, one paused, 512 KiB window | **1.9 ms** |

The control is *slower* than the test. The paused consumer contributes nothing;
the p99 is the cost of ~49 concurrent consumers sharing one event loop, and it
is dominated by credit-refill round trips — which is why widening the window to
512 KiB collapses it to 1.9 ms, comfortably inside the target.

**Not "fixed" by changing the default, deliberately.** Raising the default
`initialCredit` from 64 KiB to 512 KiB would meet the number and multiply the
documented receive-memory bound (`PROTOCOL.md` §8.3) by eight — trading a
security-relevant bound for a benchmark figure. The window is a documented
per-application knob; an app running dozens of latency-sensitive streams should
raise it, and now has the measurement to justify the memory.

Two measurement bugs in the harness were found and fixed on the way to this
conclusion, both of which had been inflating the number: the first inter-chunk
sample per stream was really the `OPEN` round trip, and the benchmark was
generating payload inside the timed loop.

### 4.3 Unary throughput — **met**

| | Target | Measured |
| --- | --- | --- |
| Echo calls/s, one connection | ≥ 5 000 | **36 329** (20 000 calls, 64 in flight) |

### 4.4 Reconnect with resume under load — **met**

16 MiB in flight, socket cut mid-transfer, sequence numbers stamped in the
payload so a gap is detected rather than assumed.

| | Target | Measured |
| --- | --- | --- |
| Byte loss | zero | **0** — 16 384 000 of 16 384 000 |
| Out-of-order or missing chunks | zero | **0** |
| Recovery gap | < 2 s | **226 ms** |

This benchmark is what surfaced the §2.4 deadlock: before the fix it could not
complete at all.

### 4.5 Bundle budget — target missed, ratchet held

| | Budget | Measured |
| --- | --- | --- |
| `@brobridge/client` alone | < 10 KiB | **3 928 B** (3.84 KiB) |
| Shipped (core inlined) | 10 KiB target, 12.5 KiB ratchet | **12 263 B** (11.98 KiB) |

Missed by 2 023 bytes, of which 188 are the §2.4 credit fix. Measured
composition: the client's own code is 3 928 B gzipped; the protocol engine it
inlines is ~8.3 KiB. Closing the gap means a **client-role core entry point**
that drops what a browser never runs — `SessionHost` is already tree-shaken
out, but the server-role branches inside `BridgeEndpoint` (`#onHello`,
`#onResume`, the replay buffer) are not shakeable because they live in one
class. That is a structural refactor of the 1 700-line multiplexer, which in a
hardening phase raises risk rather than lowering it, so it is recorded here as
the next release's work rather than attempted now. The ratchet keeps the number
from drifting further meanwhile.

---

## 5. API and DX review

### 5.1 Packaging

`node scripts/check-packaging.mjs` — `publint` and `@arethetypeswrong/cli`
against a real `pnpm pack` of every package:

```
core:      publint All good!   attw  node16 (from ESM) 🟢   bundler 🟢
server:    publint All good!   attw  node16 (from ESM) 🟢   bundler 🟢
client:    publint All good!   attw  node16 (from ESM) 🟢   bundler 🟢
adapters:  publint All good!   attw  all four subpaths 🟢 under both
```

`node10` and `node16-from-CJS` are ignored by policy: these are ESM-only
packages, declared as such.

### 5.2 A consumer on the tarballs

`pnpm check:consumer` packs all four packages, installs them with **npm** into
a throwaway project alongside real `birpc`, oRPC, tRPC and zod, and compiles a
file that imports every adapter subpath in both directions — under
`moduleResolution node16` **and** `bundler`. Both pass, which is what proves the
subpath map and the peer-dependency declarations are honest outside the
workspace.

### 5.3 Following the READMEs verbatim

New in this phase: `pnpm check:readme` (`scripts/check-readme-examples.mjs`)
extracts every fenced TypeScript block from the five READMEs and compiles each
one **on its own, against the packed tarballs**, under both resolutions —
because that is how a reader uses it: copied out with nothing else around it.

A block that is deliberately a continuation of the prose marks itself
`<!-- check-readme: fragment -->`, so the README source now says out loud which
snippets are complete and which need their context.

```
18 TypeScript block(s) across 5 READMEs: 7 standalone, 11 marked as continuations
=== tsc --moduleResolution node16 ===   (clean)
=== tsc --moduleResolution bundler ===  (clean)
```

Two real friction points were found this way and fixed:

- **`@brobridge/client`'s opening example did not compile**: it used
  `terminal` and `statusBadge` without introducing them. A reader copying the
  first example in the browser client's README got errors. Now self-contained.
- **`@brobridge/adapters`' tRPC host example called `os.hostname()` without
  importing `os`.** Now self-contained.

Every README now has at least one standalone, compiling example, and the root
README quickstart compiles in both halves.

### 5.4 Documentation accuracy

The root README's status block still said the adapters were unimplemented and
linked to a `DEVELOPMENT-PROMPTS.md` outside the published tree. Both corrected,
along with the packages table, and the release/verification commands added.

---

## 6. Release readiness

| Item | State |
| --- | --- |
| Versions | **0.1.0** across all four packages |
| Changesets | configured — `.changeset/config.json`, the four packages **fixed** to one version |
| Release scripts | `pnpm changeset`, `pnpm version`, `pnpm release`, `pnpm publish:dry` |
| Provenance | `publishConfig.provenance: true` and `access: public` on all four, asserted by the dry-run script |
| `npm publish --dry-run` | **clean for all four** (`node scripts/check-publish.mjs`) |
| Root README quickstart | present, both halves compile against the tarballs (§5.3) |
| `SECURITY.md` | **added** — reporting route, response times, supported versions, the threat model in one page, and what is explicitly *not* defended |
| CI / release automation | **added in Phase 7** — `.github/workflows/ci.yml` (test matrix 20/22/24, Bun, quality, advisory bench smoke) and `.github/workflows/release.yml` (changesets → Version Packages PR → provenance publish) |
| Repository metadata | **corrected in Phase 7** — `repository.url` on all four packages pointed at `github.com/brobridge/brobridge`, which is not the repository that builds them; npm provenance refuses that mismatch |

```
$ node scripts/check-publish.mjs
=== @brobridge/core@0.1.0 — npm publish --dry-run ===      + @brobridge/core@0.1.0
=== brobridge@0.1.0 — npm publish --dry-run ===            + brobridge@0.1.0
=== @brobridge/client@0.1.0 — npm publish --dry-run ===    + @brobridge/client@0.1.0
=== @brobridge/adapters@0.1.0 — npm publish --dry-run ===  + @brobridge/adapters@0.1.0
publish dry-run clean.
```

The four packages are released as one version on purpose: `@brobridge/client`
and `brobridge` speak the wire protocol `@brobridge/core` defines, and a
version pair that has never been tested together is a support burden nobody
asked for. `check-publish.mjs` fails if they ever drift.

---

## 7. Exit criteria

| Criterion | State |
| --- | --- |
| Report complete with evidence for all six sections | yes |
| Zero open MUSTs | yes — every `PROTOCOL.md` MUST is implemented and, with the two exceptions named in §1.3, tested |
| All suites green on the matrix | yes — 321 tests on Node 22 and Node 24, 320 + 1 skipped on Node 20; 9 Bun tests |

### What remains unverified, and why

1. ~~**Node 20 was not run**~~ — **closed in Phase 7** (§3). Run on Node
   20.20.2: 320 pass, 1 skipped, after three test/toolchain fixes recorded
   there. It is now a cell in `.github/workflows/ci.yml`.
2. **Two MUSTs are verified by inspection, not by test** (§1.3): `GOAWAY`
   on stream-id exhaustion and stream-level `SEQ_EXHAUSTED`. Both need ~2³¹
   operations to reach; the counters beneath them are tested.
3. **The 10 KiB client bundle target is missed by 2 023 bytes** (§4.5). The
   ratchet at 12.5 KiB holds the line; closing the gap needs a client-role core
   entry point, deliberately not attempted during hardening.
4. **The isolation p99 figure is missed at the default credit window**, though
   the isolation property itself holds and the control arm shows the paused
   consumer contributes nothing (§4.2). Met at a 512 KiB window. The default was
   deliberately not changed, because it is also the documented memory bound.
5. **Long-run and adversarial-peer soak testing was not done.** Every test here
   is seconds to minutes. A multi-hour run with a hostile peer — the class that
   surfaced the §2.4 deadlock only because a benchmark happened to hold a
   pathological configuration — would be the highest-value next investment.
6. **Threat-model residual risks stand as documented** (`THREAT-MODEL.md` §8):
   a same-user local process is not defended against, loopback traffic is
   plaintext, and the authenticated tab is still remote code.
