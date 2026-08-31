/**
 * A browser, reduced to what the client needs from one.
 *
 * The client is written against standard `WebSocket` and `fetch`, but a Node
 * test process has neither of the two things a browser brings for free: a
 * cookie jar, and a way to put `Cookie` and `Origin` on a WebSocket upgrade.
 * This helper supplies both, and nothing else — every request the client makes
 * still goes over a real socket to a real listener.
 *
 * It also records every request, which is how the token-hygiene test proves
 * that the launch token rode exactly one of them.
 */
import { WebSocket as NodeWebSocket } from 'ws';

import type { FetchLike, SocketLike } from '../../src/types.js';

/** One request the environment carried, as the hygiene test sees it. */
export interface RecordedRequest {
  readonly kind: 'fetch' | 'socket';
  readonly url: string;
}

/** A cookie jar, a socket factory and a fetch, all pointed at one origin. */
export class BrowserEnv {
  readonly origin: string;
  /** Every request this environment made, in order. */
  readonly requests: RecordedRequest[] = [];
  /** Every socket it opened, so a test can kill one the way a network does. */
  readonly sockets: TestSocket[] = [];
  /** The stored session cookie, exactly as a browser would hold it. */
  cookie = '';
  /** Set to make the next socket attempt fail, standing in for a blocked WebSocket. */
  blockSockets = false;

  constructor(origin: string) {
    this.origin = origin;
  }

  readonly fetch: FetchLike = async (input, init) => {
    this.requests.push({ kind: 'fetch', url: input });
    const headers = new Headers(init?.headers ?? {});
    headers.set('origin', this.origin);
    if (this.cookie !== '') headers.set('cookie', this.cookie);
    const response = await globalThis.fetch(input, { ...init, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie !== null) this.cookie = setCookie.split(';')[0] ?? '';
    return response;
  };

  readonly socket = (url: string): SocketLike => {
    this.requests.push({ kind: 'socket', url });
    if (this.blockSockets) throw new Error('WebSocket blocked by the environment');
    const socket = new TestSocket(url, this.origin, this.cookie);
    this.sockets.push(socket);
    return socket;
  };

  /** The socket currently in use, or `undefined` before the first connection. */
  get lastSocket(): TestSocket | undefined {
    return this.sockets[this.sockets.length - 1];
  }
}

/** `SocketLike` over the `ws` client, carrying the browser's headers. */
export class TestSocket implements SocketLike {
  readonly #socket: NodeWebSocket;

  binaryType = 'arraybuffer';
  onopen: unknown = null;
  onmessage: unknown = null;
  onclose: unknown = null;
  onerror: unknown = null;

  constructor(url: string, origin: string, cookie: string) {
    this.#socket = new NodeWebSocket(url, {
      headers: { Origin: origin, ...(cookie === '' ? {} : { Cookie: cookie }) },
    });
    this.#socket.binaryType = 'arraybuffer';
    this.#socket.on('open', () => {
      call(this.onopen, {});
    });
    this.#socket.on('message', (data: ArrayBuffer) => {
      call(this.onmessage, { data });
    });
    this.#socket.on('close', () => {
      call(this.onclose, {});
    });
    this.#socket.on('error', () => {
      call(this.onerror, {});
    });
  }

  get readyState(): number {
    return this.#socket.readyState;
  }

  send(data: Uint8Array): void {
    this.#socket.send(data, { binary: true });
  }

  close(code?: number, reason?: string): void {
    this.#socket.close(code, reason);
  }

  /** Cut the connection without a close handshake, the way a dying network does. */
  kill(): void {
    this.#socket.terminate();
  }
}

/** Invoke a handler the client assigned, whatever shape it declared. */
function call(handler: unknown, event: { data?: unknown }): void {
  if (typeof handler !== 'function') return;
  (handler as (event: { data?: unknown }) => void)(event);
}

/** Collect an async iterable of chunks into one buffer. */
export async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Resolve after `ms`. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until `predicate` holds, or fail loudly rather than hang the suite. */
export async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}
