/**
 * An in-memory carrier pair.
 *
 * Delivery is asynchronous (one microtask), because a synchronous pipe hides
 * every re-entrancy bug a real socket would expose.
 *
 * Two ways to end a connection, and the difference matters:
 *
 * - `close()` on a carrier is a graceful close. Bytes already handed to the
 *   pipe are delivered first, the way a socket flushes a final `ERROR` frame
 *   before it goes away.
 * - `break()` is a dying socket. Anything still in flight is lost, which is
 *   exactly the condition the resume tests need to reproduce.
 */
import type { Carrier } from '../../src/index.js';

type ByteHandler = (bytes: Uint8Array) => void;

class PipeEnd implements Carrier {
  peer: PipeEnd | null = null;
  #onMessage: ByteHandler | null = null;
  #onClose: (() => void) | null = null;
  #outbound: Uint8Array[] = [];
  #draining = false;
  closed = false;
  dropInFlight = false;
  /** Every buffer this end has been asked to send, in order. */
  readonly sent: Uint8Array[] = [];
  /** Split each send into chunks of this size, to exercise the streaming decoder. */
  chunkSize = 0;

  send(bytes: Uint8Array): void {
    this.sent.push(bytes);
    if (this.closed) return;
    for (const piece of split(bytes, this.chunkSize)) this.#outbound.push(piece);
    this.#scheduleDrain();
  }

  onMessage(cb: ByteHandler): void {
    this.#onMessage = cb;
  }

  onClose(cb: () => void): void {
    this.#onClose = cb;
  }

  /** Graceful close: queued bytes are delivered, then both ends shut down. */
  close(): void {
    queueMicrotask(() => {
      this.shutdown();
      this.peer?.shutdown();
    });
  }

  /** Abrupt loss: in-flight bytes are dropped and both ends shut down now. */
  breakNow(): void {
    this.dropInFlight = true;
    if (this.peer !== null) this.peer.dropInFlight = true;
    this.shutdown();
    this.peer?.shutdown();
  }

  #scheduleDrain(): void {
    if (this.#draining) return;
    this.#draining = true;
    queueMicrotask(() => {
      this.#draining = false;
      const queued = this.#outbound;
      this.#outbound = [];
      if (this.dropInFlight) return;
      const peer = this.peer;
      if (peer === null) return;
      for (const chunk of queued) {
        if (this.dropInFlight || peer.dropInFlight) return;
        peer.deliver(chunk);
      }
    });
  }

  /** @internal */
  deliver(bytes: Uint8Array): void {
    this.#onMessage?.(bytes);
  }

  /** @internal */
  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.#onClose?.();
  }
}

function split(bytes: Uint8Array, chunkSize: number): Uint8Array[] {
  if (chunkSize <= 0 || bytes.length <= chunkSize) return [bytes];
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    out.push(bytes.subarray(offset, offset + chunkSize));
  }
  return out;
}

/** A connected pair of carriers plus the controls a test needs. */
export interface MemoryPipe {
  readonly client: Carrier;
  readonly server: Carrier;
  /** Kill the connection, dropping anything still in flight. */
  break(): void;
  /** Feed each side's writes to the peer in chunks of `size` bytes. */
  setChunkSize(size: number): void;
}

/** Create a connected carrier pair. */
export function createPipe(): MemoryPipe {
  const client = new PipeEnd();
  const server = new PipeEnd();
  client.peer = server;
  server.peer = client;
  return {
    client,
    server,
    break(): void {
      client.breakNow();
    },
    setChunkSize(size: number): void {
      client.chunkSize = size;
      server.chunkSize = size;
    },
  };
}

/** Let every queued microtask and timer callback run. */
export function flush(times = 4): Promise<void> {
  return new Promise((resolve) => {
    let left = times;
    const tick = (): void => {
      left -= 1;
      if (left <= 0) resolve();
      else setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
  });
}
