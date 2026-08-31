# brobridge

The host side of brobridge: an HTTP listener on loopback, the trust fence, the
one-time launch token, cookie authentication, and a WebSocket wired into a
`@brobridge/core` endpoint. One public API across Node >= 20 and Bun.

Normative specs: [`PROTOCOL.md`](../../PROTOCOL.md),
[`THREAT-MODEL.md`](../../THREAT-MODEL.md).

> **Status: scaffold.** The implementation lands in Phase 3. The example below
> is the target API.

## Install

```bash
npm install brobridge
```

## Example

```ts
import { createBridge } from 'brobridge';

const bridge = await createBridge({
  // Defaults: bind 127.0.0.1, port 0 (ephemeral). A non-loopback bind needs
  // an explicit opt-in — see THREAT-MODEL.md §5.12.
});

bridge.expose('files', {
  read: async (path: string) => readFile(path, 'utf8'),
});

bridge.stream('pty.attach', async function* ({ cols, rows }) {
  for await (const chunk of spawnPty({ cols, rows })) {
    yield chunk; // Uint8Array, passed through untouched
  }
});

console.log(`open ${bridge.url}`); // http://127.0.0.1:52341/?bt=<one-time token>

// Graceful: END every live stream, then close.
process.on('SIGINT', () => void bridge.close());
```

## What you get, and what you still own

brobridge guarantees that only the tab you launched can reach this listener. It
does **not** vouch for the code running in that tab: the capability surface you
pass to `expose()` is your decision. Treat arguments arriving over the bridge
as untrusted input, exactly as you would an HTTP handler's body.

## The trust fence

Every request — the bootstrap, the WebSocket upgrade, and the `POST /rpc`
fallback — passes one shared check before routing:

- `Host` must appear once and **byte-match** the bound authority. Values that
  merely parse to the same address (`0x7f.0.0.1`, `127.000.000.001`,
  zero-padded ports, embedded userinfo) are refused, which is what stops DNS
  rebinding.
- `Sec-Fetch-Site: cross-site` (or `same-site`) is refused.
- `Origin`, when present, must be in the allowlist.
- A valid session cookie is required, minted by burning the one-time launch
  token.

The fence ships as a pure function (request-like in, verdict out) so it is
unit-testable without sockets.

## License

MIT
