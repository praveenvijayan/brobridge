# @brobridgejs/client

The browser side of brobridge. Standards only — a `WebSocket` and a `fetch` —
with no third-party runtime dependencies: token bootstrap, `HELLO`
negotiation, typed calls, streams that grant credit as you consume them, and
reconnect with resume so a dropped socket does not lose bytes.

Normative spec: [`PROTOCOL.md`](../../PROTOCOL.md).

## Install

```bash
npm install @brobridgejs/client
```

## Example

```ts
import { connect } from '@brobridgejs/client';

const terminal = document.querySelector('#terminal') as HTMLElement;
const statusBadge = document.querySelector('#status') as HTMLElement;
const decoder = new TextDecoder();

// Redeems the ?bt= launch token exactly once, then keeps only the origin: the
// token is never retained, never logged, never sent again.
const bridge = await connect(location.href);

// Unary call. Arguments and the result are JSON.
const contents = await bridge.call<string>('files.read', '/etc/hostname');
console.log(contents);

// Stream. Iterating is what grants credit, so a slow consumer applies
// backpressure to the producer automatically, and stalls only this stream.
const pty = await bridge.openStream('pty.attach', { cols: 80, rows: 24 });
for await (const chunk of pty) {
  terminal.textContent += decoder.decode(chunk); // chunk is a Uint8Array
}

// Connection state is an event stream you can render.
bridge.on('state', (state) => {
  // 'connecting' | 'open' | 'resuming' | 'degraded' | 'closed'
  statusBadge.textContent = state;
});
```

`scripts/demo.ts` in the repository root is this example as a running program:
a host with an echo service and a ticker stream, a page that connects back over
the bridge, and a button that cuts the socket so a resume can be watched.

```bash
node --experimental-strip-types scripts/demo.ts   # or: bun scripts/demo.ts
```

## The API

| | |
| --- | --- |
| `connect(url, options?)` | Bootstrap, connect, handshake. Resolves when usable. |
| `bridge.call<T>(route, ...args)` | Unary call. `"<service>.<method>"`, JSON arguments. |
| `bridge.callBytes(route, bytes)` | The same call with raw bytes, for adapters. |
| `bridge.makeProxy<T>(service)` | A typed view of one service. Type-level only. |
| `bridge.openStream(name, params?)` | A `BridgeStream`: async-iterable, and writable. |
| `bridge.ping()` | Round-trip time in milliseconds. |
| `bridge.on('state' \| 'error', fn)` | Subscribe; returns the unsubscribe function. |
| `bridge.close()` | Stop reconnecting, fail live streams, release the socket. |

`openStream` is a promise because it waits for a usable connection: opening a
stream into a socket that is currently down would put an `OPEN` nowhere, and
unsequenced frames are not replayed (`PROTOCOL.md` §9.4).

## Reconnect and resume

On a dropped socket the client reconnects with exponential backoff
(500 ms to 10 s, **full jitter**, `PROTOCOL.md` §11.1) and resumes every live
stream from its last processed sequence number. The consumer sees every byte
exactly once, in order — a `for await` loop does not even observe the gap.

When the host's replay buffer has already evicted the frames the cursor needs,
the stream fails with `SnapshotRequiredError` rather than continuing with a
silent hole: the application is told to re-derive its state. When the host has
forgotten the session altogether, the client starts a fresh one on the same
socket and the old streams fail — again visibly, never silently.

A call issued while the connection is down waits for it to come back. A call
already in flight when the socket dies fails: the host may have run it, and
deciding whether that is safe to retry is the application's call, not this
layer's.

### States

| State | Meaning |
| --- | --- |
| `connecting` | A first connection is being made. |
| `open` | Attached; calls and streams available. |
| `resuming` | Reconnecting a session that already exists; streams are being replayed. |
| `degraded` | The WebSocket is unavailable; unary calls ride `POST /rpc`. Streams are not available. The socket is still being retried underneath, so the state does not flap. |
| `closed` | Terminal. |

## The HTTP fallback

Some environments block WebSockets. With `httpFallback: true` the client, after
`wsAttemptsBeforeFallback` failures, routes unary calls over `POST /rpc` — the
same frames in an HTTP body, the same cookie, the same trust fence
(`PROTOCOL.md` §10.1). Streams and resume are not available there, and
`openStream` says so by name (`BridgeClientError` with
`reason: 'streams-unavailable'`) rather than degrading silently.

## Authentication

A browser cannot see why a WebSocket upgrade was refused — the API reports a
bare error, by design. Since `PROTOCOL.md` §11.1 requires an authentication
failure to be terminal rather than retried forever, the client asks the same
route over plain HTTP after a failed upgrade: the host answers `426` to a
caller it trusts and `403` to one it does not. A definite `403` closes the
bridge with `reason: 'unauthorized'`; anything inconclusive is treated as
transient and retried.

## Errors

Faults the wire carried keep their protocol types, re-exported from
`@brobridgejs/core`: `StreamError` (with `error.code` from `PROTOCOL.md` §12),
`SnapshotRequiredError`, `ResumeFailedError`, `ConnectionClosedError`.

Faults that never reached a host are a `BridgeClientError` with a stable
`reason`: `bootstrap-failed`, `unauthorized`, `socket-failed`,
`connect-timeout`, `streams-unavailable`, `fallback-disabled`,
`fallback-failed`, `closed`. `isClientError(value, reason?)` narrows both.

## Types

`makeProxy<T>()` maps a service interface onto promise-returning methods at the
type level; the runtime stays a string-keyed call, deliberately. Full
end-to-end inference is the job of `@brobridgejs/adapters`.

<!-- check-readme: fragment -->
```ts
interface Files {
  read(path: string): Promise<string>;
}
const files = bridge.makeProxy<Files>('files');
await files.read('/etc/hostname'); // -> string
```

## Options worth knowing

| Option | Default | What it decides |
| --- | --- | --- |
| `reconnect` | `true` | Whether a dropped connection is retried at all. |
| `reconnectMinMs` / `reconnectMaxMs` | 500 / 10 000 | The backoff window. |
| `httpFallback` | `false` | Whether unary calls may ride `POST /rpc`. |
| `wsAttemptsBeforeFallback` | 3 | Failures before the fallback engages — and, on a first connection, before `connect()` gives up. |
| `heartbeatTimeoutMs` | 45 000 | Silence that counts as a dead connection. |
| `connectTimeoutMs` | 10 000 | How long one attempt may take. |
| `onStream` | — | Called for every stream the host pushes to this tab. |
| `socket` / `fetch` | the globals | Injection points, for tests and unusual runtimes. |

## Size

The client's own code is well inside the 10 KiB min+gzip budget; bundled
together with `@brobridgejs/core`, which is what a browser actually downloads,
the total is over it. `pnpm size` prints both numbers and says by how much:

```
own      (core external): 3878 bytes min+gzip (3.79 KiB)
shipped  (core inlined):  12022 bytes min+gzip (11.74 KiB)
```

Closing that gap means giving core a browser-only entry point that leaves out
the replay buffer and session hosting, which only the host side uses. That is a
change to `@brobridgejs/core`, not to this package.

## License

MIT
