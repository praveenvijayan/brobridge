# Security policy

## Reporting a vulnerability

Report privately. Do **not** open a public issue for a vulnerability.

- **GitHub:** open a [private security advisory](https://github.com/praveenvijayan/brobridge/security/advisories/new)
  on the repository. This is the preferred route — it gives us a private fork
  to fix in and a coordinated disclosure timeline.
- **Email:** `security@brobridge.dev`, if you would rather not use GitHub.

Please include what you have: the version, the platform, a description of the
issue, and a proof of concept if you have one. A raw HTTP exchange or a short
script is worth more than a paragraph of prose. If the finding depends on a
configuration (a non-loopback bind, a custom `allowedOrigins`), say so.

What to expect:

| | |
| --- | --- |
| First response | within 3 working days |
| Triage and severity | within 7 days |
| Fix or mitigation plan | within 30 days for high and critical |
| Credit | in the advisory and the changelog, unless you would rather not be |

We will not take legal action against good-faith research that stays within
your own machines and does not exfiltrate anyone else's data.

## Supported versions

brobridge is pre-1.0. Security fixes land on the latest minor release only.

| Version | Supported |
| --- | --- |
| 0.1.x | yes |
| < 0.1 | no |

The four packages — `@brobridgejs/core`, `brobridge`, `@brobridgejs/client` and
`@brobridgejs/adapters` — are released together on one version.

## What brobridge defends, in one page

The full analysis is in [`THREAT-MODEL.md`](./THREAT-MODEL.md), attack by
attack, with the check and the package that enforces each mitigation. The
summary:

**The problem.** A local HTTP listener is reachable by every page the user's
browser loads. Loopback is not a security boundary, and the WebSocket
handshake ignores the same-origin policy. So the bridge's job is not framing
messages — it is making the listener useless to every page except the one the
host process deliberately launched.

**The attackers we defend against.**

- A malicious or compromised web page in the user's browser (the main one).
- A non-browser process on the machine that can send arbitrary HTTP but cannot
  read the host process's memory.
- A LAN peer, only when the operator has explicitly opted into a non-loopback
  bind.

**The defences.**

| Attack | Defence |
| --- | --- |
| DNS rebinding | `Host` must byte-match the bound authority; it is compared, never normalised, so `0x7f.0.0.1`, `2130706433` and `127.0.0.1:07777` are all refused |
| CSRF, cross-origin WebSocket | `Sec-Fetch-Site` refusal, `Origin` allowlist, `SameSite=Strict` cookie — applied to the upgrade as well as to HTTP |
| A non-browser client forging headers | An unguessable credential it cannot obtain: a one-time launch token, then an HMAC session cookie |
| Token leaking via history or `Referer` | Single use, short lived, stripped by a `303`, `Referrer-Policy: no-referrer`, redacted in logs |
| Cookie fixation from another loopback port | The MAC covers the bound authority, so another port's cookie is inert |
| Brute force and timing oracles | Constant-time comparison over fixed-length inputs; rate-limited failures; uniform refusals |
| Session hijack across a resume | Authentication precedes `RESUME`; a `sessionId` is honoured only for the identity that created it |
| Frame flooding, memory exhaustion | Per-stream credit windows, bounded replay buffers, a capped socket write buffer, and a hard frame-size limit checked before any allocation |
| Slowloris on the HTTP surface | Header-block cap and a handshake deadline |

**What is explicitly *not* defended** (see `THREAT-MODEL.md` §8):

- **A same-user local process.** Anything running as the user can read the
  host process's memory and its credentials. This is an OS boundary, not one
  a library can draw.
- **Loopback traffic is plaintext.** The bridge is `http://` on `127.0.0.1` by
  construction.
- **The authenticated tab is still remote code.** brobridge decides *who* may
  talk to the host, not what your handlers do with what they are told.
  Validate arguments in your services exactly as you would for any input.
- **Non-loopback binding weakens several assumptions at once**, which is why
  it requires an explicit flag and always warns.

## For contributors

A change to the server package is reviewed against the twelve invariants in
[`THREAT-MODEL.md`](./THREAT-MODEL.md) §9. The short version: the fence runs
before everything, there is exactly one implementation of it, `Host` is never
normalised, secrets are compared in constant time, every buffer is bounded by
a documented limit, refusals are uniform, and every fixed security bug gains a
regression test.
