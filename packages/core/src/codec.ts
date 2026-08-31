/**
 * Frame encoding and a streaming decoder.
 *
 * This is the only module that knows the byte layout. Everything above it
 * works with {@link Frame} values.
 *
 * The decoder is a state machine, not a "concatenate then parse" buffer: a
 * frame may arrive split across any number of carrier messages, and any
 * number of frames may arrive in one. It copies each byte exactly once, so a
 * 16 MiB frame delivered in 64 KiB chunks costs 16 MiB of copying, not 4 GiB.
 *
 * It never throws. Malformed input — a bad version, an unknown type, a length
 * over the limit, a payload that is not UTF-8 JSON, a control payload missing
 * a required member — comes back as a {@link ProtocolError} value. An
 * out-of-bounds read or an unhandled throw from here is a defect.
 *
 * @see PROTOCOL.md §3 "Frame header", §5 "Control payload schemas"
 */

import { ErrorCode, ProtocolError } from './errors.js';
import type {
  CancelPayload,
  CreditPayload,
  EndPayload,
  ErrorPayload,
  Frame,
  GoawayPayload,
  HelloAckPayload,
  HelloPayload,
  OpenAckPayload,
  OpenPayload,
  PingPayload,
  ResumeAckPayload,
  ResumeCursor,
  ResumeFailPayload,
  ResumeFailure,
  ResumePayload,
  StreamMode,
} from './types.js';
import {
  FRAME_HEADER_SIZE,
  FrameType,
  HARD_MAX_FRAME_SIZE,
  MAX_STREAM_ID,
  PROTOCOL_VERSION,
} from './types.js';

const textEncoder = /* @__PURE__ */ new TextEncoder();
const textDecoder = /* @__PURE__ */ new TextDecoder('utf-8', { fatal: true });

/** Frame types that address the connection and MUST carry `streamId = 0`. */
const CONNECTION_FRAME_TYPES: ReadonlySet<number> = new Set<number>([
  FrameType.HELLO,
  FrameType.HELLO_ACK,
  FrameType.RESUME,
  FrameType.RESUME_ACK,
  FrameType.RESUME_FAIL,
  FrameType.PING,
  FrameType.PONG,
  FrameType.GOAWAY,
]);

/** Frame types that address a stream and MUST carry `streamId != 0`. */
const STREAM_FRAME_TYPES: ReadonlySet<number> = new Set<number>([
  FrameType.OPEN,
  FrameType.OPEN_ACK,
  FrameType.DATA,
  FrameType.CREDIT,
  FrameType.END,
  FrameType.CANCEL,
]);

const KNOWN_FRAME_TYPES: ReadonlySet<number> = new Set<number>(Object.values(FrameType));

/* -------------------------------------------------------------------------- */
/*  Encoding                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Serialise one frame to bytes.
 *
 * Unlike decoding, encoding sees only local input, so an oversized frame is a
 * local defect and is reported by throwing.
 *
 * @param frame - The frame to serialise.
 * @param options - `maxFrameSize` caps the payload; defaults to the protocol
 *   hard maximum of 16 MiB.
 * @throws ProtocolError with `FRAME_TOO_LARGE` when the payload exceeds the
 *   effective limit.
 */
export function encodeFrame(frame: Frame, options?: { maxFrameSize?: number }): Uint8Array {
  const maxFrameSize = options?.maxFrameSize ?? HARD_MAX_FRAME_SIZE;
  const payload =
    frame.type === FrameType.DATA ? frame.payload : textEncoder.encode(JSON.stringify(frame.payload));

  if (payload.length > maxFrameSize) {
    throw new ProtocolError(
      ErrorCode.FRAME_TOO_LARGE,
      `frame payload of ${String(payload.length)} bytes exceeds maxFrameSize ${String(maxFrameSize)}`,
      { streamId: frame.streamId },
    );
  }

  const out = new Uint8Array(FRAME_HEADER_SIZE + payload.length);
  const view = new DataView(out.buffer);
  out[0] = PROTOCOL_VERSION;
  out[1] = frame.type;
  out[2] = frame.flags & 0xff;
  out[3] = 0; // reserved
  view.setUint32(4, frame.streamId, true);
  view.setUint32(8, frame.seq, true);
  view.setUint32(12, payload.length, true);
  out.set(payload, FRAME_HEADER_SIZE);
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Decoding                                                                   */
/* -------------------------------------------------------------------------- */

/** What one {@link FrameDecoder.push} produced. */
export interface DecodeResult {
  /** Frames completed by this chunk, in wire order. */
  readonly frames: readonly Frame[];
  /**
   * The fault that stopped decoding, or `null`. A decoder that has reported
   * an error is poisoned: every later `push` returns the same error and no
   * further frames, because every fault the codec can raise is fatal to the
   * connection (`PROTOCOL.md` §3.2).
   */
  readonly error: ProtocolError | null;
}

interface PendingHeader {
  readonly type: number;
  readonly flags: number;
  readonly streamId: number;
  readonly seq: number;
  readonly length: number;
}

const NO_FRAMES: readonly Frame[] = Object.freeze([]);

/**
 * A streaming frame parser.
 *
 * Feed it whatever the carrier delivers; it returns whole frames as they
 * complete and holds partial state in between.
 *
 * Memory note: once a header is parsed the decoder allocates a buffer of the
 * declared `length` before the payload arrives. That allocation is bounded by
 * the effective `maxFrameSize` and by one in-flight frame per connection, so
 * a peer cannot amplify it; the credit window (`PROTOCOL.md` §8.3) bounds
 * everything downstream of it.
 */
export class FrameDecoder {
  #maxFrameSize: number;
  readonly #header = new Uint8Array(FRAME_HEADER_SIZE);
  readonly #headerView: DataView;
  #headerLen = 0;
  #pending: PendingHeader | null = null;
  #payload: Uint8Array | null = null;
  #payloadLen = 0;
  #error: ProtocolError | null = null;

  constructor(options?: { maxFrameSize?: number }) {
    this.#maxFrameSize = clampMaxFrameSize(options?.maxFrameSize ?? HARD_MAX_FRAME_SIZE);
    this.#headerView = new DataView(this.#header.buffer);
  }

  /** The largest payload this decoder will accept. */
  get maxFrameSize(): number {
    return this.#maxFrameSize;
  }

  /**
   * Narrow the accepted frame size once `HELLO` / `HELLO_ACK` has settled the
   * effective limit (`PROTOCOL.md` §6.1). Never widens past the hard maximum.
   */
  setMaxFrameSize(bytes: number): void {
    this.#maxFrameSize = clampMaxFrameSize(bytes);
  }

  /** The fault that poisoned this decoder, or `null`. */
  get error(): ProtocolError | null {
    return this.#error;
  }

  /** True while a frame is partially received. */
  get hasPartialFrame(): boolean {
    return this.#headerLen > 0 || this.#pending !== null;
  }

  /** Drop all partial state. Does not clear a recorded error. */
  reset(): void {
    this.#headerLen = 0;
    this.#pending = null;
    this.#payload = null;
    this.#payloadLen = 0;
  }

  /** Feed the next bytes from the carrier. */
  push(chunk: Uint8Array): DecodeResult {
    if (this.#error !== null) return { frames: NO_FRAMES, error: this.#error };

    const frames: Frame[] = [];
    let offset = 0;

    while (offset < chunk.length) {
      if (this.#pending === null) {
        const wanted = FRAME_HEADER_SIZE - this.#headerLen;
        const take = Math.min(wanted, chunk.length - offset);
        this.#header.set(chunk.subarray(offset, offset + take), this.#headerLen);
        this.#headerLen += take;
        offset += take;
        if (this.#headerLen < FRAME_HEADER_SIZE) break;

        const parsed = this.#parseHeader();
        if (parsed instanceof ProtocolError) return this.#poison(parsed, frames);
        this.#headerLen = 0;
        this.#pending = parsed;
        this.#payload = new Uint8Array(parsed.length);
        this.#payloadLen = 0;
      }

      const pending = this.#pending;
      const payload = this.#payload as Uint8Array;
      const missing = pending.length - this.#payloadLen;
      if (missing > 0) {
        const take = Math.min(missing, chunk.length - offset);
        payload.set(chunk.subarray(offset, offset + take), this.#payloadLen);
        this.#payloadLen += take;
        offset += take;
        if (this.#payloadLen < pending.length) break;
      }

      this.#pending = null;
      this.#payload = null;
      this.#payloadLen = 0;

      const frame = buildFrame(pending, payload);
      if (frame instanceof ProtocolError) return this.#poison(frame, frames);
      frames.push(frame);
    }

    return { frames, error: null };
  }

  #poison(error: ProtocolError, frames: readonly Frame[]): DecodeResult {
    this.#error = error;
    this.reset();
    return { frames, error };
  }

  #parseHeader(): PendingHeader | ProtocolError {
    const version = this.#header[0] as number;
    const type = this.#header[1] as number;
    const flags = this.#header[2] as number;
    const streamId = this.#headerView.getUint32(4, true);
    const seq = this.#headerView.getUint32(8, true);
    const length = this.#headerView.getUint32(12, true);

    // Order matters: reject the version before anything else, and reject an
    // oversized length before a buffer is sized from it (PROTOCOL.md §3.2).
    if (version !== PROTOCOL_VERSION) {
      return new ProtocolError(
        ErrorCode.UNSUPPORTED_VERSION,
        `unsupported wire version ${String(version)}`,
      );
    }
    if (length > this.#maxFrameSize) {
      return new ProtocolError(
        ErrorCode.FRAME_TOO_LARGE,
        `frame length ${String(length)} exceeds maxFrameSize ${String(this.#maxFrameSize)}`,
      );
    }
    if (!KNOWN_FRAME_TYPES.has(type)) {
      return new ProtocolError(
        ErrorCode.PROTOCOL_VIOLATION,
        `unknown frame type 0x${type.toString(16).padStart(2, '0')}`,
      );
    }
    if (streamId === 0 && STREAM_FRAME_TYPES.has(type)) {
      return new ProtocolError(
        ErrorCode.PROTOCOL_VIOLATION,
        `frame type 0x${type.toString(16).padStart(2, '0')} requires a non-zero streamId`,
      );
    }
    if (streamId !== 0 && CONNECTION_FRAME_TYPES.has(type)) {
      return new ProtocolError(
        ErrorCode.PROTOCOL_VIOLATION,
        `frame type 0x${type.toString(16).padStart(2, '0')} must carry streamId 0`,
      );
    }

    return { type, flags, streamId, seq, length };
  }
}

/**
 * Decode exactly one frame from a complete buffer.
 *
 * A convenience over {@link FrameDecoder} for callers that already hold a
 * whole frame. Trailing bytes and a truncated frame are both faults.
 */
export function decodeFrame(
  bytes: Uint8Array,
  options?: { maxFrameSize?: number },
): Frame | ProtocolError {
  const decoder = new FrameDecoder(options);
  const result = decoder.push(bytes);
  if (result.error !== null) return result.error;
  const [frame, ...rest] = result.frames;
  if (frame === undefined) {
    return new ProtocolError(ErrorCode.PROTOCOL_VIOLATION, 'buffer holds no complete frame');
  }
  if (rest.length > 0 || decoder.hasPartialFrame) {
    return new ProtocolError(ErrorCode.PROTOCOL_VIOLATION, 'buffer holds more than one frame');
  }
  return frame;
}

function clampMaxFrameSize(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return HARD_MAX_FRAME_SIZE;
  return Math.min(bytes, HARD_MAX_FRAME_SIZE);
}

/* -------------------------------------------------------------------------- */
/*  Control payload validation (PROTOCOL.md §5)                                */
/* -------------------------------------------------------------------------- */

function buildFrame(header: PendingHeader, payload: Uint8Array): Frame | ProtocolError {
  const { type, flags, streamId, seq } = header;

  if (type === FrameType.DATA) {
    return { type: FrameType.DATA, flags, streamId, seq, payload };
  }

  const json = parseControlPayload(payload, streamId);
  if (json instanceof ProtocolError) return json;

  switch (type) {
    case FrameType.HELLO: {
      const p = readHello(json, streamId);
      return p instanceof ProtocolError ? p : { type, flags, streamId, seq, payload: p };
    }
    case FrameType.HELLO_ACK: {
      const p = readHelloAck(json, streamId);
      return p instanceof ProtocolError ? p : { type, flags, streamId, seq, payload: p };
    }
    case FrameType.OPEN: {
      const p = readOpen(json, streamId);
      return p instanceof ProtocolError ? p : { type, flags, streamId, seq, payload: p };
    }
    case FrameType.OPEN_ACK: {
      const p = readOpenAck(json, streamId);
      return p instanceof ProtocolError ? p : { type, flags, streamId, seq, payload: p };
    }
    case FrameType.CREDIT: {
      const p = readCredit(json, streamId);
      return p instanceof ProtocolError ? p : { type, flags, streamId, seq, payload: p };
    }
    case FrameType.END: {
      const p: EndPayload = json;
      return { type, flags, streamId, seq, payload: p };
    }
    case FrameType.ERROR: {
      const p = readError(json, streamId);
      return p instanceof ProtocolError ? p : { type, flags, streamId, seq, payload: p };
    }
    case FrameType.CANCEL: {
      const p = readCancel(json, streamId);
      return p instanceof ProtocolError ? p : { type, flags, streamId, seq, payload: p };
    }
    case FrameType.RESUME: {
      const p = readResume(json, streamId);
      return p instanceof ProtocolError ? p : { type, flags, streamId, seq, payload: p };
    }
    case FrameType.RESUME_ACK: {
      const p = readResumeAck(json, streamId);
      return p instanceof ProtocolError ? p : { type, flags, streamId, seq, payload: p };
    }
    case FrameType.RESUME_FAIL: {
      const p = readResumeFail(json, streamId);
      return p instanceof ProtocolError ? p : { type, flags, streamId, seq, payload: p };
    }
    case FrameType.PING:
    case FrameType.PONG: {
      const p = readPing(json, streamId);
      return p instanceof ProtocolError ? p : { type, flags, streamId, seq, payload: p };
    }
    case FrameType.GOAWAY: {
      const p = readGoaway(json, streamId);
      return p instanceof ProtocolError ? p : { type, flags, streamId, seq, payload: p };
    }
    /* c8 ignore next 3 -- unknown types are rejected in #parseHeader */
    default:
      return violation(streamId, `unknown frame type ${String(type)}`);
  }
}

function violation(streamId: number, message: string): ProtocolError {
  return new ProtocolError(ErrorCode.PROTOCOL_VIOLATION, message, { streamId });
}

function parseControlPayload(
  payload: Uint8Array,
  streamId: number,
): Record<string, unknown> | ProtocolError {
  let text: string;
  try {
    text = textDecoder.decode(payload);
  } catch {
    return violation(streamId, 'control payload is not valid UTF-8');
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return violation(streamId, 'control payload is not valid JSON');
  }
  if (!isPlainObject(value)) return violation(streamId, 'control payload is not a JSON object');
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isU32(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_STREAM_ID;
}

function readHello(o: Record<string, unknown>, streamId: number): HelloPayload | ProtocolError {
  const versions = o['versions'];
  if (!Array.isArray(versions) || !versions.every((v) => Number.isSafeInteger(v))) {
    return violation(streamId, 'HELLO.versions must be an array of integers');
  }
  const maxFrameSize = o['maxFrameSize'];
  if (maxFrameSize !== undefined && !isU32(maxFrameSize)) {
    return violation(streamId, 'HELLO.maxFrameSize must be a non-negative integer');
  }
  const maxStreams = o['maxStreams'];
  if (maxStreams !== undefined && !isU32(maxStreams)) {
    return violation(streamId, 'HELLO.maxStreams must be a non-negative integer');
  }
  const client = o['client'];
  if (client !== undefined && typeof client !== 'string') {
    return violation(streamId, 'HELLO.client must be a string');
  }
  return {
    versions: versions as number[],
    ...(maxFrameSize === undefined ? {} : { maxFrameSize }),
    ...(maxStreams === undefined ? {} : { maxStreams }),
    ...(client === undefined ? {} : { client }),
  };
}

function readHelloAck(
  o: Record<string, unknown>,
  streamId: number,
): HelloAckPayload | ProtocolError {
  const version = o['version'];
  const sessionId = o['sessionId'];
  const maxFrameSize = o['maxFrameSize'];
  const maxStreams = o['maxStreams'];
  const initialCredit = o['initialCredit'];
  const resumeWindow = o['resumeWindow'];
  const heartbeatMs = o['heartbeatMs'];

  if (!Number.isSafeInteger(version)) return violation(streamId, 'HELLO_ACK.version must be an integer');
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return violation(streamId, 'HELLO_ACK.sessionId must be a non-empty string');
  }
  if (!isU32(maxFrameSize)) return violation(streamId, 'HELLO_ACK.maxFrameSize must be an integer');
  if (!isU32(maxStreams)) return violation(streamId, 'HELLO_ACK.maxStreams must be an integer');
  if (!isU32(initialCredit)) return violation(streamId, 'HELLO_ACK.initialCredit must be an integer');
  if (!isU32(heartbeatMs)) return violation(streamId, 'HELLO_ACK.heartbeatMs must be an integer');
  if (!isPlainObject(resumeWindow)) return violation(streamId, 'HELLO_ACK.resumeWindow must be an object');
  const bytes = resumeWindow['bytes'];
  const frames = resumeWindow['frames'];
  if (!isU32(bytes) || !isU32(frames)) {
    return violation(streamId, 'HELLO_ACK.resumeWindow.{bytes,frames} must be integers');
  }

  return {
    version: version as number,
    sessionId,
    maxFrameSize,
    maxStreams,
    initialCredit,
    resumeWindow: { bytes, frames },
    heartbeatMs,
  };
}

const STREAM_MODES: ReadonlySet<string> = new Set(['read', 'write', 'duplex']);

function readOpen(o: Record<string, unknown>, streamId: number): OpenPayload | ProtocolError {
  const name = o['name'];
  if (typeof name !== 'string') return violation(streamId, 'OPEN.name must be a string');
  const params = o['params'];
  if (params !== undefined && !isPlainObject(params)) {
    return violation(streamId, 'OPEN.params must be an object');
  }
  const mode = o['mode'];
  if (mode !== undefined && (typeof mode !== 'string' || !STREAM_MODES.has(mode))) {
    return violation(streamId, 'OPEN.mode must be "read", "write" or "duplex"');
  }
  const credit = o['credit'];
  if (credit !== undefined && !isU32(credit)) {
    return violation(streamId, 'OPEN.credit must be a non-negative integer');
  }
  return {
    name,
    ...(params === undefined ? {} : { params }),
    ...(mode === undefined ? {} : { mode: mode as StreamMode }),
    ...(credit === undefined ? {} : { credit }),
  };
}

function readOpenAck(o: Record<string, unknown>, streamId: number): OpenAckPayload | ProtocolError {
  const credit = o['credit'];
  if (credit !== undefined && !isU32(credit)) {
    return violation(streamId, 'OPEN_ACK.credit must be a non-negative integer');
  }
  return credit === undefined ? {} : { credit };
}

function readCredit(o: Record<string, unknown>, streamId: number): CreditPayload | ProtocolError {
  const bytes = o['bytes'];
  // Only the *type* is checked here. A non-integer or non-positive increment
  // is a stream-level FLOW_CONTROL_ERROR, not a codec fault (PROTOCOL.md §5.5,
  // §8.2), so it is the mux's decision to make.
  if (typeof bytes !== 'number') return violation(streamId, 'CREDIT.bytes must be a number');
  return { bytes };
}

function readError(o: Record<string, unknown>, streamId: number): ErrorPayload | ProtocolError {
  const code = o['code'];
  if (typeof code !== 'string') return violation(streamId, 'ERROR.code must be a string');
  const message = o['message'];
  if (message !== undefined && typeof message !== 'string') {
    return violation(streamId, 'ERROR.message must be a string');
  }
  const retryable = o['retryable'];
  if (retryable !== undefined && typeof retryable !== 'boolean') {
    return violation(streamId, 'ERROR.retryable must be a boolean');
  }
  return {
    code,
    ...(message === undefined ? {} : { message }),
    ...(retryable === undefined ? {} : { retryable }),
  };
}

function readCancel(o: Record<string, unknown>, streamId: number): CancelPayload | ProtocolError {
  const reason = o['reason'];
  if (reason !== undefined && typeof reason !== 'string') {
    return violation(streamId, 'CANCEL.reason must be a string');
  }
  return reason === undefined ? {} : { reason };
}

function readResume(o: Record<string, unknown>, streamId: number): ResumePayload | ProtocolError {
  const sessionId = o['sessionId'];
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return violation(streamId, 'RESUME.sessionId must be a non-empty string');
  }
  const streams = o['streams'];
  if (!Array.isArray(streams)) return violation(streamId, 'RESUME.streams must be an array');
  const cursors: ResumeCursor[] = [];
  for (const entry of streams) {
    if (!isPlainObject(entry) || !isU32(entry['streamId']) || !isU32(entry['lastSeq'])) {
      return violation(streamId, 'RESUME.streams entries need integer streamId and lastSeq');
    }
    cursors.push({ streamId: entry['streamId'], lastSeq: entry['lastSeq'] });
  }
  return { sessionId, streams: cursors };
}

function readResumeAck(
  o: Record<string, unknown>,
  streamId: number,
): ResumeAckPayload | ProtocolError {
  const sessionId = o['sessionId'];
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return violation(streamId, 'RESUME_ACK.sessionId must be a non-empty string');
  }
  const resumed = o['resumed'];
  if (!Array.isArray(resumed) || !resumed.every(isU32)) {
    return violation(streamId, 'RESUME_ACK.resumed must be an array of integers');
  }
  const failed = o['failed'];
  if (!Array.isArray(failed)) return violation(streamId, 'RESUME_ACK.failed must be an array');
  const failures: ResumeFailure[] = [];
  for (const entry of failed) {
    if (!isPlainObject(entry) || !isU32(entry['streamId']) || typeof entry['code'] !== 'string') {
      return violation(streamId, 'RESUME_ACK.failed entries need integer streamId and string code');
    }
    failures.push({ streamId: entry['streamId'], code: entry['code'] });
  }
  return { sessionId, resumed: resumed as number[], failed: failures };
}

function readResumeFail(
  o: Record<string, unknown>,
  streamId: number,
): ResumeFailPayload | ProtocolError {
  const code = o['code'];
  if (code !== 'SESSION_UNKNOWN' && code !== 'SESSION_EXPIRED') {
    return violation(streamId, 'RESUME_FAIL.code must be SESSION_UNKNOWN or SESSION_EXPIRED');
  }
  const message = o['message'];
  if (message !== undefined && typeof message !== 'string') {
    return violation(streamId, 'RESUME_FAIL.message must be a string');
  }
  return { code, ...(message === undefined ? {} : { message }) };
}

function readPing(o: Record<string, unknown>, streamId: number): PingPayload | ProtocolError {
  const nonce = o['nonce'];
  if (typeof nonce !== 'string') return violation(streamId, 'PING/PONG.nonce must be a string');
  const at = o['at'];
  if (at !== undefined && !Number.isSafeInteger(at)) {
    return violation(streamId, 'PING/PONG.at must be an integer');
  }
  return { nonce, ...(at === undefined ? {} : { at: at as number }) };
}

function readGoaway(o: Record<string, unknown>, streamId: number): GoawayPayload | ProtocolError {
  const code = o['code'];
  if (typeof code !== 'string') return violation(streamId, 'GOAWAY.code must be a string');
  const lastStreamId = o['lastStreamId'];
  if (!isU32(lastStreamId)) {
    return violation(streamId, 'GOAWAY.lastStreamId must be a non-negative integer');
  }
  const message = o['message'];
  if (message !== undefined && typeof message !== 'string') {
    return violation(streamId, 'GOAWAY.message must be a string');
  }
  return { code, lastStreamId, ...(message === undefined ? {} : { message }) };
}
