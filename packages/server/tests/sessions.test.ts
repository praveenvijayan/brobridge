/**
 * The session wall and the socket pump.
 *
 * Two invariants live here. A `RESUME` may only reach a session that the
 * *same* authenticated identity created (`THREAT-MODEL.md` §9 invariant 8),
 * and nothing the server buffers on behalf of a peer is unbounded
 * (§5.10, last row).
 */
import { BridgeEndpoint, ResumeFailedError } from '@brobridgejs/core';
import { describe, expect, it } from 'vitest';

import { SessionManager } from '../src/manager.js';
import { resolveOptions } from '../src/options.js';
import { ServiceRegistry } from '../src/services.js';
import { FakeSocket, memoryPair } from './helpers/memory.js';
import { SocketCarrier } from '../src/carrier.js';

const encoder = new TextEncoder();

function manager(registry = new ServiceRegistry()): SessionManager {
  return new SessionManager({
    options: resolveOptions({ heartbeatMs: 60_000 }),
    registry,
    onSession: undefined,
  });
}

describe('the session wall', () => {
  it('resumes a session for the identity that created it', async () => {
    const sessions = manager();
    const first = memoryPair();
    const client = new BridgeEndpoint({ role: 'client' });
    await Promise.all([client.attach(first.client), sessions.accept(first.server, 'auth-a')]);
    const sessionId = client.sessionId;
    expect(sessionId).not.toBeNull();

    first.kill();

    const second = memoryPair();
    const [outcome] = await Promise.all([
      client.attach(second.client),
      sessions.accept(second.server, 'auth-a'),
    ]);
    expect(outcome.kind).toBe('resume');
    expect(client.sessionId).toBe(sessionId);

    await sessions.close();
  });

  it('refuses to resume a session that belongs to another identity', async () => {
    const sessions = manager();

    const first = memoryPair();
    const client = new BridgeEndpoint({ role: 'client' });
    await Promise.all([client.attach(first.client), sessions.accept(first.server, 'auth-a')]);
    expect(client.sessionId).not.toBeNull();
    first.kill();

    // The same session identifier, presented over a connection that
    // authenticated as somebody else. It is not merely refused: it is
    // indistinguishable from a session that never existed.
    const second = memoryPair();
    const attaching = client.attach(second.client);
    void sessions.accept(second.server, 'auth-b');

    await expect(attaching).rejects.toBeInstanceOf(ResumeFailedError);
    await expect(attaching).rejects.toMatchObject({ code: 'SESSION_UNKNOWN' });

    // And the connection is still usable for a fresh session, per
    // `PROTOCOL.md` §6.1.
    const renegotiated = await client.renegotiate();
    expect(renegotiated.kind).toBe('hello');

    await sessions.close();
  });

  it('releases connections when their socket dies', async () => {
    const sessions = manager();
    const pair = memoryPair();
    const client = new BridgeEndpoint({ role: 'client' });
    await Promise.all([client.attach(pair.client), sessions.accept(pair.server, 'auth-a')]);
    expect(sessions.connectionCount).toBe(1);

    pair.kill();
    expect(sessions.connectionCount).toBe(0);

    await sessions.close();
  });
});

describe('the socket pump', () => {
  it('waits for the socket instead of writing past its high-water mark', () => {
    const socket = new FakeSocket();
    const carrier = new SocketCarrier(socket, {
      maxBufferedBytes: 1024 * 1024,
      highWaterMark: 64,
    });

    socket.buffered = 128; // congested from the start
    carrier.send(encoder.encode('first'));
    expect(socket.written).toHaveLength(0);
    expect(carrier.paused).toBe(true);
    expect(carrier.queuedBytes).toBe(5);

    socket.buffered = 0;
    carrier.resume();
    expect(socket.written).toHaveLength(1);
    expect(carrier.queuedBytes).toBe(0);
  });

  it('preserves frame order across a pause', () => {
    const socket = new FakeSocket();
    const carrier = new SocketCarrier(socket, { maxBufferedBytes: 1024, highWaterMark: 8 });

    socket.buffered = 32;
    for (const text of ['a', 'b', 'c']) carrier.send(encoder.encode(text));
    socket.buffered = 0;
    carrier.resume();

    expect(socket.written.map((bytes) => new TextDecoder().decode(bytes))).toEqual(['a', 'b', 'c']);
  });

  it('closes a connection whose peer stopped reading rather than buffering forever', () => {
    const socket = new FakeSocket();
    let overflowed = 0;
    let closed = false;
    const carrier = new SocketCarrier(socket, {
      maxBufferedBytes: 1024,
      highWaterMark: 1,
      onOverflow: (bytes) => {
        overflowed = bytes;
      },
    });
    carrier.onClose(() => {
      closed = true;
    });

    socket.buffered = 4096; // the peer never reads
    for (let i = 0; i < 20 && !closed; i += 1) carrier.send(new Uint8Array(128));

    expect(overflowed).toBeGreaterThan(1024);
    expect(closed).toBe(true);
    expect(socket.closed).toBe(true);
    // Nothing is retained after the close: the queue is released, not leaked.
    expect(carrier.queuedBytes).toBe(0);
  });

  it('stops writing once the socket reports failure', () => {
    const socket = new FakeSocket();
    const carrier = new SocketCarrier(socket, { maxBufferedBytes: 1024 });
    let closed = false;
    carrier.onClose(() => {
      closed = true;
    });

    socket.outcome = 'failed';
    carrier.send(encoder.encode('doomed'));
    expect(closed).toBe(true);
    expect(carrier.queuedBytes).toBe(0);
  });

  it('notifies core and the host of the same close, once', () => {
    const socket = new FakeSocket();
    const carrier = new SocketCarrier(socket, { maxBufferedBytes: 1024 });
    let coreCloses = 0;
    let hostCloses = 0;
    carrier.onClose(() => {
      coreCloses += 1;
    });
    carrier.addCloseListener(() => {
      hostCloses += 1;
    });

    carrier.notifyClose();
    carrier.notifyClose();

    expect(coreCloses).toBe(1);
    expect(hostCloses).toBe(1);
  });
});
