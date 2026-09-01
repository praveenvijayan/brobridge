/**
 * Option resolution: the defaults are the spec's, and a bad value is refused
 * where it is written rather than where it is used.
 *
 * The globals are stubbed rather than borrowed from the host runtime. `fetch`
 * is global from Node 18 and `WebSocket` only from Node 22, so a suite that
 * leans on whichever the runtime happens to have tests the runtime, not
 * `resolveOptions` — and fails on Node 20, the declared `engines` floor. The
 * last case deletes them again on purpose.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveOptions } from '../src/options.js';

const globals = globalThis as unknown as Record<string, unknown>;
const savedSocket = Reflect.getOwnPropertyDescriptor(globalThis, 'WebSocket');
const savedFetch = Reflect.getOwnPropertyDescriptor(globalThis, 'fetch');

/** A constructor-shaped stand-in: `resolveOptions` only checks the type. */
const stubSocket = function StubWebSocket(): never {
  throw new Error('the stub WebSocket is never constructed');
};
const stubFetch = (): never => {
  throw new Error('the stub fetch is never called');
};

/** Put a global back exactly as it was, including having been absent. */
function restore(name: string, saved: PropertyDescriptor | undefined): void {
  if (saved === undefined) Reflect.deleteProperty(globalThis, name);
  else Object.defineProperty(globalThis, name, saved);
}

beforeEach(() => {
  globals['WebSocket'] = stubSocket;
  globals['fetch'] = stubFetch;
});

afterEach(() => {
  restore('WebSocket', savedSocket);
  restore('fetch', savedFetch);
});

describe('resolveOptions', () => {
  it('applies the PROTOCOL.md §13 defaults', () => {
    const resolved = resolveOptions({});
    expect(resolved.reconnect).toBe(true);
    expect(resolved.reconnectMinMs).toBe(500);
    expect(resolved.reconnectMaxMs).toBe(10_000);
    expect(resolved.heartbeatTimeoutMs).toBe(45_000);
    expect(resolved.httpFallback).toBe(false);
    expect(resolved.wsAttemptsBeforeFallback).toBe(3);
    expect(resolved.clientName).toBe('@brobridgejs/client');
  });

  it('keeps what the caller passed', () => {
    const socket = (): never => {
      throw new Error('unused');
    };
    const resolved = resolveOptions({
      reconnect: false,
      reconnectMinMs: 25,
      clientName: 'my-app',
      socket,
      now: () => 7,
      random: () => 0.5,
    });
    expect(resolved.reconnect).toBe(false);
    expect(resolved.reconnectMinMs).toBe(25);
    expect(resolved.clientName).toBe('my-app');
    expect(resolved.socket).toBe(socket);
    expect(resolved.now()).toBe(7);
  });

  it('refuses a nonsensical duration, naming the option', () => {
    expect(() => resolveOptions({ reconnectMinMs: 0 })).toThrow(/reconnectMinMs/);
    expect(() => resolveOptions({ connectTimeoutMs: -1 })).toThrow(/connectTimeoutMs/);
    expect(() => resolveOptions({ heartbeatTimeoutMs: Number.NaN })).toThrow(/heartbeatTimeoutMs/);
  });

  it('says what is missing when a runtime has no WebSocket or no fetch', () => {
    Reflect.deleteProperty(globalThis, 'WebSocket');
    expect(() => resolveOptions({})).toThrow(/no global WebSocket/);

    globals['WebSocket'] = stubSocket;
    Reflect.deleteProperty(globalThis, 'fetch');
    expect(() => resolveOptions({})).toThrow(/no global fetch/);
  });
});
