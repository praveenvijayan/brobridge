/**
 * The carrier and its watchdog, without a host.
 *
 * These are the behaviours that only show up at the socket boundary: silence
 * detection, bytes that arrive before core has attached, and payload shapes a
 * runtime might hand over.
 */
import { describe, expect, it } from 'vitest';

import { openSocket } from '../src/socket.js';
import type { SocketLike } from '../src/types.js';

/** A socket that does nothing until a test tells it to. */
class FakeSocket implements SocketLike {
  binaryType = '';
  readyState = 0;
  onopen: unknown = null;
  onmessage: unknown = null;
  onclose: unknown = null;
  onerror: unknown = null;

  readonly sent: Uint8Array[] = [];
  closes: { code?: number; reason?: string }[] = [];

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) });
    this.readyState = 3;
    fire(this.onclose, {});
  }

  open(): void {
    this.readyState = 1;
    fire(this.onopen, {});
  }

  deliver(data: unknown): void {
    fire(this.onmessage, { data });
  }
}

function fire(handler: unknown, event: { data?: unknown }): void {
  (handler as (event: { data?: unknown }) => void)(event);
}

const options = (socket: FakeSocket) => ({
  socket: () => socket,
  connectTimeoutMs: 1_000,
  heartbeatTimeoutMs: 30,
});

describe('openSocket', () => {
  it('resolves once the socket opens, and reports the close', async () => {
    const socket = new FakeSocket();
    const pending = openSocket('ws://host/ws', options(socket));
    socket.open();
    const connection = await pending;

    expect(socket.binaryType).toBe('arraybuffer');
    let closed = false;
    void connection.closed.then(() => {
      closed = true;
    });
    connection.close();
    await Promise.resolve();
    expect(closed).toBe(true);
  });

  it('queues bytes that arrive before core has attached', async () => {
    const socket = new FakeSocket();
    const pending = openSocket('ws://host/ws', options(socket));
    socket.open();
    const connection = await pending;

    socket.deliver(new Uint8Array([1, 2]).buffer);
    socket.deliver(new Uint8Array([3]));

    const seen: number[] = [];
    connection.carrier.onMessage((bytes) => seen.push(...bytes));
    expect(seen).toEqual([1, 2, 3]);

    // And straight through, once a handler is set.
    socket.deliver(new Uint8Array([4]));
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it('drops a text frame rather than guessing an encoding for it', async () => {
    const socket = new FakeSocket();
    const pending = openSocket('ws://host/ws', options(socket));
    socket.open();
    const connection = await pending;

    const seen: Uint8Array[] = [];
    connection.carrier.onMessage((bytes) => seen.push(bytes));
    socket.deliver('not a frame');
    expect(seen).toHaveLength(0);
  });

  it('kills a connection that has gone silent', async () => {
    const socket = new FakeSocket();
    const pending = openSocket('ws://host/ws', options(socket));
    socket.open();
    const connection = await pending;

    await connection.closed;
    expect(connection.timedOut()).toBe(true);
    expect(socket.closes[0]?.reason).toBe('heartbeat timeout');
  });

  it('rearms the watchdog on every frame, so a live connection survives', async () => {
    const socket = new FakeSocket();
    const pending = openSocket('ws://host/ws', options(socket));
    socket.open();
    const connection = await pending;

    for (let tick = 0; tick < 4; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      socket.deliver(new Uint8Array([tick]));
    }
    expect(connection.timedOut()).toBe(false);
    connection.close();
  });

  it('gives up when the upgrade is refused', async () => {
    const socket = new FakeSocket();
    const pending = openSocket('ws://host/ws', options(socket));
    socket.close(1006, 'refused');
    await expect(pending).rejects.toMatchObject({ reason: 'unauthorized' });
  });

  it('gives up when the caller aborts the attempt', async () => {
    const socket = new FakeSocket();
    let abort = (): void => {};
    const pending = openSocket('ws://host/ws', {
      ...options(socket),
      abort: new Promise<void>((resolve) => {
        abort = resolve;
      }),
    });
    abort();
    await expect(pending).rejects.toMatchObject({ reason: 'closed' });
  });

  it('times out an upgrade that never completes', async () => {
    const socket = new FakeSocket();
    await expect(
      openSocket('ws://host/ws', { ...options(socket), connectTimeoutMs: 10 }),
    ).rejects.toMatchObject({ reason: 'connect-timeout' });
  });
});
