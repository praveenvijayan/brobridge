/**
 * The trust fence.
 *
 * Loopback is not a security boundary in a browser: every page the user
 * visits can reach this listener. The fence is what makes the listener
 * useless to everyone except the tab the host process deliberately launched.
 *
 * It is a pure function — request-like in, verdict out — for two reasons.
 * It is unit-testable without sockets, and it is the *single* implementation
 * used by the served route, the WebSocket upgrade and the `POST /rpc`
 * fallback. A second copy would be a defect (`THREAT-MODEL.md` §9 invariant
 * 3).
 *
 * @see THREAT-MODEL.md §6 "The trust fence, precisely"
 */

/**
 * One raw header as it appeared on the wire: name as sent, value unparsed.
 *
 * Raw pairs rather than a map, because duplicate-`Host` detection
 * (`THREAT-MODEL.md` §5.2) is impossible once a runtime has collapsed
 * duplicates — Node keeps the first and drops the rest, and the Fetch
 * `Headers` type joins them with a comma.
 */
export type RawHeader = readonly [name: string, value: string];

/** What the fence needs to know about a request. */
export interface FenceRequest {
  /**
   * The request target exactly as it appeared on the request line, before
   * any parsing: `/ws`, `/rpc`, `http://host/ws` for the absolute form.
   */
  readonly target: string;
  /** Raw headers in wire order. */
  readonly rawHeaders: readonly RawHeader[];
  /** True when this request is a WebSocket upgrade attempt. */
  readonly upgrade?: boolean;
}

/** Which check refused a request. Diagnostic only; never reaches the wire. */
export type FenceCheck =
  | 'request-line'
  | 'host-count'
  | 'host-userinfo'
  | 'host-mismatch'
  | 'sec-fetch-site'
  | 'origin'
  | 'sec-fetch-mode';

/** The fence's answer. */
export type FenceVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** Which rule refused it, for tests and local diagnostics. */
      readonly check: FenceCheck;
      /** Human-readable reason. Local diagnostics only — never sent. */
      readonly detail: string;
    };

/** Configuration the fence compares requests against. */
export interface FencePolicy {
  /**
   * The authority the server bound to, as the exact string a legitimate
   * client will send: `127.0.0.1:7777`, `[::1]:7777`, `localhost:7777`.
   */
  readonly authority: string;
  /**
   * Origins allowed to reach the bridge. Defaults to exactly the bound
   * authority's origin. An absent `Origin` is always allowed — see
   * `THREAT-MODEL.md` §5.5.
   */
  readonly allowedOrigins: readonly string[];
}

/** `Sec-Fetch-Site` values that are not a cross-document request. */
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none']);

/** The refusal every failed check produces on the wire: `403`, no body. */
export const FENCE_REFUSAL_STATUS = 403;

const OK: FenceVerdict = { ok: true };

/**
 * Apply the fence.
 *
 * Evaluation order matches `THREAT-MODEL.md` §6: first failure wins, and
 * every failure is decided before routing, before any body read and before
 * any authentication work.
 *
 * The `Host` value is **compared, never normalised**. Normalisation is the
 * bug class in §5.2: `0x7f.0.0.1`, `0177.0.0.1`, `2130706433`, `127.0.0.1.`,
 * `127.000.000.001` and `127.0.0.1:07777` all parse to the bound address and
 * are all refused.
 */
export function checkRequest(request: FenceRequest, policy: FencePolicy): FenceVerdict {
  // 1. Request-line form. An absolute-form or authority-form target lets a
  //    request carry an authority that disagrees with `Host`; refuse rather
  //    than pick a winner.
  const target = request.target;
  if (!target.startsWith('/')) {
    return refuse('request-line', `request target ${JSON.stringify(target)} is not origin-form`);
  }

  // 2. `Host` exactly once. Two disagreeing values are the classic
  //    front-end/back-end split (THREAT-MODEL.md §5.2).
  const hosts = collect(request.rawHeaders, 'host');
  if (hosts.length === 0) return refuse('host-count', 'no Host header');
  if (hosts.length > 1) return refuse('host-count', `${String(hosts.length)} Host headers`);
  const host = hosts[0] as string;
  // A runtime that already joined duplicates hands us `a, b`; that is the
  // same attack arriving through a different door.
  if (host.includes(',')) return refuse('host-count', 'Host header carries multiple values');

  // 3. No userinfo. `user@127.0.0.1:7777` is a different authority wearing
  //    the right one's clothes.
  if (host.includes('@')) return refuse('host-userinfo', 'Host header contains userinfo');

  // 4. Byte-identical to the bound authority.
  if (host !== policy.authority) {
    return refuse('host-mismatch', `Host ${JSON.stringify(host)} is not the bound authority`);
  }

  // 5. `Sec-Fetch-Site`. Browsers set it and pages cannot forge it; absent is
  //    allowed because non-browser clients legitimately omit it and are
  //    stopped by the credential instead (THREAT-MODEL.md §5.5).
  const site = single(request.rawHeaders, 'sec-fetch-site');
  if (site !== undefined && !ALLOWED_FETCH_SITES.has(site)) {
    return refuse('sec-fetch-site', `Sec-Fetch-Site: ${site}`);
  }

  // 6. `Origin` allowlist. Present and unknown -> refuse; absent -> allowed.
  const origin = single(request.rawHeaders, 'origin');
  if (origin !== undefined && origin !== 'null' && !policy.allowedOrigins.includes(origin)) {
    return refuse('origin', `Origin ${JSON.stringify(origin)} is not allowed`);
  }
  if (origin === 'null') return refuse('origin', 'opaque Origin');

  // 7. A WebSocket upgrade from a browser must say so. Checked only when the
  //    client sends `Sec-Fetch-*` at all, so a non-browser client that sends
  //    none of them is not required to invent one.
  if (request.upgrade === true && site !== undefined) {
    const mode = single(request.rawHeaders, 'sec-fetch-mode');
    if (mode !== undefined && mode !== 'websocket') {
      return refuse('sec-fetch-mode', `Sec-Fetch-Mode: ${mode} on an upgrade`);
    }
  }

  return OK;
}

/** Every value sent under `name`, lowercased comparison, trimmed values. */
function collect(headers: readonly RawHeader[], name: string): string[] {
  const out: string[] = [];
  for (const [key, value] of headers) {
    if (key.toLowerCase() === name) out.push(value.trim());
  }
  return out;
}

/**
 * The single value sent under `name`.
 *
 * A repeated header is reported as its joined form, which fails every
 * equality check it feeds — the conservative answer for a header that should
 * not repeat.
 */
function single(headers: readonly RawHeader[], name: string): string | undefined {
  const values = collect(headers, name);
  if (values.length === 0) return undefined;
  if (values.length === 1) return values[0] as string;
  return values.join(',');
}

function refuse(check: FenceCheck, detail: string): FenceVerdict {
  return { ok: false, check, detail };
}

/**
 * The origin string for an authority, as a browser would send it.
 *
 * The bridge is `http://` on loopback by construction (`THREAT-MODEL.md`
 * §8.2), so the scheme is not a parameter.
 */
export function originOf(authority: string): string {
  return `http://${authority}`;
}

/**
 * Format the authority for a bound address, quoting IPv6 the way a URL does.
 */
export function formatAuthority(host: string, port: number): string {
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${bracketed}:${String(port)}`;
}
