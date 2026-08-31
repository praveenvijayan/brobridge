/**
 * A connected client endpoint and server session host over an in-memory pipe.
 */
import type { BridgeEndpoint, BridgeEndpointOptions, BridgeStream } from '../../src/index.js';
import { SessionHost } from '../../src/index.js';
import { BridgeEndpoint as Endpoint } from '../../src/index.js';
import type { MemoryPipe } from './pipe.js';
import { createPipe } from './pipe.js';

type SideOptions = Omit<BridgeEndpointOptions, 'role'>;

export interface ConnectedPair {
  pipe: MemoryPipe;
  host: SessionHost;
  client: BridgeEndpoint;
  server: BridgeEndpoint;
  /** Reconnect over a fresh pipe, sending `RESUME`. */
  reconnect(): Promise<MemoryPipe>;
}

/** Bring up a client and a server that have completed the `HELLO` handshake. */
export async function connectPair(options?: {
  client?: SideOptions;
  server?: SideOptions;
  onStream?: (stream: BridgeStream) => void;
  chunkSize?: number;
}): Promise<ConnectedPair> {
  const pipe = createPipe();
  if (options?.chunkSize !== undefined) pipe.setChunkSize(options.chunkSize);

  const host = new SessionHost({
    ...options?.server,
    ...(options?.onStream === undefined ? {} : { onStream: options.onStream }),
  });
  const client = new Endpoint({ role: 'client', ...options?.client });

  const accepted = host.accept(pipe.server);
  await client.attach(pipe.client);
  const server = await accepted;

  const pair: ConnectedPair = {
    pipe,
    host,
    client,
    server,
    async reconnect(): Promise<MemoryPipe> {
      const next = createPipe();
      if (options?.chunkSize !== undefined) next.setChunkSize(options.chunkSize);
      const resumed = host.accept(next.server);
      await client.attach(next.client);
      await resumed;
      pair.pipe = next;
      return next;
    },
  };
  return pair;
}
