/**
 * The socket carrier: what turns a WebSocket into something
 * `@brobridgejs/core` can speak through.
 *
 * Core's {@link Carrier} interface is synchronous — `send(bytes): void` — so
 * the socket's own backpressure has to be absorbed here. That absorption is
 * bounded on purpose: a peer that stops reading must cost the host a fixed
 * amount of memory and then lose its connection, never an unbounded
 * userspace queue (`THREAT-MODEL.md` §5.10, last row).
 */
import type { Carrier } from '@brobridgejs/core';

/** How a write to the underlying socket went. */
export type WriteOutcome =
  /** Written; keep going. */
  | 'ok'
  /** Accepted, but the socket wants us to wait for its drain signal. */
  | 'pause'
  /** The socket refused it. The connection is over. */
  | 'failed';

/** The per-runtime half: everything `ws` and Bun do differently. */
export interface SocketAdapter {
  /** Hand one frame to the socket. */
  write(bytes: Uint8Array): WriteOutcome;
  /** Bytes the socket itself is still holding. */
  readonly buffered: number;
  /** Close the socket. */
  close(code: number, reason: string): void;
}

/** Options for {@link SocketCarrier}. */
export interface SocketCarrierOptions {
  /** Queued bytes past which the connection is closed instead of buffered. */
  readonly maxBufferedBytes: number;
  /** Socket-held bytes past which the pump waits for drain. */
  readonly highWaterMark?: number;
  /** Called when the peer stopped reading and blew the budget. */
  readonly onOverflow?: (bufferedBytes: number) => void;
}

const DEFAULT_HIGH_WATER_MARK = 1024 * 1024;

/** Close code for a peer that stopped reading. `1008` is "policy violation". */
const CLOSE_POLICY = 1008;

/**
 * One WebSocket, as core sees it.
 *
 * Frames are handed over whole. When the socket is congested they queue here,
 * and the queue is drained in order the moment the socket says it can take
 * more — so ordering is preserved and a congested socket slows the sender
 * instead of losing frames.
 */
export class SocketCarrier implements Carrier {
  readonly #adapter: SocketAdapter;
  readonly #maxBufferedBytes: number;
  readonly #highWaterMark: number;
  readonly #onOverflow: ((bufferedBytes: number) => void) | undefined;
  readonly #queue: Uint8Array[] = [];

  #queuedBytes = 0;
  #paused = false;
  #closed = false;
  #onMessage: ((bytes: Uint8Array) => void) | null = null;
  #onClose: (() => void) | null = null;
  readonly #closeListeners = new Set<() => void>();

  constructor(adapter: SocketAdapter, options: SocketCarrierOptions) {
    this.#adapter = adapter;
    this.#maxBufferedBytes = options.maxBufferedBytes;
    this.#highWaterMark = options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
    this.#onOverflow = options.onOverflow;
  }

  /** Bytes waiting in this carrier's own queue. */
  get queuedBytes(): number {
    return this.#queuedBytes;
  }

  /** True while the pump is waiting for the socket to drain. */
  get paused(): boolean {
    return this.#paused;
  }

  send(bytes: Uint8Array): void {
    if (this.#closed) return;
    this.#queue.push(bytes);
    this.#queuedBytes += bytes.length;
    if (this.#queuedBytes > this.#maxBufferedBytes) {
      const overflowed = this.#queuedBytes;
      this.#drop();
      this.#onOverflow?.(overflowed);
      this.#adapter.close(CLOSE_POLICY, 'send buffer exceeded');
      this.notifyClose();
      return;
    }
    this.#drain();
  }

  onMessage(cb: (bytes: Uint8Array) => void): void {
    this.#onMessage = cb;
  }

  onClose(cb: () => void): void {
    this.#onClose = cb;
  }

  /**
   * Subscribe to the close alongside core's own handler.
   *
   * `Carrier.onClose` *replaces* the handler by contract, so the host cannot
   * use it: doing so would silently unsubscribe the endpoint that owns this
   * connection, and the session would never learn its socket had died.
   */
  addCloseListener(cb: () => void): void {
    if (this.#closed) {
      cb();
      return;
    }
    this.#closeListeners.add(cb);
  }

  close(): void {
    if (this.#closed) return;
    // Anything still queued is dropped: core calls this after a
    // connection-level fault, and the peer is not going to read it.
    this.#drop();
    this.#adapter.close(1000, 'closed');
    this.notifyClose();
  }

  /** @internal Bytes arrived from the socket. */
  deliver(bytes: Uint8Array): void {
    if (this.#closed) return;
    this.#onMessage?.(bytes);
  }

  /** @internal The socket drained; resume the pump. */
  resume(): void {
    if (!this.#paused || this.#closed) return;
    this.#paused = false;
    this.#drain();
  }

  /** @internal The socket went away. */
  notifyClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#drop();
    const cb = this.#onClose;
    this.#onClose = null;
    const listeners = [...this.#closeListeners];
    this.#closeListeners.clear();
    cb?.();
    for (const listener of listeners) listener();
  }

  #drain(): void {
    while (!this.#paused && !this.#closed && this.#queue.length > 0) {
      if (this.#adapter.buffered >= this.#highWaterMark) {
        this.#paused = true;
        return;
      }
      const chunk = this.#queue[0] as Uint8Array;
      const outcome = this.#adapter.write(chunk);
      if (outcome === 'failed') {
        this.notifyClose();
        return;
      }
      this.#queue.shift();
      this.#queuedBytes -= chunk.length;
      if (outcome === 'pause') this.#paused = true;
    }
  }

  #drop(): void {
    this.#queue.length = 0;
    this.#queuedBytes = 0;
  }
}
