/**
 * The client against the Bun host, under Bun's own test runner.
 *
 * `pnpm -F @brobridgejs/client test` covers the client against the Node backend.
 * This file covers the other half of the matrix: the same client code, the
 * same protocol, with `Bun.serve` owning the socket on the host side. The
 * point is not to re-test the client's logic — that is runtime-independent
 * and already covered — but to prove that a tab talking to a Bun host gets the
 * same handshake, the same streams and the same resume.
 *
 * Run with `pnpm -F @brobridgejs/client test:bun`.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { createBridge } from 'brobridge';
import type { Bridge as HostBridge } from 'brobridge';

import { connect } from '../src/client.js';
import type { Bridge } from '../src/client.js';
import type { FetchLike, SocketLike } from '../src/types.js';

const text = new TextEncoder();

const hosts: HostBridge[] = [];
const clients: Bridge[] = [];

afterEach(async () => {
  while (clients.length > 0) await clients.pop()?.close();
  while (hosts.length > 0) await hosts.pop()?.close();
});

/**
 * The browser parts Bun does not provide: a cookie jar, and headers on the
 * upgrade. Everything else is Bun's own `fetch` and `WebSocket`.
 */
class BunEnv {
  readonly origin: string;
  readonly sockets: BunSocket[] = [];
  cookie = '';

  constructor(origin: string) {
    this.origin = origin;
  }

  readonly fetch: FetchLike = async (input, init) => {
    const headers = new Headers(init?.headers ?? {});
    headers.set('origin', this.origin);
    if (this.cookie !== '') headers.set('cookie', this.cookie);
    const response = await fetch(input, { ...init, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie !== null) this.cookie = setCookie.split(';')[0] ?? '';
    return response;
  };

  readonly socket = (url: string): SocketLike => {
    const socket = new BunSocket(url, this.origin, this.cookie);
    this.sockets.push(socket);
    return socket;
  };

  get lastSocket(): BunSocket | undefined {
    return this.sockets[this.sockets.length - 1];
  }
}

/** `SocketLike` over Bun's WebSocket, carrying the browser's headers. */
class BunSocket implements SocketLike {
  readonly #socket: WebSocket;

  binaryType = 'arraybuffer';
  onopen: unknown = null;
  onmessage: unknown = null;
  onclose: unknown = null;
  onerror: unknown = null;

  constructor(url: string, origin: string, cookie: string) {
    this.#socket = new WebSocket(url, {
      headers: { Origin: origin, ...(cookie === '' ? {} : { Cookie: cookie }) },
    } as unknown as string[]);
    this.#socket.binaryType = 'arraybuffer';
    this.#socket.addEventListener('open', () => call(this.onopen, {}));
    this.#socket.addEventListener('message', (event: MessageEvent) => {
      call(this.onmessage, { data: event.data as unknown });
    });
    this.#socket.addEventListener('close', () => call(this.onclose, {}));
    this.#socket.addEventListener('error', () => call(this.onerror, {}));
  }

  get readyState(): number {
    return this.#socket.readyState;
  }

  send(data: Uint8Array): void {
    this.#socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.#socket.close(code, reason);
  }
}

function call(handler: unknown, event: { data?: unknown }): void {
  if (typeof handler !== 'function') return;
  (handler as (event: { data?: unknown }) => void)(event);
}

async function startHost(): Promise<{ host: HostBridge; env: BunEnv }> {
  const host = await createBridge({ logger: { warn: () => {}, error: () => {} } });
  hosts.push(host);
  host.expose('math', { add: (a: number, b: number) => a + b });
  host.stream('bulk', async (stream) => {
    for (let index = 0; index < 512; index += 1) {
      await stream.write(text.encode(`${String(index)},`.padEnd(1_024, '.')));
    }
    await stream.end();
  });
  host.stream('ticker', async (stream) => {
    for (let tick = 0; tick < 3; tick += 1) await stream.write(text.encode(`tick ${String(tick)};`));
    await stream.end();
  });
  return { host, env: new BunEnv(host.origin) };
}

async function open(host: HostBridge, env: BunEnv): Promise<Bridge> {
  const client = await connect(host.url, {
    fetch: env.fetch,
    socket: env.socket,
    reconnectMinMs: 10,
    reconnectMaxMs: 40,
    clientName: 'client-bun-tests',
  });
  clients.push(client);
  return client;
}

describe('the client against a Bun host', () => {
  it('bootstraps, handshakes and calls', async () => {
    const { host, env } = await startHost();
    const client = await open(host, env);
    expect(client.state).toBe('open');
    expect(client.sessionId).not.toBeNull();
    expect(await client.call<number>('math.add', 2, 3)).toBe(5);
    expect(client.url).toBe(host.origin);
  });

  it('consumes a stream', async () => {
    const { host, env } = await startHost();
    const client = await open(host, env);
    const stream = await client.openStream('ticker');
    let received = '';
    for await (const chunk of stream) received += new TextDecoder().decode(chunk);
    expect(received).toBe('tick 0;tick 1;tick 2;');
  });

  it('resumes a stream across a dropped socket, losing nothing', async () => {
    const { host, env } = await startHost();
    const client = await open(host, env);
    const stream = await client.openStream('bulk');

    let bytes = 0;
    let index = 0;
    let killed = false;
    const seen: string[] = [];
    for await (const chunk of stream) {
      bytes += chunk.length;
      // Each frame starts with its own index, so a gap or a repeat is visible.
      seen.push(new TextDecoder().decode(chunk).split(',')[0] ?? '');
      index += 1;
      if (!killed && bytes > 32 * 1_024) {
        killed = true;
        env.lastSocket?.close();
      }
    }

    expect(killed).toBe(true);
    expect(env.sockets.length).toBeGreaterThan(1);
    expect(bytes).toBe(512 * 1_024);
    expect(index).toBe(512);
    expect(seen).toEqual(Array.from({ length: 512 }, (_value, at) => String(at)));
    expect(client.state).toBe('open');
  });

  it('carries unary calls over the HTTP fallback', async () => {
    const { host, env } = await startHost();
    const client = await connect(host.url, {
      fetch: env.fetch,
      socket: () => {
        throw new Error('WebSocket blocked by the environment');
      },
      httpFallback: true,
      wsAttemptsBeforeFallback: 2,
      reconnectMinMs: 5,
      reconnectMaxMs: 10,
    });
    clients.push(client);
    expect(client.state).toBe('degraded');
    expect(await client.call<number>('math.add', 20, 22)).toBe(42);
  });
});
