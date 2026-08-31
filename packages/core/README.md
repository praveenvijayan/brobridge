# @brobridge/core

The brobridge protocol, as pure logic: frame codec, stream multiplexing,
credit-based flow control and resume. No sockets, no runtime dependencies,
no runtime assumptions — it runs unchanged in Node, Bun, Deno and the browser.

Normative spec: [`PROTOCOL.md`](../../PROTOCOL.md).

> **Status: scaffold.** The implementation lands in Phase 2. The example below
> is the target API from the spec.

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
}
```

## Example

```ts
import { BridgeEndpoint, PROTOCOL_VERSION } from '@brobridge/core';

console.log(PROTOCOL_VERSION); // 1

const endpoint = new BridgeEndpoint(carrier, { role: 'client' });

// Open a stream and read it as bytes arrive. Iterating grants credit, so
// backpressure reaches the producer without any explicit call.
const stream = await endpoint.openStream('pty.attach', { cols: 80, rows: 24 });
for await (const chunk of stream) {
  process.stdout.write(chunk);
}

// Writing awaits credit rather than buffering without bound.
await stream.write(new TextEncoder().encode('ls -la\n'));
```

## What lives here

| Module | Responsibility |
| --- | --- |
| `codec.ts` | `encodeFrame` / `decodeFrame`; the decoder is a streaming parser that accepts any chunk boundary and returns typed `ProtocolError` rather than throwing. |
| `mux.ts` | `BridgeEndpoint`: stream table, credit accounting, the unary call helper. |
| `resume.ts` | Bounded per-stream replay ring, sequence assignment, `RESUME` / `RESUME_FAIL`. |
| `errors.ts`, `types.ts` | Discriminated unions for every frame; frame-type constants (no magic numbers outside `codec.ts`). |

## License

MIT
