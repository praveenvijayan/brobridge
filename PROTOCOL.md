# brobridge wire protocol

**Version:** 1
**Status:** Normative. This document governs `@brobridgejs/core`,
`brobridge` (server) and `@brobridgejs/client`. Implementation MUST NOT deviate;
a behaviour change requires an edit to this document in the same commit.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**,
**SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY** and **OPTIONAL** in this
document are to be interpreted as described in RFC 2119 and RFC 8174.

---

## Contents

1. [Scope and model](#1-scope-and-model)
2. [Terminology](#2-terminology)
3. [Frame header](#3-frame-header)
4. [Frame types](#4-frame-types)
5. [Control payload schemas](#5-control-payload-schemas)
6. [Handshake](#6-handshake)
7. [Stream lifecycle](#7-stream-lifecycle)
8. [Flow control](#8-flow-control)
9. [Resume](#9-resume)
10. [Unary calls](#10-unary-calls)
11. [Keepalive](#11-keepalive)
12. [Error codes](#12-error-codes)
13. [Limits and defaults](#13-limits-and-defaults)
14. [Version negotiation and extensibility](#14-version-negotiation-and-extensibility)

---

## 1. Scope and model

brobridge is a **transport and session layer**, not an RPC framework. It
defines how bytes move between a host process and a browser tab over a single
physical connection, how many logical streams share that connection, how a
slow reader applies backpressure, and how a stream survives a dropped socket.
Method dispatch, schema validation and end-to-end type inference are the
business of adapters layered on top and are out of scope here.

The model:

- Exactly **one physical connection per browser tab** — a WebSocket in the
  normal case, an HTTP request/response pair in the fallback case (§10).
- **Many logical streams** multiplexed over it, keyed by `streamId`.
- The protocol is **symmetric**: both peers can open streams, send data,
  grant credit and signal errors. `@brobridgejs/core` therefore implements one
  endpoint type used by both sides. Asymmetry exists only in the handshake
  (§6), where the browser is always the initiator, and in resume (§9), where
  only the server keeps a replay buffer.

### 1.1 Byte order and encoding

- All multi-byte header integers are **little endian**, unsigned.
- Control payloads are **UTF-8 encoded JSON**. Implementations MUST reject a
  control payload that is not valid UTF-8 or not a valid JSON object with
  `PROTOCOL_VIOLATION` (§12).
- `DATA` payloads are **opaque bytes**. Implementations MUST pass them through
  unmodified. Base64 or any other re-encoding of `DATA` payloads is forbidden.

---

## 2. Terminology

| Term | Meaning |
| --- | --- |
| **Endpoint** | One side of a connection; owns the codec, the stream table and the credit accounting. |
| **Connection** | The physical transport (WebSocket or HTTP fallback) between two endpoints. |
| **Stream** | A logical, ordered, unidirectional-or-bidirectional byte channel identified by `streamId`. |
| **Initiator** | The endpoint that sent `OPEN` for a given stream. |
| **Responder** | The endpoint that received that `OPEN`. |
| **Credit** | A byte allowance granted by a receiver that bounds how much `DATA` payload a sender may transmit on a stream. |
| **Carrier** | The minimal interface core uses to reach the transport: `send(bytes)`, `onMessage(cb)`, `onClose(cb)`, and an OPTIONAL `close()`. A carrier that omits `close()` leaves closing the connection to its host; an endpoint MUST still stop sending after a connection-level `ERROR` (§5.7). |
| **Session** | The logical continuity across one or more connections, identified by `sessionId`, that makes resume possible. |

---

## 3. Frame header

Every frame — control or data — begins with a fixed **16-byte** header
followed by `length` payload bytes. There is no trailer and no padding.

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|    version    |     type      |     flags     |   (reserved)  |  bytes 0-3
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                          streamId (u32 LE)                    |  bytes 4-7
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                            seq (u32 LE)                       |  bytes 8-11
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                          length (u32 LE)                      |  bytes 12-15
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                        payload (length bytes)                 |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

| Field | Offset | Size | Description |
| --- | --- | --- | --- |
| `version` | 0 | u8 | Protocol version. MUST be `1` for this document. |
| `type` | 1 | u8 | Frame type (§4). |
| `flags` | 2 | u8 | Bit field (§3.1). |
| reserved | 3 | u8 | MUST be `0` on send. A receiver MUST ignore its value. |
| `streamId` | 4 | u32 LE | Stream identifier; `0` for connection-level frames. |
| `seq` | 8 | u32 LE | Per-stream sequence number (§9.1); `0` where §4 says the frame is unsequenced. |
| `length` | 12 | u32 LE | Payload byte count. MUST NOT exceed `maxFrameSize` (§13). |

### 3.1 Flags

| Bit | Name | Meaning |
| --- | --- | --- |
| `0x01` | `FIN` | On `DATA`: this is the last `DATA` frame the sender will send on this stream; equivalent to an immediately following `END`. On any other type: MUST be `0`. |
| `0x02` | `REPLAY` | This frame is a retransmission served from the replay buffer (§9). Set only by the replaying peer; informational for diagnostics. |
| `0x04`–`0x80` | reserved | MUST be `0` on send. A receiver MUST ignore unknown flag bits rather than reject the frame, so that a future minor extension does not break a version-1 peer. |

### 3.2 Framing rules

- A sender MUST emit a frame as a single carrier message where the carrier is
  message-oriented (WebSocket binary message). A receiver MUST NOT rely on
  that: the decoder is a streaming parser and MUST accept a frame split across
  any number of carrier messages, and any number of frames in one message.
- A receiver MUST reject `version != 1` with `UNSUPPORTED_VERSION` (§12) and
  close the connection.
- A receiver MUST reject `length > maxFrameSize` with `FRAME_TOO_LARGE` before
  buffering the payload, and close the connection. A decoder MUST NOT allocate
  a buffer sized from an untrusted `length` before that check.
- A receiver MUST reject an unknown `type` with `PROTOCOL_VIOLATION`.
- Malformed input MUST surface as a typed `ProtocolError` value. An
  out-of-bounds read, an exception from a slice operation, or an unhandled
  throw from the decoder is a defect.

---

## 4. Frame types

`streamId = 0` addresses the connection itself. All other `streamId` values
address one stream.

| Value | Name | streamId | seq | Payload | Direction |
| --- | --- | --- | --- | --- | --- |
| `0x01` | `HELLO` | `0` | `0` | JSON (§5.1) | client -> server |
| `0x02` | `HELLO_ACK` | `0` | `0` | JSON (§5.2) | server -> client |
| `0x03` | `OPEN` | stream | `0` | JSON (§5.3) | either |
| `0x04` | `OPEN_ACK` | stream | `0` | JSON (§5.4) | either |
| `0x05` | `DATA` | stream | sequenced | opaque bytes | either |
| `0x06` | `CREDIT` | stream | `0` | JSON (§5.5) | either |
| `0x07` | `END` | stream | sequenced | JSON (§5.6) | either |
| `0x08` | `ERROR` | stream or `0` | `0` | JSON (§5.7) | either |
| `0x09` | `CANCEL` | stream | `0` | JSON (§5.8) | either |
| `0x0A` | `RESUME` | `0` | `0` | JSON (§5.9) | client -> server |
| `0x0B` | `RESUME_ACK` | `0` | `0` | JSON (§5.10) | server -> client |
| `0x0C` | `RESUME_FAIL` | `0` | `0` | JSON (§5.11) | server -> client |
| `0x0D` | `PING` | `0` | `0` | JSON (§5.12) | either |
| `0x0E` | `PONG` | `0` | `0` | JSON (§5.12) | either |
| `0x0F` | `GOAWAY` | `0` | `0` | JSON (§5.13) | either |

Notes:

- A receiver MUST reject a frame whose `streamId` contradicts the table with
  `PROTOCOL_VIOLATION`: a connection-level type (`HELLO`, `HELLO_ACK`,
  `RESUME`, `RESUME_ACK`, `RESUME_FAIL`, `PING`, `PONG`, `GOAWAY`) carrying a
  non-zero `streamId`, or a stream-level type (`OPEN`, `OPEN_ACK`, `DATA`,
  `CREDIT`, `END`, `CANCEL`) carrying `streamId = 0`. `ERROR` is legal at
  either scope (§5.7). Checking this at the framing layer keeps every later
  stage free of "which stream did they mean?".
- **Sequenced** means the frame consumes a `seq` value from the stream's
  sender-side counter and is eligible for replay (§9). Only `DATA` and `END`
  are sequenced. Every other frame MUST set `seq = 0`, and a receiver MUST
  ignore `seq` on those frames.
- `CREDIT`, `CANCEL` and `ERROR` are deliberately unsequenced so that they
  remain deliverable while a stream is blocked at zero credit, and so that a
  replay never re-applies a credit grant.
- `ACK` in the design brief is realised as two distinct frames: `OPEN_ACK`
  (stream accepted) and `CREDIT` (flow-control grant). Keeping them separate
  removes the ambiguity of one frame meaning two things.

### 4.1 Stream identifier allocation

- `streamId` `0` is reserved for connection-level frames and MUST NOT be used
  by `OPEN`.
- The **client** allocates **odd** identifiers (`1, 3, 5, ...`).
- The **server** allocates **even** identifiers (`2, 4, 6, ...`).
- Identifiers are allocated in increasing order within a session and MUST NOT
  be reused within that session, so that a late frame for a closed stream can
  never be mistaken for one belonging to a new stream.
- On exhaustion of the `u32` space an endpoint MUST send `GOAWAY` with
  `STREAM_ID_EXHAUSTED` and close.
- Receiving `OPEN` for a `streamId` of the receiver's own parity is a
  `PROTOCOL_VIOLATION` at the connection level.

---

## 5. Control payload schemas

All control payloads are JSON objects. A receiver MUST reject a payload whose
required fields are absent or of the wrong type with `PROTOCOL_VIOLATION`. A
receiver MUST ignore unknown object members (forward compatibility, §14).

### 5.1 `HELLO`

```jsonc
{
  "versions": [1],          // integer[], REQUIRED, versions the client supports
  "maxFrameSize": 16777216, // integer, OPTIONAL, largest frame the client will accept
  "maxStreams": 1024,       // integer, OPTIONAL, concurrent streams the client will accept
  "client": "brobridge-client/0.1.0" // string, OPTIONAL, diagnostic only
}
```

`HELLO` never carries a `sessionId`. Resuming an existing session uses `RESUME`
(§5.9) in place of `HELLO`, so that authentication, session lookup and replay
are one decision made in one frame.

### 5.2 `HELLO_ACK`

```jsonc
{
  "version": 1,             // integer, REQUIRED, the version selected by the server
  "sessionId": "…",         // string, REQUIRED, session identity for later resume
  "maxFrameSize": 16777216, // integer, REQUIRED, largest frame the server will accept
  "maxStreams": 1024,       // integer, REQUIRED, concurrent streams the server will accept
  "initialCredit": 65536,   // integer, REQUIRED, credit auto-granted per new stream (§8)
  "resumeWindow": {         // object, REQUIRED, the server's replay bound (§9)
    "bytes": 1048576,
    "frames": 256
  },
  "heartbeatMs": 30000      // integer, REQUIRED, PING interval the server will use (§11)
}
```

### 5.3 `OPEN`

```jsonc
{
  "name": "pty.attach",  // string, REQUIRED, the endpoint/route being opened
  "params": { },         // object, OPTIONAL, opaque to the protocol
  "mode": "duplex",      // "read" | "write" | "duplex", OPTIONAL, default "duplex"
  "credit": 65536        // integer, OPTIONAL, initial credit the initiator grants
                         //   the responder; default = negotiated initialCredit
}
```

`mode` is declared from the **initiator's** point of view: `"read"` means the
initiator will only read, `"write"` means it will only write, `"duplex"` means
both.

### 5.4 `OPEN_ACK`

```jsonc
{
  "credit": 65536  // integer, OPTIONAL, initial credit the responder grants the
                   //   initiator; default = negotiated initialCredit
}
```

### 5.5 `CREDIT`

```jsonc
{
  "bytes": 32768  // integer > 0, REQUIRED, additional payload bytes the sender
                  //   of this frame is now willing to receive on this stream
}
```

`bytes` is an **increment**, never an absolute window. `bytes <= 0`, a
non-integer, or an increment that would push the peer's available credit above
`2^31 - 1` is a `FLOW_CONTROL_ERROR` (§12) at stream level.

### 5.6 `END`

```jsonc
{}  // no members defined in version 1
```

`END` closes the sending direction of the peer that sent it (§7). It is
sequenced so that resume can reconstruct exactly where a stream finished.

### 5.7 `ERROR`

```jsonc
{
  "code": "FLOW_CONTROL_ERROR", // string, REQUIRED, a value from §12
  "message": "…",               // string, OPTIONAL, human-readable, MUST NOT
                                //   contain secrets, tokens or cookie material
  "retryable": false            // boolean, OPTIONAL, default false
}
```

With `streamId != 0` the error is stream-scoped: the stream is torn down and
the connection survives. With `streamId = 0` the error is connection-scoped
and the sender MUST close the connection after sending it.

### 5.8 `CANCEL`

```jsonc
{
  "reason": "consumer-detached"  // string, OPTIONAL, diagnostic only
}
```

### 5.9 `RESUME`

```jsonc
{
  "sessionId": "…",  // string, REQUIRED, from a previous HELLO_ACK
  "streams": [       // array, REQUIRED, may be empty
    { "streamId": 3, "lastSeq": 417, "granted": 196608 }
  ]
}
```

`lastSeq` is the highest `seq` the client has **fully processed** on that
stream. `0` means nothing was processed and replay starts at `seq = 1`.

`granted` is OPTIONAL: the cumulative count of `DATA` payload bytes this
endpoint has granted the peer on that stream, counting `OPEN.credit` and every
`CREDIT` increment since. It exists because `CREDIT` is unsequenced and is
therefore never replayed (§9.4): a grant written to a socket that then died is
lost, while the granting side has already counted it as delivered. The two
peers' views of `available` then differ for the rest of the session, and a
producer whose last grant was the lost one waits forever. A **cumulative**
count rather than an increment is what makes the repair idempotent — applying
it twice is applying it once — so it is safe to send on every resume without
knowing which frames the dead socket swallowed.

A receiver that omits `granted` gets the pre-repair behaviour: the peer leaves
its window as it stands.

### 5.10 `RESUME_ACK`

```jsonc
{
  "sessionId": "…",  // string, REQUIRED, echoes the resumed session
  "resumed": [3, 5], // integer[], REQUIRED, streams that will be replayed
  "failed": [        // array, REQUIRED, may be empty; per-stream failures
    { "streamId": 7, "code": "SNAPSHOT_REQUIRED" }
  ],
  "credit": [        // array, OPTIONAL; the responder's own cumulative grants
    { "streamId": 3, "granted": 65536 }
  ]
}
```

`credit` is the mirror of `RESUME.streams[].granted` (§5.9), for the other
direction: the responder's cumulative grant per resumed stream, so the
reconnecting peer can restore its own send window exactly. Same semantics,
same idempotence.

### 5.11 `RESUME_FAIL`

```jsonc
{
  "code": "SESSION_UNKNOWN", // "SESSION_UNKNOWN" | "SESSION_EXPIRED", REQUIRED
  "message": "…"             // string, OPTIONAL
}
```

`RESUME_FAIL` at `streamId = 0` fails the **whole** resume attempt: the
session is gone and the client MUST start a fresh session. Per-stream failures
are reported in `RESUME_ACK.failed` instead, so that one aged-out stream does
not discard the others.

### 5.12 `PING` / `PONG`

```jsonc
{
  "nonce": "…",  // string, REQUIRED, echoed verbatim in the PONG
  "at": 0        // integer, OPTIONAL, sender's clock in ms since epoch, diagnostic only
}
```

### 5.13 `GOAWAY`

```jsonc
{
  "code": "SERVER_SHUTDOWN", // string, REQUIRED, a value from §12
  "lastStreamId": 41,        // integer, REQUIRED, highest peer-initiated streamId
                             //   the sender has processed; higher ones were not
  "message": "…"             // string, OPTIONAL
}
```

---

## 6. Handshake

The handshake spans three stages. Stages 1 and 2 are HTTP and are the server
package's responsibility; stage 3 is protocol and is core's.

```
  browser                                            host process
     |                                                     |
     |  (1) GET /?bt=<launch-token>                        |
     |---------------------------------------------------->|   burn token,
     |                                                     |   mint session cookie
     |  <-- 303 See Other, Location: /                      |
     |      Set-Cookie: bb_session_<port>=<mac>; HttpOnly;  |
     |        SameSite=Strict; Path=/                       |
     |<----------------------------------------------------|
     |                                                     |
     |  (2) GET /ws  Upgrade: websocket                     |
     |      Cookie: bb_session_<port>=<mac>                 |
     |      Origin: http://127.0.0.1:<port>                 |
     |---------------------------------------------------->|   trust fence:
     |                                                     |   Host, Origin,
     |  <-- 101 Switching Protocols                         |   Sec-Fetch-Site,
     |<----------------------------------------------------|   cookie MAC
     |                                                     |
     |  (3) HELLO { versions:[1] }                          |
     |---------------------------------------------------->|
     |  <-- HELLO_ACK { version:1, sessionId, limits… }      |
     |<----------------------------------------------------|
     |                       connection open                |
```

### 6.1 Rules

- The first frame on a new connection MUST be either `HELLO` (new session) or
  `RESUME` (existing session, §9.3). The client MUST NOT send any other frame
  until `HELLO_ACK` or `RESUME_ACK` arrives.
- The server MUST reject any other frame received before that point with a
  connection-level `ERROR` carrying `PROTOCOL_VIOLATION`, then close.
- Exactly one session may be established per connection. A second `HELLO`, or a
  `HELLO` after a successful `RESUME_ACK`, or a `RESUME` after `HELLO_ACK`, is a
  `PROTOCOL_VIOLATION`. The one exception is recovery: after the server answers
  `RESUME_FAIL` at `streamId = 0` the connection carries no session, and the
  client MAY then send `HELLO` on that same connection to start a fresh one
  (§9.3).
- The server MUST select `version` as the highest value present in **both**
  `HELLO.versions` and its own supported set. If the intersection is empty it
  MUST send connection-level `ERROR` with `UNSUPPORTED_VERSION` and close
  without sending `HELLO_ACK`.
- The effective `maxFrameSize` for a direction is the **minimum** of the two
  peers' advertised values. The same rule applies to `maxStreams`. An endpoint
  MUST NOT send a frame larger than the peer's advertised `maxFrameSize`.
- `HELLO_ACK.sessionId` MUST be unguessable (>= 128 bits from a CSPRNG). It
  identifies the session for resume and MUST NOT be reused across sessions.
- The `HELLO` / `HELLO_ACK` exchange carries no authority of its own. All
  authentication and origin checks happen in stages 1 and 2 and are specified
  in `THREAT-MODEL.md`; an endpoint MUST NOT treat a well-formed `HELLO` as
  evidence of a trustworthy peer.
- A `GET /ws` that passes stage 1 but does not ask to upgrade MUST be answered
  `426 Upgrade Required`, distinct from the fence's uniform refusal. A browser
  cannot read the status of a refused upgrade, so this is how a client tells an
  authentication failure — terminal, §11.1 — from a transport that merely could
  not carry a WebSocket. The answer says nothing a caller with a valid session
  cookie does not already know.

---

## 7. Stream lifecycle

Each stream is a small state machine held independently by both endpoints.
`local` is the endpoint evaluating the machine; `remote` is its peer.

```
                 ┌──────────┐
   send OPEN     │          │   recv OPEN
 ┌───────────────│   idle   │───────────────┐
 │               │          │               │
 │               └──────────┘               │
 ▼                                          ▼
┌──────────┐   recv OPEN_ACK  ┌──────────┐  send OPEN_ACK
│ opening  │─────────────────>│          │<───────────────
└──────────┘                  │   open   │
 │                            │          │
 │ recv ERROR/CANCEL          └──────────┘
 │                             │        │
 │              send END/FIN   │        │   recv END/FIN
 │                             ▼        ▼
 │                  ┌────────────────┐ ┌────────────────┐
 │                  │ half-closed    │ │ half-closed    │
 │                  │ (local done)   │ │ (remote done)  │
 │                  └────────────────┘ └────────────────┘
 │                             │        │
 │              recv END/FIN   │        │   send END/FIN
 │                             ▼        ▼
 │                            ┌──────────┐
 └───────────────────────────>│  closed  │<─── CANCEL / ERROR / GOAWAY
                              └──────────┘
                                    │
                                    │  resume window elapses or
                                    ▼  session ends
                              ┌──────────┐
                              │  reaped  │  (state discarded, id never reused)
                              └──────────┘
```

### 7.1 Transition table

The diagram is a summary; this table is normative. `local` is the endpoint
evaluating the transition.

| From | Event | To |
| --- | --- | --- |
| `idle` | local sends `OPEN` | `opening` |
| `idle` | local receives `OPEN` (and accepts) | `open`, after sending `OPEN_ACK` |
| `idle` | local receives `OPEN` and rejects it (unknown route, stream limit, permission) | `closed`, after sending stream-level `ERROR` |
| `opening` | receives `OPEN_ACK` | `open` |
| `opening` | local sends `END` or `DATA` with `FIN` | `half-closed (local)` — the `OPEN_ACK` is still expected and still legal |
| `opening` | receives `END` or `DATA` with `FIN` | `half-closed (remote)` |
| `opening` | receives stream-level `ERROR`, or either side `CANCEL`s | `closed` |
| `open` | local sends `END` or `DATA` with `FIN` | `half-closed (local)` |
| `open` | receives `END` or `DATA` with `FIN` | `half-closed (remote)` |
| `open` | `CANCEL` or stream-level `ERROR` either way | `closed` |
| `half-closed (local)` | receives `END` or `DATA` with `FIN` | `closed` |
| `half-closed (local)` | receives `OPEN_ACK` (when it arrived after a fast `FIN`) | stays `half-closed (local)` |
| `half-closed (local)` | `CANCEL` or stream-level `ERROR` either way | `closed` |
| `half-closed (remote)` | local sends `END` or `DATA` with `FIN` | `closed` |
| `half-closed (remote)` | `CANCEL` or stream-level `ERROR` either way | `closed` |
| `closed` | replay window released (§9.5), `sessionTtlMs` elapses, or session ends | `reaped` |
| any | connection-level `ERROR` or connection loss | `closed` locally; server-side replay state survives for `sessionTtlMs` (§9) |

A stream may therefore be `half-closed` while still `opening`: a unary call
sends `OPEN` and `DATA` with `FIN` back to back, so its initiator is
half-closed before the `OPEN_ACK` arrives. `OPEN_ACK` remains legal in every
pre-`closed` state for exactly that reason.

### 7.2 States

| State | Meaning |
| --- | --- |
| `idle` | No stream with this identifier exists yet. |
| `opening` | Initiator sent `OPEN`, has not yet seen `OPEN_ACK` or a rejection. |
| `open` | Both directions live. |
| `half-closed (local)` | Local sent `END` (or `DATA` with `FIN`); local may still receive. |
| `half-closed (remote)` | Remote sent `END` (or `DATA` with `FIN`); local may still send. |
| `closed` | Both directions finished, or the stream was cancelled/errored. Replay state may still exist (§9). |
| `reaped` | All state discarded. A frame for a reaped stream is answered per §7.4. |

### 7.3 Legal frames per state

| State | MAY send | MUST accept | MUST reject with |
| --- | --- | --- | --- |
| `opening` (initiator) | `DATA`*, `END`, `CREDIT`, `CANCEL`, `ERROR` | `OPEN_ACK`, `CREDIT`, `DATA`, `END`, `CANCEL`, `ERROR` | `OPEN` -> `STREAM_STATE_ERROR`; any type not in §4 -> `PROTOCOL_VIOLATION` |
| `open` | `DATA`, `CREDIT`, `END`, `CANCEL`, `ERROR` | `OPEN_ACK`†, `DATA`, `CREDIT`, `END`, `CANCEL`, `ERROR` | `OPEN` -> `STREAM_STATE_ERROR`; a second `OPEN_ACK` -> `STREAM_STATE_ERROR` |
| `half-closed (local)` | `CREDIT`, `CANCEL`, `ERROR` | `OPEN_ACK`†, `DATA`, `END`, `CREDIT`, `CANCEL`, `ERROR` | `OPEN` -> `STREAM_STATE_ERROR`. Sending `DATA` or `END` from this state is a local defect, not a wire condition. |
| `half-closed (remote)` | `DATA`, `END`, `CREDIT`, `CANCEL`, `ERROR` | `CREDIT`, `CANCEL`, `ERROR` | received `DATA`, `END` or `OPEN` -> `STREAM_STATE_ERROR` |
| `closed` | nothing | `CREDIT`, `CANCEL`, `ERROR` (ignored) | `DATA`, `END`, `OPEN`, `OPEN_ACK` -> `STREAM_STATE_ERROR` |

\* An initiator MAY send `DATA` optimistically while `opening`, bounded by the
credit it assumed in `OPEN.credit`; this is what makes a unary call one round
trip (§10). If the responder rejects the `OPEN`, that data is discarded.

† `OPEN_ACK` is legal in any pre-`closed` state on the initiator side, because
an initiator that sent `OPEN` and `DATA` with `FIN` back to back reaches
`half-closed (local)` before the acknowledgement arrives (§7.1). Exactly one
`OPEN_ACK` per stream is legal; a second is a `STREAM_STATE_ERROR`.

### 7.4 Frames for unknown or reaped streams

- `DATA`, `END` or `OPEN_ACK` for a `streamId` in `idle`/`reaped` state MUST be
  answered with a stream-level `ERROR` carrying `STREAM_CLOSED`. The connection
  survives.
- `CREDIT`, `CANCEL` and `ERROR` for such a stream MUST be silently discarded.
  These frames legitimately race a close and must not escalate.

### 7.5 Closing

- `END` (or `DATA` with `FIN`) closes only the sender's direction. A stream
  reaches `closed` when both directions have ended, or immediately on `CANCEL`,
  stream-level `ERROR`, or connection teardown.
- `CANCEL` means "stop, I no longer want this". On receiving `CANCEL` an
  endpoint MUST stop producing `DATA` for that stream, release its buffers and
  treat the stream as `closed`. It MUST NOT send `END` afterwards.
- After entering `closed` an endpoint MUST release all buffered payload for
  that stream, except the replay ring buffer, which is released when the
  stream is reaped (§9.5).
- On `GOAWAY`, streams with `streamId <= lastStreamId` MAY finish; the peer
  MUST NOT open new streams and SHOULD close after in-flight streams settle.

---

## 8. Flow control

Flow control is **per stream, credit based, and byte denominated**. There is
no connection-level window: connection-level fairness is the carrier's job,
and per-stream credit is what guarantees the design promise that a slow stream
stalls only itself.

### 8.1 Rules

1. `available[stream]` is the number of `DATA` **payload** bytes the sender may
   still transmit. Frame headers do not consume credit.
2. Initial `available` for each direction is set by `OPEN.credit` /
   `OPEN_ACK.credit`, defaulting to the negotiated `initialCredit` (§5.2).
   An initiator that sent `DATA` optimistically while `opening` (§7.3) had no
   grant to spend yet, so on receiving `OPEN_ACK` it MUST set
   `available = OPEN_ACK.credit - (payload bytes already sent)`. The responder
   counts those same bytes against the window it granted, so both peers reach
   the same number. The result MAY be negative, in which case the sender
   awaits `CREDIT` before sending again.
3. A sender MUST NOT emit a `DATA` frame whose `length` exceeds
   `available[stream]`. If the caller's write is larger than the available
   credit, the sender MUST either split the write across frames as credit
   arrives or await credit; it MUST NOT drop, reorder or coalesce out of order.
4. Sending `DATA` decrements `available` by `length`.
5. Receiving `CREDIT { bytes }` increments `available` by `bytes`.
6. A receiver SHOULD grant credit as the **consumer** consumes bytes, not as
   they arrive, so that consumer backpressure propagates to the producer. A
   receiver SHOULD coalesce grants and send a `CREDIT` frame when the ungranted
   amount reaches `creditGrantThreshold` (§13) or when `available` at the peer
   would otherwise reach zero, whichever comes first.
7. A receiver MUST NOT grant credit that would take the peer's `available`
   above `2^31 - 1`.
8. Credit is per stream and per direction, and does not carry across streams.

### 8.2 Misbehaviour

- A peer that sends `DATA` exceeding its `available` credit is in violation.
  The receiver MUST respond with a **stream-level** `ERROR` carrying
  `FLOW_CONTROL_ERROR`, tear that stream down and **keep the connection open**.
  The over-sent bytes MUST be discarded, not delivered.
- Repeated violations are a resource-exhaustion signal: after
  `maxFlowViolations` (§13) stream-level flow-control violations on one
  connection, an endpoint MUST send connection-level `ERROR` with
  `FLOW_CONTROL_ERROR` and close.
- A `CREDIT` frame with `bytes <= 0` or a non-integer is a stream-level
  `FLOW_CONTROL_ERROR`.

### 8.3 Buffer bounds

The credit window is what bounds receive memory. An endpoint MUST NOT buffer
more than `available` bytes of undelivered payload per stream, so total
undelivered receive memory is bounded by
`maxStreams x initialCredit` plus the replay buffers (§9.5). With the defaults
in §13 that is 1024 x 64 KiB = 64 MiB of receive window plus at most
1024 x 1 MiB of replay, and an implementation SHOULD expose a lower
`maxStreams` or `initialCredit` when a tighter bound matters.

---

## 9. Resume

Resume makes a dropped socket invisible to the application: the consumer sees
every byte exactly once, in order, across the reconnect.

### 9.1 Sequence numbers

- Each stream has an independent sender-side counter per direction, starting at
  `0`. Every sequenced frame (`DATA`, `END`) increments it and carries the new
  value, so the first sequenced frame on a stream has `seq = 1`.
- `seq` is a `u32`. Wrap-around is not permitted: an endpoint that would exceed
  `2^32 - 1` MUST close the stream with `SEQ_EXHAUSTED`.
- The receiver tracks `lastSeq`, the highest sequence number it has fully
  processed. A frame is fully processed once it has been accounted for against
  the credit window and placed in the receive queue the session owns; it need
  not have been read by the application. Because that queue survives a dropped
  connection, replaying frames the consumer has not yet read would deliver
  them twice.
- On a live connection a receiver MUST reject a sequenced frame whose `seq` is
  not exactly `lastSeq + 1` with a stream-level `PROTOCOL_VIOLATION`; the
  carrier is ordered and reliable, so a gap is a defect, not loss.
- During replay (§9.4) a receiver MUST discard frames with `seq <= lastSeq`
  rather than error, because the server may replay from an earlier point than
  the client's true cursor.

### 9.2 Replay buffer

- Only the **server** keeps a replay buffer, because only the client
  reconnects. It is per stream and per direction (server -> client).
- The buffer is a ring bounded by **both** `resumeWindow.bytes` and
  `resumeWindow.frames` (§13 defaults: 1 MiB and 256 frames). Whichever bound
  is reached first evicts the oldest frame.
- Eviction advances `oldestReplaySeq` for that stream. A resume request for a
  cursor older than `oldestReplaySeq - 1` cannot be served (§9.4).
- The buffer holds the frames as they were sent, so replay reproduces the exact
  byte stream. Replayed frames MUST set the `REPLAY` flag and MUST keep their
  original `seq`.

### 9.3 Resume handshake

On reconnect the client sends `RESUME` **instead of** `HELLO` as the first
frame of the new connection:

```
  RESUME { sessionId, streams: [ { streamId, lastSeq }, … ] }
      |
      ├── session known and not expired
      │       └── RESUME_ACK { sessionId, resumed: […], failed: […] }
      │               then, for each resumed stream, the replayed frames
      │               (REPLAY flag set) followed by live frames
      │
      └── session unknown / expired
              └── RESUME_FAIL { code } at streamId 0, connection stays open
                  and the client MUST restart with HELLO on a fresh session
```

- The trust fence and cookie authentication of §6 apply to the reconnecting
  request exactly as they do to a first connection. A valid `sessionId` is
  **not** a substitute for the session cookie: an endpoint MUST authenticate
  first and resume second.
- A `sessionId` MUST NOT be accepted from a connection that authenticated as a
  different session cookie.
- The server MUST retain a session for `sessionTtlMs` (§13) after its last
  connection drops, then discard it. A `RESUME` naming a discarded session gets
  `RESUME_FAIL { code: "SESSION_EXPIRED" }`.
- After `RESUME_ACK` the connection is fully open; the client MUST NOT send
  `HELLO` on that connection.

### 9.4 Per-stream replay decision

For each entry in `RESUME.streams` the server evaluates:

| Condition | Result |
| --- | --- |
| Stream unknown to the session | `failed: [{ streamId, code: "STREAM_CLOSED" }]` |
| `lastSeq >= oldestReplaySeq - 1` | `resumed`: replay from `lastSeq + 1` |
| `lastSeq < oldestReplaySeq - 1` (cursor aged out) | `failed: [{ streamId, code: "SNAPSHOT_REQUIRED" }]` |
| `lastSeq > server's highest sent seq` | `failed: [{ streamId, code: "PROTOCOL_VIOLATION" }]` |

- `SNAPSHOT_REQUIRED` means the gap cannot be closed from the buffer and the
  application must re-derive state (re-open the stream, re-fetch a snapshot).
  An implementation MUST surface this to the consumer as a distinct, typed
  error. Silently continuing with a gap is forbidden.
- Streams the client did not list are treated as abandoned and MUST be
  cancelled server-side, freeing their buffers.
- Credit is **not** replayed: `CREDIT` frames are unsequenced and never appear
  in the replay buffer. Instead, both sides restore `available` from the
  cumulative grant totals carried by the handshake — `RESUME.streams[].granted`
  (§5.9) and `RESUME_ACK.credit` (§5.10). On receiving them an endpoint MUST
  set, for each resumed stream,

  ```
  available = peer.granted - (payload bytes this endpoint has sent on it)
  ```

  which MAY be negative (§8.1 rule 2), in which case the sender waits for
  `CREDIT` as usual. Re-granting alone is not sufficient and MUST NOT be relied
  on: a grant handed to a dying socket is counted by the granting side and
  never received by the peer, so without the totals the two views of
  `available` diverge permanently, and a stream whose last grant was the lost
  one never moves again.

### 9.5 Reaping

A closed stream's replay buffer is retained until the earlier of: the client
acknowledging the final `seq` on a later connection, `sessionTtlMs` elapsing,
or the session being explicitly closed. Then the stream is `reaped` and its
identifier is never reused within the session.

---

## 10. Unary calls

A unary call is a stream with a short life, not a separate mechanism. This
keeps one code path for framing, flow control and cancellation.

1. The caller allocates a `streamId`, sends `OPEN { name, params }` and then
   the request payload as `DATA` with `FIN` set (one frame in the common
   case), consuming initial credit.
2. The responder replies with `OPEN_ACK`, then the response payload as `DATA`
   with `FIN` set, or a stream-level `ERROR`.
3. Both sides then see both directions ended; the stream closes.

Rules:

- A caller MUST treat a unary call whose request does not fit in the initial
  credit as an ordinary stream write and await credit (§8).
- Request and response payload encoding is the adapter's business. Core MUST
  pass bytes through untouched.
- `CANCEL` on a unary stream is a call cancellation; a responder SHOULD stop
  work and MUST NOT send a response afterwards.

### 10.1 HTTP fallback

Where WebSocket is unavailable, a unary call MAY be made as
`POST /rpc` with the same authentication and trust fence as the WS upgrade
(`THREAT-MODEL.md`). The request body is one complete frame sequence
(`OPEN`, `DATA` with `FIN`) and the response body is the corresponding
(`OPEN_ACK`, `DATA` with `FIN`) or (`ERROR`) sequence, using the identical
framing of §3. Streams and resume are **not** available over the fallback: an
`openStream` attempt in fallback mode MUST fail with a typed error naming the
reason rather than degrading silently.

---

## 11. Keepalive

- The server MUST send `PING` every `heartbeatMs` (§13 default 30 000 ms) on an
  otherwise idle connection. The client MAY also send `PING`.
- A receiver MUST answer `PING` with `PONG` echoing `nonce` verbatim, promptly
  and regardless of stream state or credit.
- An endpoint that receives neither `PONG` nor any other frame within
  `heartbeatTimeoutMs` (§13 default 45 000 ms) MUST treat the connection as
  dead and close it. The client then reconnects with backoff (§11.1) and
  attempts `RESUME`.
- `PING`/`PONG` MUST NOT be blocked by flow control.

### 11.1 Reconnect backoff

A disconnected client MUST reconnect with exponential backoff from
`reconnectMinMs` to `reconnectMaxMs` (§13: 500 ms to 10 000 ms), doubling per
attempt, with **full jitter** (`delay = random(0, min(max, min * 2^n))`). It
MUST NOT reconnect in a tight loop after an authentication failure; a `401` or
`403` on the upgrade is terminal for that session and MUST be surfaced to the
application.

---

## 12. Error codes

Codes are stable strings carried in `ERROR.code`, `GOAWAY.code`,
`RESUME_FAIL.code` and `RESUME_ACK.failed[].code`.

| Code | Scope | Meaning |
| --- | --- | --- |
| `PROTOCOL_VIOLATION` | connection or stream | Malformed frame, illegal frame for the current state, or bad control payload. |
| `UNSUPPORTED_VERSION` | connection | No overlap between the peers' supported versions, or `version != 1` in a header. |
| `FRAME_TOO_LARGE` | connection | `length` exceeds the effective `maxFrameSize`. |
| `FLOW_CONTROL_ERROR` | stream or connection | Credit exceeded, or an invalid `CREDIT` grant. |
| `STREAM_STATE_ERROR` | stream | Frame illegal for the stream's current state (§7.3). |
| `STREAM_CLOSED` | stream | Frame for a closed, reaped or unknown stream. |
| `STREAM_LIMIT_EXCEEDED` | stream | `OPEN` would exceed the negotiated `maxStreams`. |
| `STREAM_ID_EXHAUSTED` | connection | The `u32` identifier space is spent. |
| `SEQ_EXHAUSTED` | stream | The `u32` sequence space is spent for this stream. |
| `NOT_FOUND` | stream | `OPEN.name` names no registered route. |
| `PERMISSION_DENIED` | stream | The peer may not open this route. |
| `CANCELLED` | stream | Terminated by `CANCEL`. |
| `INTERNAL_ERROR` | stream or connection | Unexpected fault in the peer. Detail MUST NOT leak internals to a browser peer. |
| `SESSION_UNKNOWN` | connection | `RESUME.sessionId` is not recognised. |
| `SESSION_EXPIRED` | connection | The session existed but its TTL elapsed. |
| `SNAPSHOT_REQUIRED` | stream | The resume cursor aged out of the replay buffer. |
| `SERVER_SHUTDOWN` | connection | Sent in `GOAWAY` during graceful close. |
| `UNAUTHORIZED` | connection | Authentication failed. Carried at the HTTP layer where possible; as a connection `ERROR` only after upgrade. |

An `ERROR` message string MUST NOT contain launch tokens, session cookies, MAC
values or filesystem paths outside the host application's own control.

---

## 13. Limits and defaults

All values are overridable through server options and advertised in
`HELLO_ACK` where the peer needs them. Both peers MUST honour the negotiated
effective value, not their own preference.

| Name | Default | Bound | Enforced by |
| --- | --- | --- | --- |
| `maxFrameSize` | 16 MiB (16 777 216) | hard maximum for `length` | codec, both sides |
| `maxStreams` | 1024 | concurrent open streams per connection | mux, both sides |
| `initialCredit` | 64 KiB (65 536) | initial per-stream, per-direction window | mux |
| `creditGrantThreshold` | 50 % of `initialCredit` | when to coalesce a `CREDIT` grant | mux, receiver |
| `resumeWindow.bytes` | 1 MiB (1 048 576) | replay ring, per stream | resume, server |
| `resumeWindow.frames` | 256 | replay ring, per stream | resume, server |
| `sessionTtlMs` | 60 000 | session retention after last disconnect | server |
| `heartbeatMs` | 30 000 | `PING` interval | both |
| `heartbeatTimeoutMs` | 45 000 | dead-connection detection | both |
| `reconnectMinMs` | 500 | backoff floor | client |
| `reconnectMaxMs` | 10 000 | backoff ceiling | client |
| `maxFlowViolations` | 8 | stream-level flow errors before connection teardown | mux |
| `launchTokenTtlMs` | 120 000 | validity window of the one-time launch token | server |
| `sessionCookieTtlMs` | 28 800 000 (8 h) | validity window of a minted session cookie, distinct from `sessionTtlMs` (`THREAT-MODEL.md` §7.2) | server |
| `authFailureWindowMs` | 60 000 | rate-limit window for authentication failures | server |
| `authFailuresPerWindow` | 20 | authentication failures per window per remote address before `429` | server |
| `maxHeaderBytes` | 16 KiB | HTTP request header budget | server |
| `handshakeTimeoutMs` | 10 000 | HTTP request line + headers, and `HELLO` after upgrade | server |

An endpoint MUST NOT advertise a `maxFrameSize` above the hard maximum, and
MUST reject a peer that does with `PROTOCOL_VIOLATION`.

---

## 14. Version negotiation and extensibility

- `version` in the header is the **wire format** version. This document defines
  version 1 and it is the only version an implementation of this document
  accepts on the wire.
- Backwards-compatible additions in version 1 are made by adding **object
  members** to control payloads. A receiver MUST ignore unknown members, and
  MUST ignore unknown `flags` bits (§3.1). A sender MUST NOT rely on an
  optional member being understood.
- A change that alters header layout, frame semantics, or the meaning of an
  existing member requires a new `version` value and a new entry in
  `HELLO.versions`.
- New frame types are **not** a compatible addition in version 1: an unknown
  `type` is a `PROTOCOL_VIOLATION` by §3.2, so any new frame type requires a
  version bump.
