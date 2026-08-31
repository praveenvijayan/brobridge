/**
 * Faults the client raises on its own, as opposed to those the wire carries.
 *
 * Protocol faults already have typed values in `@brobridge/core`
 * (`StreamError`, `SnapshotRequiredError`, `ConnectionClosedError`,
 * `ResumeFailedError`) and are re-exported unchanged. What is left is the
 * handful of conditions that exist only on this side of the socket: a
 * bootstrap that was refused, an upgrade the host would not authenticate, a
 * stream asked for while the connection is degraded to the HTTP fallback.
 *
 * They are deliberately *not* modelled with `PROTOCOL.md` §12 codes. Those
 * codes describe what a peer said; these describe what never reached a peer,
 * and borrowing a wire code for them would make `error.code` ambiguous.
 */

/** Why a {@link BridgeClientError} was raised. Stable, branchable strings. */
export type ClientErrorReason =
  /** The bootstrap request was refused, so no session cookie was minted. */
  | 'bootstrap-failed'
  /** The host refused the upgrade: the cookie is missing, wrong or expired. */
  | 'unauthorized'
  /** No socket could be built at all — the environment blocks WebSockets. */
  | 'socket-failed'
  /** No connection could be established within the configured deadline. */
  | 'connect-timeout'
  /** Streams were asked for while the connection is degraded to `POST /rpc`. */
  | 'streams-unavailable'
  /** The WebSocket is unusable and no HTTP fallback was enabled. */
  | 'fallback-disabled'
  /** The HTTP fallback itself was refused by the host. */
  | 'fallback-failed'
  /** The bridge was closed by the application. */
  | 'closed';

/**
 * A fault raised by the client itself.
 *
 * `reason` is the stable discriminant; the message is for humans and may
 * change. Neither ever carries the launch token: it is stripped before any
 * URL reaches an error (`THREAT-MODEL.md` §5.6).
 */
export class BridgeClientError extends Error {
  /** What went wrong, as a stable string. */
  readonly reason: ClientErrorReason;

  constructor(reason: ClientErrorReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BridgeClientError';
    this.reason = reason;
  }
}

/** True when `value` is a {@link BridgeClientError} with the given reason. */
export function isClientError(value: unknown, reason?: ClientErrorReason): value is BridgeClientError {
  if (!(value instanceof BridgeClientError)) return false;
  return reason === undefined || value.reason === reason;
}
