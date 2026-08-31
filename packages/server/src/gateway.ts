/**
 * The request pipeline both runtimes share.
 *
 * Node and Bun differ in how bytes arrive; they must not differ in what is
 * allowed through. Every request from either backend — served route, `POST
 * /rpc`, and the WebSocket upgrade — is decided here, in this order:
 *
 * 1. the trust fence (`trust.ts`),
 * 2. the authentication failure limiter,
 * 3. the credential: launch token or session cookie (`auth.ts`),
 * 4. routing.
 *
 * Nothing downstream of step 3 runs for a caller without a credential, and
 * nothing downstream of step 1 runs for a caller the fence refused — not
 * routing, not a body read, not an allocation proportional to the request
 * (`THREAT-MODEL.md` §9 invariants 1 and 2).
 */
import type { AuthGuard } from './auth.js';
import { LAUNCH_TOKEN_PARAM } from './auth.js';
import type { RawHeader } from './trust.js';
import { FENCE_REFUSAL_STATUS, checkRequest } from './trust.js';

/** A request, reduced to what the pipeline needs. Both runtimes produce this. */
export interface GatewayRequest {
  readonly method: string;
  /** The request target exactly as it appeared on the request line. */
  readonly target: string;
  /** Raw headers in wire order, duplicates preserved. */
  readonly rawHeaders: readonly RawHeader[];
  /** Remote address, for the failure limiter. */
  readonly remote: string;
  /** True when the request asks to become a WebSocket. */
  readonly upgrade: boolean;
}

/** A response the runtime is to write verbatim. */
export interface GatewayResponse {
  readonly status: number;
  readonly headers: readonly RawHeader[];
  readonly body: Uint8Array | null;
}

/** What the pipeline decided. */
export type GatewayDecision =
  | { readonly kind: 'respond'; readonly response: GatewayResponse }
  /** Complete the WebSocket handshake and bind it to this authenticated session. */
  | { readonly kind: 'upgrade'; readonly authSessionId: string }
  /** Read the body (bounded by `maxRpcBodyBytes`) and call {@link Gateway.rpc}. */
  | { readonly kind: 'rpc'; readonly authSessionId: string };

/** What the gateway needs from the bridge around it. */
export interface GatewayConfig {
  readonly authority: string;
  readonly allowedOrigins: readonly string[];
  readonly auth: AuthGuard;
  readonly index: { readonly body: Uint8Array; readonly contentType: string } | null;
}

/**
 * Headers every response carries.
 *
 * `no-referrer` keeps a launch token out of a `Referer` even before the `303`
 * lands; `no-store` keeps the token-bearing response out of the disk cache
 * (`THREAT-MODEL.md` §5.6).
 */
const BASE_HEADERS: readonly RawHeader[] = [
  ['Referrer-Policy', 'no-referrer'],
  ['Cache-Control', 'no-store'],
  ['X-Content-Type-Options', 'nosniff'],
];

/** The bridge's entire route table. Anything else is `404`, untouched by disk. */
const ROUTES = new Set(['/', '/ws', '/rpc']);

/** The uniform refusal: one status, one empty body, no hint about which check failed. */
function refusal(status: number, extra: readonly RawHeader[] = []): GatewayResponse {
  return { status, headers: [...BASE_HEADERS, ...extra, ['Content-Length', '0']], body: null };
}

/** Decides every request, for both runtimes. */
export class Gateway {
  readonly #config: GatewayConfig;

  constructor(config: GatewayConfig) {
    this.#config = config;
  }

  /**
   * Run the pipeline.
   *
   * The verdict detail from the fence and the reason from the credential
   * check stay inside this method: what leaves is a status and, for a
   * refusal, an empty body.
   */
  async handle(request: GatewayRequest): Promise<GatewayDecision> {
    const verdict = checkRequest(
      { target: request.target, rawHeaders: request.rawHeaders, upgrade: request.upgrade },
      { authority: this.#config.authority, allowedOrigins: this.#config.allowedOrigins },
    );
    if (!verdict.ok) return respond(refusal(FENCE_REFUSAL_STATUS));

    const rate = this.#config.auth.checkRate(request.remote);
    if (rate.limited) {
      return respond(refusal(429, [['Retry-After', String(rate.retryAfterSeconds)]]));
    }

    const { path, query } = splitTarget(request.target);
    const cookie = header(request.rawHeaders, 'cookie');
    const session = await this.#config.auth.verifyCookie(cookie);

    // The bootstrap is the only route a caller may reach without a cookie, and
    // only by presenting the launch token.
    const token = query.get(LAUNCH_TOKEN_PARAM);
    if (path === '/' && token !== null && !session.ok) {
      const redeemed = this.#config.auth.redeemToken(token);
      if (!redeemed.ok) {
        this.#config.auth.noteFailure(request.remote);
        return respond(refusal(FENCE_REFUSAL_STATUS));
      }
      return respond({
        status: 303,
        headers: [
          ...BASE_HEADERS,
          ['Location', '/'],
          ['Set-Cookie', await this.#config.auth.cookieFor(redeemed.sessionId)],
          ['Content-Length', '0'],
        ],
        body: null,
      });
    }

    if (!session.ok) {
      this.#config.auth.noteFailure(request.remote);
      return respond(refusal(FENCE_REFUSAL_STATUS));
    }

    // An authenticated caller that still carries the token in its URL is sent
    // to the same path without it, so the token-bearing entry leaves history.
    if (path === '/' && token !== null) {
      return respond({
        status: 303,
        headers: [...BASE_HEADERS, ['Location', '/'], ['Content-Length', '0']],
        body: null,
      });
    }

    if (!ROUTES.has(path)) return respond(refusal(404));

    if (path === '/ws') {
      if (request.method !== 'GET') return respond(refusal(405));
      if (!request.upgrade) return respond(refusal(426, [['Upgrade', 'websocket']]));
      return { kind: 'upgrade', authSessionId: session.sessionId };
    }

    if (path === '/rpc') {
      if (request.method !== 'POST') return respond(refusal(405));
      return { kind: 'rpc', authSessionId: session.sessionId };
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') return respond(refusal(405));
    const index = this.#config.index;
    if (index === null) return respond(refusal(404));
    return respond({
      status: 200,
      headers: [
        ...BASE_HEADERS,
        ['Content-Type', index.contentType],
        ['Content-Length', String(index.body.length)],
      ],
      body: request.method === 'HEAD' ? null : index.body,
    });
  }

  /**
   * The uniform refusal, for the few cases a backend decides on its own: a
   * body over the limit, a request too malformed to reach the fence, or a
   * request that arrived before the gateway was armed.
   *
   * One builder, so a refusal written by the Node backend and one written by
   * the Bun backend cannot come to differ.
   */
  static refuse(status: number, extra: readonly RawHeader[] = []): GatewayResponse {
    return refusal(status, extra);
  }
}

function respond(response: GatewayResponse): GatewayDecision {
  return { kind: 'respond', response };
}

/** Split a request target into its path and its query parameters. */
export function splitTarget(target: string): { path: string; query: URLSearchParams } {
  const cut = target.indexOf('?');
  if (cut < 0) return { path: decodePath(target), query: new URLSearchParams() };
  return {
    path: decodePath(target.slice(0, cut)),
    query: new URLSearchParams(target.slice(cut + 1)),
  };
}

/**
 * Percent-decode a path for route matching.
 *
 * The route table is an exact-match set and nothing here reaches the
 * filesystem (`THREAT-MODEL.md` §5.13), so a path that fails to decode simply
 * matches nothing.
 */
function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** The first value sent under `name`, case-insensitively. */
export function header(headers: readonly RawHeader[], name: string): string | undefined {
  for (const [key, value] of headers) {
    if (key.toLowerCase() === name) return value.trim();
  }
  return undefined;
}
