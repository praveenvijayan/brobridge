# brobridge threat model

**Status:** Normative. Every mitigation named here is a requirement on the
package and check listed in its "Enforced by" column. A code change that
weakens or relocates a mitigation requires an edit to this document in the same
commit.

Companion document: [`PROTOCOL.md`](./PROTOCOL.md), which specifies the wire
format this document defends.

---

## Contents

1. [What brobridge is, in security terms](#1-what-brobridge-is-in-security-terms)
2. [Assets](#2-assets)
3. [Trust boundaries](#3-trust-boundaries)
4. [Attacker model](#4-attacker-model)
5. [Attack catalogue and mitigations](#5-attack-catalogue-and-mitigations)
6. [The trust fence, precisely](#6-the-trust-fence-precisely)
7. [Authentication, precisely](#7-authentication-precisely)
8. [Residual risks and accepted limitations](#8-residual-risks-and-accepted-limitations)
9. [Security invariants for reviewers](#9-security-invariants-for-reviewers)

---

## 1. What brobridge is, in security terms

A host application (an editor, a CLI, a local agent, a build tool) opens a
listener on the loopback interface and invites *one* browser tab to talk to it.
The listener frequently sits in front of capabilities that are far more
powerful than a normal web origin: a filesystem, a PTY, a package manager, a
credential store.

The defining hazard is that **every web page the user visits can also reach
that listener.** Loopback is not a security boundary in a browser: any page
can `fetch("http://127.0.0.1:7777/…")` or open a WebSocket to it. The browser
alone decides what that page may read back, and for WebSockets it decides
almost nothing. brobridge's job is to make the listener useless to everyone
except the tab the host process deliberately launched.

Everything else — framing, multiplexing, resume — is performance work. This
document is the product.

---

## 2. Assets

| # | Asset | Why it matters | Loss if compromised |
| --- | --- | --- | --- |
| A1 | The host application's exposed capability surface (services registered via `expose()`, stream routes) | This is the real target; brobridge is only the door | Arbitrary use of whatever the host exposed: file reads, command execution, data exfiltration |
| A2 | The one-time launch token (`?bt=…`) | Bearer credential that mints a session | Full A1 access for the holder |
| A3 | The session cookie (`bb_session`) | Bearer credential for every later request | Full A1 access for the holder |
| A4 | The per-instance HMAC key | Signs A3 | Ability to forge unlimited valid sessions |
| A5 | The `sessionId` used for resume | Names a resumable session and its replay buffers | Access to replayed stream content if it were accepted without A3 |
| A6 | Stream payload in flight and in replay buffers | May contain terminal output, file contents, secrets | Disclosure of application data |
| A7 | Host process availability and memory | The host is a user-facing application | Denial of service, OOM kill of the user's editor or agent |

---

## 3. Trust boundaries

```
┌──────────────────────────────────── user's machine ────────────────────────────────────┐
│                                                                                        │
│   ┌───────────────────────────┐                    ┌──────────────────────────────┐    │
│   │  host process             │                    │  browser                     │    │
│   │  (trusted — same user,    │                    │                              │    │
│   │   same privileges)        │                    │  ┌────────────────────────┐  │    │
│   │                           │                    │  │ launched tab           │  │    │
│   │  ┌─────────────────────┐  │   ══ B1 ══════════════▶│ (semi-trusted: holds  │  │    │
│   │  │ exposed services A1 │  │   loopback socket   │  │  A3, but its content  │  │    │
│   │  └─────────────────────┘  │                     │  │  is still remote code)│  │    │
│   │            ▲              │                     │  └────────────────────────┘  │    │
│   │            │              │                     │                              │    │
│   │  ┌─────────┴───────────┐  │                     │  ┌────────────────────────┐  │    │
│   │  │ brobridge server:   │  │   ✗ B2 ✗            │  │ ANY OTHER PAGE         │  │    │
│   │  │ trust fence + auth  │◀─┼─────────────────────┼──│ (untrusted, hostile    │  │    │
│   │  └─────────────────────┘  │   blocked here      │  │  by assumption)        │  │    │
│   └───────────────────────────┘                     │  └────────────────────────┘  │    │
│                  ▲                                  └──────────────────────────────┘    │
│                  │  ✗ B3 ✗  (blocked: loopback bind + fence)                            │
│         ┌────────┴────────┐                                                             │
│         │ other local apps│  (same user — see §8.1)                                     │
│         └─────────────────┘                                                             │
└────────────────────────────────────────────────────────────────────────────────────────┘
                   ▲
                   │  ✗ B4 ✗  (blocked: loopback bind; opt-in only)
          ┌────────┴────────┐
          │  LAN / internet │
          └─────────────────┘
```

| Boundary | Between | Crossing is allowed when |
| --- | --- | --- |
| **B1** | host process <-> launched browser tab | The request passes the trust fence (§6) **and** carries a valid session cookie (§7). This is the only sanctioned crossing. |
| **B2** | host process <-> any other web page in the same browser | Never. This is the primary attack surface. |
| **B3** | host process <-> other local processes owned by the same user | Never through brobridge's authenticated surface; see §8.1 for what is genuinely out of scope. |
| **B4** | host process <-> other machines | Never by default (loopback bind). Only with an explicit non-loopback opt-in, which this document treats as a different, weaker deployment. |

The launched tab is **semi-trusted**: it is authenticated, but it runs code the
host process did not write and did not review. brobridge authenticates *the
tab*; it does not vouch for it. A host application MUST still treat arguments
arriving over the bridge as untrusted input, and MUST NOT expose a capability
it would not expose to the page it loaded.

---

## 4. Attacker model

| ID | Attacker | Capabilities assumed | In scope |
| --- | --- | --- | --- |
| **T1** | **Malicious web page** in the user's browser | Can issue `fetch`/`XMLHttpRequest`/form posts/`<img>`/`<script>` to any loopback address and port; can open `WebSocket` to any of them (no same-origin restriction on the handshake); can read its own responses only if CORS permits; can navigate the user; can read `document.referrer` it receives; can control DNS for a domain it owns | **Yes — primary** |
| **T2** | **Malicious page that also owns a domain** | Everything in T1, plus DNS records with short TTLs pointing at `127.0.0.1` (DNS rebinding) | **Yes — primary** |
| **T3** | **Non-browser local client** (curl, a script, another app) | Can craft arbitrary HTTP: any `Host`, any `Origin`, any `Sec-Fetch-*`, any `Cookie`; not bound by browser rules; can port-scan loopback | **Yes**, with the limits in §8.1 |
| **T4** | **Malicious LAN peer** | Reachable only when the operator has explicitly opted into a non-loopback bind; can reach the port and craft arbitrary HTTP | **Yes, in the opt-in deployment only** |
| **T5** | **Same-user local attacker with process privileges** | Can read the host process's memory, its environment, its files, and can ptrace it | **No — out of scope (§8.1)** |
| **T6** | **Network attacker on the path** | Man-in-the-middle on the wire | **No for loopback** (there is no path). Out of scope for the non-loopback opt-in, which must be tunnelled by the operator (§8.3) |
| **T7** | **Malicious dependency in the host application** | Runs in-process | **No — out of scope**; brobridge's zero-runtime-dependency rule for `core` and `client` limits brobridge's own contribution to this risk |

---

## 5. Attack catalogue and mitigations

"Enforced by" names the package and the specific check. Every row is a required
test case.

### 5.1 DNS rebinding (T2)

**Attack.** The user visits `evil.test`, whose DNS answer briefly points at the
attacker's server and then at `127.0.0.1` with a 1-second TTL. The page then
issues same-origin requests to `http://evil.test:7777/rpc`. The browser now
connects to the host process while believing the origin is `evil.test`, so the
same-origin policy hands the attacker the response body. This defeats CORS
entirely, because from the browser's point of view no cross-origin request was
ever made.

**Mitigation.** The `Host` header must **byte-match** the authority the server
bound to. `evil.test:7777` is not `127.0.0.1:7777`, so the request is refused
before any handler, any route lookup, any body read, and any authentication
work.

**Enforced by.** `brobridge` (server) — `trust.ts`, exact-authority `Host`
check, applied to every request including the WebSocket upgrade, before
routing. Refusal: `403`, no body detail.

---

### 5.2 `Host` header normalisation bypass (T2, T3)

**Attack.** Defeat a naive `Host` comparison with a spelling that a parser
treats as loopback but a string comparison does not: `0x7f.0.0.1`,
`0177.0.0.1`, `2130706433`, `127.0.0.1.` (trailing dot), `127.000.000.001`,
`127.0.0.1:07777` (zero-padded port), `user@127.0.0.1:7777` (embedded
userinfo), `[::ffff:127.0.0.1]`, `localhost` where `127.0.0.1` was bound, or a
duplicated `Host` header where the front and back of a proxy pair disagree.

**Mitigation.** Reject rather than normalise. The check is: the `Host` header
must appear **exactly once**, must contain no userinfo, and must be
byte-identical to the bound authority string. Any value that a WHATWG URL parse
would rewrite — different case, alternate radix, zero padding, trailing dot,
IPv4-mapped IPv6 — is refused even when it parses to the right address. An
absolute-form request line (`GET http://host/path HTTP/1.1`) is refused
outright.

**Enforced by.** `brobridge` — `trust.ts`, `assertExactAuthority()`; duplicate
header detection in the raw-header inspection that precedes it. `localhost` is
accepted only when the server bound to `localhost` and only as the exact bound
string.

---

### 5.3 Cross-site request forgery against the bridge (T1)

**Attack.** A page the user is visiting issues `POST http://127.0.0.1:7777/rpc`
with a credentialled request, relying on the cookie riding along. Even without
reading the response, the side effect alone (delete a file, run a command) is
the win.

**Mitigation.** Three independent layers, all required:

1. `SameSite=Strict` on the session cookie: the browser does not attach it to
   any request initiated from another site.
2. `Sec-Fetch-Site` must be `same-origin` or `none`; `cross-site` and
   `same-site` are refused. Browsers set this header and pages cannot forge it.
3. `Origin`, when present, must be in the allowlist (by default, exactly the
   bound authority).

Layer 1 makes the request unauthenticated; layers 2 and 3 refuse it before
authentication is even consulted.

**Enforced by.** `brobridge` — `auth.ts` (cookie attributes, exact string
`HttpOnly; SameSite=Strict; Path=/`) and `trust.ts` (`Sec-Fetch-Site` and
`Origin` checks).

---

### 5.4 Cross-origin WebSocket (T1)

**Attack.** The same-origin policy does not apply to the WebSocket handshake. A
malicious page can open `ws://127.0.0.1:7777/ws` and, if the server accepts,
read and write freely — the strongest version of 5.3.

**Mitigation.** The trust fence runs on the **upgrade request** exactly as on
any other request: `Host`, `Sec-Fetch-Site`, `Origin` allowlist, and a valid
session cookie. An upgrade that fails any check is answered with an HTTP error
and the socket is destroyed; the server MUST NOT complete the handshake and
then close, because a completed handshake is already an authenticated channel
from the page's point of view.

**Enforced by.** `brobridge` — upgrade handler calls the same `trust.ts` and
`auth.ts` entry points as the HTTP path; a test asserts the upgrade path and
the request path share one implementation, not two.

---

### 5.5 `Origin` spoofing by a non-browser client (T3)

**Attack.** `curl -H 'Origin: http://127.0.0.1:7777' -H 'Sec-Fetch-Site: same-origin'`
sends whatever headers make the fence happy. Header-based checks are advisory
against a non-browser client by construction.

**Mitigation.** Accepted and designed around: header checks are **not** the
authentication mechanism. They exist to stop browsers, which cannot lie about
`Sec-Fetch-Site` or `Origin`. Against T3 the defence is the unguessable
credential: a request must present the one-time launch token or a valid
HMAC-signed session cookie (§7). A missing `Origin` is therefore *allowed*
(non-browser clients legitimately omit it) while a *wrong* `Origin` is refused
— the reverse policy would block legitimate CLI clients while doing nothing
against an attacker who simply omits the header.

**Enforced by.** `brobridge` — `trust.ts` (absent `Origin` allowed, mismatched
`Origin` refused) plus `auth.ts` (credential required regardless).

---

### 5.6 Launch-token leakage via URL, history and `Referer` (T1, T3)

**Attack.** The launch token is delivered as `?bt=…` in a URL the user opens.
That URL lands in browser history, in the address bar, in session restore, in
shell history where the URL was printed, and — if the page later links or
loads a sub-resource off-origin — in the `Referer` header. Any of these hands
A2 to an attacker.

**Mitigation.**

- The token is **one-time**: the first valid presentation burns it atomically,
  and a second presentation is refused with `403`. A leaked token from history
  is already spent.
- The bootstrap response is a **`303 See Other` to the same path without the
  query**, so the token-bearing URL is replaced in the history entry rather
  than kept.
- Every served response carries `Referrer-Policy: no-referrer`, so the token
  cannot escape in a `Referer` header even before the redirect lands.
- Responses also carry `Cache-Control: no-store` so the token-bearing response
  is not written to disk cache.
- The token has a short validity window (`launchTokenTtlMs`, default 120 s) after
  which it is refused even if unused.
- The token is never logged: it is redacted in every diagnostic path, and the
  client strips it from the URL it retains and never re-sends it.

**Enforced by.** `brobridge` — `auth.ts` (single-use burn, TTL, constant-time
compare), bootstrap handler (`303` + `Referrer-Policy` + `Cache-Control`
headers). `@brobridgejs/client` — token stripped from retained state after the
single bootstrap fetch; a test asserts the token appears in no retained field
and in no later request.

---

### 5.7 Token brute force and timing oracles (T1, T3)

**Attack.** Guess the token or the cookie MAC, or extract it a byte at a time
from comparison timing.

**Mitigation.** Token and MAC key are >= 128 bits of CSPRNG output. All
comparisons of secret material use a constant-time algorithm over
fixed-length inputs. Authentication failures are rate limited per remote
address (fixed window, `authFailuresPerWindow` / `authFailureWindowMs`,
default 20 failures per 60 s, then `429` with
`Retry-After`), which also bounds an online guessing attack to an irrelevant
rate. Failure responses are uniform: the same status and body whether the
credential was absent, malformed or wrong.

**Enforced by.** `brobridge` — `auth.ts`, `timingSafeEqual`-style comparison
and the failure limiter. A test asserts no `===` comparison of secret material
exists on the auth path.

---

### 5.8 Cookie fixation and the loopback cookie jar (T1, T3)

**Attack.** Cookies are **not isolated by port**: every page and every local
service on `127.0.0.1`, whatever the port, shares one cookie jar for that host.
A hostile page (or another local service on a different port) can set
`bb_session=…` for `127.0.0.1` and thereby overwrite or pre-set the cookie the
bridge will see.

**Mitigation.** The cookie is not a bearer name, it is a **MAC over the
session's identity bound to the exact authority**, keyed by a secret generated
per server instance and never persisted. An attacker can write any cookie
value; none of them verify. The server therefore treats an unverifiable cookie
exactly as an absent one. Session identity inside the MAC includes the bound
authority, so a cookie minted by a bridge on another port fails verification
here.

The residual effect — a hostile local writer can *overwrite* the legitimate
cookie and break the user's session — is a denial of service against a local
application by a process that already runs locally. See §8.1.

The cookie is named for the port (`bb_session_<port>`) so that the jar's
port-blindness does not turn *cooperating* bridges into that hostile writer.
A host application that runs several bridges on one loopback host — a launcher
and the applications it starts — would otherwise see each one's bootstrap
overwrite the last one's cookie and log its tab out. Distinct names sit side by
side in the jar; the MAC still refuses each bridge's cookie everywhere else.

**Enforced by.** `brobridge` — `auth.ts`, MAC covers `{sessionId, authority,
issuedAt}`; per-instance key from `crypto.getRandomValues`; a test mints a
cookie under a different authority and asserts `403`.

---

### 5.9 Replay and session hijack across resume (T1, T3)

**Attack.** Reconnect with a captured or guessed `sessionId` and use `RESUME`
to be handed the replay buffer of somebody else's streams (A5 -> A6), or replay
a captured `RESUME` to re-receive data.

**Mitigation.** `RESUME` is **not** a credential path. The reconnecting request
passes the identical trust fence and cookie authentication as a first
connection *before* a single protocol frame is read; only then is
`RESUME.sessionId` consulted, and it is accepted only when it belongs to the
session the cookie authenticated. A `sessionId` from a different session is
answered `RESUME_FAIL { SESSION_UNKNOWN }` and is indistinguishable from a
session that never existed. Sessions expire (`sessionTtlMs`, default 60 s after
last disconnect) and `sessionId` values are >= 128-bit CSPRNG output, never
reused.

Data replay is bounded by design: the replay buffer only ever re-sends frames
to the same authenticated session, and the receiver discards `seq <= lastSeq`
(`PROTOCOL.md` §9.1), so a duplicate delivery cannot reach the consumer twice.

**Enforced by.** `brobridge` — upgrade path authenticates before frame
processing; session store keys the replay buffers by authenticated session.
`@brobridgejs/core` — `resume.ts`, `seq <= lastSeq` discard rule.

---

### 5.10 Frame flooding and memory exhaustion (T1 post-auth, T3, T4)

**Attack.** An authenticated but hostile peer (a compromised tab counts) opens
thousands of streams, sends maximum-size frames with no consumer, declares a
huge `length` to make the server allocate, or ignores credit entirely — driving
the host process to OOM (A7).

**Mitigation.** Every buffer in the system is bounded, and the bounds are
protocol-level, not best effort:

| Vector | Bound |
| --- | --- |
| Oversized frame | `length > maxFrameSize` (16 MiB) refused **before allocation**; the decoder never sizes a buffer from an unvalidated `length` |
| Stream count | `maxStreams` (1024) enforced on `OPEN`; excess refused with `STREAM_LIMIT_EXCEEDED` |
| Undelivered payload | Per-stream credit window (`initialCredit`, 64 KiB); a peer exceeding it gets a stream-level `FLOW_CONTROL_ERROR` and teardown, the connection survives |
| Repeated abuse | `maxFlowViolations` (8) violations on one connection escalates to connection-level error and close |
| Replay buffers | Ring bounded by **both** 1 MiB and 256 frames per stream, evicting oldest |
| Decoder reassembly | A partial frame's buffered bytes count against `maxFrameSize`; a peer dribbling a never-completed frame is bounded and subject to the idle timeout |
| Slow socket | The server respects carrier backpressure (`bufferedAmount` / drain) instead of queueing unboundedly in userspace |

**Enforced by.** `@brobridgejs/core` — `codec.ts` (frame size, pre-allocation
check), `mux.ts` (stream limit, credit accounting, violation counter),
`resume.ts` (ring bounds). `brobridge` — carrier backpressure in the socket
pump.

---

### 5.11 Slowloris and handshake resource exhaustion on the HTTP surface (T1, T3, T4)

**Attack.** Open many sockets and send request headers one byte at a time, or
send an endless header block, or connect and never send anything — holding
server sockets and memory until the host process is unusable.

**Mitigation.** `maxHeaderBytes` (16 KiB) caps the header block;
`handshakeTimeoutMs` (10 s) caps the time from connection to a complete request
line plus headers, and separately caps the time from WebSocket upgrade to
`HELLO`. Idle established connections are reaped by the heartbeat timeout
(`heartbeatTimeoutMs`, 45 s). Because the listener is loopback-only by default,
the attacker set for this is limited to T1 and T3.

**Enforced by.** `brobridge` — server construction sets `maxHeaderBytes` and
`requestTimeout`/`headersTimeout` equivalents on both the Node and Bun
backends; a `HELLO` deadline timer in the upgrade handler.

---

### 5.12 Non-loopback exposure (T4)

**Attack.** The operator binds `0.0.0.0` for convenience; every machine on the
network can now reach a service designed for a single tab, over plaintext.

**Mitigation.** The default bind is `127.0.0.1`. A non-loopback bind requires
an explicit opt-in option (not a truthy default, not an environment variable
alone) and emits a prominent warning naming the exposure. The trust fence and
authentication do not weaken in this mode, but §8.3 records what the operator
now owns.

**Enforced by.** `brobridge` — option validation at `createBridge()`; a test
asserts a non-loopback host without the opt-in throws.

---

### 5.13 Path handling on the served surface (T1, T3)

**Attack.** Request `GET /../../etc/passwd`, or an encoded variant, against
whatever static assets the host application serves through the bridge.

**Mitigation.** The bridge's own routes are an exact-match set (`/`, `/ws`,
`/rpc`); anything else is `404` without touching the filesystem. brobridge
serves no files from disk by default. A host application that adds static
serving owns that surface and is told so in the README.

**Enforced by.** `brobridge` — exact-match router; no filesystem read on the
default route table.

---

### 5.14 Information leakage in errors and logs (T1 post-auth, T3)

**Attack.** Harvest tokens, MAC values, absolute paths or internal state from
error responses, `ERROR` frames or server logs.

**Mitigation.** Authentication failures return a uniform status and body.
`ERROR` frame messages MUST NOT contain token, cookie or MAC material
(`PROTOCOL.md` §12). Diagnostic output redacts the `bt` query parameter and any
`Cookie`/`Set-Cookie` header value. Internal exception detail is not forwarded
to a browser peer; it is reduced to `INTERNAL_ERROR`.

**Enforced by.** `brobridge` — a redaction helper on the logging path and a
test that feeds a token-bearing URL through it. `@brobridgejs/core` — error
construction never embeds a payload it did not itself produce.

---

## 6. The trust fence, precisely

The fence is a pure function — request-like in, verdict out — so it is testable
without sockets, and it is the **single** implementation used by the HTTP path,
the WebSocket upgrade path and the `POST /rpc` fallback.

Evaluation order (first failure wins; every failure is refused before any
routing, body read or authentication work):

1. **Request line form.** Absolute-form or authority-form request line -> refuse.
2. **`Host` present exactly once.** Zero or two or more -> refuse.
3. **`Host` has no userinfo.** Contains `@` -> refuse.
4. **`Host` byte-matches the bound authority.** Any other value -> refuse,
   including values that would parse to the same address.
5. **`Sec-Fetch-Site`.** Present and not `same-origin` or `none` -> refuse.
   (Absent is allowed: non-browser clients omit it, and browsers that send it
   cannot forge it.)
6. **`Origin`.** Present and not in the allowlist -> refuse. Absent -> allowed.
   Default allowlist: exactly the bound authority's origin.
7. **`Sec-Fetch-Mode` / `Sec-Fetch-Dest`** on the upgrade: a WebSocket upgrade
   must present `Sec-Fetch-Mode: websocket` when `Sec-Fetch-*` headers are
   present at all.

Refusal is `403` with an empty body and no detail about which check failed.
The verdict type distinguishes the failing check internally for tests and
diagnostics, and that detail never reaches the wire.

### 6.1 What each runtime can show the fence

The fence is one function, but the two backends can feed it different amounts
of evidence, and the difference is worth stating rather than assuming away:

| Evidence | Node | Bun |
| --- | --- | --- |
| Raw request-line form (check 1) | Yes — `req.url` keeps the absolute form, and `CONNECT` is refused on its own event | No — `Bun.serve` hands a Fetch `Request` whose URL is already absolute, so the origin form is reconstructed |
| Duplicate `Host` (check 2) | Yes — raw headers preserve both, and Node's own parser rejects most cases first | Partly — `Headers` joins duplicates into `a, b`, which the fence refuses as a multi-valued `Host` |
| Every other check | Yes | Yes |

Nothing in that table is a hole: a duplicated or rebound `Host` fails the
byte-exact authority comparison whichever spelling reaches it, and no request
of any form reaches a route without a credential. It does mean the
absolute-form refusal is a Node-side defence in depth rather than a
cross-runtime guarantee, and a change to Bun's request handling should be
re-checked against this table.

---

## 7. Authentication, precisely

### 7.1 Bootstrap

1. `createBridge()` generates a launch token (>= 128 bits, CSPRNG) and an HMAC
   key (>= 256 bits, CSPRNG, per instance, memory only, never written to disk).
2. `.url` is `http://<authority>/?bt=<token>`. The host application shows or
   opens it.
3. The first request presenting a valid, unburned, unexpired token — and only
   after passing the fence — burns it atomically, mints a session, and answers
   `303 See Other` with `Location: /`,
   `Set-Cookie: bb_session_<port>=<value>; HttpOnly; SameSite=Strict; Path=/`,
   `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
4. Any later presentation of that token is refused `403`.

The cookie is not marked `Secure`: the bootstrap URL is `http://` on loopback,
and a `Secure` cookie is not universally set over plaintext `http://127.0.0.1`.
The compensating control is that the cookie's value is a MAC that is worthless
without the per-instance key, and loopback traffic has no network path to
observe (§8.2).

### 7.2 Session cookie

Value: `<sessionId>.<issuedAt>.<base64url(HMAC-SHA256(key, sessionId || "\0" ||
authority || "\0" || issuedAt))>`.

Verification: parse into exactly three parts; recompute the MAC over the
presented `sessionId`, the server's **own** bound authority and the presented
`issuedAt`; compare in constant time; then check `issuedAt` is within
`sessionCookieTtlMs` and that the server still recognises the session. Any
failure is treated as "no credential" — same status, same body, same timing
class.

`sessionCookieTtlMs` (default 8 hours) is **not** `sessionTtlMs`
(`PROTOCOL.md` §13, default 60 s). The latter is how long a *protocol*
session's replay state survives a disconnect; the former is how long the tab
stays authenticated. A tab that idles for ten minutes must still be able to
reconnect — it simply cannot resume its streams. Conflating the two would
expire the credential of every idle tab a minute after it went quiet.

Binding the authority into the MAC is what makes a cookie planted by a
different loopback port (§5.8) inert here.

### 7.3 Where it applies

Every request: the bootstrap route (token **or** cookie), `GET /ws` upgrade
(cookie), `POST /rpc` (cookie). There is no unauthenticated route that reaches
application code. A health or version endpoint, if ever added, is a change to
this document first.

---

## 8. Residual risks and accepted limitations

### 8.1 A same-user local process is not defended against

T5 is out of scope, and it must be, honestly: a process running as the same
user can read the host process's memory (and therefore A2, A3 and A4 directly),
read its files, and attach a debugger. No token scheme survives that. What
brobridge *does* defend against, and tests for, is the weaker T3 case — an
unprivileged local script that can only speak HTTP to the port. That attacker
gets nothing without the credential.

The corollary in §5.8 stands: a hostile same-user process can degrade the
session by writing cookies into the shared loopback jar. That is a denial of
service by an attacker who could also simply kill the host process.

### 8.2 Loopback traffic is unencrypted

Frames on `127.0.0.1` are plaintext. This is deliberate: TLS on loopback buys
nothing against the attackers in scope (there is no path to observe, and T5
already wins), and costs throughput on the PTY-firehose workload brobridge
exists to make fast. It does mean any tooling that can capture loopback traffic
— which requires elevated privileges — sees A6.

### 8.3 The non-loopback opt-in weakens several assumptions at once

Binding a non-loopback interface (§5.12) simultaneously: adds T4 to the
attacker set, makes §8.2's "no path to observe" false, and exposes the
handshake surface of §5.11 to the network. The fence and authentication still
apply, but the operator owns transport confidentiality (a tunnel or a reverse
proxy terminating TLS) and network-level access control. brobridge warns; it
does not pretend the deployment is equivalent.

### 8.4 The authenticated tab is still remote code

brobridge authenticates the tab, not the JavaScript running in it. A compromised
dependency in the host application's own front-end inherits the full session.
The exposed capability surface (A1) is the host application's decision and its
responsibility; brobridge's README states this plainly rather than implying
that authentication makes an exposed capability safe.

### 8.5 Browsers without `Sec-Fetch-*`

`Sec-Fetch-Site` has been broadly supported for years, but a browser that omits
it falls back to the `Origin` allowlist, `SameSite=Strict` and the cookie —
which is precisely the T3 posture, and is still credential-gated. No route
becomes reachable without a credential.

---

## 9. Security invariants for reviewers

These are the statements a change must not break. A pull request touching the
server package is reviewed against this list.

1. **No route reaches application code without a valid credential.** Not a
   health check, not a favicon, not an error page.
2. **The fence runs before everything.** Before routing, before body reads,
   before authentication, before any allocation proportional to the request.
3. **One fence implementation.** The HTTP path, the upgrade path and the
   fallback path call the same function. A second copy is a defect.
4. **`Host` is compared, never normalised.** Normalisation is the bug class
   in §5.2.
5. **Secrets are compared in constant time**, over fixed-length inputs, and
   never with `===`.
6. **The launch token is single-use, short-lived, redacted in logs, and
   stripped from the URL** by both the `303` and the client.
7. **The MAC covers the bound authority**, so a cookie from another port or
   another instance is inert.
8. **Authentication precedes `RESUME`**, and `sessionId` is only honoured for
   the session the cookie authenticated.
9. **Every buffer is bounded** by a documented limit from `PROTOCOL.md` §13,
   and no buffer is sized from an unvalidated `length`.
10. **Failures are uniform**: same status, same body, no oracle distinguishing
    absent, malformed and wrong credentials.
11. **Non-loopback binding requires an explicit opt-in** and warns.
12. **Every row in §5 has a test**, and every fixed security bug gains a
    regression test.
