/**
 * `@brobridge/adapters/trpc` — tRPC v11 over a bridge.
 *
 * Queries and mutations ride brobridge's unary call surface, which means they
 * also work through the `POST /rpc` fallback when a WebSocket is blocked.
 * Subscriptions ride a brobridge stream, so a dropped socket resumes the
 * subscription rather than restarting it: the consumer sees every event once,
 * in order, with no gap and no duplicate.
 *
 * ```ts
 * // host
 * import { mount } from '@brobridge/adapters/trpc';
 * mount(bridge, appRouter);
 *
 * // browser
 * import { createTRPCClient } from '@trpc/client';
 * import { createTRPCLink } from '@brobridge/adapters/trpc';
 * const trpc = createTRPCClient<AppRouter>({ links: [createTRPCLink(bridgeClient, {})] });
 * ```
 *
 * @see https://trpc.io/docs/client/links
 * @packageDocumentation
 */
import type { BridgeStream } from '@brobridge/core';
import type { TRPCLink } from '@trpc/client';
import { TRPCClientError } from '@trpc/client';
import type { TransformerOptions } from '@trpc/client/unstable-internals';
import { getTransformer } from '@trpc/client/unstable-internals';
import type { AnyRouter, TRPCProcedureType, inferRouterContext } from '@trpc/server';
import {
  TRPCError,
  callTRPCProcedure,
  getTRPCErrorFromUnknown,
  getTRPCErrorShape,
  isTrackedEnvelope,
  transformTRPCResponse,
} from '@trpc/server';
import { isObservable, observable, observableToAsyncIterable } from '@trpc/server/observable';
import type { TRPCResponseMessage, TRPCResult } from '@trpc/server/rpc';
import { parseTRPCMessage } from '@trpc/server/rpc';
import type { inferClientTypes } from '@trpc/server/unstable-core-do-not-import';
import { transformResult } from '@trpc/server/unstable-core-do-not-import';

import type { BridgeClientLike, BridgeHostLike, StreamRouteContext } from './internal/bridge.js';
import { readJson, writeJson } from './internal/messages.js';

/** The service and stream-route prefix both ends use unless told otherwise. */
export const DEFAULT_TRPC_NAMESPACE = 'trpc';

/** What the host knows about the request a context is being built for. */
export interface TRPCRequestContext {
  /**
   * The authenticated session the request arrived on, or `null` for a unary
   * call: brobridge's raw call surface does not attribute one.
   */
  readonly sessionId: string | null;
  /** Route parameters carried by the stream's `OPEN`, empty for a unary call. */
  readonly params: Readonly<Record<string, unknown>>;
}

/** Options accepted by {@link mount}. */
export interface TRPCMountOptions<TRouter extends AnyRouter> {
  /** Service and stream-route prefix. Must match on both ends. Defaults to `"trpc"`. */
  readonly namespace?: string;
  /** Build the router's context. Called once per request or subscription. */
  readonly createContext?: (
    context: TRPCRequestContext,
  ) => inferRouterContext<TRouter> | Promise<inferRouterContext<TRouter>>;
  /** Observe faults. The peer is told regardless; this is for the host's logs. */
  readonly onError?: (options: {
    readonly error: TRPCError;
    readonly type: TRPCProcedureType | 'unknown';
    readonly path: string | undefined;
    readonly input: unknown;
    readonly ctx: inferRouterContext<TRouter> | undefined;
  }) => void;
}

/** Options accepted by {@link createTRPCLink}. */
export type TRPCLinkOptions<TRouter extends AnyRouter> = {
  /** Service and stream-route prefix. Must match on both ends. Defaults to `"trpc"`. */
  readonly namespace?: string;
} & TransformerOptions<inferClientTypes<TRouter>>;

/**
 * Serve `router` over `bridge`.
 *
 * Registers two routes: `"<namespace>.call"` for queries and mutations, and
 * the `"<namespace>.subscription"` stream for subscriptions.
 */
export function mount<TRouter extends AnyRouter>(
  bridge: BridgeHostLike,
  router: TRouter,
  options: TRPCMountOptions<TRouter> = {},
): void {
  const namespace = options.namespace ?? DEFAULT_TRPC_NAMESPACE;

  bridge.expose(namespace, {
    call: (request: unknown): Promise<TRPCResponseMessage> =>
      handleCall(router, options, request, { sessionId: null, params: {} }),
  });

  bridge.stream(`${namespace}.subscription`, (stream, context) =>
    handleSubscription(router, options, stream, context),
  );
}

/**
 * Build a tRPC link that talks to the host's {@link mount}.
 *
 * Pass it to `createTRPCClient` and the application only ever sees tRPC: the
 * bridge is the wire, not the API.
 */
export function createTRPCLink<TRouter extends AnyRouter>(
  bridge: BridgeClientLike,
  options: TRPCLinkOptions<TRouter>,
): TRPCLink<TRouter> {
  const transformer = getTransformer(options.transformer);
  const namespace = options.namespace ?? DEFAULT_TRPC_NAMESPACE;

  return () =>
    ({ op }) =>
      observable((observer) => {
        const request = {
          id: op.id,
          jsonrpc: '2.0',
          method: op.type,
          params: { path: op.path, input: transformer.input.serialize(op.input) },
        };

        /** Feed one server envelope to the observer. Returns false once it is finished. */
        const emit = (envelope: unknown): boolean => {
          const result = transformResult(
            envelope as TRPCResponseMessage,
            transformer.output,
          );
          if (!result.ok) {
            observer.error(TRPCClientError.from(result.error));
            return false;
          }
          if (result.result.type === 'stopped') {
            observer.complete();
            return false;
          }
          observer.next({ result: result.result, context: op.context });
          return true;
        };

        const fail = (cause: unknown): void => {
          observer.error(TRPCClientError.from(asError(cause)));
        };

        if (op.type !== 'subscription') {
          let live = true;
          bridge
            .call<TRPCResponseMessage>(`${namespace}.call`, request)
            .then((envelope) => {
              if (!live) return;
              if (emit(envelope)) observer.complete();
            })
            .catch((cause: unknown) => {
              if (live) fail(cause);
            });
          return () => {
            live = false;
          };
        }

        let stream: BridgeStream | null = null;
        let live = true;
        void (async () => {
          const opened = await bridge.openStream(
            `${namespace}.subscription`,
            request as unknown as Record<string, unknown>,
            { mode: 'read' },
          );
          if (!live) {
            opened.cancel('unsubscribed');
            return;
          }
          stream = opened;
          for await (const envelope of readJson(opened)) {
            if (!live) return;
            if (!emit(envelope)) return;
          }
          if (live) observer.complete();
        })().catch((cause: unknown) => {
          if (live) fail(cause);
        });

        return () => {
          live = false;
          stream?.cancel('unsubscribed');
        };
      });
}

/* -------------------------------------------------------------------------- */
/*  Host side                                                                  */
/* -------------------------------------------------------------------------- */

/** Answer one query or mutation. Faults become error envelopes, never throws. */
async function handleCall<TRouter extends AnyRouter>(
  router: TRouter,
  options: TRPCMountOptions<TRouter>,
  request: unknown,
  context: TRPCRequestContext,
): Promise<TRPCResponseMessage> {
  const config = router._def._config;
  const parsed = parse(router, request);
  if ('error' in parsed) return shape(router, options, parsed.error, 'unknown', undefined, undefined, undefined);

  const { id, type, path, input } = parsed;
  if (type === 'subscription') {
    return shape(
      router,
      options,
      new TRPCError({
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: `Subscription ${path} must be opened as a stream, not called`,
      }),
      type,
      path,
      input,
      undefined,
      id,
    );
  }

  let ctx: inferRouterContext<TRouter> | undefined;
  try {
    ctx = await buildContext(options, context);
    const result: unknown = await callTRPCProcedure({
      router,
      path,
      getRawInput: () => Promise.resolve(input),
      ctx,
      type,
      signal: undefined,
      batchIndex: 0,
    });
    if (isIterable(result)) {
      throw new TRPCError({
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: `Cannot return an async iterable or observable from a ${type} procedure over a unary call`,
      });
    }
    return transformTRPCResponse(config, {
      id,
      jsonrpc: '2.0',
      result: { type: 'data', data: result },
    }) as TRPCResponseMessage;
  } catch (cause) {
    return shape(router, options, getTRPCErrorFromUnknown(cause), type, path, input, ctx, id);
  }
}

/** Run one subscription, writing its events to the stream as JSON messages. */
async function handleSubscription<TRouter extends AnyRouter>(
  router: TRouter,
  options: TRPCMountOptions<TRouter>,
  stream: BridgeStream,
  context: StreamRouteContext,
): Promise<void> {
  const request: TRPCRequestContext = { sessionId: context.sessionId, params: stream.params };
  const parsed = parse(router, stream.params);
  if ('error' in parsed) {
    await finish(stream, shape(router, options, parsed.error, 'unknown', undefined, undefined, undefined));
    return;
  }

  const { id, type, path, input } = parsed;
  const abort = new AbortController();
  // A cancelled stream must stop the producer, not just stop being read.
  void stream.closed.catch(() => {
    abort.abort();
  });

  let ctx: inferRouterContext<TRouter> | undefined;
  try {
    ctx = await buildContext(options, request);
    const result: unknown = await callTRPCProcedure({
      router,
      path,
      getRawInput: () => Promise.resolve(input),
      ctx,
      type,
      signal: abort.signal,
      batchIndex: 0,
    });
    if (!isIterable(result)) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `Subscription ${path} did not return an observable or an AsyncGenerator`,
      });
    }

    await send(stream, router, { id, jsonrpc: '2.0', result: { type: 'started' } });
    const iterable = isObservable(result)
      ? observableToAsyncIterable<unknown>(result, abort.signal)
      : result;
    for await (const value of iterable) {
      if (abort.signal.aborted) break;
      await send(stream, router, { id, jsonrpc: '2.0', result: event(value) });
    }
    if (abort.signal.aborted) return;
    await finish(stream, { id, jsonrpc: '2.0', result: { type: 'stopped' } });
  } catch (cause) {
    if (abort.signal.aborted) return;
    await finish(stream, shape(router, options, getTRPCErrorFromUnknown(cause), type, path, input, ctx, id));
  }
}

/** A `data` result, carrying the tracked id when the procedure supplied one. */
function event(value: unknown): TRPCResult<unknown> {
  if (!isTrackedEnvelope(value)) return { type: 'data', data: value };
  const [id, data] = value;
  return { type: 'data', id, data: { id, data } };
}

/** Parse a peer's request message, deserialising its input with the router's transformer. */
function parse<TRouter extends AnyRouter>(
  router: TRouter,
  raw: unknown,
):
  | { readonly id: number | string | null; readonly type: TRPCProcedureType; readonly path: string; readonly input: unknown }
  | { readonly error: TRPCError } {
  try {
    const message = parseTRPCMessage(raw, router._def._config.transformer);
    if (message.method === 'subscription.stop') {
      return {
        error: new TRPCError({ code: 'BAD_REQUEST', message: 'subscription.stop is not used by this transport' }),
      };
    }
    return {
      id: message.id,
      type: message.method,
      path: message.params.path,
      input: message.params.input,
    };
  } catch (cause) {
    return {
      error: new TRPCError({ code: 'PARSE_ERROR', message: 'malformed tRPC request', cause }),
    };
  }
}

async function buildContext<TRouter extends AnyRouter>(
  options: TRPCMountOptions<TRouter>,
  context: TRPCRequestContext,
): Promise<inferRouterContext<TRouter>> {
  if (options.createContext === undefined) return {} as inferRouterContext<TRouter>;
  return await options.createContext(context);
}

/** Build an error envelope, telling the host about the fault on the way past. */
function shape<TRouter extends AnyRouter>(
  router: TRouter,
  options: TRPCMountOptions<TRouter>,
  error: TRPCError,
  type: TRPCProcedureType | 'unknown',
  path: string | undefined,
  input: unknown,
  ctx: inferRouterContext<TRouter> | undefined,
  id: number | string | null = null,
): TRPCResponseMessage {
  options.onError?.({ error, type, path, input, ctx });
  return {
    id,
    jsonrpc: '2.0',
    error: getTRPCErrorShape({ config: router._def._config, error, type, path, input, ctx }),
  };
}

function send<TRouter extends AnyRouter>(
  stream: BridgeStream,
  router: TRouter,
  message: TRPCResponseMessage,
): Promise<void> {
  return writeJson(stream, transformTRPCResponse(router._def._config, message));
}

/** Write a last message and close the stream's sending direction. */
async function finish(stream: BridgeStream, message: TRPCResponseMessage): Promise<void> {
  await writeJson(stream, message);
  await stream.end();
}

function isIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    isObservable(value) ||
    (typeof value === 'object' && value !== null && Symbol.asyncIterator in value)
  );
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
