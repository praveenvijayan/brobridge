# brobridge

The host side of brobridge: an HTTP listener on loopback, the trust fence, the
one-time launch token, cookie authentication, and a WebSocket wired into a
`@brobridge/core` endpoint. One public API across Node >= 20 and Bun.

Normative specs: [`PROTOCOL.md`](../../PROTOCOL.md),
[`THREAT-MODEL.md`](../../THREAT-MODEL.md).

## Install

```bash
npm install brobridge
```

## Example

Runnable as written, on Node or Bun:

```ts
import { readFile } from 'node:fs/promises';

import { createBridge } from 'brobridge';

// Defaults: bind 127.0.0.1, port 0 (ephemeral). A non-loopback bind needs an
// explicit opt-in — see THREAT-MODEL.md §5.12.
const bridge = await createBridge();

// Methods become callable as "<service>.<method>" with JSON arguments.
bridge.expose('files', {
  read: async (path: string) => readFile(path, 'utf8'),
});

// A stream route pushes bytes. `stream.write` resolves only as credit allows,
// so a browser that stops reading slows the producer instead of growing a
// buffer.
bridge.stream('ticker', async (stream, { params }) => {
  const every = Number(params.everyMs ?? 1000);
  for (let tick = 0; ; tick += 1) {
    await stream.write(new TextEncoder().encode(`tick ${tick}\n`));
    await new Promise((resolve) => setTimeout(resolve, every));
  }
});

console.log(`open ${bridge.url}`); // http://127.0.0.1:52341/?bt=<one-time token>

// Graceful: GOAWAY, END every live stream, then release the listener.
process.on('SIGINT', () => void bridge.close());
```

From the browser, `@brobridge/client` (Phase 4) does the rest. Until then the
raw surface is: `GET /?bt=<token>` to mint the cookie, then a WebSocket to
`/ws`, then the protocol in [`PROTOCOL.md`](../../PROTOCOL.md).

## The call surface

| Route shape | Registered with | Request | Response |
| --- | --- | --- | --- |
| `"<service>.<method>"` | `expose(name, object)` | JSON array of arguments | JSON of the return value, or an empty payload for `undefined` |
| any exact name | `stream(name, handler)` | `OPEN.params` | whatever the handler writes |

Only own, enumerable function properties are callable, so `constructor`,
`toString` and the rest of the prototype chain are not routes. A handler that
throws a `BridgeError` sends its code and message to the peer; anything else
becomes `INTERNAL_ERROR` with no detail, because an exception message can carry
paths and internal state.

To push into the tab, use the session:

<!-- check-readme: fragment -->
```ts
const bridge = await createBridge({
  onSession: (session) => {
    const stream = session.openStream('notifications');
    void stream.write(new TextEncoder().encode('hello'));
  },
});
```

## What you get, and what you still own

brobridge guarantees that only the tab you launched can reach this listener. It
does **not** vouch for the code running in that tab: the capability surface you
pass to `expose()` is your decision. Treat arguments arriving over the bridge
as untrusted input, exactly as you would an HTTP handler's body.

The bridge serves three exact paths — `/`, `/ws`, `/rpc` — and reads nothing
from disk. If you add static serving in front of it, that surface is yours.

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
unit-testable without sockets:

```ts
import { checkRequest } from 'brobridge';

checkRequest(
  { target: '/ws', rawHeaders: [['Host', 'evil.test:7777']], upgrade: true },
  { authority: '127.0.0.1:7777', allowedOrigins: ['http://127.0.0.1:7777'] },
);
// { ok: false, check: 'host-mismatch', detail: '…' }  → 403, empty body
```

## Options worth knowing

| Option | Default | What it decides |
| --- | --- | --- |
| `host` / `port` | `127.0.0.1` / `0` | Where to bind. Non-loopback throws without `allowNonLoopback`. |
| `allowedOrigins` | the bound origin | Which `Origin` values pass the fence. An absent `Origin` is always allowed; a wrong one never is. |
| `index` | a placeholder page | What `/` serves to an authenticated caller. |
| `launchTokenTtlMs` | 120 000 | How long the launch token stays redeemable. |
| `sessionCookieTtlMs` | 8 h | How long the tab stays authenticated. |
| `sessionTtlMs` | 60 000 | How long a disconnected session's streams stay resumable. |
| `authFailuresPerWindow` / `authFailureWindowMs` | 20 / 60 000 | The failure limiter, per remote address. |
| `maxSocketBufferBytes` | 8 MiB | What a peer that stops reading may cost before its connection is closed. |
| `maxFrameSize`, `maxStreams`, `initialCredit`, `resumeWindow` | `PROTOCOL.md` §13 | Protocol limits, advertised in `HELLO_ACK`. |

## Runtimes

Node uses `node:http` plus [`ws`](https://github.com/websockets/ws) — the one
runtime dependency this package takes, because Node ships a WebSocket *client*
and no server. Bun uses `Bun.serve` and never loads `ws`. The public API,
the fence, the authentication and the session handling are the same code on
both; only the socket plumbing differs.

```bash
pnpm -F brobridge test      # Node
pnpm -F brobridge test:bun  # Bun
```

## License

MIT
