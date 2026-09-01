# Troubleshooting

What each failure looks like from application code, what actually happened,
and what to do. Error identities are stable API: branch on `error.reason`
(client faults) or `error.code` (wire faults), never on message text.

## The two error families

**`BridgeClientError`** (from `@brobridgejs/client`) — faults that happened on
the browser side and never reached the host. Discriminant: `reason`.

**`BridgeError`** and subclasses (from `@brobridgejs/core`, re-exported by the
client) — faults a peer expressed on the wire. Discriminant: `code`, one of
the stable strings in [`PROTOCOL.md` §12](../PROTOCOL.md). Subclasses that
matter to applications: `StreamError`, `SnapshotRequiredError`,
`ConnectionClosedError`, `ResumeFailedError`.

```ts
import { isClientError, SnapshotRequiredError } from '@brobridgejs/client';

try {
  for await (const chunk of stream) render(chunk);
} catch (error) {
  if (error instanceof SnapshotRequiredError) return refetchAndReopen();
  if (isClientError(error, 'streams-unavailable')) return showDegradedBanner();
  throw error;
}
```

## `connect()` rejects

| You see | It means | Do |
| --- | --- | --- |
| `BridgeClientError` `reason: 'bootstrap-failed'` | The `?bt=` token was refused: already redeemed (a reload after a successful connect is the common case), expired (`launchTokenTtlMs`, default 2 min), or the request tripped the trust fence. | Relaunch from the host to mint a fresh URL. For reload-safety, note the cookie survives: `connect(location.origin)` without a token works for `sessionCookieTtlMs` (default 8 h). |
| `reason: 'unauthorized'` | No valid session cookie on the upgrade: never bootstrapped, cookie expired, or the page is on a different origin than the bridge. | Bootstrap first (open the tokened URL). Cross-origin pages (e.g. Vite dev server) need `allowedOrigins` on the host — see below. |
| `reason: 'socket-failed'` | No WebSocket could be constructed at all. | In a browser: an extension/proxy is blocking WS — enable `httpFallback` for calls. In Node/tests: pass `options.socket`. |
| `reason: 'connect-timeout'` | Nothing answered within `connectTimeoutMs`. | Host not running, wrong port, or a firewall. Check `bridge.url` on the host side. |

## Fence refusals (HTTP 403 before any handler runs)

The host refuses, by design, any request whose `Host` is not byte-identical
to the bound authority, whose `Origin` is not allowlisted, or that arrives
with `Sec-Fetch-Site: cross-site`. This is the DNS-rebinding/CSRF fence
(`THREAT-MODEL.md` §5.1–§5.5), not a bug.

Common legitimate trip: serving your page from a dev server
(`http://localhost:5173`) while the bridge runs elsewhere. Fix on the host:

```ts
createBridge({ allowedOrigins: ['http://localhost:5173'] });
```

Also remember `localhost` and `127.0.0.1` are *different authorities*: open
the exact URL the host printed.

## Streams

| You see | It means | Do |
| --- | --- | --- |
| `SnapshotRequiredError` | A reconnect landed after the replay window aged out (`sessionTtlMs`, default 60 s, or `resumeWindow` overflow). The host refuses to continue with a silent gap (`PROTOCOL.md` §9.4). | Re-derive state: re-open the stream, re-fetch a snapshot. This error is precisely catchable so you can automate that. Longer tolerable disconnects: raise `sessionTtlMs` / `resumeWindow` on the host. |
| `BridgeClientError` `reason: 'streams-unavailable'` | Connection is `degraded` — calls ride `POST /rpc`, streams cannot. | Wait for `state` to return to `open` (subscribe with `bridge.on('state', …)`), then re-open. |
| `StreamError` `code: 'NOT_FOUND'` | No stream route with that name on the host. | Check the `bridge.stream(name, …)` registration. |
| `StreamError` `code: 'CANCELLED'` | The other side cancelled. Normal teardown, not a fault. | Treat as end-of-stream. |
| `StreamError` `code: 'STREAM_LIMIT_EXCEEDED'` | More than `maxStreams` (default 1024) concurrent streams. | Close streams you no longer read; or raise the limit on both sides. |
| Producer seems stuck on `stream.write` | Not a fault: `write` resolves only as the consumer grants credit. A paused consumer holds exactly its credit window and stalls only its own stream. | If intended, nothing. If the consumer is gone, cancel the stream. |

## Calls

| You see | It means | Do |
| --- | --- | --- |
| Call rejects with `ConnectionClosedError` while `state` was `open` | The socket dropped with the call in flight. The host may or may not have executed it. | Retry only if the method is idempotent — the client deliberately never retries for you. |
| Call hangs while `state` is `connecting`/`resuming` | Calls made while down wait for the connection to return; that is the designed behavior. | Bound it yourself with `AbortSignal.timeout`-style wrappers, or watch `state`. |
| `StreamError` `code: 'INTERNAL_ERROR'` on a call | The exposed method threw on the host. | Look at the host's `logger` output; the wire carries no stack trace by design. |

## Connection state flapping / duplicate work

`state` transitions are: `connecting → open ⇄ resuming`, `open → degraded →
open`, anything → `closed` (terminal, only via `close()` or
`reconnect: false`). If your UI reacts to `resuming` by refetching
everything, stop — resume is byte-exact when it succeeds; refetch only on
`SnapshotRequiredError`.

## Host-side

| You see | It means | Do |
| --- | --- | --- |
| `TypeError: brobridge refuses to bind …` at startup | Non-loopback `host` without `allowNonLoopback`. | Read [`docs/non-loopback.md`](./non-loopback.md) first. |
| Warning about a non-loopback listener | You opted in; the bridge reminds you the traffic is plaintext and the handshake surface exposed. | Expected. It cannot be silenced except by a custom `logger` — deliberate. |
| Connection closed, log mentions the socket buffer | A peer stopped reading and the pump hit `maxSocketBufferBytes` (default 8 MiB). Closing is the bounded-memory guarantee (`THREAT-MODEL.md` §5.10). | Usually a stuck tab; the client reconnects and resumes. Raise the limit only with a reason. |
| 429 responses | Auth-failure rate limit (`authFailuresPerWindow` per `authFailureWindowMs` per remote address). | Something is retrying with dead credentials — find it; the limit is doing its job. |

## Still stuck

- `bridge.ping()` gives round-trip time; if it resolves, transport and auth
  are fine and the problem is above brobridge.
- The client emits absorbed faults on `bridge.on('error', …)` — subscribe in
  development builds.
- The wire protocol is fully specified in [`PROTOCOL.md`](../PROTOCOL.md);
  every error code's exact semantics live in §12.
- Security-shaped surprises: check [`THREAT-MODEL.md`](../THREAT-MODEL.md)
  first — several "bugs" (fence 403s, one-time tokens, refused binds) are
  the product working.
