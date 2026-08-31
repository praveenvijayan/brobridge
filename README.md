# brobridge

A secure, high-performance bridge between a local Node/Bun process and a
browser tab.

brobridge is **not** an RPC framework. It is the transport and session layer
that RPC frameworks sit on top of: binary framing, stream multiplexing,
credit-based flow control, resume across reconnects, and — the part that is
actually hard — a trust fence that keeps every *other* page in the user's
browser out.

> **Status: pre-alpha.** The scaffold, the wire protocol and the threat model
> are written. Implementation lands package by package. See
> [`DEVELOPMENT-PROMPTS.md`](../DEVELOPMENT-PROMPTS.md) for the phase plan.

## Why

Any local HTTP listener is reachable by every web page the user visits.
Loopback is not a security boundary in a browser, and the WebSocket handshake
ignores the same-origin policy entirely. If your CLI, editor or agent opens a
port to talk to its own UI, the interesting question is not "how do I frame
messages" — it is "how do I make sure only *my* tab can talk to this".

brobridge answers both:

- **Security.** Exact-authority `Host` matching (no normalisation, so DNS
  rebinding fails), `Sec-Fetch-Site` and `Origin` enforcement, a one-time
  launch token that mints an HMAC-signed `SameSite=Strict` session cookie, and
  constant-time credential comparison with rate-limited failures. Written down
  in [`THREAT-MODEL.md`](./THREAT-MODEL.md), attack by attack, with the check
  and the package that enforces it.
- **Performance.** One WebSocket per tab carrying many logical streams, binary
  frames with raw `Uint8Array` payloads (never base64), per-stream credit flow
  control so a slow consumer stalls only its own stream, and a bounded replay
  buffer so a dropped socket does not lose bytes. Specified in
  [`PROTOCOL.md`](./PROTOCOL.md).

## Packages

| Package | npm name | What it is |
| --- | --- | --- |
| [`packages/core`](./packages/core) | `@brobridge/core` | Protocol: codec, mux, flow control, resume. Zero runtime deps, any JS runtime. |
| [`packages/server`](./packages/server) | `brobridge` | Node >= 20 and Bun host: listener, trust fence, token bootstrap, cookie auth. |
| [`packages/client`](./packages/client) | `@brobridge/client` | Browser client: reconnect, resume, typed calls, streams. Zero runtime deps, < 10 KB min+gzip. |
| [`packages/adapters`](./packages/adapters) | `@brobridge/adapters` | Subpath adapters for `birpc`, oRPC and tRPC. |

## Quickstart

> The API below is the target shape from `PROTOCOL.md`; it becomes runnable as
> Phases 3 and 4 land.

```ts
// host process
import { createBridge } from 'brobridge';

const bridge = await createBridge({
  expose: {
    echo: (message: string) => message,
  },
});

console.log(`open ${bridge.url}`); // http://127.0.0.1:52341/?bt=<one-time token>
```

```ts
// browser
import { connect } from '@brobridge/client';

const bridge = await connect(location.href);
await bridge.call('echo', 'hello'); // 'hello'
```

## Development

```bash
pnpm install
pnpm build     # tsc -b across the workspace, in reference order
pnpm test      # vitest, all packages
pnpm publint   # publint + @arethetypeswrong/cli against every package
```

Requires Node >= 20 and pnpm 11. Bun is needed for the Bun-tagged server tests.

## Documents

- [`PROTOCOL.md`](./PROTOCOL.md) — normative wire protocol (RFC-style).
- [`THREAT-MODEL.md`](./THREAT-MODEL.md) — normative threat model.

Both are binding: code that disagrees with them is a defect, and a deliberate
behaviour change edits the document in the same commit.

## License

MIT
