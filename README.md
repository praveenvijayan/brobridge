# brobridge

A secure, high-performance bridge between a local Node/Bun process and a
browser tab.

brobridge is **not** an RPC framework. It is the transport and session layer
that RPC frameworks sit on top of: binary framing, stream multiplexing,
credit-based flow control, resume across reconnects, and — the part that is
actually hard — a trust fence that keeps every *other* page in the user's
browser out.

> **Status: 0.1.0, pre-1.0.** The wire protocol, the threat model, all four
> packages and the `birpc`, oRPC and tRPC adapters are implemented and work end
> to end, in Node, in Bun and in a real browser. The audit that closes the
> first release — spec conformance, an adversarial security re-test, the
> cross-runtime matrix, benchmarks and packaging — is written up in
> [`VERIFICATION-REPORT.md`](./VERIFICATION-REPORT.md), including what it did
> not verify.

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
| [`packages/core`](./packages/core) | `@brobridge/core` | Protocol: codec, mux, flow control, resume. Zero runtime deps, any JS runtime. **Implemented.** |
| [`packages/server`](./packages/server) | `brobridge` | Node >= 20 and Bun host: listener, trust fence, token bootstrap, cookie auth. **Implemented.** |
| [`packages/client`](./packages/client) | `@brobridge/client` | Browser client: reconnect, resume, typed calls, streams. No third-party runtime deps. **Implemented.** |
| [`packages/adapters`](./packages/adapters) | `@brobridge/adapters` | Subpath adapters for `birpc`, oRPC and tRPC. **Implemented.** |

## Quickstart

```ts
// host process
import { createBridge } from 'brobridge';

const bridge = await createBridge(); // binds 127.0.0.1 on an ephemeral port

bridge.expose('demo', { echo: (message: string) => message });
bridge.stream('ticker', async (stream) => {
  const encoder = new TextEncoder();
  for (let tick = 0; ; tick += 1) {
    await stream.write(encoder.encode(`${String(tick)} `)); // resolves as credit allows
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
});

console.log(`open ${bridge.url}`); // http://127.0.0.1:52341/?bt=<one-time token>
```

```ts
// browser
import { connect } from '@brobridge/client';

const bridge = await connect(location.href); // burns the token, keeps the cookie
await bridge.call('demo.echo', 'hello'); // 'hello'

for await (const chunk of await bridge.openStream('ticker')) {
  console.log(new TextDecoder().decode(chunk)); // survives a dropped socket
}
```

Both halves, running, with a button that cuts the socket so the resume is
visible: `node --experimental-strip-types scripts/demo.ts`.

## Development

```bash
pnpm install
pnpm build     # tsc -b across the workspace, in reference order
pnpm test      # vitest, all packages
pnpm publint   # publint + @arethetypeswrong/cli against every package
pnpm size      # the browser client's bundle budget
pnpm demo      # host + page, on a loopback port
```

Release and verification:

```bash
node scripts/bench.mjs           # the performance targets, with numbers
node scripts/check-publish.mjs   # npm publish --dry-run for every package
pnpm check:consumer              # packed tarballs in a fresh temp project
pnpm changeset                   # describe a change for the next release
```

Bun covers the other half of the matrix:

```bash
pnpm -F brobridge test:bun          # the Bun host
pnpm -F @brobridge/client test:bun  # the client against a Bun host
```

Requires Node >= 20 and pnpm 11. Bun is needed for the Bun-tagged suites, and
the browser smoke test skips itself when no Chromium is installed.

## Documents

- [`PROTOCOL.md`](./PROTOCOL.md) — normative wire protocol (RFC-style).
- [`THREAT-MODEL.md`](./THREAT-MODEL.md) — normative threat model.
- [`SECURITY.md`](./SECURITY.md) — how to report a vulnerability, and the
  threat model in one page.
- [`VERIFICATION-REPORT.md`](./VERIFICATION-REPORT.md) — the release audit,
  with the evidence and the open items.

Both are binding: code that disagrees with them is a defect, and a deliberate
behaviour change edits the document in the same commit.

## License

MIT
