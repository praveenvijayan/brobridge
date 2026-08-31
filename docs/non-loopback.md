# Binding beyond loopback

By default brobridge binds `127.0.0.1` and refuses anything else:

```
TypeError: brobridge refuses to bind 0.0.0.0: it is not a loopback address. …
```

That refusal is the product's central safety property, so turning it off is
an explicit, code-level decision:

```ts
const bridge = await createBridge({
  host: '0.0.0.0',
  allowNonLoopback: true, // you are accepting everything on this page
});
```

There is intentionally no environment variable for this, and the startup
warning cannot be turned off short of a custom `logger`.

## What changes when you leave loopback

The threat model (`THREAT-MODEL.md` §5.12, §8.3) assumes the only attacker is
a hostile *web page* in the same browser. Off loopback you add every machine
that can reach the interface, and three properties you were getting for free
disappear:

1. **Confidentiality.** Traffic is plaintext HTTP/WS. On loopback that is
   fine — the OS is the boundary. On a network, anyone on the path reads
   every frame, including the launch token and the session cookie. brobridge
   does not do TLS; terminate it in front (Caddy/nginx/a tailnet) if you need
   this.
2. **The token/cookie model weakens.** The one-time token still burns, but it
   traveled in a URL over plaintext; the cookie still binds to the exact
   authority, but it can be replayed by whoever captured it. Auth-failure
   rate limiting is per remote address and helps against strangers, not
   against an on-path attacker.
3. **The handshake surface is exposed.** The fence (Host/Origin/
   `Sec-Fetch-Site`) still applies and still stops browser-borne attacks,
   but non-browser clients on the network can speak to the listener
   directly. Header budgets, handshake deadlines and socket-buffer caps
   bound the damage; they do not make it safe.

## Sane deployments off loopback

- **Tailnet / WireGuard**: bind the tailnet interface address, not
  `0.0.0.0`. The network layer provides both encryption and access control;
  this is the least-bad option and what we'd recommend.
- **Reverse proxy with TLS**: keep brobridge on loopback, put
  Caddy/nginx in front. Two things must hold: the proxy must forward the
  `Host` header *unmodified* to match the bound authority (or you
  terminate at the proxy and re-originate with the loopback authority), and
  the public origin must be in `allowedOrigins`. Test the fence afterwards:
  a request with a wrong `Host` must still get 403.
- **LAN demo**: acceptable for a demo; treat the cookie as compromised
  afterwards (`close()` the bridge — keys are per-instance, nothing
  persists).

## What not to do

- `0.0.0.0` on a machine with a public interface "temporarily".
- Reusing a printed URL across machines — the token is one-time, and the
  second open just fails.
- Wrapping the refusal in a `try/catch` that flips `allowNonLoopback` on
  automatically. The flag exists so a human decides.
