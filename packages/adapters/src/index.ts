/**
 * `@brobridgejs/adapters` — RPC framework adapters for brobridge.
 *
 * brobridge is a transport, not an RPC framework. Each adapter is a subpath
 * export, so an application installs and loads only the framework it uses:
 *
 * - `@brobridgejs/adapters/birpc` — birpc over one duplex stream per tab.
 * - `@brobridgejs/adapters/orpc` — oRPC's message-port adapter over a stream.
 * - `@brobridgejs/adapters/trpc` — tRPC v11 calls and subscriptions.
 *
 * Every adapter comes in both directions: `mount()` on the host, and a
 * `create…Link()` the framework's own client consumes, so end-to-end types
 * flow through the framework and the bridge stays invisible in application
 * code.
 *
 * This entry point carries only the types the adapters share. Importing it
 * pulls in no framework.
 *
 * @packageDocumentation
 */

export type {
  BridgeClientLike,
  BridgeHostLike,
  StreamRoute,
  StreamRouteContext,
} from './internal/bridge.js';

export {
  MAX_MESSAGE_SIZE,
  MESSAGE_HEADER_SIZE,
  MessageFramingError,
  MessageKind,
} from './internal/messages.js';
export type { Message } from './internal/messages.js';
