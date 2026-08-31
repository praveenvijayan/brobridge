# @brobridge/core

The brobridge protocol, as pure logic: frame codec, stream multiplexing,
credit-based flow control and resume. No sockets, no runtime dependencies,
no runtime assumptions — it runs unchanged in Node, Bun, Deno and the browser.

Normative spec: [`PROTOCOL.md`](../../PROTOCOL.md). Code and spec do not drift:
a behaviour change requires a spec change in the same commit.

## Install

```bash
npm install @brobridge/core
```

## The carrier interface

Core never touches a socket. It reaches the outside world through a carrier you
supply, which is why the same endpoint code runs on both sides of the wire:

```ts
interface Carrier {
  send(bytes: Uint8Array): void;
  onMessage(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  close?(): void; // optional; core calls it after a connection-level ERROR
}
```

## Example

```ts
import { BridgeEndpoint } from '@brobridge/core';

const endpoint = new BridgeEndpoint({ role: 'client' });
await endpoint.attach(carrier); // sends HELLO, resolves on HELLO_ACK

// Opening returns immediately: writing before the peer's OPEN_ACK is legal,
// which is what makes a unary call one round trip.
const stream = endpoint.openStream('pty.attach', { params: { cols: 80, rows: 24 } });

// Iterating is what grants credit, so a consumer that stops reading applies
// backpressure to the producer instead of growing a buffer.
for await (const chunk of stream) {
  process.stdout.write(chunk);
}

// Writing awaits credit rather than buffering without bound.
await stream.write(new TextEncoder().encode('ls -la\n'));
```

A unary call is the same machinery with a shorter life:

```ts
const response = await endpoint.call('users.get', new TextEncoder().encode('{"id":1}'));
```

## Serving

The responder side registers one handler and reads the stream. Throw a
`BridgeError` synchronously to reject the `OPEN` with a protocol error code:

```ts
import { BridgeError, ErrorCode, SessionHost } from '@brobridge/core';

const host = new SessionHost({
  onStream: (stream) => {
    if (stream.name !== 'echo') {
      throw new BridgeError(ErrorCode.NOT_FOUND, `no route named ${stream.name}`);
    }
    void stream.readAll().then((request) => stream.end(request));
  },
});

// One call per authenticated connection. The first frame decides whether this
// is a new session (HELLO) or a reconnect (RESUME).
const endpoint = await host.accept(carrier);
```

## Resume

An endpoint outlives its carrier. When a connection dies the endpoint moves to
`detached` and keeps every stream, its cursors and — server side — a bounded
replay ring. Attaching a fresh carrier sends `RESUME`, and the consumer sees
every byte exactly once, in order, across the gap:

```ts
await endpoint.attach(freshCarrier); // sends RESUME with each stream's cursor
```

When a cursor has aged out of the ring the gap cannot be closed from the
buffer. That surfaces as a distinct `SnapshotRequiredError` on the affected
stream rather than as a silent hole, so the application can re-derive state.

`SessionHost.reap(ttlMs)` discards sessions that have been detached too long.
Core holds no timers; scheduling that sweep is the host's business.

## What lives here

| Module | Responsibility |
| --- | --- |
| `codec.ts` | `encodeFrame` / `decodeFrame` / `FrameDecoder`; the decoder is a streaming parser that accepts any chunk boundary and returns a typed `ProtocolError` rather than throwing. |
| `mux.ts` | `BridgeEndpoint` and `BridgeStream`: stream table, credit accounting, the unary call helper. |
| `resume.ts` | `SeqCounter`, `SeqTracker`, the bounded per-stream replay ring and the `RESUME` decision table. |
| `sessions.ts` | `SessionHost`: routes a new connection to a new session or to the one its `RESUME` names. |
| `errors.ts`, `types.ts` | Discriminated unions for every frame; frame-type constants (no magic numbers outside `codec.ts`). |

## License

MIT
