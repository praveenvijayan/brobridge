/**
 * What an adapter needs from a bridge, and nothing more.
 *
 * These are structural types, satisfied by `Bridge` from `brobridge` and by
 * `Bridge` from `@brobridgejs/client` without either package being imported
 * here. An application that only ever mounts a router on the host must not be
 * made to install the browser client to typecheck, and the reverse holds too.
 *
 * @packageDocumentation
 */
import type { BridgeStream, OpenStreamOptions } from '@brobridgejs/core';

/** Context a host hands to a stream route. */
export interface StreamRouteContext {
  /** Route parameters carried by `OPEN`. */
  readonly params: Readonly<Record<string, unknown>>;
  /** The authenticated session the stream belongs to. */
  readonly sessionId: string;
}

/** A stream route, as the host package declares it. */
export type StreamRoute = (stream: BridgeStream, context: StreamRouteContext) => unknown;

/** The host side of a bridge: `Bridge` from `brobridge`. */
export interface BridgeHostLike {
  /** Register a service whose methods answer `"<name>.<method>"`. */
  expose(name: string, service: Record<string, unknown>): void;
  /** Register a stream route. */
  stream(name: string, handler: StreamRoute): void;
}

/** The browser side of a bridge: `Bridge` from `@brobridgejs/client`. */
export interface BridgeClientLike {
  /** Call an exposed method with JSON arguments. */
  call<T = unknown>(route: string, ...args: readonly unknown[]): Promise<T>;
  /** Open a stream on a route. */
  openStream(
    name: string,
    params?: Readonly<Record<string, unknown>>,
    options?: Omit<OpenStreamOptions, 'params'>,
  ): Promise<BridgeStream>;
}
