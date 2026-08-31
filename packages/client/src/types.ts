/**
 * The public shapes of `@brobridge/client`: connection state, options, and the
 * two host primitives the client borrows from its environment.
 *
 * The client is written against standard `WebSocket` and `fetch` and takes no
 * runtime dependency on either a bundler shim or a Node polyfill. Both are
 * nonetheless *injectable*, because a test process has no cookie jar and no
 * way to put a `Cookie` header on a `WebSocket` upgrade, and because a browser
 * that lacks a cookie jar is not a case worth designing around.
 */
import type { BridgeStream } from '@brobridge/core';

/**
 * What the connection is doing, as an application would render it.
 *
 * - `connecting` — a first WebSocket attempt is in flight.
 * - `open` — attached, handshake settled, streams and calls available.
 * - `resuming` — a reconnect is in flight for a session that already exists;
 *   live streams are being replayed from their cursors.
 * - `degraded` — the WebSocket is unavailable and unary calls are riding
 *   `POST /rpc`. Streams are not available in this state. The socket is still
 *   retried in the background, and a successful one moves the bridge back to
 *   `open`; the state does not flap between `degraded` and `connecting` while
 *   that happens.
 * - `closed` — terminal. The bridge will not reconnect.
 */
export type BridgeState = 'connecting' | 'open' | 'resuming' | 'degraded' | 'closed';

/** The event names a {@link BridgeEvents} listener may subscribe to. */
export interface BridgeEvents {
  /** Emitted on every state transition, with the new state. */
  readonly state: BridgeState;
  /**
   * Emitted for a fault the client absorbed — a failed connection attempt, a
   * resume that had to renegotiate. The bridge keeps working; this is for
   * diagnostics, not for control flow.
   */
  readonly error: Error;
}

/** Unsubscribe from an event. Calling it twice is harmless. */
export type Unsubscribe = () => void;

/**
 * The slice of `WebSocket` the client uses.
 *
 * The four handlers are typed `unknown` on purpose. The DOM's `WebSocket` and
 * Node's declare their event types in incompatible hierarchies, and an
 * interface that named either one would stop the other from satisfying it —
 * which is exactly what a browser client with an injectable socket must not
 * do. The client only ever *writes* these properties, so the type it writes is
 * the one that matters, and that type is stated where the handler is defined.
 */
export interface SocketLike {
  /** Set to `"arraybuffer"` by the client before any frame arrives. */
  binaryType: string;
  /** `WebSocket.OPEN` is `1`; the client sends only in that state. */
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** Assigned by the client: the upgrade completed. */
  onopen: unknown;
  /** Assigned by the client: one inbound message. */
  onmessage: unknown;
  /** Assigned by the client: the socket is gone. */
  onclose: unknown;
  /** Assigned by the client: a fault, always followed by a close. */
  onerror: unknown;
}

/** Constructs a socket for `url`. Defaults to `new WebSocket(url)`. */
export type SocketFactory = (url: string) => SocketLike;

/** The slice of `fetch` the client uses. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Options for {@link connect}. */
export interface ConnectOptions {
  /**
   * Reconnect after the connection drops. Default `true`.
   *
   * Turning it off does not make a dropped connection an error: the bridge
   * moves to `closed` and every pending call rejects.
   */
  readonly reconnect?: boolean;
  /** Floor of the reconnect backoff, in milliseconds. Default 500. */
  readonly reconnectMinMs?: number;
  /** Ceiling of the reconnect backoff, in milliseconds. Default 10 000. */
  readonly reconnectMaxMs?: number;
  /**
   * Route unary calls over `POST /rpc` once the WebSocket has failed
   * {@link ConnectOptions.wsAttemptsBeforeFallback} times in a row.
   * Default `false`.
   */
  readonly httpFallback?: boolean;
  /** Consecutive WebSocket failures before the fallback engages. Default 3. */
  readonly wsAttemptsBeforeFallback?: number;
  /**
   * Silence for this long means the connection is dead. Default 45 000 ms,
   * which is `PROTOCOL.md` §13's `heartbeatTimeoutMs` against a server that
   * pings every 30 000 ms.
   */
  readonly heartbeatTimeoutMs?: number;
  /** How long one connection attempt may take before it is abandoned. Default 10 000 ms. */
  readonly connectTimeoutMs?: number;
  /** Largest frame this client accepts. Default and hard ceiling 16 MiB. */
  readonly maxFrameSize?: number;
  /** Concurrent streams this client accepts. Default 1024. */
  readonly maxStreams?: number;
  /** Per-stream, per-direction credit this client grants. Default 64 KiB. */
  readonly initialCredit?: number;
  /** Diagnostic name sent in `HELLO.client`. */
  readonly clientName?: string;
  /** Called for every stream the host pushes to this tab. */
  readonly onStream?: (stream: BridgeStream) => void;
  /** Socket constructor. Defaults to the global `WebSocket`. */
  readonly socket?: SocketFactory;
  /** Fetch implementation. Defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
  /** Injectable clock, for deterministic tests. Default `Date.now`. */
  readonly now?: () => number;
  /** Injectable randomness for backoff jitter, for deterministic tests. Default `Math.random`. */
  readonly random?: () => number;
}

/** Every option with its default applied. */
export interface ResolvedConnectOptions {
  readonly reconnect: boolean;
  readonly reconnectMinMs: number;
  readonly reconnectMaxMs: number;
  readonly httpFallback: boolean;
  readonly wsAttemptsBeforeFallback: number;
  readonly heartbeatTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly maxFrameSize: number | undefined;
  readonly maxStreams: number | undefined;
  readonly initialCredit: number | undefined;
  readonly clientName: string;
  readonly onStream: ((stream: BridgeStream) => void) | undefined;
  readonly socket: SocketFactory;
  readonly fetch: FetchLike;
  readonly now: () => number;
  readonly random: () => number;
}
