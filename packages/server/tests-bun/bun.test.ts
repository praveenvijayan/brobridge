/**
 * The Bun backend, under Bun's own test runner.
 *
 * `pnpm -F brobridge test` covers the Node backend; this file covers the
 * other half of the same public API. The point is not to re-test the fence's
 * logic — that is runtime-independent and already covered — but to prove that
 * the Bun path really does run it, and that handshake, streams and
 * authentication behave identically when `Bun.serve` owns the socket.
 *
 * Run with `pnpm -F brobridge test:bun`.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { createBridge } from '../src/index.js';
import type { Bridge } from '../src/index.js';
import { BridgeEndpoint } from '@brobridge/core';
import type { Carrier } from '@brobridge/core';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const running: Bridge[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
});

async function startBridge(): Promise<Bridge> {
  const bridge = await createBridge();
  running.push(bridge);
  bridge.expose('echo', {
    say: (text: string) => `echo: ${text}`,
    boom: () => {
      throw new Error('/private/secret blew up');
    },
  });
  bridge.stream('ticker', async (stream) => {
    for (let i = 0; i < 3; i += 1) await stream.write(encoder.encode(`tick ${String(i)};`));
    await stream.end();
  });
  return bridge;
}

/** Redeem the launch token and keep the cookie. */
async function bootstrap(bridge: Bridge): Promise<string> {
  const response = await fetch(bridge.url, { redirect: 'manual' });
  if (response.status !== 303) throw new Error(`bootstrap answered ${String(response.status)}`);
  const setCookie = response.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0] as string;
}

/** A carrier over Bun's WebSocket client. */
function carrierFor(socket: WebSocket): Carrier {
  let onMessage: ((bytes: Uint8Array) => void) | null = null;
  let onClose: (() => void) | null = null;
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('message', (event: MessageEvent) => {
    const data: unknown = event.data;
    if (data instanceof ArrayBuffer) onMessage?.(new Uint8Array(data));
  });
  socket.addEventListener('close', () => onClose?.());
  return {
    send: (bytes) => {
      socket.send(bytes);
    },
    onMessage: (cb) => {
      onMessage = cb;
    },
    onClose: (cb) => {
      onClose = cb;
    },
    close: () => {
      socket.close();
    },
  };
}

/** Connect a client endpoint over a real Bun WebSocket. */
async function connect(
  bridge: Bridge,
  cookie: string,
): Promise<{ endpoint: BridgeEndpoint; socket: WebSocket }> {
  const socket = new WebSocket(`${bridge.origin.replace('http://', 'ws://')}/ws`, {
    headers: { Cookie: cookie, Origin: bridge.origin },
  } as unknown as string[]);

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve();
    });
    socket.addEventListener('error', () => {
      reject(new Error('the upgrade was refused'));
    });
  });

  const endpoint = new BridgeEndpoint({ role: 'client', clientName: 'bun-tests' });
  await endpoint.attach(carrierFor(socket));
  return { endpoint, socket };
}

describe('the Bun backend', () => {
  it('runs the same bootstrap: one-time token, cookie, redirect', async () => {
    const bridge = await startBridge();

    const first = await fetch(bridge.url, { redirect: 'manual' });
    expect(first.status).toBe(303);
    expect(first.headers.get('location')).toBe('/');
    expect(first.headers.get('referrer-policy')).toBe('no-referrer');
    expect(first.headers.get('set-cookie') ?? '').toContain('SameSite=Strict');

    const replay = await fetch(bridge.url, { redirect: 'manual' });
    expect(replay.status).toBe(403);
  });

  it('runs the same fence on the served route', async () => {
    const bridge = await startBridge();
    const cookie = await bootstrap(bridge);

    const rebound = await fetch(`${bridge.origin}/`, {
      headers: { cookie, host: `evil.test:${String(bridge.port)}` },
    });
    expect(rebound.status).toBe(403);

    const crossSite = await fetch(`${bridge.origin}/`, {
      headers: { cookie, 'sec-fetch-site': 'cross-site' },
    });
    expect(crossSite.status).toBe(403);

    const allowed = await fetch(`${bridge.origin}/`, { headers: { cookie } });
    expect(allowed.status).toBe(200);
  });

  it('requires a credential everywhere', async () => {
    const bridge = await startBridge();
    expect((await fetch(`${bridge.origin}/`)).status).toBe(403);
    expect((await fetch(`${bridge.origin}/rpc`, { method: 'POST' })).status).toBe(403);

    const socket = new WebSocket(`${bridge.origin.replace('http://', 'ws://')}/ws`);
    const refused = await new Promise<boolean>((resolve) => {
      socket.addEventListener('open', () => {
        resolve(false);
      });
      socket.addEventListener('error', () => {
        resolve(true);
      });
      socket.addEventListener('close', () => {
        resolve(true);
      });
    });
    expect(refused).toBe(true);
  });

  it('completes the handshake and answers a unary call', async () => {
    const bridge = await startBridge();
    const cookie = await bootstrap(bridge);
    const { endpoint, socket } = await connect(bridge, cookie);

    const response = await endpoint.call('echo.say', encoder.encode(JSON.stringify(['bun'])));
    expect(decoder.decode(response)).toBe('"echo: bun"');

    endpoint.close();
    socket.close();
  });

  it('streams, and reduces a handler fault without leaking detail', async () => {
    const bridge = await startBridge();
    const cookie = await bootstrap(bridge);
    const { endpoint, socket } = await connect(bridge, cookie);

    const chunks: string[] = [];
    for await (const chunk of endpoint.openStream('ticker')) chunks.push(decoder.decode(chunk));
    expect(chunks.join('')).toBe('tick 0;tick 1;tick 2;');

    const failure = await endpoint
      .call('echo.boom', encoder.encode('[]'))
      .then(() => null)
      .catch((error: unknown) => error as Error);
    expect(failure).not.toBeNull();
    expect(failure?.message).not.toContain('/private/secret');

    endpoint.close();
    socket.close();
  });
});
