/**
 * A browser-shaped client for the server tests.
 *
 * It does what `@brobridgejs/client` will do in Phase 4 — bootstrap with the
 * launch token, then connect a WebSocket carrying the cookie — but with
 * nothing hidden: the tests need to see the raw handshake, so this helper
 * stays a thin wrapper over `ws` and `@brobridgejs/core`.
 */
import type { AttachOutcome, BridgeStream, Carrier } from '@brobridgejs/core';
import { BridgeEndpoint } from '@brobridgejs/core';
import WebSocket from 'ws';

/** What the bootstrap request yielded. */
export interface Bootstrap {
  /** The `bb_session_<port>` cookie, ready for a `Cookie` header. */
  readonly cookie: string;
  /** The redirect target. */
  readonly location: string | null;
  /** The bootstrap response itself, for header assertions. */
  readonly response: Response;
}

/**
 * Redeem a launch token.
 *
 * Redirects are not followed: the `303` and the headers on it are exactly
 * what the token-hygiene tests are about.
 */
export async function bootstrap(url: string, init: RequestInit = {}): Promise<Bootstrap> {
  const response = await fetch(url, { ...init, redirect: 'manual' });
  const setCookie = response.headers.get('set-cookie');
  const cookie = setCookie === null ? '' : (setCookie.split(';')[0] as string);
  return { cookie, location: response.headers.get('location'), response };
}

/** A connected client endpoint plus the socket under it. */
export interface TestClient {
  readonly endpoint: BridgeEndpoint;
  readonly socket: WebSocket;
  readonly outcome: AttachOutcome;
  /** Close the socket abruptly, the way a dying network does. */
  kill(): void;
  /** Close the endpoint and the socket. */
  close(): Promise<void>;
}

/** Options for {@link connect}. */
export interface ConnectOptions {
  readonly origin: string;
  readonly cookie: string;
  /** Reuse an endpoint to exercise `RESUME` on a fresh socket. */
  readonly endpoint?: BridgeEndpoint;
  /** Extra headers on the upgrade request. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Called for each stream the server pushes. */
  readonly onStream?: (stream: BridgeStream) => void;
}

/** Open a WebSocket to `/ws` and complete the protocol handshake. */
export async function connect(options: ConnectOptions): Promise<TestClient> {
  const url = `${options.origin.replace('http://', 'ws://')}/ws`;
  const socket = new WebSocket(url, {
    headers: {
      Cookie: options.cookie,
      Origin: options.origin,
      ...options.headers,
    },
  });
  socket.binaryType = 'nodebuffer';

  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
    socket.once('unexpected-response', (_request, response) => {
      reject(new Error(`upgrade refused with ${String(response.statusCode)}`));
    });
  });

  const carrier = new SocketClientCarrier(socket);
  const endpoint =
    options.endpoint ??
    new BridgeEndpoint({
      role: 'client',
      clientName: 'server-tests',
      ...(options.onStream === undefined ? {} : { onStream: options.onStream }),
    });
  const outcome = await endpoint.attach(carrier);

  return {
    endpoint,
    socket,
    outcome,
    kill: () => {
      socket.terminate();
    },
    close: async () => {
      endpoint.close();
      if (socket.readyState === WebSocket.CLOSED) return;
      socket.close();
      // A socket the server already terminated will never emit again, so the
      // wait is bounded rather than trusting the event.
      await Promise.race([
        once(socket, 'close'),
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
    },
  };
}

/** Do the whole dance: redeem the token, then connect. */
export async function bootstrapAndConnect(
  bridgeUrl: string,
  origin: string,
): Promise<TestClient & { cookie: string }> {
  const { cookie } = await bootstrap(bridgeUrl);
  const client = await connect({ origin, cookie });
  return Object.assign(client, { cookie });
}

/** The client half of the carrier contract, over a `ws` client socket. */
export class SocketClientCarrier implements Carrier {
  readonly #socket: WebSocket;
  #onMessage: ((bytes: Uint8Array) => void) | null = null;
  #onClose: (() => void) | null = null;

  constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on('message', (data: Buffer) => {
      this.#onMessage?.(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    });
    socket.on('close', () => {
      this.#onClose?.();
    });
    socket.on('error', () => {
      this.#onClose?.();
    });
  }

  send(bytes: Uint8Array): void {
    if (this.#socket.readyState !== WebSocket.OPEN) return;
    this.#socket.send(bytes, { binary: true });
  }

  onMessage(cb: (bytes: Uint8Array) => void): void {
    this.#onMessage = cb;
  }

  onClose(cb: () => void): void {
    this.#onClose = cb;
  }

  close(): void {
    this.#socket.close();
  }
}

/** Resolve when `emitter` emits `event`. */
export function once(emitter: WebSocket, event: string): Promise<void> {
  return new Promise((resolve) => {
    emitter.once(event, () => {
      resolve();
    });
  });
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

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Encode call arguments the way the raw service surface expects. */
export function args(...values: readonly unknown[]): Uint8Array {
  return encoder.encode(JSON.stringify(values));
}

/** Decode a call result. */
export function result<T>(payload: Uint8Array): T | undefined {
  if (payload.length === 0) return undefined;
  return JSON.parse(decoder.decode(payload)) as T;
}
