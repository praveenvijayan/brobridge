/**
 * The pieces that need no socket: URL handling, backoff, the proxy.
 */
import { describe, expect, it, vi } from 'vitest';

import { backoffDelay } from '../src/backoff.js';
import { BridgeClientError, isClientError } from '../src/errors.js';
import { makeProxy } from '../src/proxy.js';
import type { FetchLike } from '../src/types.js';
import { parseTarget, probeUpgrade, redeemToken } from '../src/url.js';

describe('parseTarget', () => {
  it('keeps only the origin, and finds the launch token', () => {
    const target = parseTarget('http://127.0.0.1:5123/?bt=secret-token');
    expect(target.origin).toBe('http://127.0.0.1:5123');
    expect(target.wsUrl).toBe('ws://127.0.0.1:5123/ws');
    expect(target.rpcUrl).toBe('http://127.0.0.1:5123/rpc');
    expect(target.bootstrapUrl).toBe('http://127.0.0.1:5123/?bt=secret-token');
  });

  it('accepts a bare origin, a path, and https', () => {
    expect(parseTarget('http://127.0.0.1:5123').bootstrapUrl).toBeNull();
    expect(parseTarget('http://127.0.0.1:5123/app/index.html').origin).toBe('http://127.0.0.1:5123');
    expect(parseTarget('https://localhost:8443/').wsUrl).toBe('wss://localhost:8443/ws');
  });

  it('refuses a scheme that is not http(s)', () => {
    expect(() => parseTarget('file:///tmp/index.html')).toThrow(BridgeClientError);
  });
});

describe('redeemToken', () => {
  const ok = (init: ResponseInit & { type?: string }): FetchLike => {
    return () => Promise.resolve(new Response(null, init));
  };

  it('accepts the redirect the server answers with', async () => {
    await expect(redeemToken('http://h/?bt=t', ok({ status: 303 }))).resolves.toBeUndefined();
  });

  it('accepts a browser opaque redirect', async () => {
    const opaque = {
      type: 'opaqueredirect',
      status: 0,
      ok: false,
    } as unknown as Response;
    await expect(redeemToken('http://h/?bt=t', () => Promise.resolve(opaque))).resolves.toBeUndefined();
  });

  it('fails on a refusal, without echoing the token', async () => {
    const error = await redeemToken('http://h/?bt=super-secret', ok({ status: 403 })).catch(
      (cause: unknown) => cause,
    );
    expect(isClientError(error, 'bootstrap-failed')).toBe(true);
    expect(String(error)).not.toContain('super-secret');
  });

  it('reports a transport failure as a bootstrap failure', async () => {
    const error = await redeemToken('http://h/?bt=t', () => Promise.reject(new Error('offline'))).catch(
      (cause: unknown) => cause,
    );
    expect(isClientError(error, 'bootstrap-failed')).toBe(true);
  });
});

describe('probeUpgrade', () => {
  it('reads 426 as authenticated and 403 as refused', async () => {
    const status = (code: number): FetchLike => () => Promise.resolve(new Response(null, { status: code }));
    await expect(probeUpgrade('http://h', status(426))).resolves.toBe('authenticated');
    await expect(probeUpgrade('http://h', status(403))).resolves.toBe('unauthorized');
    await expect(probeUpgrade('http://h', status(500))).resolves.toBe('unknown');
  });

  it('treats an unreachable host as inconclusive, not as a refusal', async () => {
    await expect(probeUpgrade('http://h', () => Promise.reject(new Error('offline')))).resolves.toBe(
      'unknown',
    );
  });
});

describe('backoffDelay', () => {
  it('is full jitter over a doubling ceiling, capped at the maximum', () => {
    // `random` at its extremes pins the window PROTOCOL.md §11.1 describes.
    const high = (): number => 0.999_999;
    expect(backoffDelay(0, 500, 10_000, () => 0)).toBe(0);
    expect(backoffDelay(0, 500, 10_000, high)).toBe(499);
    expect(backoffDelay(1, 500, 10_000, high)).toBe(999);
    expect(backoffDelay(2, 500, 10_000, high)).toBe(1_999);
    expect(backoffDelay(20, 500, 10_000, high)).toBe(9_999);
  });

  it('never exceeds the ceiling, for any attempt number', () => {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const value = backoffDelay(attempt, 500, 10_000, Math.random);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(10_000);
    }
  });
});

describe('makeProxy', () => {
  interface Files {
    read(path: string): Promise<string>;
    size: number;
  }

  it('routes a method to "<service>.<method>"', async () => {
    const call = vi.fn(() => Promise.resolve('hostname'));
    const proxy = makeProxy<Files>({ call: call as never }, 'files');
    await expect(proxy.read('/etc/hostname')).resolves.toBe('hostname');
    expect(call).toHaveBeenCalledWith('files.read', '/etc/hostname');
  });

  it('is not a thenable, so awaiting it cannot call a method named then', async () => {
    const call = vi.fn(() => Promise.resolve(null));
    const proxy = makeProxy<Files>({ call: call as never }, 'files') as unknown as Record<
      string,
      unknown
    >;
    expect(proxy['then']).toBeUndefined();
    await Promise.resolve(proxy);
    expect(call).not.toHaveBeenCalled();
  });
});
