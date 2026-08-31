/**
 * oRPC, end to end, over a real bridge.
 *
 * The interesting case is the event iterator: oRPC streams it over the same
 * peer connection as a call, so putting that connection on a brobridge stream
 * means an iterator survives a dropped socket instead of restarting.
 */
import { createORPCClient } from '@orpc/client';
import type { RouterClient } from '@orpc/server';
import { os } from '@orpc/server';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { createORPCLink, mount } from '../src/orpc.js';
import type { Harness } from './helpers/env.js';
import { harness, sleep } from './helpers/env.js';

const router = {
  greet: os
    .input(z.object({ name: z.string() }))
    .handler(({ input }) => `hello ${input.name}`),
  double: os.input(z.object({ value: z.number() })).handler(({ input }) => input.value * 2),
  refuse: os.handler(() => {
    throw new Error('nope');
  }),
  ticker: os
    .input(z.object({ count: z.number(), everyMs: z.number() }))
    .handler(async function* ({ input }) {
      for (let index = 0; index < input.count; index += 1) {
        await sleep(input.everyMs);
        yield index;
      }
    }),
};

type AppRouter = typeof router;

const live: Harness[] = [];

afterEach(async () => {
  await Promise.all(live.splice(0).map((one) => one.close()));
});

async function connectClient(): Promise<{
  harness: Harness;
  client: RouterClient<AppRouter>;
}> {
  const one = await harness((host) => {
    mount(host, router);
  });
  live.push(one);
  const link = await createORPCLink(one.client);
  return { harness: one, client: createORPCClient(link) };
}

describe('oRPC adapter', () => {
  it("round-trips calls with the framework's own types", async () => {
    const { client } = await connectClient();

    expect(await client.greet({ name: 'ada' })).toBe('hello ada');
    expect(await client.double({ value: 21 })).toBe(42);

    expectTypeOf(client.greet).parameter(0).toMatchObjectType<{ name: string }>();
    expectTypeOf(await client.greet({ name: 'ada' })).toEqualTypeOf<string>();
  });

  it('surfaces a handler failure as an error, not a value', async () => {
    const { client } = await connectClient();
    await expect(client.refuse()).rejects.toThrow();
  });

  it('streams an event iterator', async () => {
    const { client } = await connectClient();
    const seen: number[] = [];
    for await (const value of await client.ticker({ count: 4, everyMs: 1 })) seen.push(value);
    expect(seen).toEqual([0, 1, 2, 3]);
  });

  it('resumes an event iterator across a dropped socket', async () => {
    const { harness: one, client } = await connectClient();
    const seen: number[] = [];

    let cut = false;
    for await (const value of await client.ticker({ count: 12, everyMs: 20 })) {
      seen.push(value);
      if (!cut && seen.length === 3) {
        cut = true;
        // Cut the wire, not the session: the iterator must continue, not restart.
        one.env.lastSocket?.kill();
      }
    }

    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(one.env.sockets.length).toBeGreaterThan(1);
  }, 20_000);
});
