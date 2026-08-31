/**
 * Error codes and typed error values.
 *
 * Two rules shape this module:
 *
 * - The decoder never throws. Malformed input is *returned* as a
 *   {@link ProtocolError}, so a hostile peer can never turn a byte pattern
 *   into an unhandled exception (`PROTOCOL.md` §3.2).
 * - Every condition the wire can express has a stable string code, so an
 *   adapter or an application can branch on `error.code` rather than on
 *   message text.
 *
 * @see PROTOCOL.md §12 "Error codes"
 */

/**
 * The stable error codes carried in `ERROR.code`, `GOAWAY.code`,
 * `RESUME_FAIL.code` and `RESUME_ACK.failed[].code`.
 *
 * @see PROTOCOL.md §12
 */
export const ErrorCode = {
  PROTOCOL_VIOLATION: 'PROTOCOL_VIOLATION',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  FRAME_TOO_LARGE: 'FRAME_TOO_LARGE',
  FLOW_CONTROL_ERROR: 'FLOW_CONTROL_ERROR',
  STREAM_STATE_ERROR: 'STREAM_STATE_ERROR',
  STREAM_CLOSED: 'STREAM_CLOSED',
  STREAM_LIMIT_EXCEEDED: 'STREAM_LIMIT_EXCEEDED',
  STREAM_ID_EXHAUSTED: 'STREAM_ID_EXHAUSTED',
  SEQ_EXHAUSTED: 'SEQ_EXHAUSTED',
  NOT_FOUND: 'NOT_FOUND',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  CANCELLED: 'CANCELLED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SESSION_UNKNOWN: 'SESSION_UNKNOWN',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  SNAPSHOT_REQUIRED: 'SNAPSHOT_REQUIRED',
  SERVER_SHUTDOWN: 'SERVER_SHUTDOWN',
  UNAUTHORIZED: 'UNAUTHORIZED',
} as const;

/** Union of the string values in {@link ErrorCode}. */
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Every value of {@link ErrorCode}, for validation and exhaustiveness tests. */
export const ERROR_CODES: readonly ErrorCode[] = Object.values(ErrorCode);

/** True when `value` is one of the codes defined by `PROTOCOL.md` §12. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Whether a fault tears down one stream or the whole connection.
 *
 * @see PROTOCOL.md §5.7
 */
export type ErrorScope = 'connection' | 'stream';

/** Base class for every error this package produces. */
export class BridgeError extends Error {
  /** The stable code from `PROTOCOL.md` §12. */
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = 'BridgeError';
    this.code = code;
  }
}

/**
 * A protocol fault: malformed bytes, an illegal frame for the current state,
 * or a bad control payload.
 *
 * Produced as a *value* by the decoder and by the state machine, and turned
 * into an `ERROR` frame by the endpoint. Constructing one has no side effect.
 */
export class ProtocolError extends BridgeError {
  /** Whether the fault kills one stream or the connection. */
  readonly scope: ErrorScope;
  /** The stream at fault, or `0` for a connection-scoped fault. */
  readonly streamId: number;
  /** Whether the peer may usefully retry. Mirrors `ERROR.retryable`. */
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { scope?: ErrorScope; streamId?: number; retryable?: boolean; cause?: unknown },
  ) {
    super(code, message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProtocolError';
    this.streamId = options?.streamId ?? 0;
    this.scope = options?.scope ?? (this.streamId === 0 ? 'connection' : 'stream');
    this.retryable = options?.retryable ?? false;
  }
}

/**
 * A stream was torn down by the peer, by a local `cancel()`, or by connection
 * loss. Surfaced to whoever is reading or writing that stream.
 */
export class StreamError extends BridgeError {
  /** The stream that ended. */
  readonly streamId: number;
  /** True when the peer sent the `ERROR`; false when it was raised locally. */
  readonly remote: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { streamId: number; remote?: boolean; cause?: unknown },
  ) {
    super(code, message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StreamError';
    this.streamId = options.streamId;
    this.remote = options.remote ?? false;
  }
}

/**
 * The resume cursor for a stream aged out of the server's replay buffer, so
 * the gap cannot be closed from the buffer.
 *
 * This is deliberately its own type: `PROTOCOL.md` §9.4 forbids silently
 * continuing with a gap, so an application must be able to catch exactly this
 * case and re-derive state (re-open the stream, re-fetch a snapshot).
 */
export class SnapshotRequiredError extends StreamError {
  constructor(streamId: number, message = 'resume cursor aged out of the replay buffer') {
    super(ErrorCode.SNAPSHOT_REQUIRED, message, { streamId, remote: true });
    this.name = 'SnapshotRequiredError';
  }
}

/** The connection went away, or was closed locally, while work was in flight. */
export class ConnectionClosedError extends BridgeError {
  constructor(
    code: ErrorCode = ErrorCode.INTERNAL_ERROR,
    message = 'connection closed',
    options?: { cause?: unknown },
  ) {
    super(code, message, options);
    this.name = 'ConnectionClosedError';
  }
}

/**
 * A `RESUME` attempt failed at the session level: the session is unknown or
 * its TTL elapsed, and the client must start a fresh one with `HELLO`.
 */
export class ResumeFailedError extends BridgeError {
  constructor(code: ErrorCode, message: string) {
    super(code, message);
    this.name = 'ResumeFailedError';
  }
}
