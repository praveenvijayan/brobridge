# @brobridge/adapters

brobridge is a transport, not an RPC framework. These adapters let an existing
framework ride on it — so your application code keeps the framework's own
types and API, and brobridge is invisible except for what it adds: origin
security, multiplexing, backpressure and resume.

## Install

```bash
npm install @brobridge/adapters
```

Each framework is a subpath export, so you pull in only the one you use:

| Subpath | Framework | Server | Browser |
| --- | --- | --- | --- |
| `@brobridge/adapters/birpc` | [birpc](https://github.com/antfu/birpc) | `mount` | `createBirpcLink` |
| `@brobridge/adapters/orpc` | [oRPC](https://orpc.dev) | `mount` | `createORPCLink` |
| `@brobridge/adapters/trpc` | [tRPC](https://trpc.io) v11 | `mount` | `createTRPCLink` |

The frameworks themselves are optional peer dependencies: bring your own
version. Importing one subpath never loads another framework.

## tRPC

```ts
// host process
import os from 'node:os';
import { createBridge } from 'brobridge';
import { mount } from '@brobridge/adapters/trpc';
import { initTRPC } from '@trpc/server';

const t = initTRPC.create();
const appRouter = t.router({
  hostname: t.procedure.query(() => os.hostname()),
  ticks: t.procedure.subscription(async function* () {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      yield Date.now();
    }
  }),
});
export type AppRouter = typeof appRouter;

const bridge = await createBridge();
mount(bridge, appRouter);
console.log(bridge.url); // open this
```

<!-- check-readme: fragment -->
```ts
// browser
import { connect } from '@brobridge/client';
import { createTRPCLink } from '@brobridge/adapters/trpc';
import { createTRPCClient } from '@trpc/client';

const bridge = await connect(location.href);
const trpc = createTRPCClient<AppRouter>({
  links: [createTRPCLink<AppRouter>(bridge, {})],
});

await trpc.hostname.query(); // fully typed, end to end
trpc.ticks.subscribe(undefined, { onData: (at) => console.log(at) });
```

Queries and mutations ride brobridge's unary call surface, so they keep
working through the `POST /rpc` fallback when a WebSocket is blocked.
Subscriptions ride a stream, which is what gives them resume.

Pass the router's data transformer the way tRPC's own links take it —
`createTRPCLink(bridge, { transformer: superjson })` — and `{}` when the router
has none. The host reads the transformer off the router, so it is configured
in one place only.

## oRPC

<!-- check-readme: fragment -->
```ts
// host process
import { mount } from '@brobridge/adapters/orpc';
mount(bridge, router);
```

<!-- check-readme: fragment -->
```ts
// browser
import { createORPCClient } from '@orpc/client';
import type { RouterClient } from '@orpc/server';
import { createORPCLink } from '@brobridge/adapters/orpc';

const client: RouterClient<typeof router> = createORPCClient(
  await createORPCLink(bridge),
);

await client.greet({ name: 'ada' });
for await (const event of await client.ticker({})) console.log(event);
```

The adapter hands oRPC's message-port adapter a brobridge duplex stream, so
calls and event iterators share one ordered, credit-controlled channel.

## birpc

birpc is symmetric, and so is the adapter: the host gets a birpc *group* with
one client per connected tab.

<!-- check-readme: fragment -->
```ts
// host process
import { mount } from '@brobridge/adapters/birpc';

interface HostFunctions { add(a: number, b: number): number }
interface TabFunctions { reload(): void }

const group = mount<TabFunctions, HostFunctions>(bridge, { add: (a, b) => a + b });
await group.broadcast.reload();
```

<!-- check-readme: fragment -->
```ts
// browser
import { createBirpcLink } from '@brobridge/adapters/birpc';

const rpc = await createBirpcLink<HostFunctions, TabFunctions>(bridge, {
  reload: () => location.reload(),
});
await rpc.add(1, 2);
```

Messages are JSON by default. A thrown host error reaches the caller as an
`Error` with its name and message — but never its stack, which would hand a
browser tab host paths and internal structure. Replace `serialize` /
`deserialize` to use another codec; the framing carries text or bytes either
way.

## Subscriptions get resume for free

tRPC subscriptions, oRPC event iterators and birpc's whole channel sit on
brobridge streams. A dropped socket is reconnected and the stream resumed from
the last sequence the client acknowledged, so a consumer sees every event
exactly once, in order — and where the host can no longer serve the resume it
gets a `SnapshotRequiredError`, not a silent gap.

## Choosing a route name

Every adapter takes an option (`route`, or `namespace` for tRPC) naming where
it sits on the bridge. The default is the framework's name. Change it on both
ends together, or mount two adapters on one bridge without them colliding.

## License

MIT
