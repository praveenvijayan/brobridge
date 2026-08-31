/**
 * The attack catalogue, replayed against a live listener with hand-written
 * HTTP.
 *
 * `trust.test.ts` proves the fence's logic. This file proves the fence is
 * actually *in front of* the running server, on every path, and that nothing
 * in Node's parser, the router or the upgrade handler lets a request past it.
 * The requests here are raw bytes on a socket, not `fetch` calls, because
 * `fetch` will not send a `Host` header that disagrees with the connection —
 * and that disagreement is the attack.
 */
import { connect as tcpConnect } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createBridge } from '../src/index.js';
import type { Bridge } from '../src/index.js';
import { bootstrap } from './helpers/client.js';
import { activeListeners, settle } from './helpers/handles.js';

const running: Bridge[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
  // Every listener this file opened must be gone. A suite that needs
  // `--forceExit` is a suite that has stopped testing shutdown.
  await settle(() => activeListeners().length === 0);
  expect(activeListeners()).toHaveLength(0);
});

async function startBridge(): Promise<Bridge> {
  const bridge = await createBridge();
  bridge.expose('echo', { say: (text: string) => text });
  running.push(bridge);
  return bridge;
}

/** A raw HTTP exchange: send exactly these bytes, read what comes back. */
function raw(port: number, request: string, timeoutMs = 3_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect(port, '127.0.0.1', () => {
      socket.write(request.replaceAll('\n', '\r\n'));
    });
    let received = '';
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(received);
    }, timeoutMs);
    timer.unref();
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      received += chunk;
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(received);
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // A refusal Node makes at the parser level arrives as a reset rather
      // than a response. That is still a refusal, and the caller asserts on
      // whatever bytes (if any) preceded it.
      if (error.code === 'ECONNRESET') resolve(received);
      else reject(error);
    });
  });
}

/** The status line of a raw response, or `''` when the peer said nothing. */
function status(response: string): string {
  return response.split('\r\n')[0] ?? '';
}

describe('the attack catalogue against a live listener', () => {
  it('refuses a rebound Host before any handler runs (§5.1)', async () => {
    const bridge = await startBridge();
    const { cookie } = await bootstrap(bridge.url);

    // The classic DNS-rebinding request: a real connection to loopback, a
    // `Host` the browser believes is the attacker's own domain.
    const response = await raw(
      bridge.port,
      `GET / HTTP/1.1\nHost: evil.test:${String(bridge.port)}\nCookie: ${cookie}\nConnection: close\n\n`,
    );
    expect(status(response)).toContain('403');
    // No body, no hint about which check refused it.
    expect(response.split('\r\n\r\n')[1] ?? '').toBe('');
  });

  it('refuses every Host spelling that parses to the bound address (§5.2)', async () => {
    const bridge = await startBridge();
    const { cookie } = await bootstrap(bridge.url);
    const port = String(bridge.port);

    for (const host of [
      `0x7f.0.0.1:${port}`,
      `0177.0.0.1:${port}`,
      `2130706433:${port}`,
      `127.0.0.1.:${port}`,
      `127.000.000.001:${port}`,
      `127.0.0.1:0${port}`,
      `[::ffff:127.0.0.1]:${port}`,
      `localhost:${port}`,
      `user@127.0.0.1:${port}`,
      '127.0.0.1',
    ]) {
      const response = await raw(
        bridge.port,
        `GET / HTTP/1.1\nHost: ${host}\nCookie: ${cookie}\nConnection: close\n\n`,
      );
      expect(status(response), host).toContain('403');
    }
  });

  it('refuses duplicate Host headers even when they agree (§5.2)', async () => {
    const bridge = await startBridge();
    const { cookie } = await bootstrap(bridge.url);
    const authority = `127.0.0.1:${String(bridge.port)}`;

    const agreeing = await raw(
      bridge.port,
      `GET / HTTP/1.1\nHost: ${authority}\nHost: ${authority}\nCookie: ${cookie}\nConnection: close\n\n`,
    );
    // Node's parser rejects a duplicated Host outright; either way the request
    // never reaches a handler.
    expect(status(agreeing)).toMatch(/40[03]/);

    const disagreeing = await raw(
      bridge.port,
      `GET / HTTP/1.1\nHost: ${authority}\nHost: evil.test\nCookie: ${cookie}\nConnection: close\n\n`,
    );
    expect(status(disagreeing)).toMatch(/40[03]/);
  });

  it('refuses an absolute-form request line (§5.2)', async () => {
    const bridge = await startBridge();
    const { cookie } = await bootstrap(bridge.url);
    const authority = `127.0.0.1:${String(bridge.port)}`;

    const response = await raw(
      bridge.port,
      `GET http://${authority}/ HTTP/1.1\nHost: ${authority}\nCookie: ${cookie}\nConnection: close\n\n`,
    );
    expect(status(response)).toContain('403');
  });

  it('refuses a CONNECT request outright (§5.2 authority form)', async () => {
    const bridge = await startBridge();
    const authority = `127.0.0.1:${String(bridge.port)}`;
    const response = await raw(bridge.port, `CONNECT ${authority} HTTP/1.1\nHost: ${authority}\n\n`);
    expect(response).toBe('');
  });

  it('refuses a cross-site request that carries the cookie (§5.3)', async () => {
    const bridge = await startBridge();
    const { cookie } = await bootstrap(bridge.url);
    const authority = `127.0.0.1:${String(bridge.port)}`;

    const response = await raw(
      bridge.port,
      `POST /rpc HTTP/1.1\nHost: ${authority}\nOrigin: http://evil.test\n` +
        `Sec-Fetch-Site: cross-site\nCookie: ${cookie}\nContent-Length: 0\nConnection: close\n\n`,
    );
    expect(status(response)).toContain('403');
  });

  it('refuses a cross-origin WebSocket upgrade without completing it (§5.4)', async () => {
    const bridge = await startBridge();
    const { cookie } = await bootstrap(bridge.url);
    const authority = `127.0.0.1:${String(bridge.port)}`;

    const response = await raw(
      bridge.port,
      `GET /ws HTTP/1.1\nHost: ${authority}\nUpgrade: websocket\nConnection: Upgrade\n` +
        'Sec-WebSocket-Version: 13\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\n' +
        `Origin: http://evil.test\nSec-Fetch-Site: cross-site\nSec-Fetch-Mode: websocket\nCookie: ${cookie}\n\n`,
    );
    expect(status(response)).toContain('403');
    // The decisive assertion: no 101, so the page never gets a channel.
    expect(response).not.toContain('101');
    expect(response).not.toContain('Sec-WebSocket-Accept');
  });

  it('refuses an upgrade with no credential (§5.4, §7.3)', async () => {
    const bridge = await startBridge();
    const authority = `127.0.0.1:${String(bridge.port)}`;

    const response = await raw(
      bridge.port,
      `GET /ws HTTP/1.1\nHost: ${authority}\nUpgrade: websocket\nConnection: Upgrade\n` +
        'Sec-WebSocket-Version: 13\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\n\n',
    );
    expect(status(response)).toContain('403');
    expect(response).not.toContain('101');
  });

  it('refuses a forged cookie however it is spelt (§5.7, §5.8)', async () => {
    const bridge = await startBridge();
    const { cookie } = await bootstrap(bridge.url);
    const authority = `127.0.0.1:${String(bridge.port)}`;
    const value = cookie.slice('bb_session='.length);

    for (const forged of [
      'bb_session=forged',
      'bb_session=a.b.c',
      `bb_session=${value.split('.')[0] ?? ''}.0.${value.split('.')[2] ?? ''}`,
      `bb_session=${value}x`,
      'bb_session=',
    ]) {
      const response = await raw(
        bridge.port,
        `GET / HTTP/1.1\nHost: ${authority}\nCookie: ${forged}\nConnection: close\n\n`,
      );
      expect(status(response), forged).toContain('403');
    }
  });

  it('answers absent, malformed and wrong credentials identically (§9 invariant 10)', async () => {
    const bridge = await startBridge();
    const authority = `127.0.0.1:${String(bridge.port)}`;

    const responses = await Promise.all(
      ['', 'Cookie: bb_session=garbage\n', 'Cookie: bb_session=a.1.b\n'].map(async (header) =>
        raw(bridge.port, `GET / HTTP/1.1\nHost: ${authority}\n${header}Connection: close\n\n`),
      ),
    );
    const heads = responses.map((response) =>
      response.split('\r\n\r\n')[0]?.replace(/Date: [^\r]+\r\n/, ''),
    );
    expect(heads[1]).toBe(heads[0]);
    expect(heads[2]).toBe(heads[0]);
  });

  it('never serves a path off the exact route table (§5.13)', async () => {
    const bridge = await startBridge();
    const { cookie } = await bootstrap(bridge.url);
    const authority = `127.0.0.1:${String(bridge.port)}`;

    for (const path of [
      '/../../etc/passwd',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/ws/../rpc',
      '/rpc/',
      '//',
      '/index.html',
    ]) {
      const response = await raw(
        bridge.port,
        `GET ${path} HTTP/1.1\nHost: ${authority}\nCookie: ${cookie}\nConnection: close\n\n`,
      );
      expect(status(response), path).toContain('404');
    }
  });

  it('caps the header block a client may send (§5.11)', async () => {
    const bridge = await startBridge();
    const authority = `127.0.0.1:${String(bridge.port)}`;
    const padding = 'X-Pad: '.concat('a'.repeat(1024), '\n').repeat(64); // 64 KiB

    const response = await raw(
      bridge.port,
      `GET / HTTP/1.1\nHost: ${authority}\n${padding}Connection: close\n\n`,
    );
    // 431 from the parser, or a dropped connection. Either way the request
    // never reaches the fence or a handler.
    expect(status(response)).not.toContain('200');
  });

  it('drops a slowloris connection that never finishes its headers (§5.11)', async () => {
    const bridge = await createBridge({ handshakeTimeoutMs: 300 });
    running.push(bridge);

    const closed = await new Promise<boolean>((resolve) => {
      const socket = tcpConnect(bridge.port, '127.0.0.1', () => {
        socket.write('GET / HTTP/1.1\r\n');
        socket.write(`Host: 127.0.0.1:${String(bridge.port)}\r\n`);
        // …and then nothing. No blank line, ever.
      });
      // A paused socket never processes the peer's FIN, so the read side has
      // to be flowing for this test to observe the drop at all.
      socket.resume();
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 3_000);
      timer.unref();
      socket.on('close', () => {
        clearTimeout(timer);
        resolve(true);
      });
      socket.on('error', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    expect(closed).toBe(true);
  });

  it('refuses a token replayed from browser history (§5.6)', async () => {
    const bridge = await startBridge();
    const authority = `127.0.0.1:${String(bridge.port)}`;
    const token = new URL(bridge.url).searchParams.get('bt') ?? '';

    const first = await raw(
      bridge.port,
      `GET /?bt=${token} HTTP/1.1\nHost: ${authority}\nConnection: close\n\n`,
    );
    expect(status(first)).toContain('303');
    expect(first).toContain('Referrer-Policy: no-referrer');
    expect(first).toContain('Cache-Control: no-store');
    expect(first).toContain('Location: /');

    const replay = await raw(
      bridge.port,
      `GET /?bt=${token} HTTP/1.1\nHost: ${authority}\nConnection: close\n\n`,
    );
    expect(status(replay)).toContain('403');
    expect(replay).not.toContain('Set-Cookie');
  });

  it('rate-limits a guessing loop and says how long to wait (§5.7)', async () => {
    const bridge = await createBridge({ authFailuresPerWindow: 5, authFailureWindowMs: 60_000 });
    running.push(bridge);
    const authority = `127.0.0.1:${String(bridge.port)}`;

    const statuses: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const response = await raw(
        bridge.port,
        `GET /?bt=guess${String(i)} HTTP/1.1\nHost: ${authority}\nConnection: close\n\n`,
      );
      statuses.push(status(response));
    }
    expect(statuses.slice(0, 5).every((line) => line.includes('403'))).toBe(true);
    expect(statuses[5]).toContain('429');
    expect(statuses.at(-1)).toContain('429');
  });

  it('will not bind a non-loopback interface without the opt-in (§5.12)', async () => {
    await expect(createBridge({ host: '0.0.0.0' })).rejects.toThrow(/allowNonLoopback/);
    await expect(createBridge({ host: '192.168.1.10' })).rejects.toThrow(/loopback/);
  });

  it('keeps the launch token and cookie material out of diagnostics (§5.14)', async () => {
    const { redact } = await import('../src/redact.js');
    const bridge = await startBridge();

    expect(redact(`GET ${bridge.url}`)).not.toContain(
      new URL(bridge.url).searchParams.get('bt') ?? 'unreachable',
    );
    expect(redact('Cookie: bb_session=abc.123.def')).not.toContain('abc.123.def');
    expect(redact('set-cookie: bb_session=abc.123.def; HttpOnly')).not.toContain('abc.123.def');
    expect(redact('a jar with bb_session=abc.123.def in it')).not.toContain('abc.123.def');
  });
});
