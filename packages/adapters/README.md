# @brobridge/adapters

brobridge is a transport, not an RPC framework. These adapters let an existing
framework ride on it — so your application code keeps the framework's own
types and API, and brobridge is invisible except for what it adds: origin
security, multiplexing, backpressure and resume.

> **Status: scaffold.** The adapters land in Phase 5, written against the
> current documentation of each target library. The example below is the target
> shape.

## Install

```bash
npm install @brobridge/adapters
```

Each framework is a subpath export, so you pull in only the one you use:

| Subpath | Framework |
| --- | --- |
| `@brobridge/adapters/birpc` | [birpc](https://github.com/antfu/birpc) |
| `@brobridge/adapters/orpc` | [oRPC](https://orpc.dev) |
| `@brobridge/adapters/trpc` | [tRPC](https://trpc.io) v11 |

The frameworks themselves are peer dependencies: bring your own version.

## Example

```ts
// host process
import { createBridge } from 'brobridge';
import { mount } from '@brobridge/adapters/trpc';

const bridge = await createBridge();
mount(bridge, appRouter);
```

```ts
// browser
import { connect } from '@brobridge/client';
import { createTRPCLink } from '@brobridge/adapters/trpc';
import { createTRPCClient } from '@trpc/client';

const bridge = await connect(location.href);
const trpc = createTRPCClient<AppRouter>({
  links: [createTRPCLink(bridge)],
});

await trpc.files.read.query('/etc/hostname'); // fully typed, end to end
```

## Subscriptions get resume for free

tRPC subscriptions and oRPC event iterators map onto brobridge streams, so a
reconnect mid-subscription replays the frames the client missed instead of
dropping events on the floor.

## License

MIT
