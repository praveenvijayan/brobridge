# Choosing an adapter

brobridge's own surface — `expose`/`call` with JSON, `stream`/`openStream`
with bytes — is deliberately small and string-keyed. If that is all you need,
use it directly and skip this page. An adapter earns its place when you want
end-to-end types, schema validation, or you already have a router.

All three adapters give you the same brobridge underneath: origin security,
one multiplexed socket, per-stream backpressure, and resume across
reconnects (subscriptions included). Your application code sees only the
framework.

## Quick decision

- **Nothing yet, want minimal** → `birpc`. Plain typed functions in both
  directions, ~zero concepts, no schemas.
- **Building an API you'll validate and maybe expose elsewhere** → `oRPC`.
  Standard-schema validation (Zod, Valibot, ArkType) and OpenAPI output from
  the same router.
- **Existing tRPC router, or you want the React Query ecosystem** → `tRPC`.
  Biggest ecosystem; subscriptions map onto brobridge streams and gain
  resume for free.

## What each looks like

| | birpc | oRPC | tRPC v11 |
| --- | --- | --- | --- |
| Subpath | `@brobridge/adapters/birpc` | `@brobridge/adapters/orpc` | `@brobridge/adapters/trpc` |
| Server side | `mount(bridge, functions)` | `mount(bridge, router)` | `mount(bridge, router)` |
| Browser side | `createBirpcLink(bridge)` | `createORPCLink(bridge)` | `createTRPCLink(bridge)` |
| Types | inferred from your functions | router + schemas | router |
| Runtime validation | none (yours) | standard schema | optional per-procedure |
| Bidirectional (host calls tab) | yes, symmetric | via event iterators | subscriptions only |
| Streaming | manual (use brobridge streams directly) | event iterators → brobridge streams | subscriptions → brobridge streams |
| Extra deps in the page | birpc (tiny) | oRPC client | tRPC client (+ React Query if used) |

Frameworks are optional peer dependencies; importing one subpath never loads
another framework. Runnable examples for each live in the
[adapters README](../packages/adapters/README.md).

## Mixing

Adapters and the raw surface coexist on one bridge. A common shape: tRPC for
the app's API, plus one raw brobridge stream for the PTY/log firehose where
you want bytes and backpressure without a framework in the path.

## When to stay raw

- Payloads are bytes, not JSON (terminals, files, media).
- You are wrapping brobridge in your own product SDK anyway.
- Bundle size is critical — the raw client is the smallest path.
