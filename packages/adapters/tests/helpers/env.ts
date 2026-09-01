/**
 * A browser, reduced to what an adapter test needs from one.
 *
 * Nothing below the browser line is mocked: `brobridge` binds an ephemeral
 * loopback port and `@brobridgejs/client` speaks the real protocol to it over a
 * real socket. What this supplies is what a browser would have supplied — a
 * cookie jar, and headers on the WebSocket upgrade — plus the ability to cut
 * a socket the way a failing network does.
 */
import type { Bridge as ClientBridge, ConnectOptions, FetchLike, SocketLike } from '@brobridgejs/client';
import { connect } from '@brobridgejs/client';
import type { Bridge as HostBridge, BridgeOptions } from 'brobridge';
import { createBridge } from 'brobridge';
import { WebSocket as NodeWebSocket } from 'ws';

/** Diagnostics from a deliberately broken connection are not test output. */
const quiet = { warn: (): void => {}, error: (): void => {} };

/** A cookie jar, a socket factory and a fetch, all pointed at one origin. */
export class BrowserEnv {
  readonly origin: string;
  readonly sockets: TestSocket[] = [];
  cookie = '';

  constructor(origin: string) {
    this.origin = origin;
  }

  readonly fetch: FetchLike = async (input, init) => {
    const headers = new Headers(init?.headers ?? {});
    headers.set('origin', this.origin);
    if (this.cookie !== '') headers.set('cookie', this.cookie);
    const response = await globalThis.fetch(input, { ...init, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie !== null) this.cookie = setCookie.split(';')[0] ?? '';
    return response;
  };

  readonly socket = (url: string): SocketLike => {
    const socket = new TestSocket(url, this.origin, this.cookie);
    this.sockets.push(socket);
    return socket;
  };

  /** The socket currently in use. */
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
    this.#socket.on('open', () => call(this.onopen, {}));
    this.#socket.on('message', (data: ArrayBuffer) => call(this.onmessage, { data }));
    this.#socket.on('close', () => call(this.onclose, {}));
    this.#socket.on('error', () => call(this.onerror, {}));
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

function call(handler: unknown, event: { data?: unknown }): void {
  if (typeof handler !== 'function') return;
  (handler as (event: { data?: unknown }) => void)(event);
}

/** One host and one browser, torn down together. */
export interface Harness {
  readonly host: HostBridge;
  readonly env: BrowserEnv;
  readonly client: ClientBridge;
  close(): Promise<void>;
}

/**
 * Start a host, let `mount` register routes on it, then connect a client.
 *
 * Routes must exist before the client connects, which is why `mount` runs
 * between the two rather than being left to the caller.
 */
export async function harness(
  mount: (host: HostBridge) => void,
  options: { host?: BridgeOptions; client?: ConnectOptions } = {},
): Promise<Harness> {
  const host = await createBridge({ logger: quiet, ...options.host });
  mount(host);
  const env = new BrowserEnv(host.origin);
  const client = await connect(host.url, {
    fetch: env.fetch,
    socket: env.socket,
    reconnectMinMs: 10,
    reconnectMaxMs: 40,
    ...options.client,
  });
  return {
    host,
    env,
    client,
    close: async () => {
      await client.close();
      await host.close();
    },
  };
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
