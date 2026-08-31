/**
 * `@brobridge/adapters/orpc` — oRPC over a brobridge stream.
 *
 * oRPC already speaks a peer-to-peer message protocol for adapters that have
 * no HTTP under them: its message-port adapter. A brobridge duplex stream is
 * a better message port than a real one — it is ordered, credit-controlled,
 * and resumed after a dropped socket — so this adapter is mostly a matter of
 * handing oRPC that stream and staying out of the way.
 *
 * Event iterators ride the same stream and therefore survive a reconnect: the
 * subscription is not restarted, it continues where it stopped.
 *
 * ```ts
 * // host
 * import { mount } from '@brobridge/adapters/orpc';
 * mount(bridge, router);
 *
 * // browser
 * import { createORPCClient } from '@orpc/client';
 * import { createORPCLink } from '@brobridge/adapters/orpc';
 * const client: RouterClient<typeof router> = createORPCClient(await createORPCLink(bridgeClient));
 * ```
 *
 * @see https://orpc.dev/docs/adapters/message-port
 * @packageDocumentation
 */
import type { ClientContext } from '@orpc/client';
import type { RPCLinkOptions } from '@orpc/client/message-port';
import { RPCLink } from '@orpc/client/message-port';
import type { Context, Router } from '@orpc/server';
import type { RPCHandlerOptions } from '@orpc/server/message-port';
import { RPCHandler } from '@orpc/server/message-port';

import type { BridgeClientLike, BridgeHostLike, StreamRouteContext } from './internal/bridge.js';
import { createStreamPort } from './internal/port.js';

/** The stream route both ends use unless told otherwise. */
export const DEFAULT_ORPC_ROUTE = 'orpc';

/** Builds the oRPC initial context for one connected stream. */
export type ORPCContextFactory<T extends Context> = (
  context: StreamRouteContext,
) => T | Promise<T>;

/**
 * Options accepted by {@link mount}.
 *
 * `context` is required exactly when the router's initial context is, which
 * is the same rule oRPC's own adapters apply.
 */
export type ORPCMountOptions<T extends Context> = {
  /** Stream route name. Must match on both ends. Defaults to `"orpc"`. */
  readonly route?: string;
} & RPCHandlerOptions<T> &
  (Record<never, never> extends T
    ? { readonly context?: ORPCContextFactory<T> }
    : { readonly context: ORPCContextFactory<T> });

/** Options accepted by {@link createORPCLink}. Everything `RPCLink` takes, minus the port. */
export interface ORPCLinkOptions<T extends ClientContext>
  extends Omit<RPCLinkOptions<T>, 'port'> {
  /** Stream route name. Must match on both ends. Defaults to `"orpc"`. */
  readonly route?: string;
}

/** An argument list that is optional exactly when every option is. */
type MaybeOptional<T> = Record<never, never> extends T ? [options?: T] : [options: T];

/**
 * Serve `router` to every browser tab that connects to `bridge`.
 *
 * One oRPC handler is built for the bridge and upgraded once per stream, so
 * per-connection state stays per-connection while the router itself is shared.
 */
export function mount<T extends Context>(
  bridge: BridgeHostLike,
  router: Router<any, T>,
  ...rest: MaybeOptional<ORPCMountOptions<T>>
): void {
  const options = rest[0] ?? ({} as ORPCMountOptions<T>);
  const { route = DEFAULT_ORPC_ROUTE } = options;
  const handler = new RPCHandler(router, options);
  const buildContext = (options as { readonly context?: ORPCContextFactory<T> }).context;

  bridge.stream(route, async (stream, context) => {
    const port = createStreamPort(stream);
    // The port buffers until a listener exists, so awaiting the application's
    // context factory here cannot drop the first request on the stream.
    // oRPC types `upgrade`'s options tuple so that `context` is required only
    // for routers that need one. That distinction is already made by
    // `ORPCMountOptions`, and re-expressing it here buys nothing.
    const upgrade = handler.upgrade.bind(handler) as (port: unknown, options?: unknown) => void;
    upgrade(port, buildContext === undefined ? {} : { context: await buildContext(context) });
    await port.drained;
  });
}

/**
 * Build an oRPC link that talks to the host's {@link mount}.
 *
 * Resolves once the stream is open. Pass the result to `createORPCClient` and
 * the application sees oRPC's own client, fully typed, with no sign of the
 * transport underneath it.
 */
export async function createORPCLink<T extends ClientContext = Record<never, never>>(
  bridge: BridgeClientLike,
  options: ORPCLinkOptions<T> = {},
): Promise<RPCLink<T>> {
  const { route = DEFAULT_ORPC_ROUTE, ...linkOptions } = options;
  const stream = await bridge.openStream(route, {}, { mode: 'duplex' });
  await stream.opened;
  return new RPCLink<T>({ ...linkOptions, port: createStreamPort(stream) });
}
