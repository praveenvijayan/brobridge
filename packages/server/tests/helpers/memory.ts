/**
 * An in-memory socket pair, for the tests that are about the server's own
 * bookkeeping rather than about HTTP.
 *
 * The server side is a real {@link SocketCarrier} over a fake adapter, so the
 * pump, the close listeners and the session wall are exercised exactly as
 * they are over a WebSocket — only the bytes take a shorter path.
 */
import type { Carrier } from '@brobridgejs/core';

import { SocketCarrier } from '../../src/carrier.js';
import type { SocketAdapter, WriteOutcome } from '../../src/carrier.js';

/** A fake socket whose congestion and failures the test decides. */
export class FakeSocket implements SocketAdapter {
  #peer: ((bytes: Uint8Array) => void) | null = null;
  #onClose: (() => void) | null = null;

  /** Bytes the fake socket claims to be holding. */
  buffered = 0;
  /** What the next write returns. */
  outcome: WriteOutcome = 'ok';
  /** Everything written, in order. */
  readonly written: Uint8Array[] = [];
  /** True once the socket has been closed from either end. */
  closed = false;

  write(bytes: Uint8Array): WriteOutcome {
    if (this.closed) return 'failed';
    this.written.push(bytes);
    if (this.outcome === 'ok') this.#peer?.(bytes);
    return this.outcome;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.#onClose?.();
  }

  /** @internal Wire the far end. */
  connect(peer: (bytes: Uint8Array) => void, onClose: () => void): void {
    this.#peer = peer;
    this.#onClose = onClose;
  }
}

/** A connected pair: a server carrier and the client carrier facing it. */
export interface MemorySocketPair {
  readonly server: SocketCarrier;
  readonly client: Carrier;
  readonly socket: FakeSocket;
  /** Drop the connection the way a dying network does. */
  kill(): void;
}

/** Create a connected pair. */
export function memoryPair(maxBufferedBytes = 1024 * 1024): MemorySocketPair {
  const socket = new FakeSocket();
  const server = new SocketCarrier(socket, { maxBufferedBytes });

  let clientOnMessage: ((bytes: Uint8Array) => void) | null = null;
  let clientOnClose: (() => void) | null = null;

  socket.connect(
    (bytes) => {
      // A microtask hop, because a synchronous pipe hides re-entrancy bugs.
      queueMicrotask(() => {
        clientOnMessage?.(bytes);
      });
    },
    () => {
      queueMicrotask(() => {
        clientOnClose?.();
      });
    },
  );

  const client: Carrier = {
    send: (bytes) => {
      if (socket.closed) return;
      queueMicrotask(() => {
        server.deliver(bytes);
      });
    },
    onMessage: (cb) => {
      clientOnMessage = cb;
    },
    onClose: (cb) => {
      clientOnClose = cb;
    },
    close: () => {
      socket.close();
      server.notifyClose();
    },
  };

  return {
    server,
    client,
    socket,
    kill: () => {
      socket.closed = true;
      server.notifyClose();
      clientOnClose?.();
    },
  };
}
