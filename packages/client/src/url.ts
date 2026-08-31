/**
 * URL handling and the token bootstrap.
 *
 * The launch token is a credential that arrives in a URL, which is the worst
 * place a credential can be: URLs land in history, in `Referer`, in logs.
 * `PROTOCOL.md` §6 has the server burn it on first use and answer with a
 * redirect that drops it; this module is the client half of that hygiene.
 *
 * The rules here are absolute:
 *
 * - the token is read once, from the URL handed to {@link connect}, and lives
 *   only as an argument on the stack;
 * - it is sent on exactly one request, the bootstrap;
 * - nothing the bridge retains — `bridge.url`, an error message, an event —
 *   ever contains it.
 *
 * @see THREAT-MODEL.md §5.6 "Token leakage"
 */
import { BridgeClientError } from './errors.js';
import type { FetchLike } from './types.js';

/** The query parameter the server mints the one-time launch token into. */
export const LAUNCH_TOKEN_PARAM = 'bt';

/** A bridge URL split into the parts the client keeps and the part it burns. */
export interface BridgeTarget {
  /** The origin, with no path, query or token. This is what the bridge retains. */
  readonly origin: string;
  /** The WebSocket endpoint. */
  readonly wsUrl: string;
  /** The HTTP fallback endpoint. */
  readonly rpcUrl: string;
  /** The bootstrap URL including the token, or `null` when there is no token. */
  readonly bootstrapUrl: string | null;
}

/**
 * Split a bridge URL.
 *
 * Accepts anything a page can hand over — `location.href`, the URL the host
 * printed, an origin on its own — because the caller should not have to know
 * which one it has.
 */
export function parseTarget(url: string): BridgeTarget {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BridgeClientError(
      'bootstrap-failed',
      `bridge URL must be http or https, got ${parsed.protocol}`,
    );
  }
  const token = parsed.searchParams.get(LAUNCH_TOKEN_PARAM);
  const origin = parsed.origin;
  const wsScheme = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  return {
    origin,
    wsUrl: `${wsScheme}//${parsed.host}/ws`,
    rpcUrl: `${origin}/rpc`,
    bootstrapUrl: token === null ? null : `${origin}/?${LAUNCH_TOKEN_PARAM}=${encodeURIComponent(token)}`,
  };
}

/**
 * Redeem a launch token, so that the session cookie exists before the upgrade.
 *
 * Redirects are not followed. The server answers `303 See Other` to `/` with
 * the `Set-Cookie`, and following it would fetch the host's page a second time
 * for nothing. A browser applies the cookie from the redirect response itself,
 * and reports the unfollowed redirect as an opaque response rather than as a
 * failure — hence the three shapes accepted below.
 *
 * A refusal is terminal: the token was already burnt, expired, or never
 * valid, and retrying cannot change that.
 */
export async function redeemToken(bootstrapUrl: string, fetchImpl: FetchLike): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(bootstrapUrl, {
      method: 'GET',
      credentials: 'include',
      redirect: 'manual',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  } catch (cause) {
    // The URL is deliberately absent from the message: it carries the token.
    throw new BridgeClientError('bootstrap-failed', 'the bootstrap request failed', { cause });
  }

  // `opaqueredirect` is what a browser reports for an unfollowed same-origin
  // redirect: status 0, no headers, cookie already stored.
  if (response.type === 'opaqueredirect') return;
  if (response.status === 303 || response.status === 302 || response.ok) return;

  throw new BridgeClientError(
    'bootstrap-failed',
    `the host refused the launch token with ${String(response.status)}`,
  );
}

/** What a `GET /ws` probe learned about why the upgrade failed. */
export type UpgradeVerdict = 'authenticated' | 'unauthorized' | 'unknown';

/**
 * Ask the host why an upgrade failed.
 *
 * A browser never sees the status of a refused WebSocket upgrade — the API
 * reports a bare `error` and a `close`, by design, so that a page cannot use
 * upgrades to probe the network. `PROTOCOL.md` §11.1 nonetheless requires an
 * authentication failure to be terminal rather than retried forever, so the
 * client asks the same route over plain HTTP: the host answers `426` to an
 * authenticated caller that forgot to upgrade, and the fence's uniform `403`
 * to one it does not trust.
 *
 * An inconclusive answer is reported as such and treated as transient, which
 * is the safe direction: retrying costs a backoff, while giving up on a
 * healthy session costs the application its connection.
 */
export async function probeUpgrade(origin: string, fetchImpl: FetchLike): Promise<UpgradeVerdict> {
  try {
    const response = await fetchImpl(`${origin}/ws`, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    if (response.status === 426) return 'authenticated';
    if (response.status === 401 || response.status === 403) return 'unauthorized';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
