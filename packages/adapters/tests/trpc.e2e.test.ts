/**
 * tRPC v11, end to end, over a real bridge.
 *
 * Queries and mutations take the unary call surface; subscriptions take a
 * stream, which is what gives them resume: a socket that dies mid-subscription
 * costs the consumer nothing, not even a duplicate event.
 */
import { createTRPCClient } from '@trpc/client';
import { TRPCError, initTRPC } from '@trpc/server';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { createTRPCLink, mount } from '../src/trpc.js';
import type { Harness } from './helpers/env.js';
import { harness, sleep } from './helpers/env.js';

const t = initTRPC.context<{ sessionId: string | null }>().create();

const appRouter = t.router({
  greet: t.procedure
    .input(z.object({ name: z.string() }))
    .query(({ input }) => `hello ${input.name}`),
  bump: t.procedure.input(z.number()).mutation(({ input }) => input + 1),
  whoami: t.procedure.query(({ ctx }) => ctx.sessionId),
  boom: t.procedure.query(() => {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'not for you' });
  }),
  ticker: t.procedure
    .input(z.object({ count: z.number(), everyMs: z.number() }))
    .subscription(async function* ({ input }) {
      for (let index = 0; index < input.count; index += 1) {
        await sleep(input.everyMs);
        yield index;
      }
    }),
});

type AppRouter = typeof appRouter;

const live: Harness[] = [];

afterEach(async () => {
  await Promise.all(live.splice(0).map((one) => one.close()));
});

async function connectClient(): Promise<{
  harness: Harness;
  trpc: ReturnType<typeof createTRPCClient<AppRouter>>;
}> {
  const one = await harness((host) => {
    mount(host, appRouter, {
      createContext: (context) => ({ sessionId: context.sessionId }),
    });
  });
  live.push(one);
  return {
    harness: one,
    trpc: createTRPCClient<AppRouter>({ links: [createTRPCLink<AppRouter>(one.client, {})] }),
  };
}

describe('tRPC adapter', () => {
  it('round-trips queries and mutations with end-to-end types', async () => {
    const { trpc } = await connectClient();

    expect(await trpc.greet.query({ name: 'ada' })).toBe('hello ada');
    expect(await trpc.bump.mutate(41)).toBe(42);

    expectTypeOf(trpc.greet.query).parameter(0).toMatchObjectType<{ name: string }>();
    expectTypeOf(await trpc.greet.query({ name: 'ada' })).toEqualTypeOf<string>();
    expectTypeOf(await trpc.bump.mutate(1)).toEqualTypeOf<number>();
  });

  it('rejects an input the router refuses, before the resolver runs', async () => {
    const { trpc } = await connectClient();
    await expect(
      // @ts-expect-error — the router's input schema forbids this shape.
      trpc.greet.query({ name: 42 }),
    ).rejects.toThrow();
  });

  it('carries a router error with its code and message', async () => {
    const { trpc } = await connectClient();
    await expect(trpc.boom.query()).rejects.toThrow('not for you');
  });

  it('builds context per call, but only a stream carries a session', async () => {
    const { trpc } = await connectClient();
    // The raw unary surface does not attribute a call to a session, and the
    // adapter says so rather than inventing one.
    expect(await trpc.whoami.query()).toBeNull();
  });

  it('streams a subscription', async () => {
    const { trpc } = await connectClient();
    const seen = await collectSubscription(trpc, { count: 4, everyMs: 1 });
    expect(seen).toEqual([0, 1, 2, 3]);
  });

  it('resumes a subscription across a dropped socket', async () => {
    const { harness: one, trpc } = await connectClient();
    const seen = await collectSubscription(trpc, { count: 12, everyMs: 20 }, (values) => {
      if (values.length === 3) one.env.lastSocket?.kill();
    });

    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(one.env.sockets.length).toBeGreaterThan(1);
  }, 20_000);

  it('stops the host producer when the consumer unsubscribes', async () => {
    const { trpc } = await connectClient();
    const seen: number[] = [];
    await new Promise<void>((resolve, reject) => {
      const subscription = trpc.ticker.subscribe(
        { count: 1_000, everyMs: 5 },
        {
          onData: (value) => {
            seen.push(value);
            if (seen.length === 3) {
              subscription.unsubscribe();
              resolve();
            }
          },
          onError: reject,
        },
      );
    });
    const afterUnsubscribe = seen.length;
    await sleep(60);
    expect(seen.length).toBe(afterUnsubscribe);
  });
});

/** Consume a subscription to completion, reporting each batch as it arrives. */
function collectSubscription(
  trpc: ReturnType<typeof createTRPCClient<AppRouter>>,
  input: { count: number; everyMs: number },
  onEach: (values: readonly number[]) => void = () => {},
): Promise<number[]> {
  return new Promise<number[]>((resolve, reject) => {
    const seen: number[] = [];
    trpc.ticker.subscribe(input, {
      onData: (value) => {
        seen.push(value);
        onEach(seen);
      },
      onError: reject,
      onComplete: () => {
        resolve(seen);
      },
    });
  });
}
