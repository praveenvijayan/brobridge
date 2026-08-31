/**
 * Option resolution: the defaults are the spec's, and a bad value is refused
 * where it is written rather than where it is used.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { resolveOptions } from '../src/options.js';

const globals = globalThis as unknown as Record<string, unknown>;
const savedSocket = globals['WebSocket'];
const savedFetch = globals['fetch'];

afterEach(() => {
  globals['WebSocket'] = savedSocket;
  globals['fetch'] = savedFetch;
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
    expect(resolved.clientName).toBe('@brobridge/client');
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

    globals['WebSocket'] = savedSocket;
    Reflect.deleteProperty(globalThis, 'fetch');
    expect(() => resolveOptions({})).toThrow(/no global fetch/);
  });
});
