/**
 * The client against the real host, over real sockets.
 *
 * Nothing here is mocked below the browser line: `brobridge` binds an
 * ephemeral loopback port, the client bootstraps with the launch token,
 * upgrades, and speaks the protocol. What the helper supplies is only what a
 * browser would have supplied anyway — a cookie jar and headers on the
 * upgrade — plus the ability to cut a socket the way a network does.
 */
import type { Bridge as HostBridge, BridgeOptions } from 'brobridge';
import { createBridge } from 'brobridge';
import { BridgeError, ErrorCode, ResumeFailedError, SnapshotRequiredError } from '@brobridge/core';
import { afterEach, describe, expect, it } from 'vitest';

import { connect } from '../src/client.js';
import type { Bridge } from '../src/client.js';
import type { ConnectOptions } from '../src/types.js';
import { BrowserEnv, collect, sleep, waitFor } from './helpers/env.js';

/** Diagnostics from a deliberately broken connection are not test output. */
const quiet = { warn: () => {}, error: () => {} };

const started: HostBridge[] = [];
const connected: Bridge[] = [];

afterEach(async () => {
  await Promise.all(connected.splice(0).map((client) => client.close()));
  await Promise.all(started.splice(0).map((host) => host.close()));
});

async function startHost(options: BridgeOptions = {}): Promise<{
  host: HostBridge;
  env: BrowserEnv;
}> {
  const host = await createBridge({ logger: quiet, ...options });
  started.push(host);
  return { host, env: new BrowserEnv(host.origin) };
}

async function open(
  host: HostBridge,
  env: BrowserEnv,
  options: ConnectOptions = {},
): Promise<Bridge> {
  const client = await connect(host.url, {
    fetch: env.fetch,
    socket: env.socket,
    reconnectMinMs: 10,
    reconnectMaxMs: 40,
    clientName: 'client-tests',
    ...options,
  });
  connected.push(client);
  return client;
}

const text = new TextEncoder();

describe('calls', () => {
  it('round-trips arguments and results, through the proxy too', async () => {
    const { host, env } = await startHost();
    host.expose('math', {
      add: (a: number, b: number) => a + b,
      nothing: () => undefined,
    });

    const client = await open(host, env);
    await expect(client.call<number>('math.add', 2, 3)).resolves.toBe(5);
    await expect(client.call('math.nothing')).resolves.toBeUndefined();

    interface Math_ {
      add(a: number, b: number): number;
    }
    const math = client.makeProxy<Math_>('math');
    await expect(math.add(20, 22)).resolves.toBe(42);
  });

  it('surfaces the code the host sent, and hides everything else', async () => {
    const { host, env } = await startHost();
    host.expose('svc', {
      denied: () => {
        throw new BridgeError(ErrorCode.PERMISSION_DENIED, 'not for you');
      },
      leaky: () => {
        throw new Error('/home/secret/path exploded');
      },
    });

    const client = await open(host, env);
    await expect(client.call('svc.denied')).rejects.toMatchObject({
      code: ErrorCode.PERMISSION_DENIED,
      message: 'not for you',
    });
    const leak = await client.call('svc.leaky').catch((cause: unknown) => cause);
    expect(String(leak)).not.toContain('secret');
    await expect(client.call('svc.missing')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('refuses to work once closed', async () => {
    const { host, env } = await startHost();
    host.expose('math', { add: (a: number, b: number) => a + b });
    const client = await open(host, env);
    await client.close();
    await expect(client.call('math.add', 1, 1)).rejects.toMatchObject({ reason: 'closed' });
    expect(client.state).toBe('closed');
  });
});

describe('streams', () => {
  it('consumes a host stream to completion', async () => {
    const { host, env } = await startHost();
    host.stream('ticker', async (stream) => {
      for (let tick = 0; tick < 5; tick += 1) await stream.write(text.encode(`tick ${tick};`));
      await stream.end();
    });

    const client = await open(host, env);
    const stream = await client.openStream('ticker');
    expect(new TextDecoder().decode(await collect(stream))).toBe(
      'tick 0;tick 1;tick 2;tick 3;tick 4;',
    );
  });

  it('passes route parameters', async () => {
    const { host, env } = await startHost();
    host.stream('echo-params', async (stream, context) => {
      await stream.end(text.encode(JSON.stringify(context.params)));
    });

    const client = await open(host, env);
    const stream = await client.openStream('echo-params', { cols: 80 });
    expect(new TextDecoder().decode(await collect(stream))).toBe('{"cols":80}');
  });

  it('stalls only the stream whose consumer stopped reading', async () => {
    const { host, env } = await startHost();
    // The slow route writes far more than one credit window, so it blocks in
    // `write` as soon as its consumer stops reading.
    host.stream('slow', async (stream) => {
      for (let index = 0; index < 4_096; index += 1) {
        await stream.write(new Uint8Array(1_024));
      }
    });
    host.stream('fast', async (stream) => {
      for (let index = 0; index < 32; index += 1) await stream.write(text.encode('x'));
      await stream.end();
    });

    const client = await open(host, env);
    const slow = await client.openStream('slow');
    const slowReader = slow[Symbol.asyncIterator]();
    await slowReader.next(); // take one chunk, then stop reading entirely.

    const started_ = Date.now();
    const fast = await client.openStream('fast');
    const payload = await collect(fast);
    const elapsed = Date.now() - started_;

    expect(payload.length).toBe(32);
    // A socket blocked by the stalled stream would take far longer than this;
    // the assertion is deliberately loose so it measures isolation, not speed.
    expect(elapsed).toBeLessThan(1_000);
    slow.cancel('done');
  });
});

describe('reconnect and resume', () => {
  it('sees every byte exactly once across a dropped socket', async () => {
    // 512 KiB in 1 KiB frames: eight times the initial credit window, so the
    // producer is still writing — and blocked on credit — when the socket
    // dies. A transfer that fits in one window would be delivered before the
    // kill lands and would prove nothing.
    const chunks = 512;
    const chunk = (index: number): Uint8Array =>
      text.encode(`${String(index)},`.padEnd(1_024, '.'));
    const { host, env } = await startHost();
    host.stream('bulk', async (stream) => {
      for (let index = 0; index < chunks; index += 1) await stream.write(chunk(index));
      await stream.end();
    });

    const client = await open(host, env);
    const stream = await client.openStream('bulk');

    const received: Uint8Array[] = [];
    let bytes = 0;
    let killed = false;
    for await (const piece of stream) {
      received.push(piece);
      bytes += piece.length;
      if (!killed && bytes > 32 * 1_024) {
        killed = true;
        env.lastSocket?.kill();
      }
    }

    expect(killed).toBe(true);
    expect(env.sockets.length).toBeGreaterThan(1);
    expect(bytes).toBe(chunks * 1_024);
    // Byte-for-byte: a resume that replayed too much, or too little, shows up
    // here as a shifted or duplicated index marker.
    const expected = new Uint8Array(chunks * 1_024);
    for (let index = 0; index < chunks; index += 1) expected.set(chunk(index), index * 1_024);
    const actual = new Uint8Array(bytes);
    let offset = 0;
    for (const piece of received) {
      actual.set(piece, offset);
      offset += piece.length;
    }
    expect(actual).toEqual(expected);
    expect(client.state).toBe('open');
  });

  it('reports an aged-out cursor as SnapshotRequiredError, never as a gap', async () => {
    // A replay window of two frames cannot cover a producer that keeps going
    // while the socket is down.
    const { host, env } = await startHost({ resumeWindow: { bytes: 2_048, frames: 2 } });
    host.stream('firehose', async (stream) => {
      for (let index = 0; index < 4_096; index += 1) {
        await stream.write(new Uint8Array(512));
      }
    });

    const client = await open(host, env);
    const stream = await client.openStream('firehose');
    const reader = stream[Symbol.asyncIterator]();
    await reader.next();

    env.blockSockets = true;
    env.lastSocket?.kill();
    await sleep(150); // the host fills the window while nothing is attached
    env.blockSockets = false;

    const failure = await drain(reader).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(SnapshotRequiredError);
    await waitFor(() => client.state === 'open', 'the connection to come back');
  });

  it('starts a fresh session when the host has forgotten this one', async () => {
    const { host, env } = await startHost({ sessionTtlMs: 100 });
    host.stream('ticker', async (stream) => {
      for (;;) {
        await stream.write(text.encode('.'));
        await sleep(5);
      }
    });

    const client = await open(host, env);
    const first = client.sessionId;
    const faults: Error[] = [];
    client.on('error', (fault) => faults.push(fault));
    const stream = await client.openStream('ticker');
    const reader = stream[Symbol.asyncIterator]();
    await reader.next();

    env.blockSockets = true;
    env.lastSocket?.kill();
    // The host reaps expired sessions on a sweep, and the sweep runs at most
    // twice a second, so outliving the TTL means outliving the sweep too.
    await sleep(1_400);
    env.blockSockets = false;

    await expect(drain(reader)).rejects.toBeInstanceOf(Error);
    expect(faults.some((fault) => fault instanceof ResumeFailedError)).toBe(true);
    await waitFor(() => client.state === 'open', 'the renegotiated connection');
    expect(client.sessionId).not.toBe(first);

    // The new session is a working one, not a husk.
    host.expose('math', { add: (a: number, b: number) => a + b });
    await expect(client.call<number>('math.add', 1, 2)).resolves.toBe(3);
  });

  it('reports the states an application would render', async () => {
    const { host, env } = await startHost();
    host.expose('math', { add: (a: number, b: number) => a + b });
    const client = await open(host, env);

    const states: string[] = [];
    client.on('state', (state) => states.push(state));
    env.lastSocket?.kill();
    await waitFor(() => states.includes('open'), 'a reconnect');
    expect(env.sockets.length).toBe(2);

    expect(states[0]).toBe('resuming');
    expect(states).toContain('open');
    await expect(client.call<number>('math.add', 1, 1)).resolves.toBe(2);
  });

  it('waits out the reconnect instead of failing a call issued during it', async () => {
    const { host, env } = await startHost();
    host.expose('math', { add: (a: number, b: number) => a + b });
    const client = await open(host, env);

    // Blocking new sockets keeps the bridge visibly down, so the call is
    // issued while it is *known* to be disconnected rather than in the blind
    // moment between a socket dying and the close event arriving.
    env.blockSockets = true;
    env.lastSocket?.kill();
    await waitFor(() => client.state !== 'open', 'the drop to register');

    const pending = client.call<number>('math.add', 40, 2);
    env.blockSockets = false;
    await expect(pending).resolves.toBe(42);
  });
});

describe('the HTTP fallback', () => {
  it('carries unary calls when the WebSocket is unavailable', async () => {
    const { host, env } = await startHost();
    host.expose('math', { add: (a: number, b: number) => a + b });
    env.blockSockets = true;

    const client = await open(host, env, { httpFallback: true, wsAttemptsBeforeFallback: 2 });
    expect(client.state).toBe('degraded');
    await expect(client.call<number>('math.add', 2, 2)).resolves.toBe(4);
  });

  it('goes back to the socket as soon as one can be opened', async () => {
    const { host, env } = await startHost();
    host.expose('math', { add: (a: number, b: number) => a + b });
    host.stream('ticker', async (stream) => {
      await stream.end(text.encode('back'));
    });
    env.blockSockets = true;

    const client = await open(host, env, { httpFallback: true, wsAttemptsBeforeFallback: 2 });
    expect(client.state).toBe('degraded');

    env.blockSockets = false;
    await waitFor(() => client.state === 'open', 'the socket to come back');
    const stream = await client.openStream('ticker');
    expect(new TextDecoder().decode(await collect(stream))).toBe('back');
  });

  it('names the reason instead of degrading a stream silently', async () => {
    const { host, env } = await startHost();
    host.stream('ticker', async (stream) => {
      await stream.end();
    });
    env.blockSockets = true;

    const client = await open(host, env, { httpFallback: true, wsAttemptsBeforeFallback: 2 });
    await expect(client.openStream('ticker')).rejects.toMatchObject({
      reason: 'streams-unavailable',
    });
  });

  it('gives up when the WebSocket fails and no fallback was asked for', async () => {
    const { host, env } = await startHost();
    env.blockSockets = true;
    await expect(
      connect(host.url, {
        fetch: env.fetch,
        socket: env.socket,
        reconnectMinMs: 5,
        reconnectMaxMs: 10,
        wsAttemptsBeforeFallback: 2,
      }),
      // `socket-failed`, not `unauthorized`: nothing ever reached the host, so
      // the client does not accuse it of refusing the connection.
    ).rejects.toMatchObject({ reason: 'socket-failed' });
  });
});

describe('authentication', () => {
  it('is terminal when the host refuses the connection', async () => {
    const { host, env } = await startHost();
    // No token, no cookie: the fence refuses the upgrade, and retrying it
    // forever is exactly what PROTOCOL.md §11.1 forbids.
    const error = await connect(host.origin, {
      fetch: env.fetch,
      socket: env.socket,
      reconnectMinMs: 5,
      reconnectMaxMs: 10,
    }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ reason: 'unauthorized' });
  });
});

describe('the upgrade probe', () => {
  it('gets 426 from the live host when the caller is authenticated', async () => {
    // PROTOCOL.md §6.1: this is what lets a client tell "not authenticated"
    // from "this transport cannot carry a WebSocket".
    const { host, env } = await startHost();
    await open(host, env); // mints the cookie
    const authenticated = await env.fetch(`${host.origin}/ws`);
    expect(authenticated.status).toBe(426);
    expect(authenticated.headers.get('upgrade')).toBe('websocket');

    const anonymous = await fetch(`${host.origin}/ws`);
    expect(anonymous.status).toBe(403);
  });
});

describe('token hygiene', () => {
  it('sends the launch token on exactly one request and retains it nowhere', async () => {
    const { host, env } = await startHost();
    host.expose('math', { add: (a: number, b: number) => a + b });
    const token = new URL(host.url).searchParams.get('bt');
    expect(token).not.toBeNull();

    const client = await open(host, env);
    await client.call('math.add', 1, 1);

    // A reconnect must not reach for the token again: it was burnt on use.
    // The wait is on the *second* socket being up, because `state` is still
    // `open` in the moment between a socket dying and its close event.
    env.lastSocket?.kill();
    await waitFor(
      () => env.sockets.length > 1 && client.state === 'open',
      'the reconnected socket',
    );
    await client.call('math.add', 1, 1);

    const carrying = env.requests.filter((request) => request.url.includes(token as string));
    expect(carrying).toHaveLength(1);
    expect(carrying[0]?.kind).toBe('fetch');
    expect(env.requests.filter((request) => request.kind === 'socket').length).toBeGreaterThan(1);

    expect(client.url).toBe(host.origin);
    expect(client.url).not.toContain('bt=');
    expect(JSON.stringify({ url: client.url, state: client.state })).not.toContain(token as string);
  });
});

/** Read an iterator to exhaustion, discarding what it yields. */
async function drain(reader: AsyncIterator<Uint8Array>): Promise<void> {
  for (;;) {
    const next = await reader.next();
    if (next.done === true) return;
  }
}
