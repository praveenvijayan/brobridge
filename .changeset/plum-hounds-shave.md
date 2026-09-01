---
'@brobridgejs/adapters': minor
'@brobridgejs/client': minor
'@brobridgejs/core': minor
'brobridge': minor
---

First release: the wire protocol, the host, the browser client and the birpc,
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
