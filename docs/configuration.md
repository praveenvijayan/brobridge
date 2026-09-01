# Configuration reference

Every option of `createBridge` (host) and `connect` (browser), with its
default and what changing it costs. Numeric protocol defaults come from
[`PROTOCOL.md` §13](../PROTOCOL.md); security-relevant defaults cite the
[`THREAT-MODEL.md`](../THREAT-MODEL.md) section that motivates them.

All options are optional. Both functions throw a `TypeError` at startup for a
value that is out of range or a configuration that cannot be made safe — a
bridge never starts in a state the spec forbids.

## `createBridge(options)` — the host

```ts
import { createBridge } from 'brobridge';
const bridge = await createBridge({ port: 3080 });
```

### Binding

| Option | Default | Meaning |
| --- | --- | --- |
| `host` | `'127.0.0.1'` | Interface to bind. Non-loopback values throw without `allowNonLoopback`. |
| `port` | `0` | Port to bind. `0` lets the OS pick an ephemeral port; read it back from `bridge.port`. |
| `allowNonLoopback` | `false` | Explicit opt-in for a non-loopback bind. Never settable by environment variable. Read [`docs/non-loopback.md`](./non-loopback.md) before using it. |
| `allowedOrigins` | the bound origin | Origins allowed to reach the bridge. An absent `Origin` header (non-browser client) is always allowed (`THREAT-MODEL.md` §5.5). Add entries only for a page served from somewhere other than the bridge itself, e.g. a Vite dev server: `['http://localhost:5173']`. |
| `index` | a placeholder page | `{ body, contentType? }` served at `/` to an authenticated caller — usually your built SPA's `index.html`. |
| `logger` | `console` | `{ warn, error }` sink for diagnostics. Values are redacted before they reach it; the launch token never appears. |
| `onSession` | — | Called once per protocol session when its `HELLO` handshake completes. The `BridgeSession` argument is how the host *pushes*: `session.openStream(name)`, `session.call(name, bytes)`. |

### Authentication

| Option | Default | Meaning |
| --- | --- | --- |
| `launchTokenTtlMs` | `120_000` | How long the one-time `?bt=` token in `bridge.url` stays redeemable. After redemption it is dead regardless. |
| `sessionCookieTtlMs` | 8 hours | Validity of the HMAC-signed session cookie the token mints. This bounds how long a tab can keep reconnecting without relaunching; distinct from `sessionTtlMs`, which only bounds stream *resume*. |
| `authFailureWindowMs` | `60_000` | Rate-limit window for authentication failures. |
| `authFailuresPerWindow` | `20` | Failures allowed per window per remote address before requests are refused outright. |

### Connection lifecycle

| Option | Default | Meaning |
| --- | --- | --- |
| `sessionTtlMs` | `60_000` | How long a protocol session's replay state survives after its last socket dies. A tab that reconnects within this window resumes its streams byte-exact; later, it must reauthenticate its streams from scratch (`SnapshotRequiredError` path). |
| `handshakeTimeoutMs` | `10_000` | Deadline for request headers, and for `HELLO` after a WebSocket upgrade. |
| `heartbeatMs` | `30_000` | `PING` interval. |
| `heartbeatTimeoutMs` | `45_000` | Silence longer than this means the connection is dead. |
| `closeTimeoutMs` | `2_000` | How long `bridge.close()` waits for streams to end before forcing sockets shut. |

### Limits (memory bounds — see `THREAT-MODEL.md` §5.10, §8.3)

| Option | Default | Meaning |
| --- | --- | --- |
| `maxFrameSize` | 16 MiB | Largest accepted frame. Also the hard protocol ceiling: raising it above 16 MiB throws. |
| `maxStreams` | `1024` | Concurrent streams per connection. |
| `initialCredit` | 64 KiB | Per-stream, per-direction flow-control window. The single biggest throughput/latency knob: a larger window cuts credit-refill latency under high stream concurrency at the cost of a proportionally larger per-stream memory bound. The verification report measured p99 inter-chunk latency of ~6 ms at 64 KiB across 50 streams and ~1.3 ms at 512 KiB. |
| `resumeWindow` | `{ bytes: 1 MiB, frames: 256 }` | Replay ring per stream. Larger = longer disconnects survivable without `SnapshotRequiredError`, more memory per stream. |
| `maxHeaderBytes` | 16 KiB | HTTP request header budget. |
| `maxRpcBodyBytes` | 2 × `maxFrameSize` | Largest `POST /rpc` fallback body. |
| `maxSocketBufferBytes` | 8 MiB | Bytes the socket pump may hold for a peer that is not reading; a connection exceeding it is closed. |

### The `Bridge` you get back

| Member | Meaning |
| --- | --- |
| `url` | The URL to open — carries the one-time token. Show it or open it; do not log it. |
| `origin`, `authority`, `host`, `port` | Where the bridge is bound. `origin` never contains the token. |
| `sessions` | Live protocol sessions (for pushing). |
| `expose(name, service)` | Methods become callable as `"<name>.<method>"` with JSON arguments. Arguments are untrusted input — validate them (`THREAT-MODEL.md` §8.4). |
| `stream(name, handler)` | Stream route for server-push and long transfers. `stream.write` resolves as credit allows — backpressure is the await. |
| `close()` | `GOAWAY`, end streams, release the listener. |

## `connect(url, options)` — the browser

```ts
import { connect } from '@brobridgejs/client';
const bridge = await connect(location.href, { httpFallback: true });
```

`url` may be `location.href`, the printed URL, or a bare origin. A `?bt=`
token in it is redeemed exactly once and never retained.

### Reconnect and fallback

| Option | Default | Meaning |
| --- | --- | --- |
| `reconnect` | `true` | Reconnect with backoff after a drop. `false` moves the bridge to `closed` on first loss and rejects pending calls. |
| `reconnectMinMs` / `reconnectMaxMs` | `500` / `10_000` | Backoff floor and ceiling (full jitter between them). |
| `connectTimeoutMs` | `10_000` | Budget for one connection attempt. |
| `heartbeatTimeoutMs` | `45_000` | Silence longer than this means the connection is dead. Keep it matched with the server's `heartbeatMs`. |
| `httpFallback` | `false` | After `wsAttemptsBeforeFallback` consecutive WebSocket failures, route unary calls over `POST /rpc`. Streams are unavailable in that state; `openStream` rejects with reason `streams-unavailable`. The socket keeps retrying in the background. |
| `wsAttemptsBeforeFallback` | `3` | Consecutive failures before the fallback engages. |

### Protocol limits (client side of the negotiation)

| Option | Default | Meaning |
| --- | --- | --- |
| `maxFrameSize` | 16 MiB | Largest frame this client accepts. |
| `maxStreams` | `1024` | Concurrent streams this client accepts. |
| `initialCredit` | 64 KiB | Credit this client grants per stream — bounds the memory a fast host can force this tab to hold. |

### Integration points

| Option | Default | Meaning |
| --- | --- | --- |
| `clientName` | `'@brobridgejs/client'` | Diagnostic name sent in `HELLO.client`. |
| `onStream` | — | Called for every stream the *host* pushes to this tab. |
| `socket` / `fetch` | globals | Injectable constructors, for tests and non-browser runtimes. A runtime with neither global throws a clear `TypeError` at `connect`. |
| `now` / `random` | `Date.now` / `Math.random` | Injectable clock and jitter source, for deterministic tests. |

### The `Bridge` you get back

| Member | Meaning |
| --- | --- |
| `state` | `'connecting' \| 'open' \| 'resuming' \| 'degraded' \| 'closed'`. |
| `on('state' \| 'error', cb)` | Subscribe; returns the unsubscribe function. `error` events are absorbed faults (diagnostics), not control flow. |
| `call(route, ...args)` / `callBytes(route, bytes)` | Unary call, JSON or raw. A call made while down waits for reconnection; one in flight when the socket drops **rejects**, because the host may have executed it — retrying is your decision. |
| `makeProxy<T>(service)` | Typed view of one service; type-level only. |
| `openStream(name, params?)` | `AsyncIterable<Uint8Array>`. Iterating grants credit — slow consumption is backpressure. |
| `ping()` | Round-trip time in ms. |
| `sessionId` | Protocol session id once the handshake settles. |
| `close()` | Stops reconnecting, fails live streams. |
