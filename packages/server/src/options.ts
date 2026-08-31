/**
 * Public options for {@link createBridge}, their defaults, and the validation
 * that refuses a dangerous configuration outright.
 *
 * Defaults come from `PROTOCOL.md` §13. The one value that is not in that
 * table is `sessionCookieTtlMs` — see its documentation below.
 *
 * @see PROTOCOL.md §13 "Limits and defaults"
 */
import { PROTOCOL_DEFAULTS } from '@brobridge/core';

import type { BridgeSession } from './manager.js';

import { formatAuthority, originOf } from './trust.js';

/** Where diagnostics go. Values are redacted before they reach it. */
export interface BridgeLogger {
  warn(message: string): void;
  error(message: string): void;
}

/** A body the bridge serves at `/` once the caller is authenticated. */
export interface IndexDocument {
  /** Response body. */
  readonly body: string | Uint8Array;
  /** `Content-Type` for it. Default `text/html; charset=utf-8`. */
  readonly contentType?: string;
}

/** Options for {@link createBridge}. */
export interface BridgeOptions {
  /** Interface to bind. Default `127.0.0.1`. */
  readonly host?: string;
  /** Port to bind. Default `0` — the OS picks an ephemeral port. */
  readonly port?: number;
  /**
   * Permit a non-loopback bind.
   *
   * Binding a non-loopback interface adds a whole attacker class and makes
   * the plaintext loopback assumption false (`THREAT-MODEL.md` §5.12, §8.3).
   * It therefore requires this explicit flag — never a truthy default, never
   * an environment variable alone — and always warns.
   */
  readonly allowNonLoopback?: boolean;
  /**
   * Origins allowed to reach the bridge. Default: exactly the bound
   * authority's origin. An absent `Origin` header is always allowed
   * (`THREAT-MODEL.md` §5.5).
   */
  readonly allowedOrigins?: readonly string[];
  /** What to serve at `/` for an authenticated caller. */
  readonly index?: IndexDocument;
  /** Diagnostics sink. Default: `console`. */
  readonly logger?: BridgeLogger;
  /**
   * Called once per protocol session, when its `HELLO` handshake completes.
   *
   * The hook is where a host application pushes to a tab: the session is the
   * handle for opening a stream or making a call in that direction.
   */
  readonly onSession?: (session: BridgeSession) => void;

  /** Validity window of the one-time launch token. Default 120 000 ms. */
  readonly launchTokenTtlMs?: number;
  /**
   * How long a minted session cookie stays valid. Default 8 hours.
   *
   * Distinct from `sessionTtlMs`, which is how long a *protocol* session's
   * replay state survives a disconnect (`PROTOCOL.md` §13). A tab that sits
   * idle for ten minutes must still be able to reconnect and authenticate;
   * it just cannot resume its streams.
   */
  readonly sessionCookieTtlMs?: number;
  /** Protocol session retention after the last disconnect. Default 60 000 ms. */
  readonly sessionTtlMs?: number;
  /** Rate-limit window for authentication failures. Default 60 000 ms. */
  readonly authFailureWindowMs?: number;
  /** Authentication failures per window per remote address. Default 20. */
  readonly authFailuresPerWindow?: number;
  /** HTTP request header budget. Default 16 KiB. */
  readonly maxHeaderBytes?: number;
  /** Request-line-plus-headers deadline, and `HELLO` deadline after upgrade. Default 10 000 ms. */
  readonly handshakeTimeoutMs?: number;
  /** Largest accepted `POST /rpc` body. Default: twice `maxFrameSize`. */
  readonly maxRpcBodyBytes?: number;
  /**
   * Bytes the socket pump may hold for a peer that is not reading. Default
   * 8 MiB. A connection that exceeds it is closed rather than allowed to grow
   * the userspace queue without bound (`THREAT-MODEL.md` §5.10).
   */
  readonly maxSocketBufferBytes?: number;
  /** Time `close()` waits for streams to end before forcing sockets shut. Default 2 000 ms. */
  readonly closeTimeoutMs?: number;

  /** Largest frame this endpoint accepts. Default and hard ceiling 16 MiB. */
  readonly maxFrameSize?: number;
  /** Concurrent streams per connection. Default 1024. */
  readonly maxStreams?: number;
  /** Per-stream, per-direction initial credit. Default 64 KiB. */
  readonly initialCredit?: number;
  /** Replay ring bounds per stream. Default 1 MiB / 256 frames. */
  readonly resumeWindow?: { readonly bytes: number; readonly frames: number };
  /** `PING` interval. Default 30 000 ms. */
  readonly heartbeatMs?: number;
  /** Dead-connection detection window. Default 45 000 ms. */
  readonly heartbeatTimeoutMs?: number;
}

/** Every option with its default applied. */
export interface ResolvedOptions {
  readonly host: string;
  readonly port: number;
  readonly allowNonLoopback: boolean;
  readonly allowedOrigins: readonly string[] | null;
  readonly index: IndexDocument | null;
  readonly logger: BridgeLogger;
  readonly launchTokenTtlMs: number;
  readonly sessionCookieTtlMs: number;
  readonly sessionTtlMs: number;
  readonly authFailureWindowMs: number;
  readonly authFailuresPerWindow: number;
  readonly maxHeaderBytes: number;
  readonly handshakeTimeoutMs: number;
  readonly maxRpcBodyBytes: number;
  readonly maxSocketBufferBytes: number;
  readonly closeTimeoutMs: number;
  readonly maxFrameSize: number;
  readonly maxStreams: number;
  readonly initialCredit: number;
  readonly resumeWindow: { readonly bytes: number; readonly frames: number };
  readonly heartbeatMs: number;
  readonly heartbeatTimeoutMs: number;
}

/** Defaults not already covered by `PROTOCOL.md` §13. */
const DEFAULT_LAUNCH_TOKEN_TTL_MS = 120_000;
const DEFAULT_SESSION_COOKIE_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_AUTH_FAILURE_WINDOW_MS = 60_000;
const DEFAULT_AUTH_FAILURES_PER_WINDOW = 20;
const DEFAULT_MAX_HEADER_BYTES = 16 * 1024;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_SOCKET_BUFFER_BYTES = 8 * 1024 * 1024;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;

/** Hosts that need no non-loopback opt-in. */
const LOOPBACK_NAMES = new Set(['localhost', '::1', '[::1]', '::ffff:127.0.0.1']);

/** True when binding `host` keeps the listener off the network. */
export function isLoopbackHost(host: string): boolean {
  if (LOOPBACK_NAMES.has(host)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Apply defaults and refuse a configuration that cannot be made safe.
 *
 * @throws TypeError when a non-loopback host is requested without
 *   `allowNonLoopback`, or when a numeric limit is out of range.
 */
export function resolveOptions(options: BridgeOptions = {}): ResolvedOptions {
  const host = options.host ?? '127.0.0.1';
  const allowNonLoopback = options.allowNonLoopback ?? false;
  if (!isLoopbackHost(host) && !allowNonLoopback) {
    throw new TypeError(
      `brobridge refuses to bind ${host}: it is not a loopback address. ` +
        'Binding a network interface exposes the bridge to every machine that can reach it. ' +
        'Pass { allowNonLoopback: true } to accept that, and read THREAT-MODEL.md §8.3 first.',
    );
  }

  const maxFrameSize = positive('maxFrameSize', options.maxFrameSize, PROTOCOL_DEFAULTS.maxFrameSize);
  if (maxFrameSize > PROTOCOL_DEFAULTS.maxFrameSize) {
    throw new TypeError(
      `maxFrameSize ${String(maxFrameSize)} exceeds the protocol maximum of ` +
        `${String(PROTOCOL_DEFAULTS.maxFrameSize)} bytes (PROTOCOL.md §13)`,
    );
  }

  return {
    host,
    port: options.port ?? 0,
    allowNonLoopback,
    allowedOrigins: options.allowedOrigins ?? null,
    index: options.index ?? null,
    logger: options.logger ?? console,
    launchTokenTtlMs: positive(
      'launchTokenTtlMs',
      options.launchTokenTtlMs,
      DEFAULT_LAUNCH_TOKEN_TTL_MS,
    ),
    sessionCookieTtlMs: positive(
      'sessionCookieTtlMs',
      options.sessionCookieTtlMs,
      DEFAULT_SESSION_COOKIE_TTL_MS,
    ),
    sessionTtlMs: positive('sessionTtlMs', options.sessionTtlMs, PROTOCOL_DEFAULTS.sessionTtlMs),
    authFailureWindowMs: positive(
      'authFailureWindowMs',
      options.authFailureWindowMs,
      DEFAULT_AUTH_FAILURE_WINDOW_MS,
    ),
    authFailuresPerWindow: positive(
      'authFailuresPerWindow',
      options.authFailuresPerWindow,
      DEFAULT_AUTH_FAILURES_PER_WINDOW,
    ),
    maxHeaderBytes: positive('maxHeaderBytes', options.maxHeaderBytes, DEFAULT_MAX_HEADER_BYTES),
    handshakeTimeoutMs: positive(
      'handshakeTimeoutMs',
      options.handshakeTimeoutMs,
      DEFAULT_HANDSHAKE_TIMEOUT_MS,
    ),
    maxRpcBodyBytes: positive('maxRpcBodyBytes', options.maxRpcBodyBytes, maxFrameSize * 2),
    maxSocketBufferBytes: positive(
      'maxSocketBufferBytes',
      options.maxSocketBufferBytes,
      DEFAULT_MAX_SOCKET_BUFFER_BYTES,
    ),
    closeTimeoutMs: positive('closeTimeoutMs', options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS),
    maxFrameSize,
    maxStreams: positive('maxStreams', options.maxStreams, PROTOCOL_DEFAULTS.maxStreams),
    initialCredit: positive('initialCredit', options.initialCredit, PROTOCOL_DEFAULTS.initialCredit),
    resumeWindow: options.resumeWindow ?? {
      bytes: PROTOCOL_DEFAULTS.resumeWindowBytes,
      frames: PROTOCOL_DEFAULTS.resumeWindowFrames,
    },
    heartbeatMs: positive('heartbeatMs', options.heartbeatMs, PROTOCOL_DEFAULTS.heartbeatMs),
    heartbeatTimeoutMs: positive(
      'heartbeatTimeoutMs',
      options.heartbeatTimeoutMs,
      PROTOCOL_DEFAULTS.heartbeatTimeoutMs,
    ),
  };
}

/** The origins a bound authority accepts, given the configured allowlist. */
export function resolveAllowedOrigins(
  authority: string,
  configured: readonly string[] | null,
): readonly string[] {
  return configured ?? [originOf(authority)];
}

/** Warn once about what a non-loopback bind costs. */
export function warnNonLoopback(options: ResolvedOptions, host: string, port: number): void {
  if (isLoopbackHost(host)) return;
  options.logger.warn(
    `brobridge is listening on ${formatAuthority(host, port)}, which is reachable from the ` +
      'network. Traffic is plaintext and the handshake surface is exposed; you own transport ' +
      'confidentiality and network access control (THREAT-MODEL.md §8.3).',
  );
}

function positive(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new TypeError(`${name} must be a positive integer, got ${String(value)}`);
  }
  return value;
}
