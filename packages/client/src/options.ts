/**
 * Option defaults.
 *
 * The numeric defaults are `PROTOCOL.md` §13's, not invented ones: a client
 * that reconnected on a different schedule than the spec describes would be
 * correct only by accident against a conforming host.
 */
import type { ConnectOptions, FetchLike, ResolvedConnectOptions, SocketFactory } from './types.js';

/** `PROTOCOL.md` §13 defaults, plus the client-only deadlines. */
const DEFAULTS = {
  reconnectMinMs: 500,
  reconnectMaxMs: 10_000,
  heartbeatTimeoutMs: 45_000,
  connectTimeoutMs: 10_000,
  wsAttemptsBeforeFallback: 3,
} as const;

/**
 * Apply defaults.
 *
 * The globals are read here, once, rather than at each use: a test that
 * injects a socket factory must not have the browser's `WebSocket` picked up
 * behind its back, and a runtime without one must fail with a clear message
 * instead of a `ReferenceError` deep in a reconnect.
 */
export function resolveOptions(options: ConnectOptions): ResolvedConnectOptions {
  return {
    reconnect: options.reconnect ?? true,
    reconnectMinMs: positive(options.reconnectMinMs, DEFAULTS.reconnectMinMs, 'reconnectMinMs'),
    reconnectMaxMs: positive(options.reconnectMaxMs, DEFAULTS.reconnectMaxMs, 'reconnectMaxMs'),
    httpFallback: options.httpFallback ?? false,
    wsAttemptsBeforeFallback: positive(
      options.wsAttemptsBeforeFallback,
      DEFAULTS.wsAttemptsBeforeFallback,
      'wsAttemptsBeforeFallback',
    ),
    heartbeatTimeoutMs: positive(
      options.heartbeatTimeoutMs,
      DEFAULTS.heartbeatTimeoutMs,
      'heartbeatTimeoutMs',
    ),
    connectTimeoutMs: positive(options.connectTimeoutMs, DEFAULTS.connectTimeoutMs, 'connectTimeoutMs'),
    maxFrameSize: options.maxFrameSize,
    maxStreams: options.maxStreams,
    initialCredit: options.initialCredit,
    clientName: options.clientName ?? '@brobridgejs/client',
    onStream: options.onStream,
    socket: options.socket ?? defaultSocketFactory(),
    fetch: options.fetch ?? defaultFetch(),
    now: options.now ?? Date.now,
    random: options.random ?? Math.random,
  };
}

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number, got ${String(value)}`);
  }
  return value;
}

function defaultSocketFactory(): SocketFactory {
  const ctor = globalThis.WebSocket as unknown;
  if (typeof ctor !== 'function') {
    throw new TypeError(
      'no global WebSocket in this runtime; pass options.socket with an implementation',
    );
  }
  return (url) => new WebSocket(url);
}

function defaultFetch(): FetchLike {
  if (typeof globalThis.fetch !== 'function') {
    throw new TypeError('no global fetch in this runtime; pass options.fetch with an implementation');
  }
  return (input, init) => globalThis.fetch(input, init);
}
