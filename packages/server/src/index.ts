/**
 * `brobridge` — the server (host) package.
 *
 * A host application calls {@link createBridge}, prints or opens the returned
 * URL, and gets a bridge that exactly one browser tab can use. Everything
 * that makes that safe — the trust fence, the one-time launch token, the
 * HMAC-signed session cookie — is on by default and is not optional.
 *
 * ```ts
 * const bridge = await createBridge();
 * bridge.expose('echo', { say: (text: string) => text });
 * console.log(bridge.url); // http://127.0.0.1:53119/?bt=…
 * ```
 *
 * The same code runs on Node >= 20 and on Bun. Which sockets are used
 * underneath is an implementation detail of this package.
 *
 * @packageDocumentation
 * @see PROTOCOL.md
 * @see THREAT-MODEL.md
 */
import { AuthGuard } from './auth.js';
import { Gateway } from './gateway.js';
import type { BridgeSession, SessionManager as SessionManagerType } from './manager.js';
import { SessionManager } from './manager.js';
import type { BridgeOptions, IndexDocument } from './options.js';
import { resolveAllowedOrigins, resolveOptions, warnNonLoopback } from './options.js';
import { ServiceRegistry } from './services.js';
import type { ServiceObject, StreamHandler } from './services.js';
import type { HostListener, RuntimeConfig } from './runtime.js';
import { isBun } from './runtime.js';
import { formatAuthority, originOf } from './trust.js';

export {
  LAUNCH_TOKEN_PARAM,
  MAX_LIVE_LAUNCH_TOKENS,
  SESSION_COOKIE_ATTRIBUTES,
  SESSION_COOKIE_NAME,
  sessionCookieName,
} from './auth.js';
export type { BridgeSession } from './manager.js';
export type { BridgeLogger, BridgeOptions, IndexDocument } from './options.js';
export { isLoopbackHost } from './options.js';
export { RPC_CONTENT_TYPE } from './rpc.js';
export type { ServiceObject, StreamContext, StreamHandler } from './services.js';
export type {
  FenceCheck,
  FencePolicy,
  FenceRequest,
  FenceVerdict,
  RawHeader,
} from './trust.js';
export { FENCE_REFUSAL_STATUS, checkRequest, formatAuthority, originOf } from './trust.js';

/** A running bridge. */
export interface Bridge {
  /**
   * The URL to open, carrying the one-time launch token.
   *
   * Show it, open it, or pass it to a browser launcher — but do not log it:
   * the token in it is a credential until it is burnt.
   */
  readonly url: string;
  /**
   * A fresh URL carrying a new one-time launch token, for opening the
   * application again from somewhere else.
   *
   * Each call mints a token of its own, single-use, valid for
   * `launchTokenTtlMs`; at most eight are live at once and a ninth drops the
   * oldest. Call it only on the host's own decision — never because a browser
   * asked. Do not log the result.
   */
  launchUrl(): string;
  /** The bridge's origin, without the token. */
  readonly origin: string;
  /** The bound authority, exactly as a legitimate `Host` header spells it. */
  readonly authority: string;
  /** The interface bound. */
  readonly host: string;
  /** The port bound. */
  readonly port: number;
  /** Protocol sessions currently alive. */
  readonly sessions: readonly BridgeSession[];
  /**
   * Register a service. Its methods become callable as `"<name>.<method>"`
   * with JSON arguments.
   *
   * Arguments arrive from a browser tab and are untrusted input, however the
   * tab was authenticated (`THREAT-MODEL.md` §8.4). Validate them.
   */
  expose(name: string, service: ServiceObject): void;
  /** Register a stream route, for server-push and long-lived transfers. */
  stream(name: string, handler: StreamHandler): void;
  /** Stop the bridge: `GOAWAY`, end open streams, then release the listener. */
  close(): Promise<void>;
}

/** The page served at `/` when the host application supplies none. */
const DEFAULT_INDEX: IndexDocument = {
  contentType: 'text/html; charset=utf-8',
  body:
    '<!doctype html><meta charset="utf-8"><title>brobridge</title>' +
    '<p>This bridge is running. The application that started it did not supply a page.</p>',
};

/**
 * Start a bridge.
 *
 * Binds `127.0.0.1` on an ephemeral port by default. A non-loopback bind
 * throws unless `allowNonLoopback` is set, because it changes who can reach
 * the host application (`THREAT-MODEL.md` §5.12).
 */
export async function createBridge(options: BridgeOptions = {}): Promise<Bridge> {
  const resolved = resolveOptions(options);
  const registry = new ServiceRegistry();
  const manager: SessionManagerType = new SessionManager({
    options: resolved,
    registry,
    onSession: options.onSession,
  });

  let gateway: Gateway | null = null;
  const runtime: RuntimeConfig = {
    options: resolved,
    manager,
    registry,
    gateway: () => gateway,
  };

  // The listener opens closed: until the gateway exists, every request is
  // refused. The port is not knowable to anyone yet — `createBridge` has not
  // returned — so the window is unreachable as well as safe.
  const listener: HostListener = isBun()
    ? await (await import('./bun.js')).startBunServer(runtime)
    : await (await import('./node.js')).startNodeServer(runtime);

  const authority = formatAuthority(resolved.host, listener.port);
  const auth = await AuthGuard.create({
    authority,
    launchTokenTtlMs: resolved.launchTokenTtlMs,
    sessionCookieTtlMs: resolved.sessionCookieTtlMs,
    authFailureWindowMs: resolved.authFailureWindowMs,
    authFailuresPerWindow: resolved.authFailuresPerWindow,
  });

  const index = resolved.index ?? DEFAULT_INDEX;
  gateway = new Gateway({
    authority,
    allowedOrigins: resolveAllowedOrigins(authority, resolved.allowedOrigins),
    auth,
    index: {
      body: typeof index.body === 'string' ? new TextEncoder().encode(index.body) : index.body,
      contentType: index.contentType ?? 'text/html; charset=utf-8',
    },
  });

  warnNonLoopback(resolved, resolved.host, listener.port);

  let closed = false;
  return {
    url: `${originOf(authority)}/?bt=${auth.launchToken}`,
    launchUrl: () => `${originOf(authority)}/?bt=${auth.mintLaunchToken()}`,
    origin: originOf(authority),
    authority,
    host: listener.host,
    port: listener.port,
    get sessions(): readonly BridgeSession[] {
      return manager.sessions;
    },
    expose(name, service): void {
      registry.expose(name, service);
    },
    stream(name, handler): void {
      registry.stream(name, handler);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await manager.close();
      await listener.close();
      auth.clear();
    },
  };
}
