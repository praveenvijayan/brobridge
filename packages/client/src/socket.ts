/**
 * The WebSocket carrier and its watchdog.
 *
 * `@brobridge/core` speaks to the outside world through a three-method
 * carrier; this module is the only place in the client that knows a
 * `WebSocket` exists. It also owns liveness: `PROTOCOL.md` §11 makes silence
 * longer than `heartbeatTimeoutMs` a dead connection, and the cheapest place
 * to notice silence is where the bytes arrive.
 */
import type { Carrier } from '@brobridge/core';

import { BridgeClientError } from './errors.js';
import type { SocketFactory } from './types.js';

/** `WebSocket.OPEN`. Spelled out so the client needs no global at runtime. */
const OPEN = 1;

/** Close code used when the watchdog fires. In the application-private range. */
const HEARTBEAT_TIMEOUT_CODE = 4000;

/** What a `message` event carries. */
interface MessageLike {
  readonly data: unknown;
}

/** A connected socket, wrapped for core. */
export interface SocketConnection {
  /** The carrier to hand to the endpoint's `attach`. */
  readonly carrier: Carrier;
  /** Resolves once the socket is gone, whatever ended it. */
  readonly closed: Promise<void>;
  /** True when the watchdog, rather than the peer, ended this connection. */
  readonly timedOut: () => boolean;
  /** Close the socket. Idempotent. */
  close(): void;
}

/** Options for {@link openSocket}. */
export interface OpenSocketOptions {
  readonly socket: SocketFactory;
  /** How long the upgrade may take. */
  readonly connectTimeoutMs: number;
  /** Silence longer than this ends the connection. */
  readonly heartbeatTimeoutMs: number;
  /**
   * Settles when the caller has given up on this attempt.
   *
   * Without it, closing a bridge mid-upgrade would have to wait out
   * `connectTimeoutMs` before the process could let go of the socket.
   */
  readonly abort?: Promise<void>;
}

/**
 * Open a socket and wrap it as a carrier.
 *
 * Rejects with `connect-timeout` when the upgrade neither completes nor fails
 * in time, with `socket-failed` when the environment will not build a socket
 * at all, and with `unauthorized` when the upgrade itself fails — a browser
 * cannot see the status of a refused upgrade, so the caller confirms that last
 * reason with a probe rather than guessing here.
 */
export function openSocket(url: string, options: OpenSocketOptions): Promise<SocketConnection> {
  return new Promise<SocketConnection>((resolve, reject) => {
    let socket: ReturnType<SocketFactory>;
    try {
      socket = options.socket(url);
    } catch (cause) {
      reject(new BridgeClientError('socket-failed', 'the socket could not be created', { cause }));
      return;
    }
    socket.binaryType = 'arraybuffer';

    let settled = false;
    let timedOut = false;
    let closeConnection = (): void => {
      socket.close();
    };

    let resolveClosed = (): void => {};
    const closed = new Promise<void>((done) => {
      resolveClosed = done;
    });

    const openTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.close();
      reject(new BridgeClientError('connect-timeout', 'the connection attempt timed out'));
    }, options.connectTimeoutMs);

    void options.abort?.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(openTimer);
      socket.close();
      reject(new BridgeClientError('closed', 'the bridge closed during the connection attempt'));
    });

    const carrier = new SocketCarrier(socket);

    // Silence is measured from the last byte in, not from the last PING out:
    // any frame proves the peer is alive (`PROTOCOL.md` §11).
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const arm = (): void => {
      if (watchdog !== null) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        timedOut = true;
        socket.close(HEARTBEAT_TIMEOUT_CODE, 'heartbeat timeout');
      }, options.heartbeatTimeoutMs);
    };
    const disarm = (): void => {
      if (watchdog !== null) clearTimeout(watchdog);
      watchdog = null;
    };
    carrier.onBytes = arm;

    socket.onopen = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(openTimer);
      arm();
      closeConnection = (): void => {
        disarm();
        socket.close();
      };
      resolve({
        carrier,
        closed,
        timedOut: () => timedOut,
        close: () => {
          closeConnection();
        },
      });
    };

    socket.onclose = (): void => {
      disarm();
      carrier.notifyClosed();
      resolveClosed();
      if (settled) return;
      settled = true;
      clearTimeout(openTimer);
      reject(new BridgeClientError('unauthorized', 'the host refused the WebSocket upgrade'));
    };

    // `error` is deliberately not a rejection path of its own: a browser fires
    // it without a reason and always follows it with `close`, which is where
    // the single rejection lives. It is still claimed, because an unhandled
    // `error` is a warning in some runtimes and an exception in others.
    socket.onerror = (): void => {
      /* handled by the close handler */
    };
  });
}

/**
 * The carrier contract over one socket.
 *
 * Bytes that arrive before core has attached are queued rather than dropped:
 * the handshake sets `onMessage` a turn after the socket opens, and a server
 * that spoke first would otherwise lose that frame.
 */
class SocketCarrier implements Carrier {
  readonly #socket: ReturnType<SocketFactory>;
  #handler: ((bytes: Uint8Array) => void) | null = null;
  #onClose: (() => void) | null = null;
  #queue: Uint8Array[] = [];
  #closed = false;

  /** Called for every inbound message, before delivery. Rearms the watchdog. */
  onBytes: () => void = () => {};

  constructor(socket: ReturnType<SocketFactory>) {
    this.#socket = socket;
    socket.onmessage = (event: MessageLike): void => {
      this.onBytes();
      const bytes = toBytes(event.data);
      if (bytes === null) return;
      if (this.#handler === null) {
        this.#queue.push(bytes);
        return;
      }
      this.#handler(bytes);
    };
  }

  send(bytes: Uint8Array): void {
    if (this.#socket.readyState !== OPEN) return;
    this.#socket.send(bytes);
  }

  onMessage(cb: (bytes: Uint8Array) => void): void {
    this.#handler = cb;
    const queued = this.#queue;
    this.#queue = [];
    for (const bytes of queued) cb(bytes);
  }

  onClose(cb: () => void): void {
    this.#onClose = cb;
    if (this.#closed) cb();
  }

  close(): void {
    this.#socket.close();
  }

  /** Fire the close handler exactly once, whenever core gets around to setting it. */
  notifyClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#onClose?.();
  }
}

/**
 * Normalise a message payload to bytes.
 *
 * A text frame is not part of this protocol (`PROTOCOL.md` §3.2: every frame
 * is binary), so it is dropped rather than coerced — a peer that sends one is
 * not speaking brobridge, and guessing an encoding for it would invent data.
 */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}
