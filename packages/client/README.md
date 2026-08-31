# @brobridge/client

The browser side of brobridge. Standards only (`WebSocket` + `fetch`), zero
runtime dependencies, budgeted at under 10 KB min+gzip: token bootstrap,
`HELLO` negotiation, typed calls, streams that grant credit as you consume
them, and reconnect with resume so a dropped socket does not lose bytes.

Normative spec: [`PROTOCOL.md`](../../PROTOCOL.md).

> **Status: scaffold.** The implementation lands in Phase 4. The example below
> is the target API.

## Install

```bash
npm install @brobridge/client
```

## Example

```ts
import { connect } from '@brobridge/client';

// Consumes the ?bt= launch token exactly once, then strips it: the token is
// never retained, never logged, never re-sent.
const bridge = await connect(location.href);

// Unary call.
const contents = await bridge.call('files.read', '/etc/hostname');

// Stream. Iterating is what grants credit, so a slow consumer applies
// backpressure to the producer automatically, and stalls only this stream.
const pty = await bridge.openStream('pty.attach', { cols: 80, rows: 24 });
for await (const chunk of pty) {
  terminal.write(chunk); // Uint8Array
}

// Connection state is an event stream you can render.
bridge.on('state', (s) => {
  // 'connecting' | 'open' | 'resuming' | 'degraded' | 'closed'
  statusBadge.textContent = s;
});
```

## Reconnect and resume

On a dropped socket the client reconnects with exponential backoff
(500 ms to 10 s, full jitter) and resumes every live stream from its last
processed sequence number. The consumer sees every byte exactly once, in order.

When the server's replay buffer has already evicted the needed frames, the
stream rejects with a `SnapshotRequiredError` rather than continuing with a
silent gap — the application is told to re-derive its state.

## Types

`makeProxy<T>()` maps a service interface onto promise-returning methods at the
type level; the runtime stays a string-keyed call, deliberately. Full
end-to-end inference is the job of `@brobridge/adapters`.

## License

MIT
