/**
 * `@brobridge/adapters/birpc` — birpc over a brobridge stream.
 *
 * birpc is symmetric: both ends register functions and both ends call the
 * other's. That maps onto one duplex brobridge stream per connected tab, and
 * because a brobridge stream is resumed after a dropped socket rather than
 * restarted, a call in flight when the network blinks still gets its answer.
 *
 * ```ts
 * // host
 * import { mount } from '@brobridge/adapters/birpc';
 * const group = mount(bridge, { hash: (text: string) => sha256(text) });
 * await group.broadcast.refresh();
 *
 * // browser
 * import { createBirpcLink } from '@brobridge/adapters/birpc';
 * const rpc = await createBirpcLink<HostFunctions>(client, { refresh: () => reload() });
 * await rpc.hash('hello');
 * ```
 *
 * @see https://github.com/antfu/birpc
 * @packageDocumentation
 */
import type { BridgeStream } from '@brobridge/core';
import type { BirpcGroup, BirpcReturn, ChannelOptions, EventOptions } from 'birpc';
import { createBirpc, createBirpcGroup } from 'birpc';

import type { BridgeClientLike, BridgeHostLike } from './internal/bridge.js';
import { decodeMessage, encodeUnknown, frameMessage, readMessages } from './internal/messages.js';

/** The stream route both ends use unless told otherwise. */
export const DEFAULT_BIRPC_ROUTE = 'birpc';

/** The codec a channel uses, if the default JSON one is not wanted. */
export interface BirpcCodec {
  /** Serialise a birpc message. May return text or bytes. */
  readonly serialize?: ChannelOptions['serialize'] | undefined;
  /** Reverse {@link BirpcCodec.serialize}. */
  readonly deserialize?: ChannelOptions['deserialize'] | undefined;
}

/** What both ends of the adapter accept, beyond birpc's own event options. */
export interface BirpcChannelOptions extends BirpcCodec {
  /** Stream route name. Must match on both ends. Defaults to `"birpc"`. */
  readonly route?: string;
}

/** Options accepted by {@link mount}. */
export type BirpcMountOptions<
  RemoteFunctions extends object,
  LocalFunctions extends object,
> = BirpcChannelOptions & EventOptions<RemoteFunctions, LocalFunctions>;

/** Options accepted by {@link createBirpcLink}. */
export type BirpcLinkOptions<
  RemoteFunctions extends object,
  LocalFunctions extends object,
> = BirpcChannelOptions & EventOptions<RemoteFunctions, LocalFunctions>;

/**
 * Expose `functions` to every browser tab that connects to `bridge`.
 *
 * Returns birpc's own group handle: `group.clients` is one RPC per live tab
 * and `group.broadcast` calls them all at once. Tabs join and leave the group
 * as their streams open and close, so the handle stays correct without the
 * host application tracking connections itself.
 */
export function mount<
  RemoteFunctions extends object = Record<string, unknown>,
  LocalFunctions extends object = Record<string, unknown>,
>(
  bridge: BridgeHostLike,
  functions: LocalFunctions,
  options: BirpcMountOptions<RemoteFunctions, LocalFunctions> = {},
): BirpcGroup<RemoteFunctions, LocalFunctions> {
  const { route = DEFAULT_BIRPC_ROUTE, serialize, deserialize, ...events } = options;
  const channels: ChannelOptions[] = [];
  const group = createBirpcGroup<RemoteFunctions, LocalFunctions>(functions, channels, events);

  bridge.stream(route, (stream) => {
    const channel = streamChannel(stream, { serialize, deserialize });
    channels.push(channel.options);
    group.updateChannels();
    void channel.closed.then(() => {
      const index = channels.indexOf(channel.options);
      if (index !== -1) channels.splice(index, 1);
      group.updateChannels();
    });
  });

  return group;
}

/**
 * Connect a browser-side birpc to the host's {@link mount}.
 *
 * Resolves once the stream is open. The returned RPC closes when the stream
 * ends — the host shutting down, or a resume the host could no longer serve.
 */
export async function createBirpcLink<
  RemoteFunctions extends object = Record<string, unknown>,
  LocalFunctions extends object = Record<string, unknown>,
>(
  bridge: BridgeClientLike,
  functions: LocalFunctions,
  options: BirpcLinkOptions<RemoteFunctions, LocalFunctions> = {},
): Promise<BirpcReturn<RemoteFunctions, LocalFunctions>> {
  const { route = DEFAULT_BIRPC_ROUTE, serialize, deserialize, ...events } = options;
  const stream = await bridge.openStream(route, {}, { mode: 'duplex' });
  await stream.opened;

  const channel = streamChannel(stream, { serialize, deserialize });
  const rpc = createBirpc<RemoteFunctions, LocalFunctions>(functions, {
    ...events,
    ...channel.options,
  });
  void channel.closed.then(() => {
    if (!rpc.$closed) rpc.$close();
  });
  return rpc;
}

/**
 * How a thrown error is spelled on the wire.
 *
 * `JSON.stringify` turns an `Error` into `{}`, which would reach the caller as
 * a rejection with no message at all. The default codec carries the name and
 * the message — and deliberately not the stack, which would hand a browser tab
 * host paths and internal structure (`THREAT-MODEL.md` §5.14).
 */
const ERROR_MARKER = '$brobridgeError';

function serializeJson(data: unknown): string {
  return JSON.stringify(data, (_key, value: unknown) =>
    value instanceof Error
      ? { [ERROR_MARKER]: { name: value.name, message: value.message } }
      : value,
  );
}

function deserializeJson(data: unknown): unknown {
  if (typeof data !== 'string') return data;
  return JSON.parse(data, (_key, value: unknown) => {
    if (typeof value !== 'object' || value === null) return value;
    const marked = (value as Record<string, unknown>)[ERROR_MARKER];
    if (typeof marked !== 'object' || marked === null) return value;
    const { name, message } = marked as { name?: unknown; message?: unknown };
    const error = new Error(typeof message === 'string' ? message : 'remote error');
    if (typeof name === 'string') error.name = name;
    return error;
  });
}

/** A birpc channel and the promise that settles when its stream is done. */
interface StreamChannel {
  readonly options: ChannelOptions;
  readonly closed: Promise<void>;
}

/**
 * Turn a stream into a birpc channel.
 *
 * JSON is the default codec, as it is for a birpc channel over any other byte
 * transport. An application that replaces it may return bytes instead of a
 * string: the framing carries either, and hands the peer back what it sent.
 */
function streamChannel(
  stream: BridgeStream,
  codec: BirpcCodec,
): StreamChannel {
  const listeners = new Set<(data: unknown) => void>();

  const closed = (async () => {
    try {
      for await (const message of readMessages(stream)) {
        const data = decodeMessage(message);
        for (const listener of [...listeners]) listener(data);
      }
    } catch {
      // A dead stream is a closed channel, which is all `closed` promises to
      // report. The fault itself already reached the application through the
      // bridge's own error surface.
    }
  })();

  return {
    closed,
    options: {
      serialize: codec.serialize ?? serializeJson,
      deserialize: codec.deserialize ?? deserializeJson,
      post: (data: unknown) => {
        const message = encodeUnknown(data);
        return stream.write(frameMessage(message.kind, message.payload));
      },
      on: (fn: (data: unknown) => void) => {
        listeners.add(fn);
      },
      off: (fn: (data: unknown) => void) => {
        listeners.delete(fn);
      },
    },
  };
}
