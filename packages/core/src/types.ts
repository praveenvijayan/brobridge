/**
 * Wire types and protocol constants shared by every module in
 * `@brobridgejs/core`.
 *
 * Everything here is a direct transcription of `PROTOCOL.md`. Magic numbers
 * live in this file and in `codec.ts` only; the rest of the package refers to
 * {@link FrameType}, {@link FrameFlags} and {@link PROTOCOL_DEFAULTS}.
 *
 * @see PROTOCOL.md
 */

/**
 * Wire protocol version carried in the frame header and negotiated by
 * `HELLO` / `HELLO_ACK`.
 *
 * @see PROTOCOL.md §3 "Frame header"
 */
export const PROTOCOL_VERSION = 1;

/**
 * Size of the fixed frame header, in bytes. Every frame is this header
 * followed by exactly `length` payload bytes; there is no trailer and no
 * padding.
 *
 * @see PROTOCOL.md §3 "Frame header"
 */
export const FRAME_HEADER_SIZE = 16;

/**
 * Frame type discriminants.
 *
 * @see PROTOCOL.md §4 "Frame types"
 */
export const FrameType = {
  HELLO: 0x01,
  HELLO_ACK: 0x02,
  OPEN: 0x03,
  OPEN_ACK: 0x04,
  DATA: 0x05,
  CREDIT: 0x06,
  END: 0x07,
  ERROR: 0x08,
  CANCEL: 0x09,
  RESUME: 0x0a,
  RESUME_ACK: 0x0b,
  RESUME_FAIL: 0x0c,
  PING: 0x0d,
  PONG: 0x0e,
  GOAWAY: 0x0f,
} as const;

/** Union of the numeric values in {@link FrameType}. */
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

/**
 * Header flag bits.
 *
 * Bits outside this set are reserved: a sender MUST leave them zero and a
 * receiver MUST ignore them, so that a future minor extension does not break
 * a version-1 peer.
 *
 * @see PROTOCOL.md §3.1 "Flags"
 */
export const FrameFlags = {
  /** No flags set. */
  NONE: 0x00,
  /** On `DATA`: the last `DATA` the sender will send on this stream. */
  FIN: 0x01,
  /** This frame was served from a replay buffer. Diagnostic only. */
  REPLAY: 0x02,
} as const;

/** Union of the numeric values in {@link FrameFlags}. */
export type FrameFlag = (typeof FrameFlags)[keyof typeof FrameFlags];

/**
 * Hard ceiling for the header `length` field. An endpoint MUST NOT advertise
 * a `maxFrameSize` above this and MUST reject a peer that does.
 *
 * @see PROTOCOL.md §13 "Limits and defaults"
 */
export const HARD_MAX_FRAME_SIZE = 16 * 1024 * 1024;

/**
 * Largest value a credit window may reach. Granting credit that would push
 * the peer above this is a `FLOW_CONTROL_ERROR`.
 *
 * @see PROTOCOL.md §8.1 rule 7
 */
export const MAX_CREDIT = 2 ** 31 - 1;

/** Largest value the `seq` field can hold before `SEQ_EXHAUSTED`. */
export const MAX_SEQ = 2 ** 32 - 1;

/** Largest allocatable `streamId` before `STREAM_ID_EXHAUSTED`. */
export const MAX_STREAM_ID = 2 ** 32 - 1;

/**
 * Protocol defaults from `PROTOCOL.md` §13. Only the values core enforces are
 * listed; transport-layer budgets (auth rate limits, HTTP header size) belong
 * to the server package.
 *
 * `creditGrantThreshold` is not a constant: it defaults to 50 % of the
 * effective `initialCredit`, so it is derived by
 * {@link defaultCreditGrantThreshold} instead.
 *
 * @see PROTOCOL.md §13 "Limits and defaults"
 */
export const PROTOCOL_DEFAULTS = {
  maxFrameSize: HARD_MAX_FRAME_SIZE,
  maxStreams: 1024,
  initialCredit: 64 * 1024,
  resumeWindowBytes: 1024 * 1024,
  resumeWindowFrames: 256,
  sessionTtlMs: 60_000,
  heartbeatMs: 30_000,
  heartbeatTimeoutMs: 45_000,
  maxFlowViolations: 8,
} as const;

/**
 * The `creditGrantThreshold` default: half the effective initial credit, at
 * least one byte so that a pathologically small window still makes progress.
 *
 * @see PROTOCOL.md §13
 */
export function defaultCreditGrantThreshold(initialCredit: number): number {
  return Math.max(1, Math.floor(initialCredit / 2));
}

/**
 * The minimal transport surface core uses to reach the outside world.
 *
 * Core owns no sockets. Anything that can move bytes in order and tell core
 * when it stopped — a WebSocket, an HTTP request pair, an in-memory pipe in a
 * test — can be a carrier.
 *
 * `onMessage` and `onClose` *set* the handler rather than adding one: a later
 * call replaces the earlier handler. That is what lets a server hand a carrier
 * from the session router to the endpoint it resolved (`sessions.ts`) without
 * the router still holding a live subscription.
 */
export interface Carrier {
  /** Hand `bytes` to the transport. Frames are emitted whole where possible. */
  send(bytes: Uint8Array): void;
  /** Set the inbound byte handler, replacing any previous one. */
  onMessage(cb: (bytes: Uint8Array) => void): void;
  /** Set the transport-closed handler, replacing any previous one. */
  onClose(cb: () => void): void;
  /**
   * Close the transport, if it can be closed from here.
   *
   * Optional, because a carrier may be one half of a pipe the host owns. Core
   * calls it after a connection-level `ERROR`, which `PROTOCOL.md` §5.7
   * requires be followed by a close; a carrier that omits it leaves that close
   * to its host.
   */
  close?(): void;
}

/** Direction a stream's initiator intends to use. @see PROTOCOL.md §5.3 */
export type StreamMode = 'read' | 'write' | 'duplex';

/**
 * Stream lifecycle states.
 *
 * @see PROTOCOL.md §7.2 "States"
 */
export type StreamState =
  | 'idle'
  | 'opening'
  | 'open'
  | 'half-closed-local'
  | 'half-closed-remote'
  | 'closed'
  | 'reaped';

/* -------------------------------------------------------------------------- */
/*  Control payloads (PROTOCOL.md §5)                                          */
/* -------------------------------------------------------------------------- */

/** @see PROTOCOL.md §5.1 */
export interface HelloPayload {
  readonly versions: readonly number[];
  readonly maxFrameSize?: number;
  readonly maxStreams?: number;
  readonly client?: string;
}

/** @see PROTOCOL.md §5.2 */
export interface HelloAckPayload {
  readonly version: number;
  readonly sessionId: string;
  readonly maxFrameSize: number;
  readonly maxStreams: number;
  readonly initialCredit: number;
  readonly resumeWindow: { readonly bytes: number; readonly frames: number };
  readonly heartbeatMs: number;
}

/** @see PROTOCOL.md §5.3 */
export interface OpenPayload {
  readonly name: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly mode?: StreamMode;
  readonly credit?: number;
}

/** @see PROTOCOL.md §5.4 */
export interface OpenAckPayload {
  readonly credit?: number;
}

/** @see PROTOCOL.md §5.5 */
export interface CreditPayload {
  readonly bytes: number;
}

/** @see PROTOCOL.md §5.6 */
export type EndPayload = Readonly<Record<string, unknown>>;

/** @see PROTOCOL.md §5.7 */
export interface ErrorPayload {
  readonly code: string;
  readonly message?: string;
  readonly retryable?: boolean;
}

/** @see PROTOCOL.md §5.8 */
export interface CancelPayload {
  readonly reason?: string;
}

/** One stream cursor in a `RESUME` request. @see PROTOCOL.md §5.9 */
export interface ResumeCursor {
  readonly streamId: number;
  readonly lastSeq: number;
  /**
   * Cumulative `DATA` payload bytes this endpoint has granted the peer on
   * this stream, counting `OPEN.credit` and every `CREDIT` since.
   *
   * `CREDIT` is unsequenced and never replayed (§9.4), so a grant that was
   * handed to a dying socket is lost while the granting side has already
   * counted it. Carrying the running total makes the window recoverable
   * exactly rather than approximately.
   */
  readonly granted?: number;
}

/** @see PROTOCOL.md §5.9 */
export interface ResumePayload {
  readonly sessionId: string;
  readonly streams: readonly ResumeCursor[];
}

/** One per-stream failure in a `RESUME_ACK`. @see PROTOCOL.md §5.10 */
export interface ResumeFailure {
  readonly streamId: number;
  readonly code: string;
}

/** One peer's cumulative grant on one stream. @see PROTOCOL.md §5.10 */
export interface StreamGrant {
  readonly streamId: number;
  /** Cumulative `DATA` payload bytes granted on this stream. */
  readonly granted: number;
}

/** @see PROTOCOL.md §5.10 */
export interface ResumeAckPayload {
  readonly sessionId: string;
  readonly resumed: readonly number[];
  readonly failed: readonly ResumeFailure[];
  /**
   * The responder's own cumulative grants, so the reconnecting peer can
   * restore its send window exactly. Same purpose as
   * {@link ResumeCursor.granted}, for the other direction.
   */
  readonly credit?: readonly StreamGrant[];
}

/** @see PROTOCOL.md §5.11 */
export interface ResumeFailPayload {
  readonly code: 'SESSION_UNKNOWN' | 'SESSION_EXPIRED';
  readonly message?: string;
}

/** @see PROTOCOL.md §5.12 */
export interface PingPayload {
  readonly nonce: string;
  readonly at?: number;
}

/** @see PROTOCOL.md §5.13 */
export interface GoawayPayload {
  readonly code: string;
  readonly lastStreamId: number;
  readonly message?: string;
}

/* -------------------------------------------------------------------------- */
/*  Frames                                                                     */
/* -------------------------------------------------------------------------- */

/** Fields every frame carries in its header. */
interface FrameHeaderFields {
  readonly streamId: number;
  readonly seq: number;
  readonly flags: number;
}

/** A decoded frame, discriminated by {@link FrameType}. */
export type Frame =
  | (FrameHeaderFields & { readonly type: typeof FrameType.HELLO; readonly payload: HelloPayload })
  | (FrameHeaderFields & {
      readonly type: typeof FrameType.HELLO_ACK;
      readonly payload: HelloAckPayload;
    })
  | (FrameHeaderFields & { readonly type: typeof FrameType.OPEN; readonly payload: OpenPayload })
  | (FrameHeaderFields & {
      readonly type: typeof FrameType.OPEN_ACK;
      readonly payload: OpenAckPayload;
    })
  | (FrameHeaderFields & { readonly type: typeof FrameType.DATA; readonly payload: Uint8Array })
  | (FrameHeaderFields & { readonly type: typeof FrameType.CREDIT; readonly payload: CreditPayload })
  | (FrameHeaderFields & { readonly type: typeof FrameType.END; readonly payload: EndPayload })
  | (FrameHeaderFields & { readonly type: typeof FrameType.ERROR; readonly payload: ErrorPayload })
  | (FrameHeaderFields & { readonly type: typeof FrameType.CANCEL; readonly payload: CancelPayload })
  | (FrameHeaderFields & { readonly type: typeof FrameType.RESUME; readonly payload: ResumePayload })
  | (FrameHeaderFields & {
      readonly type: typeof FrameType.RESUME_ACK;
      readonly payload: ResumeAckPayload;
    })
  | (FrameHeaderFields & {
      readonly type: typeof FrameType.RESUME_FAIL;
      readonly payload: ResumeFailPayload;
    })
  | (FrameHeaderFields & { readonly type: typeof FrameType.PING; readonly payload: PingPayload })
  | (FrameHeaderFields & { readonly type: typeof FrameType.PONG; readonly payload: PingPayload })
  | (FrameHeaderFields & {
      readonly type: typeof FrameType.GOAWAY;
      readonly payload: GoawayPayload;
    });

/** Narrow a {@link Frame} union member by its type discriminant. */
export type FrameOf<T extends FrameType> = Extract<Frame, { type: T }>;

/**
 * The frames that consume a sequence number and are eligible for replay.
 *
 * @see PROTOCOL.md §4 "Sequenced"
 */
export type SequencedFrame = FrameOf<typeof FrameType.DATA> | FrameOf<typeof FrameType.END>;

/** True when `type` is one of the sequenced frame types. */
export function isSequencedType(type: number): boolean {
  return type === FrameType.DATA || type === FrameType.END;
}
