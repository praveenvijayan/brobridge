/**
 * A message port backed by a brobridge stream.
 *
 * oRPC's message-port adapter is written against a port that emits `message`
 * and `close` and accepts `postMessage` — the shape Electron's
 * `MessagePortMain` has. A brobridge duplex stream provides exactly that, and
 * because the stream survives a dropped socket by resuming, so does every
 * request in flight across it.
 *
 * @packageDocumentation
 */
import type { BridgeStream } from '@brobridgejs/core';

import { decodeMessage, encodeUnknown, frameMessage, readMessages } from './messages.js';

/** The event a port listener receives. */
export interface PortEvent {
  readonly data: unknown;
}

/**
 * The `MessagePortMain`-shaped view of a stream.
 *
 * Only `message` and `close` are ever emitted; other event names are accepted
 * and never fire, because the adapters that consume a port subscribe blind.
 */
export interface StreamPort {
  on(event: string, listener: (event?: PortEvent) => void): void;
  postMessage(data: unknown, transfer?: unknown[]): void;
  /** Resolves when the read side has drained or failed. Test and teardown aid. */
  readonly drained: Promise<void>;
}

/**
 * Wrap a stream as a port.
 *
 * Writes are handed to the stream in call order — the protocol serialises
 * them — so a `postMessage` that has to wait for credit delays the messages
 * behind it rather than letting them overtake it.
 */
export function createStreamPort(stream: BridgeStream): StreamPort {
  const messageListeners = new Set<(event?: PortEvent) => void>();
  const closeListeners = new Set<(event?: PortEvent) => void>();
  // Messages that arrived before anything subscribed. A consumer that has to
  // await something — an application's context factory, say — before it can
  // subscribe must not lose the request that opened the stream.
  const pending: PortEvent[] = [];
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const listener of [...closeListeners]) listener();
  };

  const drained = (async () => {
    try {
      for await (const message of readMessages(stream)) {
        const event: PortEvent = { data: decodeMessage(message) };
        if (messageListeners.size === 0) {
          pending.push(event);
          continue;
        }
        for (const listener of [...messageListeners]) listener(event);
      }
    } finally {
      close();
    }
  })();

  return {
    drained: drained.catch(() => undefined),
    on(event, listener): void {
      if (event === 'close') {
        closeListeners.add(listener);
        if (closed) listener();
        return;
      }
      if (event !== 'message') return;
      messageListeners.add(listener);
      if (pending.length === 0) return;
      const buffered = pending.splice(0, pending.length);
      for (const held of buffered) listener(held);
    },
    postMessage(data): void {
      if (closed) return;
      const message = encodeUnknown(data);
      // A write that fails means the stream is gone; the port's contract for
      // that is `close`, not an unhandled rejection in whatever called us.
      void stream.write(frameMessage(message.kind, message.payload)).catch(close);
    },
  };
}
