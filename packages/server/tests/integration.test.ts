/**
 * The server against real sockets: bootstrap, upgrade, call, stream, resume,
 * fallback, shutdown.
 *
 * Every case here goes over an ephemeral loopback port with a client that
 * behaves like a browser would, because the interesting failures — a
 * handshake that completes before authentication, a stream that survives a
 * shutdown, a listener that outlives `close()` — are not visible from a unit
 * test.
 */
import { ErrorCode, StreamError } from '@brobridgejs/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createBridge } from '../src/index.js';
import type { Bridge } from '../src/index.js';
import { SESSION_COOKIE_NAME } from '../src/auth.js';
import { RPC_CONTENT_TYPE } from '../src/rpc.js';
import {
  args,
  bootstrap,
  bootstrapAndConnect,
  collect,
  connect,
  result,
} from './helpers/client.js';
import { activeListeners, settle } from './helpers/handles.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const running: Bridge[] = [];

/** Start a bridge that the leak guard will hold to account. */
async function startBridge(...rest: Parameters<typeof createBridge>): Promise<Bridge> {
  const bridge = await createBridge(...rest);
  running.push(bridge);
  return bridge;
}

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
  // Every listener this file opened must be gone. A suite that needs
  // `--forceExit` is a suite that has stopped testing shutdown.
  await settle(() => activeListeners().length === 0);
  expect(activeListeners()).toHaveLength(0);
});

/** A bridge with the routes the tests below use. */
async function demoBridge(): Promise<Bridge> {
  const bridge = await startBridge();
  bridge.expose('echo', {
    say: (text: string) => `echo: ${text}`,
    add: (a: number, b: number) => a + b,
    boom: () => {
      throw new Error('/Users/someone/secret/path.ts blew up');
    },
    nothing: () => undefined,
  });
  bridge.stream('ticker', async (stream, context) => {
    const count = Number(context.params['count'] ?? 3);
    for (let i = 0; i < count; i += 1) await stream.write(encoder.encode(`tick ${String(i)}\n`));
    await stream.end();
  });
  return bridge;
}

describe('bootstrap', () => {
  it('burns the token, sets the cookie and redirects the token out of history', async () => {
    const bridge = await demoBridge();

    const first = await bootstrap(bridge.url);
    expect(first.response.status).toBe(303);
    expect(first.location).toBe('/');
    expect(first.response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(first.response.headers.get('cache-control')).toBe('no-store');
    const setCookie = first.response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    expect(await first.response.text()).toBe('');

    // The token in the browser's history is worthless.
    const second = await bootstrap(bridge.url);
    expect(second.response.status).toBe(403);
    expect(await second.response.text()).toBe('');
  });

  it('serves the index only to an authenticated caller', async () => {
    const bridge = await startBridge({ index: { body: '<h1>app</h1>' } });
    const { cookie } = await bootstrap(bridge.url);

    const anonymous = await fetch(`${bridge.origin}/`);
    expect(anonymous.status).toBe(403);
    expect(await anonymous.text()).toBe('');

    const authenticated = await fetch(`${bridge.origin}/`, { headers: { cookie } });
    expect(authenticated.status).toBe(200);
    expect(await authenticated.text()).toBe('<h1>app</h1>');
  });

  it('strips a token that is presented again alongside a valid cookie', async () => {
    const bridge = await demoBridge();
    const { cookie } = await bootstrap(bridge.url);

    const replayed = await fetch(bridge.url, { headers: { cookie }, redirect: 'manual' });
    expect(replayed.status).toBe(303);
    expect(replayed.headers.get('location')).toBe('/');
    // No new session was minted for the replay.
    expect(replayed.headers.get('set-cookie')).toBeNull();
  });

  it('answers an unknown path with 404 and an unauthenticated one with 403', async () => {
    const bridge = await demoBridge();
    const { cookie } = await bootstrap(bridge.url);

    expect((await fetch(`${bridge.origin}/nope`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${bridge.origin}/nope`)).status).toBe(403);
    // Nothing on the served surface reads from disk (THREAT-MODEL.md §5.13).
    expect((await fetch(`${bridge.origin}/../../etc/passwd`, { headers: { cookie } })).status).toBe(
      404,
    );
  });

  it('rate-limits authentication failures', async () => {
    const bridge = await startBridge({ authFailuresPerWindow: 3, authFailureWindowMs: 60_000 });
    for (let i = 0; i < 3; i += 1) {
      expect((await fetch(`${bridge.origin}/`)).status).toBe(403);
    }
    const limited = await fetch(`${bridge.origin}/`);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('the WebSocket surface', () => {
  it('refuses an upgrade without a cookie, without completing the handshake', async () => {
    const bridge = await demoBridge();
    await expect(connect({ origin: bridge.origin, cookie: '' })).rejects.toThrow(/403/);
  });

  it('refuses an upgrade whose Origin is not allowed', async () => {
    const bridge = await demoBridge();
    const { cookie } = await bootstrap(bridge.url);
    await expect(
      connect({ origin: bridge.origin, cookie, headers: { Origin: 'http://evil.test' } }),
    ).rejects.toThrow(/403/);
  });

  it('completes the protocol handshake and answers a unary call', async () => {
    const bridge = await demoBridge();
    const client = await bootstrapAndConnect(bridge.url, bridge.origin);

    expect(client.outcome.kind).toBe('hello');
    const response = await client.endpoint.call('echo.say', args('hi'));
    expect(result<string>(response)).toBe('echo: hi');
    expect(result<number>(await client.endpoint.call('echo.add', args(2, 3)))).toBe(5);
    expect(result(await client.endpoint.call('echo.nothing', args()))).toBeUndefined();

    await client.close();
  });

  it('reduces an unexpected handler fault to INTERNAL_ERROR without leaking detail', async () => {
    const bridge = await demoBridge();
    const client = await bootstrapAndConnect(bridge.url, bridge.origin);

    const failure = await client.endpoint.call('echo.boom', args()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StreamError);
    const error = failure as StreamError;
    expect(error.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(error.message).not.toContain('/Users/');

    // An unknown route is NOT_FOUND, and the connection survives both.
    const missing = await client.endpoint
      .call('echo.missing', args())
      .catch((cause: unknown) => cause);
    expect((missing as StreamError).code).toBe(ErrorCode.NOT_FOUND);
    expect(result<string>(await client.endpoint.call('echo.say', args('still here')))).toBe(
      'echo: still here',
    );

    await client.close();
  });

  it('streams, and keeps concurrent streams independent', async () => {
    const bridge = await demoBridge();
    const client = await bootstrapAndConnect(bridge.url, bridge.origin);

    const first = client.endpoint.openStream('ticker', { params: { count: 4 } });
    const second = client.endpoint.openStream('ticker', { params: { count: 2 } });

    const [a, b] = await Promise.all([collect(first), collect(second)]);
    expect(decoder.decode(a)).toBe('tick 0\ntick 1\ntick 2\ntick 3\n');
    expect(decoder.decode(b)).toBe('tick 0\ntick 1\n');

    await client.close();
  });

  it('reports the session to the host application', async () => {
    const seen: string[] = [];
    const bridge = await startBridge({
      onSession: (session) => {
        seen.push(session.id);
      },
    });
    const client = await bootstrapAndConnect(bridge.url, bridge.origin);

    expect(seen).toHaveLength(1);
    expect(bridge.sessions.map((session) => session.id)).toEqual(seen);
    await client.close();
  });

  it('lets the host push a stream into the tab', async () => {
    const bridge = await startBridge();
    const { cookie } = await bootstrap(bridge.url);
    const pushed: Promise<Uint8Array>[] = [];
    const client = await connect({
      origin: bridge.origin,
      cookie,
      onStream: (stream) => {
        pushed.push(collect(stream));
      },
    });

    const session = bridge.sessions[0];
    if (session === undefined) throw new Error('the session should be registered by now');

    const outgoing = session.openStream('push');
    await outgoing.end(encoder.encode('from the host'));

    await settle(() => pushed.length > 0);
    expect(decoder.decode(await (pushed[0] as Promise<Uint8Array>))).toBe('from the host');

    await client.close();
  });
});

describe('resume across a dead socket', () => {
  it('replays the bytes the broken socket swallowed, exactly once', async () => {
    const bridge = await startBridge();
    bridge.stream('slow', async (stream) => {
      for (let i = 0; i < 8; i += 1) {
        await stream.write(encoder.encode(`chunk ${String(i)};`));
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await stream.end();
    });

    const { cookie } = await bootstrap(bridge.url);
    const first = await connect({ origin: bridge.origin, cookie });
    const stream = first.endpoint.openStream('slow');

    const received: string[] = [];
    const iterator = stream[Symbol.asyncIterator]();
    const initial = await iterator.next();
    if (initial.done !== true) received.push(decoder.decode(initial.value));

    // The socket dies mid-transfer; the session does not.
    first.kill();
    await settle(() => first.endpoint.state === 'detached');

    const second = await connect({ origin: bridge.origin, cookie, endpoint: first.endpoint });
    expect(second.outcome.kind).toBe('resume');

    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      received.push(decoder.decode(next.value));
    }

    const joined = received.join('');
    for (let i = 0; i < 8; i += 1) {
      const chunk = `chunk ${String(i)};`;
      expect(joined.split(chunk).length - 1, chunk).toBe(1);
    }
    expect(joined).toBe(
      Array.from({ length: 8 }, (_, i) => `chunk ${String(i)};`).join(''),
    );

    await second.close();
  });
});

describe('the HTTP fallback', () => {
  it('answers a unary call framed in the request body', async () => {
    const bridge = await demoBridge();
    const { cookie } = await bootstrap(bridge.url);

    const { encodeFrame, FrameType, FrameFlags, FrameDecoder } = await import('@brobridgejs/core');
    const open = encodeFrame({
      type: FrameType.OPEN,
      streamId: 1,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { name: 'echo.say' },
    });
    const data = encodeFrame({
      type: FrameType.DATA,
      streamId: 1,
      seq: 1,
      flags: FrameFlags.FIN,
      payload: args('over http'),
    });
    const body = new Uint8Array(open.length + data.length);
    body.set(open, 0);
    body.set(data, open.length);

    const response = await fetch(`${bridge.origin}/rpc`, {
      method: 'POST',
      headers: { cookie, 'content-type': RPC_CONTENT_TYPE },
      body,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(RPC_CONTENT_TYPE);

    const decoded = new FrameDecoder().push(new Uint8Array(await response.arrayBuffer()));
    expect(decoded.error).toBeNull();
    expect(decoded.frames).toHaveLength(2);
    const ack = decoded.frames[0];
    const payload = decoded.frames[1];
    expect(ack?.type).toBe(FrameType.OPEN_ACK);
    if (payload?.type !== FrameType.DATA) throw new Error('the second frame should be DATA');
    expect(payload.flags & FrameFlags.FIN).toBe(FrameFlags.FIN);
    expect(result<string>(payload.payload)).toBe('echo: over http');
  });

  it('requires the same credential as the socket', async () => {
    const bridge = await demoBridge();
    const response = await fetch(`${bridge.origin}/rpc`, { method: 'POST', body: new Uint8Array(4) });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('');
  });

  it('refuses a body that is not exactly OPEN + DATA(FIN)', async () => {
    const bridge = await demoBridge();
    const { cookie } = await bootstrap(bridge.url);
    const response = await fetch(`${bridge.origin}/rpc`, {
      method: 'POST',
      headers: { cookie },
      body: encoder.encode('not frames at all'),
    });
    expect(response.status).toBe(400);
  });

  it('refuses a body past the configured limit', async () => {
    const bridge = await startBridge({ maxRpcBodyBytes: 1024 });
    const { cookie } = await bootstrap(bridge.url);
    const response = await fetch(`${bridge.origin}/rpc`, {
      method: 'POST',
      headers: { cookie },
      body: new Uint8Array(4096),
    });
    expect(response.status).toBe(413);
  });
});

describe('shutdown', () => {
  it('closes gracefully mid-stream and releases the listener', async () => {
    const bridge = await startBridge();
    bridge.stream('endless', async (stream) => {
      for (;;) {
        await stream.write(encoder.encode('.'));
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    const client = await bootstrapAndConnect(bridge.url, bridge.origin);
    const stream = client.endpoint.openStream('endless');
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();

    await bridge.close();
    running.pop();

    await settle(() => activeListeners().length === 0);
    expect(activeListeners()).toHaveLength(0);

    // A call after shutdown fails; it does not hang.
    await expect(
      Promise.race([
        client.endpoint.call('echo.say', args('anyone there?')),
        new Promise((_, reject) => setTimeout(() => reject(new Error('hung')), 2_000)),
      ]),
    ).rejects.toThrow();
    await client.close();
  });

  it('is idempotent', async () => {
    const bridge = await startBridge();
    await bridge.close();
    await expect(bridge.close()).resolves.toBeUndefined();
    running.pop();
  });
});
