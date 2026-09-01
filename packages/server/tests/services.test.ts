/**
 * The raw call surface.
 *
 * Adapters will wrap this in Phase 5, but it has to be correct and safe on
 * its own: a route name arrives from a browser tab, and a tab is remote code
 * however it was authenticated (`THREAT-MODEL.md` §8.4).
 */
import { BridgeError, ErrorCode } from '@brobridgejs/core';
import { describe, expect, it } from 'vitest';

import { ServiceRegistry } from '../src/services.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function call(registry: ServiceRegistry, route: string, ...values: readonly unknown[]) {
  return registry.invoke(route, encoder.encode(JSON.stringify(values)));
}

describe('the service registry', () => {
  it('routes "<service>.<method>" and passes JSON arguments through', async () => {
    const registry = new ServiceRegistry();
    registry.expose('math', {
      add: (a: number, b: number) => a + b,
      later: async (value: string) => Promise.resolve(`${value}!`),
    });

    const sum = await call(registry, 'math.add', 2, 40);
    expect(sum.ok).toBe(true);
    if (sum.ok) expect(decoder.decode(sum.payload)).toBe('42');

    const later = await call(registry, 'math.later', 'soon');
    if (later.ok) expect(decoder.decode(later.payload)).toBe('"soon!"');
  });

  it('returns an empty payload for undefined', async () => {
    const registry = new ServiceRegistry();
    registry.expose('void', { nothing: () => undefined });
    const outcome = await call(registry, 'void.nothing');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.payload).toHaveLength(0);
  });

  it('refuses names that resolve through the prototype chain', async () => {
    const registry = new ServiceRegistry();
    registry.expose('svc', { real: () => 'yes' });

    for (const route of [
      'svc.constructor',
      'svc.toString',
      'svc.hasOwnProperty',
      'svc.__proto__',
      'svc.valueOf',
    ]) {
      const outcome = await call(registry, route);
      expect(outcome.ok, route).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe(ErrorCode.NOT_FOUND);
    }
  });

  it('refuses an unknown service, an unknown method and a nameless route', async () => {
    const registry = new ServiceRegistry();
    registry.expose('svc', { real: () => 'yes' });

    for (const route of ['other.real', 'svc.missing', 'svc.', '.real', 'svc', '']) {
      const outcome = await call(registry, route);
      expect(outcome.ok, route).toBe(false);
    }
  });

  it('refuses a non-function property', async () => {
    const registry = new ServiceRegistry();
    registry.expose('svc', { notAMethod: 42 });
    const outcome = await call(registry, 'svc.notAMethod');
    expect(outcome.ok).toBe(false);
  });

  it('refuses a request payload that is not a JSON array', async () => {
    const registry = new ServiceRegistry();
    registry.expose('svc', { real: () => 'yes' });

    const notJson = await registry.invoke('svc.real', encoder.encode('{'));
    expect(notJson.ok).toBe(false);
    if (!notJson.ok) expect(notJson.code).toBe(ErrorCode.PROTOCOL_VIOLATION);

    const notArray = await registry.invoke('svc.real', encoder.encode('{"a":1}'));
    expect(notArray.ok).toBe(false);

    // An empty body means "no arguments", which is how a zero-arity call
    // arrives over the fallback.
    const empty = await registry.invoke('svc.real', new Uint8Array(0));
    expect(empty.ok).toBe(true);
  });

  it('passes a BridgeError through and reduces anything else', async () => {
    const registry = new ServiceRegistry();
    registry.expose('svc', {
      denied: () => {
        throw new BridgeError(ErrorCode.PERMISSION_DENIED, 'not for you');
      },
      broken: () => {
        throw new Error('/home/user/.ssh/id_ed25519 is missing');
      },
      rejected: async () => Promise.reject(new Error('secret detail')),
    });

    const denied = await call(registry, 'svc.denied');
    expect(denied).toEqual({
      ok: false,
      code: ErrorCode.PERMISSION_DENIED,
      message: 'not for you',
    });

    for (const route of ['svc.broken', 'svc.rejected']) {
      const outcome = await call(registry, route);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe(ErrorCode.INTERNAL_ERROR);
        expect(outcome.message).toBe('internal error');
      }
    }
  });

  it('refuses to register a duplicate or a dotted service name', () => {
    const registry = new ServiceRegistry();
    registry.expose('svc', {});
    expect(() => {
      registry.expose('svc', {});
    }).toThrow(/already exposed/);
    expect(() => {
      registry.expose('a.b', {});
    }).toThrow(/must not contain/);

    registry.stream('route', () => undefined);
    expect(() => {
      registry.stream('route', () => undefined);
    }).toThrow(/already registered/);
  });

  it('reports what it routes', () => {
    const registry = new ServiceRegistry();
    registry.expose('svc', { real: () => 'yes' });
    registry.stream('ticker', () => undefined);
    expect(registry.routes).toEqual({ services: ['svc'], streams: ['ticker'] });
  });
});
