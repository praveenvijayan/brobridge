/**
 * Sequence numbering and the replay machinery that makes a dropped socket
 * invisible to the application.
 *
 * Three small pieces, all pure:
 *
 * - {@link SeqCounter} — the sender-side counter, one per stream direction.
 * - {@link SeqTracker} — the receiver-side cursor, which decides whether an
 *   inbound sequenced frame is delivered, discarded as a duplicate replay, or
 *   a protocol fault.
 * - {@link ReplayBuffer} — the bounded ring the server keeps so it can
 *   retransmit what a reconnecting client missed.
 *
 * @see PROTOCOL.md §9 "Resume"
 */

import { ErrorCode, ProtocolError } from './errors.js';
import type { ResumeCursor, ResumeFailure, SequencedFrame } from './types.js';
import { FRAME_HEADER_SIZE, FrameFlags, MAX_SEQ, PROTOCOL_DEFAULTS } from './types.js';

/**
 * The sender-side sequence counter for one stream direction.
 *
 * Starts at `0`, so the first sequenced frame carries `seq = 1`. Wrap-around
 * is not permitted: the stream dies with `SEQ_EXHAUSTED` instead.
 *
 * @see PROTOCOL.md §9.1
 */
export class SeqCounter {
  #value: number;

  /**
   * @param start - The highest sequence number already issued. Non-zero when
   *   a counter is rebuilt for a session that survived a reconnect.
   */
  constructor(start = 0) {
    this.#value = start;
  }

  /** The highest sequence number issued so far; `0` before the first frame. */
  get value(): number {
    return this.#value;
  }

  /** True when {@link next} would run past the `u32` space. */
  get exhausted(): boolean {
    return this.#value >= MAX_SEQ;
  }

  /**
   * Issue the next sequence number.
   *
   * @throws ProtocolError with `SEQ_EXHAUSTED` when the `u32` space is spent.
   *   Callers that want to fail the stream gracefully check
   *   {@link exhausted} first.
   */
  next(streamId = 0): number {
    if (this.exhausted) {
      throw new ProtocolError(
        ErrorCode.SEQ_EXHAUSTED,
        `stream ${String(streamId)} exhausted its sequence space`,
        { streamId, scope: 'stream' },
      );
    }
    this.#value += 1;
    return this.#value;
  }
}

/** What a receiver should do with an inbound sequenced frame. */
export type SeqVerdict = 'deliver' | 'discard';

/**
 * The receiver-side cursor for one stream direction.
 *
 * On a live connection the carrier is ordered and reliable, so a gap is a
 * defect rather than loss. During replay the server may start earlier than
 * the client's true cursor, so already-processed frames are discarded instead.
 *
 * @see PROTOCOL.md §9.1
 */
export class SeqTracker {
  #lastSeq: number;

  constructor(lastSeq = 0) {
    this.#lastSeq = lastSeq;
  }

  /** The highest sequence number fully processed and handed to the consumer. */
  get lastSeq(): number {
    return this.#lastSeq;
  }

  /**
   * Classify an inbound sequenced frame and advance the cursor when it is
   * the next one in order.
   *
   * @param seq - The frame's sequence number.
   * @param replay - Whether the frame carried the `REPLAY` flag.
   * @param streamId - Used only to scope the returned error.
   */
  accept(seq: number, replay: boolean, streamId = 0): SeqVerdict | ProtocolError {
    if (seq === this.#lastSeq + 1) {
      this.#lastSeq = seq;
      return 'deliver';
    }
    if (replay && seq <= this.#lastSeq) return 'discard';
    return new ProtocolError(
      ErrorCode.PROTOCOL_VIOLATION,
      `stream ${String(streamId)} expected seq ${String(this.#lastSeq + 1)}, received ${String(seq)}`,
      { streamId, scope: 'stream' },
    );
  }
}

/** Bounds for a {@link ReplayBuffer}. Both apply; whichever bites first wins. */
export interface ReplayWindow {
  /** Maximum retained bytes, counting frame headers. */
  readonly bytes: number;
  /** Maximum retained frames. */
  readonly frames: number;
}

/** The protocol default replay window: 1 MiB or 256 frames. */
export const DEFAULT_REPLAY_WINDOW: ReplayWindow = {
  bytes: PROTOCOL_DEFAULTS.resumeWindowBytes,
  frames: PROTOCOL_DEFAULTS.resumeWindowFrames,
};

/**
 * A bounded ring of the sequenced frames one endpoint has sent on one stream,
 * kept so they can be retransmitted after a reconnect.
 *
 * Only the server keeps one, because only the client reconnects
 * (`PROTOCOL.md` §9.2).
 *
 * Byte accounting includes the 16-byte frame header, so the bound describes
 * real retained memory rather than payload alone. A frame larger than the
 * whole window evicts everything including itself; that is the honest outcome
 * of configuring a window smaller than a frame, and it degrades to
 * `SNAPSHOT_REQUIRED` rather than to unbounded memory.
 */
export class ReplayBuffer {
  readonly #window: ReplayWindow;
  #entries: SequencedFrame[] = [];
  #head = 0; // index of the oldest live entry within #entries
  #bytes = 0;
  #highestSeq = 0;

  constructor(window: ReplayWindow = DEFAULT_REPLAY_WINDOW) {
    this.#window = window;
  }

  /** Number of frames currently retained. */
  get frameCount(): number {
    return this.#entries.length - this.#head;
  }

  /** Retained bytes, including frame headers. */
  get byteLength(): number {
    return this.#bytes;
  }

  /** The highest sequence number ever appended. */
  get highestSeq(): number {
    return this.#highestSeq;
  }

  /**
   * The oldest sequence number still retransmittable. When the ring is empty
   * this is `highestSeq + 1`, meaning "nothing to replay, and a client whose
   * cursor is at `highestSeq` is fully caught up".
   */
  get oldestReplaySeq(): number {
    const oldest = this.#entries[this.#head];
    return oldest === undefined ? this.#highestSeq + 1 : oldest.seq;
  }

  /** Record a frame that was (or will be) sent, evicting to stay in bounds. */
  append(frame: SequencedFrame): void {
    this.#entries.push(frame);
    this.#bytes += frameBytes(frame);
    this.#highestSeq = frame.seq;
    this.#evict();
  }

  /**
   * The frames a peer at `lastSeq` still needs, each marked `REPLAY`.
   *
   * Call {@link canReplayFrom} first: this method returns whatever it has and
   * does not report a gap.
   */
  replayFrom(lastSeq: number): readonly SequencedFrame[] {
    const out: SequencedFrame[] = [];
    for (let i = this.#head; i < this.#entries.length; i += 1) {
      const frame = this.#entries[i] as SequencedFrame;
      if (frame.seq > lastSeq) out.push({ ...frame, flags: frame.flags | FrameFlags.REPLAY });
    }
    return out;
  }

  /**
   * The per-stream replay decision of `PROTOCOL.md` §9.4.
   *
   * @returns `null` when the cursor can be served, or the error code to report
   *   in `RESUME_ACK.failed`.
   */
  canReplayFrom(lastSeq: number): null | typeof ErrorCode.SNAPSHOT_REQUIRED | typeof ErrorCode.PROTOCOL_VIOLATION {
    if (lastSeq > this.#highestSeq) return ErrorCode.PROTOCOL_VIOLATION;
    if (lastSeq < this.oldestReplaySeq - 1) return ErrorCode.SNAPSHOT_REQUIRED;
    return null;
  }

  /** Release every retained frame. Called when the stream is reaped (§9.5). */
  clear(): void {
    this.#entries = [];
    this.#head = 0;
    this.#bytes = 0;
  }

  #evict(): void {
    while (
      this.#head < this.#entries.length &&
      (this.frameCount > this.#window.frames || this.#bytes > this.#window.bytes)
    ) {
      const evicted = this.#entries[this.#head] as SequencedFrame;
      this.#bytes -= frameBytes(evicted);
      this.#head += 1;
    }
    // Reclaim the dead prefix rather than growing the array without bound.
    if (this.#head > 0 && this.#head * 2 >= this.#entries.length) {
      this.#entries = this.#entries.slice(this.#head);
      this.#head = 0;
    }
  }
}

function frameBytes(frame: SequencedFrame): number {
  const payloadLength = frame.payload instanceof Uint8Array ? frame.payload.length : 0;
  return FRAME_HEADER_SIZE + payloadLength;
}

/** The outcome of evaluating a whole `RESUME` request. @see PROTOCOL.md §9.4 */
export interface ReplayPlan {
  /** Streams that will be replayed, in request order. */
  readonly resumed: readonly number[];
  /** Streams that cannot be, each with the code to report. */
  readonly failed: readonly ResumeFailure[];
  /** `streamId -> lastSeq` for the resumed streams, so the caller can replay. */
  readonly cursors: ReadonlyMap<number, number>;
}

/**
 * Apply the §9.4 decision table to every cursor in a `RESUME` request.
 *
 * @param cursors - `RESUME.streams` as received.
 * @param buffers - The session's replay buffers. A missing entry means the
 *   session never knew that stream, or already reaped it.
 */
export function planReplay(
  cursors: readonly ResumeCursor[],
  buffers: ReadonlyMap<number, ReplayBuffer>,
): ReplayPlan {
  const resumed: number[] = [];
  const failed: ResumeFailure[] = [];
  const accepted = new Map<number, number>();

  for (const cursor of cursors) {
    const buffer = buffers.get(cursor.streamId);
    if (buffer === undefined) {
      failed.push({ streamId: cursor.streamId, code: ErrorCode.STREAM_CLOSED });
      continue;
    }
    const problem = buffer.canReplayFrom(cursor.lastSeq);
    if (problem !== null) {
      failed.push({ streamId: cursor.streamId, code: problem });
      continue;
    }
    resumed.push(cursor.streamId);
    accepted.set(cursor.streamId, cursor.lastSeq);
  }

  return { resumed, failed, cursors: accepted };
}
