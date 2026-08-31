/**
 * The stream multiplexer: `BridgeEndpoint` and `BridgeStream`.
 *
 * One `BridgeEndpoint` is one protocol session. It is symmetric — the same
 * class runs on both sides of the wire — and it owns no socket. A carrier is
 * *attached* to it, and may be replaced: that is what makes resume possible,
 * because the session (stream table, sequence cursors, replay buffers)
 * outlives the connection that carried it.
 *
 * @see PROTOCOL.md §7 "Stream lifecycle", §8 "Flow control", §9 "Resume"
 */

import { FrameDecoder, encodeFrame } from './codec.js';
import {
  BridgeError,
  ConnectionClosedError,
  ConnectionClosedError as ConnectionClosed,
  ErrorCode,
  ProtocolError,
  ResumeFailedError,
  SnapshotRequiredError,
  StreamError,
} from './errors.js';
import type { ReplayWindow } from './resume.js';
import { DEFAULT_REPLAY_WINDOW, ReplayBuffer, SeqCounter, SeqTracker, planReplay } from './resume.js';
import type {
  Carrier,
  Frame,
  FrameOf,
  HelloAckPayload,
  ResumeAckPayload,
  ResumeCursor,
  ResumeFailure,
  SequencedFrame,
  StreamGrant,
  StreamMode,
  StreamState,
} from './types.js';
import {
  FrameFlags,
  FrameType,
  HARD_MAX_FRAME_SIZE,
  MAX_CREDIT,
  MAX_STREAM_ID,
  PROTOCOL_DEFAULTS,
  PROTOCOL_VERSION,
  defaultCreditGrantThreshold,
} from './types.js';

/* -------------------------------------------------------------------------- */
/*  Small internals                                                            */
/* -------------------------------------------------------------------------- */

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Nobody is required to await `opened` or `closed`. Keeping a no-op handler
  // attached stops an unobserved rejection from becoming a process warning.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** Concatenate byte chunks into one buffer. */
function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * A session identifier: 128 bits of CSPRNG output, hex encoded.
 *
 * Uses the Web Crypto global, which every runtime this package targets
 * provides (Node >= 20, Bun, Deno, browsers), so core keeps its zero-runtime
 * -dependency guarantee.
 *
 * @see PROTOCOL.md §6.1
 */
export function generateSessionId(): string {
  const webcrypto = globalThis.crypto;
  if (webcrypto?.getRandomValues === undefined) {
    throw new BridgeError(
      ErrorCode.INTERNAL_ERROR,
      'no Web Crypto implementation available to mint a session id',
    );
  }
  const bytes = new Uint8Array(16);
  webcrypto.getRandomValues(bytes);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/* -------------------------------------------------------------------------- */
/*  Stream                                                                     */
/* -------------------------------------------------------------------------- */

/** What a {@link BridgeStream} needs from the endpoint that owns it. */
interface StreamHost {
  readonly initialCredit: number;
  readonly creditGrantThreshold: number;
  readonly maxDataPayload: number;
  /** False while no carrier is bound, so nothing can reach the peer. */
  readonly attached: boolean;
  sendStreamFrame(frame: Frame): void;
  releaseStream(streamId: number): void;
  noteFlowViolation(): void;
}

/** Options accepted when opening a stream. */
export interface OpenStreamOptions {
  /** Opaque route parameters, passed through to the peer. */
  readonly params?: Readonly<Record<string, unknown>>;
  /** Direction the initiator intends to use. Default `"duplex"`. */
  readonly mode?: StreamMode;
  /** Credit the initiator grants the responder. Default: negotiated initial credit. */
  readonly credit?: number;
}

/**
 * One logical, ordered byte channel multiplexed over the connection.
 *
 * Read it by iterating: `for await (const chunk of stream)`. Iterating is what
 * grants credit, so a consumer that stops reading applies backpressure to the
 * producer instead of growing a buffer.
 *
 * Write with `await stream.write(bytes)`. The promise settles when the bytes
 * have been handed to the protocol, which happens only as credit allows — so
 * a blocked writer is visible to the caller rather than hidden in a queue.
 */
export class BridgeStream implements AsyncIterable<Uint8Array> {
  /** The stream identifier. Odd for client-initiated, even for server-initiated. */
  readonly id: number;
  /** The route named in `OPEN`. */
  readonly name: string;
  /** Direction declared by the initiator. */
  readonly mode: StreamMode;
  /** Route parameters carried by `OPEN`. */
  readonly params: Readonly<Record<string, unknown>>;
  /** True when this endpoint sent the `OPEN`. */
  readonly initiator: boolean;

  readonly #host: StreamHost;
  #state: StreamState;

  // Send side.
  readonly #seq = new SeqCounter();
  #sendCredit: number;
  #sentBytes = 0;
  #sendEnded = false;
  #creditWaiters: Deferred<void>[] = [];
  #writeChain: Promise<void> = Promise.resolve();

  // Receive side.
  readonly #recvSeq = new SeqTracker();
  #peerCredit: number;
  /**
   * Every payload byte this endpoint has ever granted the peer on this
   * stream. `CREDIT` is unsequenced and never replayed, so a grant handed to
   * a dying socket is lost while this side has already counted it; the
   * running total is what lets a resume restore the window exactly
   * (`PROTOCOL.md` §9.4).
   */
  #grantedTotal: number;
  #ungranted = 0;
  #queue: Uint8Array[] = [];
  #readWaiters: Deferred<void>[] = [];
  #recvEnded = false;
  #openAcked = false;

  #failure: BridgeError | null = null;
  readonly #opened = deferred<void>();
  readonly #closed = deferred<void>();

  /** @internal Constructed by {@link BridgeEndpoint}, never directly. */
  constructor(
    host: StreamHost,
    init: {
      id: number;
      name: string;
      mode: StreamMode;
      params: Readonly<Record<string, unknown>>;
      initiator: boolean;
      sendCredit: number;
      peerCredit: number;
    },
  ) {
    this.#host = host;
    this.id = init.id;
    this.name = init.name;
    this.mode = init.mode;
    this.params = init.params;
    this.initiator = init.initiator;
    this.#state = init.initiator ? 'opening' : 'open';
    this.#sendCredit = init.sendCredit;
    this.#peerCredit = init.peerCredit;
    this.#grantedTotal = init.peerCredit;
    if (!init.initiator) {
      this.#openAcked = true;
      this.#opened.resolve();
    }
  }

  /** Current lifecycle state. @see PROTOCOL.md §7.2 */
  get state(): StreamState {
    return this.#state;
  }

  /** Payload bytes this endpoint may still send before it must await credit. */
  get sendCredit(): number {
    return this.#sendCredit;
  }

  /** Payload bytes the peer may still send before it must await credit. */
  get peerCredit(): number {
    return this.#peerCredit;
  }

  /** Bytes received but not yet taken by a consumer. */
  get bufferedBytes(): number {
    let total = 0;
    for (const chunk of this.#queue) total += chunk.length;
    return total;
  }

  /**
   * Resolves when the peer accepts the stream (`OPEN_ACK`), rejects when it
   * rejects it. Awaiting is optional: writing before the acknowledgement is
   * legal and is what makes a unary call one round trip.
   *
   * @see PROTOCOL.md §7.3
   */
  get opened(): Promise<void> {
    return this.#opened.promise;
  }

  /** Resolves when the stream closes cleanly, rejects with the fault that ended it. */
  get closed(): Promise<void> {
    return this.#closed.promise;
  }

  /** The fault that ended this stream, or `null`. */
  get failure(): BridgeError | null {
    return this.#failure;
  }

  /* ---------------------------------------------------------------------- */
  /*  Reading                                                                */
  /* ---------------------------------------------------------------------- */

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return this.#iterate();
  }

  async *#iterate(): AsyncGenerator<Uint8Array, void, undefined> {
    for (;;) {
      const chunk = this.#queue.shift();
      if (chunk !== undefined) {
        this.#onConsumed(chunk.length);
        yield chunk;
        continue;
      }
      if (this.#failure !== null) throw this.#failure;
      if (this.#recvEnded) return;
      const waiter = deferred<void>();
      this.#readWaiters.push(waiter);
      await waiter.promise;
    }
  }

  /** Read the whole stream into one buffer. Convenience for unary payloads. */
  async readAll(): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of this) chunks.push(chunk);
    return concatBytes(chunks);
  }

  /* ---------------------------------------------------------------------- */
  /*  Writing                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Send bytes, awaiting credit as needed.
   *
   * Concurrent calls are serialised, so bytes leave in call order and a
   * blocked write never lets a later one overtake it.
   */
  write(bytes: Uint8Array): Promise<void> {
    return this.#enqueueWrite(bytes, false);
  }

  /**
   * Close this endpoint's sending direction.
   *
   * With `bytes`, they are sent as the final `DATA` frame carrying `FIN`,
   * which is what a unary call uses to spend one frame instead of two.
   * Without, an `END` frame is sent.
   *
   * @see PROTOCOL.md §7.5
   */
  end(bytes?: Uint8Array): Promise<void> {
    return this.#enqueueWrite(bytes ?? new Uint8Array(0), true);
  }

  #enqueueWrite(bytes: Uint8Array, fin: boolean): Promise<void> {
    const run = this.#writeChain.then(
      () => this.#write(bytes, fin),
      () => this.#write(bytes, fin),
    );
    // The chain must survive a rejected write, or every later write inherits
    // the failure. Callers still see their own rejection through `run`.
    this.#writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Issue the next sequence number, closing the stream if the `u32` space is
   * spent. `PROTOCOL.md` §9.1 forbids wrap-around, so the stream ends rather
   * than reusing a number a replay could not tell apart.
   */
  #nextSeq(): number {
    if (!this.#seq.exhausted) return this.#seq.next(this.id);
    const error = new StreamError(
      ErrorCode.SEQ_EXHAUSTED,
      `stream ${String(this.id)} exhausted its sequence space`,
      { streamId: this.id },
    );
    this.#host.sendStreamFrame({
      type: FrameType.ERROR,
      streamId: this.id,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { code: error.code, message: error.message },
    });
    this.#fail(error);
    throw error;
  }

  async #write(bytes: Uint8Array, fin: boolean): Promise<void> {
    this.#assertWritable();

    let offset = 0;
    // A zero-length write with FIN still has to emit the terminator, so the
    // loop body runs at least once when `fin` is set.
    while (offset < bytes.length) {
      if (this.#sendCredit <= 0) await this.#awaitCredit();
      this.#assertWritable();
      const take = Math.min(bytes.length - offset, this.#sendCredit, this.#host.maxDataPayload);
      const chunk = bytes.slice(offset, offset + take);
      offset += take;
      const last = fin && offset === bytes.length;
      this.#sendCredit -= take;
      this.#sentBytes += take;
      this.#host.sendStreamFrame({
        type: FrameType.DATA,
        streamId: this.id,
        seq: this.#nextSeq(),
        flags: last ? FrameFlags.FIN : FrameFlags.NONE,
        payload: chunk,
      });
      if (last) this.#afterLocalEnd();
    }

    if (fin && !this.#sendEnded) {
      this.#host.sendStreamFrame({
        type: FrameType.END,
        streamId: this.id,
        seq: this.#nextSeq(),
        flags: FrameFlags.NONE,
        payload: {},
      });
      this.#afterLocalEnd();
    }
  }

  #assertWritable(): void {
    if (this.#failure !== null) throw this.#failure;
    if (this.#sendEnded) {
      throw new StreamError(
        ErrorCode.STREAM_STATE_ERROR,
        `stream ${String(this.id)} has already ended its sending direction`,
        { streamId: this.id },
      );
    }
    if (this.#state === 'closed' || this.#state === 'reaped') {
      throw new StreamError(ErrorCode.STREAM_CLOSED, `stream ${String(this.id)} is closed`, {
        streamId: this.id,
      });
    }
    const readOnly = this.initiator ? this.mode === 'read' : this.mode === 'write';
    if (readOnly) {
      throw new StreamError(
        ErrorCode.STREAM_STATE_ERROR,
        `stream ${String(this.id)} was opened in "${this.mode}" mode and may not be written here`,
        { streamId: this.id },
      );
    }
  }

  async #awaitCredit(): Promise<void> {
    const waiter = deferred<void>();
    this.#creditWaiters.push(waiter);
    await waiter.promise;
  }

  /**
   * Abandon the stream. The peer stops producing, buffers are released, and
   * no `END` follows.
   *
   * @see PROTOCOL.md §7.5
   */
  cancel(reason?: string): void {
    if (this.#state === 'closed' || this.#state === 'reaped') return;
    this.#host.sendStreamFrame({
      type: FrameType.CANCEL,
      streamId: this.id,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: reason === undefined ? {} : { reason },
    });
    this.#fail(
      new StreamError(ErrorCode.CANCELLED, reason ?? 'stream cancelled locally', {
        streamId: this.id,
      }),
    );
  }

  /**
   * Fail the stream with a stream-level `ERROR`.
   *
   * `PROTOCOL.md` §10 lets a responder answer a call with an `ERROR` instead
   * of a response payload, and a route handler that fails *after* it returned
   * needs a way to say so. `cancel()` cannot: it carries no code, and a
   * cancellation is not a fault.
   *
   * The connection is unaffected — only this stream ends.
   *
   * @see PROTOCOL.md §5.7, §10
   */
  error(code: ErrorCode, message: string): void {
    if (this.#state === 'closed' || this.#state === 'reaped') return;
    this.#host.sendStreamFrame({
      type: FrameType.ERROR,
      streamId: this.id,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { code, message },
    });
    this.#fail(new StreamError(code, message, { streamId: this.id }));
  }

  /* ---------------------------------------------------------------------- */
  /*  Internals driven by the endpoint                                       */
  /* ---------------------------------------------------------------------- */

  /** @internal The cursor to advertise in a `RESUME` request. */
  get lastReceivedSeq(): number {
    return this.#recvSeq.lastSeq;
  }

  /** @internal Cumulative payload bytes granted to the peer on this stream. */
  get grantedTotal(): number {
    return this.#grantedTotal;
  }

  /**
   * Restore the send window from the peer's cumulative grant.
   *
   * Absolute, not an increment, so applying it twice is the same as applying
   * it once — which is what makes it safe to send on every resume regardless
   * of which grants the dead socket swallowed. The result may be negative
   * when this side sent optimistically past the grant (`PROTOCOL.md` §8.1
   * rule 2); the writer then waits for `CREDIT` as usual.
   *
   * @internal
   */
  resyncSendCredit(peerGrantedTotal: number): void {
    const restored = peerGrantedTotal - this.#sentBytes;
    if (restored === this.#sendCredit) return;
    this.#sendCredit = restored;
    if (restored > 0) this.#wakeWriters();
  }

  /** @internal True while the stream still has state worth resuming. */
  get resumable(): boolean {
    return this.#state !== 'closed' && this.#state !== 'reaped';
  }

  /** @internal Handle a frame addressed to this stream. */
  handleFrame(frame: Frame): ProtocolError | null {
    switch (frame.type) {
      case FrameType.OPEN_ACK:
        return this.#onOpenAck(frame);
      case FrameType.DATA:
        return this.#onData(frame);
      case FrameType.END:
        return this.#onEnd(frame);
      case FrameType.CREDIT:
        return this.#onCredit(frame);
      case FrameType.CANCEL:
        this.#fail(
          new StreamError(ErrorCode.CANCELLED, frame.payload.reason ?? 'cancelled by peer', {
            streamId: this.id,
            remote: true,
          }),
        );
        return null;
      case FrameType.ERROR:
        this.#fail(remoteStreamError(this.id, frame.payload.code, frame.payload.message));
        return null;
      default:
        return new ProtocolError(
          ErrorCode.STREAM_STATE_ERROR,
          `frame type 0x${frame.type.toString(16)} is illegal on stream ${String(this.id)}`,
          { streamId: this.id, scope: 'stream' },
        );
    }
  }

  #onOpenAck(frame: FrameOf<typeof FrameType.OPEN_ACK>): ProtocolError | null {
    if (!this.initiator || this.#openAcked) {
      return new ProtocolError(
        ErrorCode.STREAM_STATE_ERROR,
        `unexpected OPEN_ACK on stream ${String(this.id)}`,
        { streamId: this.id, scope: 'stream' },
      );
    }
    this.#openAcked = true;
    // The responder's grant is the real window. Bytes already sent
    // optimistically while `opening` were counted by the responder against
    // this same window, so they are deducted here (PROTOCOL.md §8.1).
    const granted = frame.payload.credit ?? this.#host.initialCredit;
    this.#sendCredit = granted - this.#sentBytes;
    if (this.#state === 'opening') this.#state = 'open';
    this.#opened.resolve();
    this.#wakeWriters();
    return null;
  }

  #onData(frame: FrameOf<typeof FrameType.DATA>): ProtocolError | null {
    if (this.#recvEnded) {
      return new ProtocolError(
        ErrorCode.STREAM_STATE_ERROR,
        `DATA after the peer ended stream ${String(this.id)}`,
        { streamId: this.id, scope: 'stream' },
      );
    }

    const replay = (frame.flags & FrameFlags.REPLAY) !== 0;
    const verdict = this.#recvSeq.accept(frame.seq, replay, this.id);
    if (verdict instanceof ProtocolError) return verdict;
    // A replayed duplicate was already accounted for on its first delivery;
    // charging it again would silently shrink the peer's window.
    if (verdict === 'discard') return null;

    const length = frame.payload.length;
    if (length > this.#peerCredit) {
      this.#host.noteFlowViolation();
      return new ProtocolError(
        ErrorCode.FLOW_CONTROL_ERROR,
        `stream ${String(this.id)} received ${String(length)} bytes with ${String(this.#peerCredit)} credit granted`,
        { streamId: this.id, scope: 'stream' },
      );
    }
    this.#peerCredit -= length;

    if (length > 0) {
      this.#queue.push(frame.payload);
      this.#wakeReaders();
    }
    if ((frame.flags & FrameFlags.FIN) !== 0) this.#afterRemoteEnd();
    return null;
  }

  #onEnd(frame: FrameOf<typeof FrameType.END>): ProtocolError | null {
    if (this.#recvEnded) {
      return new ProtocolError(
        ErrorCode.STREAM_STATE_ERROR,
        `duplicate END on stream ${String(this.id)}`,
        { streamId: this.id, scope: 'stream' },
      );
    }
    const replay = (frame.flags & FrameFlags.REPLAY) !== 0;
    const verdict = this.#recvSeq.accept(frame.seq, replay, this.id);
    if (verdict instanceof ProtocolError) return verdict;
    if (verdict === 'discard') return null;
    this.#afterRemoteEnd();
    return null;
  }

  #onCredit(frame: FrameOf<typeof FrameType.CREDIT>): ProtocolError | null {
    const { bytes } = frame.payload;
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      this.#host.noteFlowViolation();
      return new ProtocolError(
        ErrorCode.FLOW_CONTROL_ERROR,
        `CREDIT increment must be a positive integer, received ${String(bytes)}`,
        { streamId: this.id, scope: 'stream' },
      );
    }
    if (this.#sendCredit + bytes > MAX_CREDIT) {
      this.#host.noteFlowViolation();
      return new ProtocolError(
        ErrorCode.FLOW_CONTROL_ERROR,
        `CREDIT increment would push stream ${String(this.id)} above the maximum window`,
        { streamId: this.id, scope: 'stream' },
      );
    }
    this.#sendCredit += bytes;
    this.#wakeWriters();
    return null;
  }

  /** @internal Grant credit as the consumer drains the receive queue. */
  #onConsumed(bytes: number): void {
    this.#ungranted += bytes;
    this.#maybeGrant(false);
  }

  /**
   * Emit the accumulated grant once a carrier is back.
   *
   * `CREDIT` is unsequenced, so it is never replayed (`PROTOCOL.md` §9.4).
   * Grants that came due while detached are therefore held, not lost, and are
   * released here — otherwise the peer's window would shrink by exactly the
   * amount the dead socket swallowed.
   *
   * @internal
   */
  grantPending(): void {
    this.#maybeGrant(true);
  }

  #maybeGrant(force: boolean): void {
    if (this.#ungranted <= 0) return;
    if (this.#recvEnded || this.#state === 'closed' || this.#state === 'reaped') return;
    if (!this.#host.attached) return;
    const enough = this.#ungranted >= this.#host.creditGrantThreshold;
    const starved = this.#peerCredit === 0;
    if (!force && !enough && !starved) return;
    const grant = Math.min(this.#ungranted, MAX_CREDIT - this.#peerCredit);
    if (grant <= 0) return;
    this.#ungranted -= grant;
    this.#peerCredit += grant;
    this.#grantedTotal += grant;
    this.#host.sendStreamFrame({
      type: FrameType.CREDIT,
      streamId: this.id,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { bytes: grant },
    });
  }

  #afterLocalEnd(): void {
    if (this.#sendEnded) return;
    this.#sendEnded = true;
    this.#state = this.#recvEnded ? 'closed' : 'half-closed-local';
    if (this.#state === 'closed') this.#finish();
  }

  #afterRemoteEnd(): void {
    if (this.#recvEnded) return;
    this.#recvEnded = true;
    this.#state = this.#sendEnded ? 'closed' : 'half-closed-remote';
    this.#wakeReaders();
    if (this.#state === 'closed') this.#finish();
  }

  /** @internal Tear the stream down without emitting anything. */
  fail(error: BridgeError): void {
    this.#fail(error);
  }

  #fail(error: BridgeError): void {
    if (this.#state === 'closed' || this.#state === 'reaped') return;
    this.#failure = error;
    this.#state = 'closed';
    this.#queue = [];
    this.#ungranted = 0;
    this.#opened.reject(error);
    this.#closed.reject(error);
    this.#wakeReaders();
    this.#rejectWriters(error);
    this.#host.releaseStream(this.id);
  }

  #finish(): void {
    this.#closed.resolve();
    this.#wakeReaders();
    this.#rejectWriters(
      new StreamError(ErrorCode.STREAM_CLOSED, `stream ${String(this.id)} closed`, {
        streamId: this.id,
      }),
    );
    this.#host.releaseStream(this.id);
  }

  #wakeReaders(): void {
    const waiters = this.#readWaiters;
    this.#readWaiters = [];
    for (const waiter of waiters) waiter.resolve();
  }

  #wakeWriters(): void {
    const waiters = this.#creditWaiters;
    this.#creditWaiters = [];
    for (const waiter of waiters) waiter.resolve();
  }

  #rejectWriters(error: BridgeError): void {
    const waiters = this.#creditWaiters;
    this.#creditWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }
}

function remoteStreamError(streamId: number, code: string, message?: string): StreamError {
  const known = isKnownCode(code) ? code : ErrorCode.INTERNAL_ERROR;
  return new StreamError(known, message ?? `peer ended stream ${String(streamId)} with ${code}`, {
    streamId,
    remote: true,
  });
}

function isKnownCode(code: string): code is ErrorCode {
  return Object.hasOwn(ErrorCode, code);
}

/* -------------------------------------------------------------------------- */
/*  Endpoint                                                                   */
/* -------------------------------------------------------------------------- */

/** Connection-level lifecycle of a {@link BridgeEndpoint}. */
export type EndpointState = 'idle' | 'handshaking' | 'open' | 'detached' | 'closed';

/**
 * Advanced options for {@link BridgeEndpoint.attach}.
 *
 * A session router (`sessions.ts`) has to decode the first frame to know which
 * endpoint owns the connection. Handing over its decoder keeps a frame that
 * straddled a chunk boundary intact, and `frames` delivers what it already
 * decoded.
 */
export interface AttachOptions {
  /** A decoder already reading this carrier, adopted with its partial state. */
  readonly decoder?: FrameDecoder;
  /** Frames already decoded from this carrier, replayed in order. */
  readonly frames?: readonly Frame[];
}

/** How a carrier attachment settled. */
export type AttachOutcome =
  | { readonly kind: 'hello'; readonly ack: HelloAckPayload }
  | { readonly kind: 'resume'; readonly ack: ResumeAckPayload };

/** Construction options for {@link BridgeEndpoint}. */
export interface BridgeEndpointOptions {
  /** Which side of the wire this endpoint is. Decides stream-id parity and who answers the handshake. */
  readonly role: 'client' | 'server';
  /** Largest frame this endpoint will accept. Default and hard ceiling: 16 MiB. */
  readonly maxFrameSize?: number;
  /** Concurrent streams this endpoint will accept. Default 1024. */
  readonly maxStreams?: number;
  /** Credit granted per new stream and direction. Default 64 KiB. */
  readonly initialCredit?: number;
  /** Ungranted bytes that trigger a coalesced `CREDIT`. Default: half of `initialCredit`. */
  readonly creditGrantThreshold?: number;
  /** Replay ring bounds, server side. Default 1 MiB / 256 frames. */
  readonly resumeWindow?: ReplayWindow;
  /** Stream-level flow-control violations tolerated before the connection dies. Default 8. */
  readonly maxFlowViolations?: number;
  /** `PING` interval this endpoint advertises. Default 30 000 ms. */
  readonly heartbeatMs?: number;
  /** Diagnostic string sent in `HELLO.client`. */
  readonly clientName?: string;
  /** Server only: the session identity to advertise. Generated when omitted. */
  readonly sessionId?: string;
  /** Called for each stream the peer opens. Throw a {@link BridgeError} to reject it. */
  readonly onStream?: (stream: BridgeStream) => void;
  /** Called when the connection dies. `error` is `null` for a clean close. */
  readonly onClose?: (error: BridgeError | null) => void;
  /** Called when the peer sends `GOAWAY`. */
  readonly onGoaway?: (code: string, lastStreamId: number) => void;
  /** Called every time a handshake settles, including a post-`RESUME_FAIL` retry. */
  readonly onHandshake?: (outcome: AttachOutcome) => void;
  /** Injectable clock, for deterministic tests. Default `Date.now`. */
  readonly now?: () => number;
}

/**
 * One protocol session.
 *
 * The endpoint outlives its carrier. `attach` binds a connection and performs
 * the `HELLO` or `RESUME` handshake; when that connection dies the endpoint
 * moves to `detached` and keeps every stream alive, so a later `attach`
 * resumes them.
 */
export class BridgeEndpoint implements StreamHost {
  readonly #options: BridgeEndpointOptions;
  readonly #role: 'client' | 'server';
  readonly #now: () => number;

  #carrier: Carrier | null = null;
  #decoder: FrameDecoder;
  #state: EndpointState = 'idle';
  #sessionId: string | null = null;

  #localMaxFrameSize: number;
  #peerMaxFrameSize: number;
  #maxStreams: number;
  #initialCredit: number;
  #creditGrantThreshold: number;
  readonly #resumeWindow: ReplayWindow;
  readonly #maxFlowViolations: number;
  readonly #heartbeatMs: number;

  readonly #streams = new Map<number, BridgeStream>();
  readonly #replay = new Map<number, ReplayBuffer>();
  /** Streams that closed but have not been reaped yet (PROTOCOL.md §7.2). */
  readonly #closedStreams = new Set<number>();
  #nextStreamId: number;
  #peerHighestStreamId = 0;
  #flowViolations = 0;
  #pending: Frame[] = [];
  #pings = new Map<string, { deferred: Deferred<number>; at: number }>();
  #pingCounter = 0;
  #handshake: Deferred<AttachOutcome> | null = null;
  /** Which acknowledgement a client is waiting for, so it accepts only that one. */
  #expecting: 'hello' | 'resume' | null = null;
  #closeError: BridgeError | null = null;
  #goawayReceived = false;

  constructor(options: BridgeEndpointOptions) {
    this.#options = options;
    this.#role = options.role;
    this.#now = options.now ?? Date.now;
    this.#localMaxFrameSize = Math.min(
      options.maxFrameSize ?? PROTOCOL_DEFAULTS.maxFrameSize,
      HARD_MAX_FRAME_SIZE,
    );
    this.#peerMaxFrameSize = this.#localMaxFrameSize;
    this.#maxStreams = options.maxStreams ?? PROTOCOL_DEFAULTS.maxStreams;
    this.#initialCredit = options.initialCredit ?? PROTOCOL_DEFAULTS.initialCredit;
    this.#creditGrantThreshold =
      options.creditGrantThreshold ?? defaultCreditGrantThreshold(this.#initialCredit);
    this.#resumeWindow = options.resumeWindow ?? DEFAULT_REPLAY_WINDOW;
    this.#maxFlowViolations = options.maxFlowViolations ?? PROTOCOL_DEFAULTS.maxFlowViolations;
    this.#heartbeatMs = options.heartbeatMs ?? PROTOCOL_DEFAULTS.heartbeatMs;
    this.#nextStreamId = this.#role === 'client' ? 1 : 2;
    this.#decoder = new FrameDecoder({ maxFrameSize: this.#localMaxFrameSize });
    if (this.#role === 'server') this.#sessionId = options.sessionId ?? generateSessionId();
  }

  /** Which side of the wire this endpoint is. */
  get role(): 'client' | 'server' {
    return this.#role;
  }

  /** Connection-level state. */
  get state(): EndpointState {
    return this.#state;
  }

  /** The session identity, once the handshake has settled. */
  get sessionId(): string | null {
    return this.#sessionId;
  }

  /** Streams currently alive, by identifier. */
  get streams(): ReadonlyMap<number, BridgeStream> {
    return this.#streams;
  }

  /** The negotiated per-stream, per-direction initial credit. */
  get initialCredit(): number {
    return this.#initialCredit;
  }

  /** Ungranted bytes that trigger a coalesced `CREDIT` frame. */
  get creditGrantThreshold(): number {
    return this.#creditGrantThreshold;
  }

  /** The largest `DATA` payload this endpoint will put on the wire. */
  get maxDataPayload(): number {
    return Math.min(this.#localMaxFrameSize, this.#peerMaxFrameSize);
  }

  /** True while a carrier is bound and frames can reach the peer. */
  get attached(): boolean {
    return this.#carrier !== null;
  }

  /** True once the peer has asked us to stop opening streams. */
  get goawayReceived(): boolean {
    return this.#goawayReceived;
  }

  /* ---------------------------------------------------------------------- */
  /*  Attach / handshake                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * Bind a carrier and run the handshake.
   *
   * A client with no session sends `HELLO`; a client that already has one
   * sends `RESUME` with its per-stream cursors. A server waits for whichever
   * arrives and answers it.
   *
   * @returns How the handshake settled.
   * @throws ResumeFailedError when the server cannot resume the session. The
   *   connection stays usable: call {@link renegotiate} to start a fresh one.
   */
  attach(carrier: Carrier, options?: AttachOptions): Promise<AttachOutcome> {
    if (this.#state === 'closed') {
      return Promise.reject(new ConnectionClosed(ErrorCode.INTERNAL_ERROR, 'endpoint is closed'));
    }
    this.#carrier = carrier;
    this.#decoder = options?.decoder ?? new FrameDecoder({ maxFrameSize: this.#localMaxFrameSize });
    this.#decoder.setMaxFrameSize(this.#localMaxFrameSize);
    this.#state = 'handshaking';
    const handshake = deferred<AttachOutcome>();
    this.#handshake = handshake;

    carrier.onMessage((bytes) => {
      this.#onCarrierBytes(bytes);
    });
    carrier.onClose(() => {
      this.#onCarrierClose();
    });

    if (this.#role === 'client') this.#sendClientHandshake();
    if (options?.frames !== undefined) this.ingest(options.frames);
    return handshake.promise;
  }

  /**
   * Feed frames a session router already decoded from this carrier.
   *
   * `sessions.ts` peeks the first frame to decide which endpoint owns the
   * connection; this is how that frame reaches the endpoint it belongs to.
   *
   * @internal
   */
  ingest(frames: readonly Frame[]): void {
    for (const frame of frames) {
      // A method call, not a field read: handling one frame can close the
      // endpoint, and narrowing on `#state` would hide that from the compiler.
      if (this.#isClosed()) return;
      this.#handleFrame(frame);
    }
  }

  #isClosed(): boolean {
    return this.#state === 'closed';
  }

  /**
   * Abandon the current session and start a new one with `HELLO` on the
   * carrier already attached.
   *
   * Legal only after a `RESUME_FAIL`, which is the one case where a
   * connection carries no session (`PROTOCOL.md` §6.1).
   */
  renegotiate(): Promise<AttachOutcome> {
    if (this.#role !== 'client') {
      return Promise.reject(
        new BridgeError(ErrorCode.INTERNAL_ERROR, 'only a client renegotiates a session'),
      );
    }
    if (this.#carrier === null) {
      return Promise.reject(new ConnectionClosed(ErrorCode.INTERNAL_ERROR, 'no carrier attached'));
    }
    this.#failAllStreams(
      new ConnectionClosed(ErrorCode.SESSION_EXPIRED, 'session discarded before renegotiation'),
    );
    this.#sessionId = null;
    this.#pending = [];
    this.#state = 'handshaking';
    const handshake = deferred<AttachOutcome>();
    this.#handshake = handshake;
    this.#sendClientHandshake();
    return handshake.promise;
  }

  #sendClientHandshake(): void {
    this.#expecting = this.#sessionId === null ? 'hello' : 'resume';
    if (this.#sessionId === null) {
      this.#emit({
        type: FrameType.HELLO,
        streamId: 0,
        seq: 0,
        flags: FrameFlags.NONE,
        payload: {
          versions: [PROTOCOL_VERSION],
          maxFrameSize: this.#localMaxFrameSize,
          maxStreams: this.#maxStreams,
          ...(this.#options.clientName === undefined ? {} : { client: this.#options.clientName }),
        },
      });
      return;
    }
    const cursors: ResumeCursor[] = [];
    for (const stream of this.#streams.values()) {
      if (stream.resumable) {
        cursors.push({
          streamId: stream.id,
          lastSeq: stream.lastReceivedSeq,
          granted: stream.grantedTotal,
        });
      }
    }
    this.#emit({
      type: FrameType.RESUME,
      streamId: 0,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { sessionId: this.#sessionId, streams: cursors },
    });
  }

  /* ---------------------------------------------------------------------- */
  /*  Streams                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Open a stream.
   *
   * Returns immediately, in `opening` state: writing before the peer's
   * `OPEN_ACK` is legal and bounded by the credit this call grants. Await
   * {@link BridgeStream.opened} when acceptance matters.
   */
  openStream(name: string, options?: OpenStreamOptions): BridgeStream {
    if (this.#state !== 'open') {
      throw new ConnectionClosed(
        ErrorCode.INTERNAL_ERROR,
        `cannot open a stream while the endpoint is "${this.#state}"`,
      );
    }
    if (this.#goawayReceived) {
      throw new BridgeError(
        ErrorCode.SERVER_SHUTDOWN,
        'peer sent GOAWAY; no new streams may be opened',
      );
    }
    if (this.#streams.size >= this.#maxStreams) {
      throw new BridgeError(
        ErrorCode.STREAM_LIMIT_EXCEEDED,
        `already at the negotiated limit of ${String(this.#maxStreams)} concurrent streams`,
      );
    }
    if (this.#nextStreamId > MAX_STREAM_ID) {
      // PROTOCOL.md §4.1: the peer has to be told, because identifiers are
      // never reused and this connection can carry no more streams.
      const message = 'stream identifier space is exhausted';
      this.goaway(ErrorCode.STREAM_ID_EXHAUSTED, message);
      this.close(new ConnectionClosedError(ErrorCode.STREAM_ID_EXHAUSTED, message));
      throw new BridgeError(ErrorCode.STREAM_ID_EXHAUSTED, message);
    }

    const id = this.#nextStreamId;
    this.#nextStreamId += 2;
    const credit = options?.credit ?? this.#initialCredit;
    const mode = options?.mode ?? 'duplex';
    const params = options?.params ?? {};
    const stream = new BridgeStream(this, {
      id,
      name,
      mode,
      params,
      initiator: true,
      // Until OPEN_ACK lands the initiator may send optimistically against the
      // credit it declared in OPEN (PROTOCOL.md §7.3).
      sendCredit: credit,
      peerCredit: credit,
    });
    this.#registerStream(stream);
    this.#emit({
      type: FrameType.OPEN,
      streamId: id,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: {
        name,
        credit,
        mode,
        ...(options?.params === undefined ? {} : { params: options.params }),
      },
    });
    return stream;
  }

  /**
   * Make a unary call: open a stream, send `request` with `FIN`, read the
   * response, close.
   *
   * @see PROTOCOL.md §10 "Unary calls"
   */
  async call(name: string, request: Uint8Array, options?: OpenStreamOptions): Promise<Uint8Array> {
    const stream = this.openStream(name, options);
    const collect = stream.readAll();
    await stream.end(request);
    return collect;
  }

  /** Send a `PING` and resolve with the round-trip time in milliseconds. */
  ping(): Promise<number> {
    if (this.#carrier === null) {
      return Promise.reject(new ConnectionClosed(ErrorCode.INTERNAL_ERROR, 'no carrier attached'));
    }
    this.#pingCounter += 1;
    const nonce = `${String(this.#now())}-${String(this.#pingCounter)}`;
    const pending = deferred<number>();
    this.#pings.set(nonce, { deferred: pending, at: this.#now() });
    this.#emit({
      type: FrameType.PING,
      streamId: 0,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { nonce, at: this.#now() },
    });
    return pending.promise;
  }

  /** Tell the peer to stop opening streams. Does not close the connection. */
  goaway(code: string = ErrorCode.SERVER_SHUTDOWN, message?: string): void {
    this.#emit({
      type: FrameType.GOAWAY,
      streamId: 0,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: {
        code,
        lastStreamId: this.#peerHighestStreamId,
        ...(message === undefined ? {} : { message }),
      },
    });
  }

  /** Close the session: every stream fails, and the endpoint is unusable after. */
  close(error?: BridgeError): void {
    if (this.#state === 'closed') return;
    const cause = error ?? new ConnectionClosed(ErrorCode.SERVER_SHUTDOWN, 'endpoint closed');
    this.#state = 'closed';
    this.#closeError = error ?? null;
    this.#failAllStreams(cause);
    this.#rejectHandshake(cause);
    this.#rejectPings(cause);
    for (const buffer of this.#replay.values()) buffer.clear();
    this.#replay.clear();
    this.#closedStreams.clear();
    this.#carrier = null;
    this.#options.onClose?.(error ?? null);
  }

  /* ---------------------------------------------------------------------- */
  /*  StreamHost                                                             */
  /* ---------------------------------------------------------------------- */

  /** @internal */
  sendStreamFrame(frame: Frame): void {
    this.#emit(frame);
  }

  /** @internal */
  releaseStream(streamId: number): void {
    this.#streams.delete(streamId);
    // The stream stops counting against `maxStreams` the moment it closes,
    // but the session must still tell "closed" from "never existed" until the
    // stream is reaped: PROTOCOL.md §7.3 and §7.4 answer those two cases with
    // different codes. The replay buffer outlives the stream for the same
    // reason (§9.5).
    this.#closedStreams.add(streamId);
  }

  /**
   * Streams whose replay state the session still holds, so a reconnect can
   * ask for them. They no longer count against `maxStreams`.
   *
   * @see PROTOCOL.md §9.5 "Reaping"
   */
  get retainedStreams(): readonly number[] {
    return [...this.#replay.keys()];
  }

  #reap(streamId: number): void {
    this.#replay.get(streamId)?.clear();
    this.#replay.delete(streamId);
    this.#closedStreams.delete(streamId);
  }

  /** @internal */
  noteFlowViolation(): void {
    this.#flowViolations += 1;
  }

  /* ---------------------------------------------------------------------- */
  /*  Carrier plumbing                                                       */
  /* ---------------------------------------------------------------------- */

  #onCarrierBytes(bytes: Uint8Array): void {
    if (this.#state === 'closed') return;
    const { frames, error } = this.#decoder.push(bytes);
    for (const frame of frames) {
      if (this.#isClosed()) return;
      this.#handleFrame(frame);
    }
    if (error !== null) this.#failConnection(error);
  }

  #onCarrierClose(): void {
    if (this.#state === 'closed') return;
    this.#carrier = null;
    this.#state = 'detached';
    const error = new ConnectionClosedError(ErrorCode.INTERNAL_ERROR, 'carrier closed');
    this.#rejectHandshake(error);
    this.#rejectPings(error);
    this.#options.onClose?.(null);
  }

  #emit(frame: Frame): void {
    if (this.#state === 'closed') return;

    if (frame.type === FrameType.DATA || frame.type === FrameType.END) {
      const buffer = this.#replayFor(frame.streamId);
      buffer?.append(frame as SequencedFrame);
      if (this.#carrier === null) {
        // Server side, the replay buffer already holds it; client side there
        // is no replay buffer, so hold it until a carrier returns.
        if (buffer === null) this.#pending.push(frame);
        return;
      }
    } else if (this.#carrier === null) {
      // Unsequenced frames are not replayed (PROTOCOL.md §9.4): credit is
      // re-granted and control frames are re-derived after the handshake.
      return;
    }

    this.#carrier?.send(encodeFrame(frame, { maxFrameSize: this.maxDataPayload }));
  }

  #replayFor(streamId: number): ReplayBuffer | null {
    if (this.#role !== 'server') return null;
    let buffer = this.#replay.get(streamId);
    if (buffer === undefined) {
      buffer = new ReplayBuffer(this.#resumeWindow);
      this.#replay.set(streamId, buffer);
    }
    return buffer;
  }

  /**
   * Release everything that was held while no carrier was bound: frames this
   * side could not replay, then the credit its consumers earned meanwhile.
   */
  #flushPending(): void {
    const pending = this.#pending;
    this.#pending = [];
    for (const frame of pending) {
      this.#carrier?.send(encodeFrame(frame, { maxFrameSize: this.maxDataPayload }));
    }
    for (const stream of this.#streams.values()) stream.grantPending();
  }

  /* ---------------------------------------------------------------------- */
  /*  Frame dispatch                                                         */
  /* ---------------------------------------------------------------------- */

  #handleFrame(frame: Frame): void {
    switch (frame.type) {
      case FrameType.HELLO:
        this.#onHello(frame);
        return;
      case FrameType.HELLO_ACK:
        this.#onHelloAck(frame);
        return;
      case FrameType.RESUME:
        this.#onResume(frame);
        return;
      case FrameType.RESUME_ACK:
        this.#onResumeAck(frame);
        return;
      case FrameType.RESUME_FAIL:
        this.#onResumeFail(frame);
        return;
      case FrameType.PING:
        // Keepalive is not exempt from §6.1: answering before the handshake
        // has settled would put a frame on the wire ahead of HELLO_ACK.
        if (!this.#requireHandshake(frame)) return;
        this.#emit({
          type: FrameType.PONG,
          streamId: 0,
          seq: 0,
          flags: FrameFlags.NONE,
          payload: { nonce: frame.payload.nonce, at: this.#now() },
        });
        return;
      case FrameType.PONG: {
        if (!this.#requireHandshake(frame)) return;
        const pending = this.#pings.get(frame.payload.nonce);
        if (pending === undefined) return;
        this.#pings.delete(frame.payload.nonce);
        pending.deferred.resolve(this.#now() - pending.at);
        return;
      }
      case FrameType.GOAWAY:
        if (!this.#requireHandshake(frame)) return;
        this.#goawayReceived = true;
        this.#options.onGoaway?.(frame.payload.code, frame.payload.lastStreamId);
        return;
      case FrameType.OPEN:
        this.#onOpen(frame);
        return;
      default:
        this.#onStreamFrame(frame);
        return;
    }
  }

  #requireHandshake(frame: Frame): boolean {
    if (this.#state === 'open') return true;
    this.#failConnection(
      new ProtocolError(
        ErrorCode.PROTOCOL_VIOLATION,
        `frame type 0x${frame.type.toString(16)} arrived before the handshake completed`,
      ),
    );
    return false;
  }

  #onStreamFrame(frame: Frame): void {
    if (frame.streamId === 0) {
      // A connection-scoped ERROR: the peer is closing us down.
      if (frame.type === FrameType.ERROR) {
        const code = isKnownCode(frame.payload.code) ? frame.payload.code : ErrorCode.INTERNAL_ERROR;
        this.close(new ConnectionClosedError(code, frame.payload.message ?? 'peer closed the connection'));
      }
      return;
    }
    if (!this.#requireHandshake(frame)) return;

    const stream = this.#streams.get(frame.streamId);
    if (stream === undefined) {
      // CREDIT, CANCEL and ERROR legitimately race a close (PROTOCOL.md §7.4).
      if (
        frame.type === FrameType.CREDIT ||
        frame.type === FrameType.CANCEL ||
        frame.type === FrameType.ERROR
      ) {
        return;
      }
      if (this.#closedStreams.has(frame.streamId)) {
        this.#sendStreamError(
          frame.streamId,
          ErrorCode.STREAM_STATE_ERROR,
          `stream ${String(frame.streamId)} is closed`,
        );
        return;
      }
      this.#sendStreamError(
        frame.streamId,
        ErrorCode.STREAM_CLOSED,
        `stream ${String(frame.streamId)} is unknown or already reaped`,
      );
      return;
    }

    const fault = stream.handleFrame(frame);
    if (fault === null) return;
    this.#sendStreamError(frame.streamId, fault.code, fault.message);
    stream.fail(new StreamError(fault.code, fault.message, { streamId: frame.streamId }));
    if (fault.code === ErrorCode.FLOW_CONTROL_ERROR && this.#flowViolations >= this.#maxFlowViolations) {
      this.#failConnection(
        new ProtocolError(
          ErrorCode.FLOW_CONTROL_ERROR,
          `peer committed ${String(this.#flowViolations)} flow-control violations`,
        ),
      );
    }
  }

  #onOpen(frame: FrameOf<typeof FrameType.OPEN>): void {
    if (!this.#requireHandshake(frame)) return;

    const id = frame.streamId;
    const peerIsOdd = this.#role === 'server';
    if ((id % 2 === 1) !== peerIsOdd) {
      this.#failConnection(
        new ProtocolError(
          ErrorCode.PROTOCOL_VIOLATION,
          `peer opened stream ${String(id)}, which has this endpoint's identifier parity`,
        ),
      );
      return;
    }
    if (id <= this.#peerHighestStreamId) {
      this.#sendStreamError(
        id,
        ErrorCode.STREAM_STATE_ERROR,
        'stream identifiers must increase and are never reused',
      );
      return;
    }
    this.#peerHighestStreamId = id;

    if (this.#streams.size >= this.#maxStreams) {
      this.#sendStreamError(
        id,
        ErrorCode.STREAM_LIMIT_EXCEEDED,
        `at the negotiated limit of ${String(this.#maxStreams)} concurrent streams`,
      );
      return;
    }

    const handler = this.#options.onStream;
    if (handler === undefined) {
      this.#sendStreamError(id, ErrorCode.NOT_FOUND, `no handler is registered for "${frame.payload.name}"`);
      return;
    }

    const grantedByPeer = frame.payload.credit ?? this.#initialCredit;
    const stream = new BridgeStream(this, {
      id,
      name: frame.payload.name,
      mode: frame.payload.mode ?? 'duplex',
      params: frame.payload.params ?? {},
      initiator: false,
      sendCredit: grantedByPeer,
      peerCredit: this.#initialCredit,
    });
    this.#registerStream(stream);

    try {
      handler(stream);
    } catch (cause) {
      const error =
        cause instanceof BridgeError
          ? cause
          : new BridgeError(ErrorCode.INTERNAL_ERROR, 'stream handler failed');
      this.#sendStreamError(id, error.code, error.message);
      stream.fail(new StreamError(error.code, error.message, { streamId: id }));
      return;
    }

    if (stream.state === 'closed') return;
    this.#emit({
      type: FrameType.OPEN_ACK,
      streamId: id,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { credit: this.#initialCredit },
    });
  }

  #registerStream(stream: BridgeStream): void {
    this.#streams.set(stream.id, stream);
    // The buffer has to exist from the moment the stream does, not from its
    // first sequenced frame: a RESUME cursor for a stream with no buffer is
    // indistinguishable from one for a stream the session never knew, and
    // PROTOCOL.md §9.4 answers those two cases very differently.
    if (this.#role === 'server') this.#replayFor(stream.id);
  }

  #sendStreamError(streamId: number, code: string, message: string): void {
    this.#emit({
      type: FrameType.ERROR,
      streamId,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { code, message },
    });
  }

  /* ---------------------------------------------------------------------- */
  /*  Handshake frames                                                       */
  /* ---------------------------------------------------------------------- */

  #onHello(frame: FrameOf<typeof FrameType.HELLO>): void {
    if (this.#role !== 'server' || this.#state !== 'handshaking') {
      this.#failConnection(
        new ProtocolError(ErrorCode.PROTOCOL_VIOLATION, 'unexpected HELLO for this connection'),
      );
      return;
    }
    if (!frame.payload.versions.includes(PROTOCOL_VERSION)) {
      this.#failConnection(
        new ProtocolError(
          ErrorCode.UNSUPPORTED_VERSION,
          `peer supports [${frame.payload.versions.join(', ')}]; this endpoint speaks ${String(PROTOCOL_VERSION)}`,
        ),
      );
      return;
    }

    this.#negotiate(frame.payload.maxFrameSize, frame.payload.maxStreams);
    const sessionId = this.#sessionId ?? generateSessionId();
    this.#sessionId = sessionId;
    const ack: HelloAckPayload = {
      version: PROTOCOL_VERSION,
      sessionId,
      maxFrameSize: this.#localMaxFrameSize,
      maxStreams: this.#maxStreams,
      initialCredit: this.#initialCredit,
      resumeWindow: { bytes: this.#resumeWindow.bytes, frames: this.#resumeWindow.frames },
      heartbeatMs: this.#heartbeatMs,
    };
    this.#state = 'open';
    this.#emit({ type: FrameType.HELLO_ACK, streamId: 0, seq: 0, flags: FrameFlags.NONE, payload: ack });
    this.#flushPending();
    this.#resolveHandshake({ kind: 'hello', ack });
  }

  #onHelloAck(frame: FrameOf<typeof FrameType.HELLO_ACK>): void {
    if (this.#role !== 'client' || this.#state !== 'handshaking' || this.#expecting !== 'hello') {
      this.#failConnection(
        new ProtocolError(ErrorCode.PROTOCOL_VIOLATION, 'unexpected HELLO_ACK for this connection'),
      );
      return;
    }
    const ack = frame.payload;
    if (ack.version !== PROTOCOL_VERSION) {
      this.#failConnection(
        new ProtocolError(
          ErrorCode.UNSUPPORTED_VERSION,
          `server selected version ${String(ack.version)}`,
        ),
      );
      return;
    }
    if (ack.maxFrameSize > HARD_MAX_FRAME_SIZE) {
      this.#failConnection(
        new ProtocolError(
          ErrorCode.PROTOCOL_VIOLATION,
          `server advertised maxFrameSize ${String(ack.maxFrameSize)} above the hard maximum`,
        ),
      );
      return;
    }
    this.#negotiate(ack.maxFrameSize, ack.maxStreams);
    this.#initialCredit = ack.initialCredit;
    this.#creditGrantThreshold =
      this.#options.creditGrantThreshold ?? defaultCreditGrantThreshold(ack.initialCredit);
    this.#sessionId = ack.sessionId;
    this.#expecting = null;
    this.#state = 'open';
    this.#flushPending();
    this.#resolveHandshake({ kind: 'hello', ack });
  }

  #negotiate(peerMaxFrameSize: number | undefined, peerMaxStreams: number | undefined): void {
    if (peerMaxFrameSize !== undefined) {
      this.#peerMaxFrameSize = Math.min(peerMaxFrameSize, HARD_MAX_FRAME_SIZE);
    }
    if (peerMaxStreams !== undefined) this.#maxStreams = Math.min(this.#maxStreams, peerMaxStreams);
    this.#decoder.setMaxFrameSize(this.#localMaxFrameSize);
  }

  #onResume(frame: FrameOf<typeof FrameType.RESUME>): void {
    if (this.#role !== 'server' || this.#state !== 'handshaking') {
      this.#failConnection(
        new ProtocolError(ErrorCode.PROTOCOL_VIOLATION, 'unexpected RESUME for this connection'),
      );
      return;
    }
    if (frame.payload.sessionId !== this.#sessionId) {
      this.#emit({
        type: FrameType.RESUME_FAIL,
        streamId: 0,
        seq: 0,
        flags: FrameFlags.NONE,
        payload: { code: 'SESSION_UNKNOWN', message: 'no such session on this connection' },
      });
      return;
    }

    const plan = planReplay(frame.payload.streams, this.#replay);
    const requested = new Set(frame.payload.streams.map((cursor) => cursor.streamId));

    // Restore each resumed stream's send window from the peer's cumulative
    // grant before anything is written on the new carrier: a grant lost with
    // the dead socket would otherwise strand this side at zero credit
    // forever, because nothing ever re-sends an unsequenced frame (§9.4).
    for (const cursor of frame.payload.streams) {
      if (cursor.granted === undefined) continue;
      this.#streams.get(cursor.streamId)?.resyncSendCredit(cursor.granted);
    }

    const grants: StreamGrant[] = [];
    for (const streamId of plan.resumed) {
      const stream = this.#streams.get(streamId);
      if (stream !== undefined) grants.push({ streamId, granted: stream.grantedTotal });
    }

    const ack: ResumeAckPayload = {
      sessionId: frame.payload.sessionId,
      resumed: plan.resumed,
      failed: plan.failed,
      credit: grants,
    };
    this.#state = 'open';
    this.#emit({ type: FrameType.RESUME_ACK, streamId: 0, seq: 0, flags: FrameFlags.NONE, payload: ack });

    // Streams the client did not list are abandoned (PROTOCOL.md §9.4).
    for (const stream of [...this.#streams.values()]) {
      if (!requested.has(stream.id)) {
        stream.fail(
          new StreamError(ErrorCode.CANCELLED, 'not listed in RESUME; abandoned by the client', {
            streamId: stream.id,
          }),
        );
        this.#reap(stream.id);
      }
    }
    for (const failure of plan.failed) {
      const stream = this.#streams.get(failure.streamId);
      stream?.fail(
        new StreamError(
          isKnownCode(failure.code) ? failure.code : ErrorCode.INTERNAL_ERROR,
          `resume failed for stream ${String(failure.streamId)}`,
          { streamId: failure.streamId },
        ),
      );
      this.#reap(failure.streamId);
    }
    // A retained stream the client never listed is gone too: it holds a replay
    // buffer for a cursor nobody will ever ask about again.
    for (const streamId of this.retainedStreams) {
      if (!requested.has(streamId) && !this.#streams.has(streamId)) this.#reap(streamId);
    }

    for (const streamId of plan.resumed) {
      const lastSeq = plan.cursors.get(streamId) ?? 0;
      const buffer = this.#replay.get(streamId);
      if (buffer === undefined) continue;
      for (const replayed of buffer.replayFrom(lastSeq)) {
        this.#carrier?.send(encodeFrame(replayed, { maxFrameSize: this.maxDataPayload }));
      }
      // The client acknowledged the final frame of a stream that has already
      // closed: nothing can ever need replaying again (PROTOCOL.md §9.5).
      if (!this.#streams.has(streamId) && lastSeq >= buffer.highestSeq) this.#reap(streamId);
    }
    this.#flushPending();

    this.#resolveHandshake({ kind: 'resume', ack });
  }

  #onResumeAck(frame: FrameOf<typeof FrameType.RESUME_ACK>): void {
    if (this.#role !== 'client' || this.#state !== 'handshaking' || this.#expecting !== 'resume') {
      this.#failConnection(
        new ProtocolError(ErrorCode.PROTOCOL_VIOLATION, 'unexpected RESUME_ACK for this connection'),
      );
      return;
    }
    this.#expecting = null;
    this.#state = 'open';
    for (const failure of frame.payload.failed) {
      const stream = this.#streams.get(failure.streamId);
      stream?.fail(resumeFailureError(failure));
    }
    // The other half of the credit restore: grants the server made that died
    // with the old socket (§9.4).
    for (const grant of frame.payload.credit ?? []) {
      this.#streams.get(grant.streamId)?.resyncSendCredit(grant.granted);
    }
    // Replay lands first; anything held while detached follows it in order.
    this.#flushPending();
    this.#resolveHandshake({ kind: 'resume', ack: frame.payload });
  }

  #onResumeFail(frame: FrameOf<typeof FrameType.RESUME_FAIL>): void {
    if (this.#role !== 'client' || this.#expecting !== 'resume') {
      this.#failConnection(
        new ProtocolError(ErrorCode.PROTOCOL_VIOLATION, 'unexpected RESUME_FAIL for this connection'),
      );
      return;
    }
    this.#expecting = null;
    const error = new ResumeFailedError(
      frame.payload.code,
      frame.payload.message ?? `resume rejected: ${frame.payload.code}`,
    );
    this.#rejectHandshake(error);
  }

  /* ---------------------------------------------------------------------- */
  /*  Teardown helpers                                                       */
  /* ---------------------------------------------------------------------- */

  #failConnection(error: ProtocolError): void {
    this.#emit({
      type: FrameType.ERROR,
      streamId: 0,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { code: error.code, message: error.message },
    });
    // PROTOCOL.md §5.7: a connection-scoped ERROR MUST be followed by a close.
    this.#carrier?.close?.();
    this.close(new ConnectionClosedError(error.code, error.message));
  }

  #failAllStreams(error: BridgeError): void {
    for (const stream of [...this.#streams.values()]) stream.fail(error);
    this.#streams.clear();
  }

  #resolveHandshake(outcome: AttachOutcome): void {
    const handshake = this.#handshake;
    this.#handshake = null;
    this.#options.onHandshake?.(outcome);
    handshake?.resolve(outcome);
  }

  #rejectHandshake(error: unknown): void {
    const handshake = this.#handshake;
    this.#handshake = null;
    handshake?.reject(error);
  }

  #rejectPings(error: BridgeError): void {
    for (const pending of this.#pings.values()) pending.deferred.reject(error);
    this.#pings.clear();
  }

  /** The fault that closed this endpoint, or `null` for a clean close. */
  get closeError(): BridgeError | null {
    return this.#closeError;
  }
}

function resumeFailureError(failure: ResumeFailure): StreamError {
  if (failure.code === ErrorCode.SNAPSHOT_REQUIRED) {
    return new SnapshotRequiredError(failure.streamId);
  }
  return new StreamError(
    isKnownCode(failure.code) ? failure.code : ErrorCode.INTERNAL_ERROR,
    `resume failed for stream ${String(failure.streamId)}: ${failure.code}`,
    { streamId: failure.streamId, remote: true },
  );
}

/** Read an entire stream into one buffer. */
export async function readAll(stream: BridgeStream): Promise<Uint8Array> {
  return stream.readAll();
}
