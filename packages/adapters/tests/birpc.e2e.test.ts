/**
 * birpc, end to end, over a real bridge.
 *
 * Both directions are exercised because birpc is symmetric: the browser calls
 * the host, and the host broadcasts to every connected browser.
 */
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';

import { createBirpcLink, mount } from '../src/birpc.js';
import type { Harness } from './helpers/env.js';
import { harness, waitFor } from './helpers/env.js';

/** What the host exposes. */
interface HostFunctions {
  add(a: number, b: number): number;
  shout(text: string): Promise<string>;
  fail(): never;
}

/** What the browser exposes back. */
interface ClientFunctions {
  note(text: string): void;
}

const hostFunctions: HostFunctions = {
  add: (a, b) => a + b,
  shout: (text) => Promise.resolve(text.toUpperCase()),
  fail: () => {
    throw new Error('host said no');
  },
};

const live: Harness[] = [];

afterEach(async () => {
  await Promise.all(live.splice(0).map((one) => one.close()));
});

async function connectPair(sessionTtlMs?: number): Promise<{
  harness: Harness;
  group: ReturnType<typeof mount<ClientFunctions, HostFunctions>>;
  notes: string[];
  rpc: Awaited<ReturnType<typeof createBirpcLink<HostFunctions, ClientFunctions>>>;
}> {
  let group!: ReturnType<typeof mount<ClientFunctions, HostFunctions>>;
  const one = await harness(
    (host) => {
      group = mount<ClientFunctions, HostFunctions>(host, hostFunctions);
    },
    sessionTtlMs === undefined ? {} : { host: { sessionTtlMs }, client: { reconnect: false } },
  );
  live.push(one);

  const notes: string[] = [];
  const rpc = await createBirpcLink<HostFunctions, ClientFunctions>(one.client, {
    note: (text: string) => {
      notes.push(text);
    },
  });
  return { harness: one, group, notes, rpc };
}

describe('birpc adapter', () => {
  it('calls host functions from the browser, with types intact', async () => {
    const { rpc } = await connectPair();

    expect(await rpc.add(2, 3)).toBe(5);
    expect(await rpc.shout('hey')).toBe('HEY');

    expectTypeOf(rpc.add).parameters.toEqualTypeOf<[number, number]>();
    expectTypeOf(rpc.add).returns.resolves.toEqualTypeOf<number>();
    expectTypeOf(rpc.shout).returns.resolves.toEqualTypeOf<string>();
  });

  it('propagates a host error to the caller', async () => {
    const { rpc } = await connectPair();
    await expect(rpc.fail()).rejects.toThrow('host said no');
  });

  it('broadcasts from the host to every connected browser', async () => {
    const { group, notes, rpc } = await connectPair();

    await waitFor(() => group.clients.length === 1, 'the browser to join the group');
    await group.broadcast.note('ready');
    expect(notes).toEqual(['ready']);

    // The client's own functions are callable by the host, so the group's
    // remote type is the browser's surface, not the host's.
    expectTypeOf(group.broadcast.note).parameters.toEqualTypeOf<[string]>();
    void rpc;
  });

  it('drops a browser from the group once its session ages out', async () => {
    // A closed socket is not a departed tab — the protocol holds the session
    // open so a reconnect can resume it. The group must shrink when the
    // session itself expires, not the moment a socket dies.
    const { harness: one, group } = await connectPair(200);
    await waitFor(() => group.clients.length === 1, 'the browser to join');
    one.env.lastSocket?.kill();
    await waitFor(() => group.clients.length === 0, 'the browser to leave', 8_000);
  }, 10_000);
});
