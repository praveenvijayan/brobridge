/**
 * The Bun backend: `Bun.serve` with its own WebSocket handlers.
 *
 * Loaded only when the process is Bun, so Node never pays for it and `ws` is
 * never imported here. Bun's globals are described by the minimal interfaces
 * below rather than by a type package: the server's public API must compile
 * with nothing but `@types/node` installed.
 *
 * One difference from Node is worth knowing. Bun hands the request as a Fetch
 * `Request`, whose URL is already absolute and whose `Headers` have collapsed
 * duplicates. The fence therefore sees a reconstructed origin-form target and
 * a joined `Host` value — and a joined `Host` still fails the exact-authority
 * comparison, which is the same refusal by a different route.
 */
import { SocketCarrier } from './carrier.js';
import type { SocketAdapter, WriteOutcome } from './carrier.js';
import { Gateway } from './gateway.js';
import type { GatewayResponse } from './gateway.js';
import { handleRpc } from './rpc.js';
import type { HostListener, RuntimeConfig } from './runtime.js';
import { bindCarrier, toBytes } from './runtime.js';
import type { RawHeader } from './trust.js';

/** The slice of Bun's `ServerWebSocket` this backend uses. */
interface BunWebSocket {
  readonly data: { authSessionId: string; carrier: SocketCarrier | null };
  readonly readyState: number;
  send(data: Uint8Array, compress?: boolean): number;
  close(code?: number, reason?: string): void;
  getBufferedAmount(): number;
}

/** The slice of Bun's `Server` this backend uses. */
interface BunServer {
  readonly port: number;
  readonly hostname: string;
  upgrade(request: Request, options: { data: unknown }): boolean;
  stop(closeActiveConnections?: boolean): void;
}

interface BunGlobal {
  serve(options: unknown): BunServer;
}

/** Bytes the socket may hold before the pump waits for `drain`. */
const HIGH_WATER_MARK = 1024 * 1024;

/** Bind the Bun listener. */
export function startBunServer(config: RuntimeConfig): Promise<HostListener> {
  const bun = (globalThis as { Bun?: BunGlobal }).Bun;
  if (bun === undefined) throw new Error('the Bun backend was loaded outside Bun');
  const { options } = config;

  const server = bun.serve({
    hostname: options.host,
    port: options.port,
    maxRequestBodySize: options.maxRpcBodyBytes,
    development: false,
    fetch: async (request: Request, self: BunServer): Promise<Response | undefined> => {
      const gateway = config.gateway();
      if (gateway === null) return toResponse(Gateway.refuse(503));

      const url = new URL(request.url);
      const rawHeaders: RawHeader[] = [];
      request.headers.forEach((value, name) => {
        rawHeaders.push([name, value]);
      });
      const upgradeHeader = request.headers.get('upgrade');
      const wantsUpgrade = upgradeHeader !== null && upgradeHeader.toLowerCase() === 'websocket';

      const decision = await gateway.handle({
        method: request.method,
        target: `${url.pathname}${url.search}`,
        rawHeaders,
        remote: 'bun',
        upgrade: wantsUpgrade,
      });

      if (decision.kind === 'respond') return toResponse(decision.response);
      if (decision.kind === 'upgrade') {
        const data = { authSessionId: decision.authSessionId, carrier: null };
        if (self.upgrade(request, { data })) return undefined;
        return toResponse(Gateway.refuse(400));
      }

      const body = new Uint8Array(await request.arrayBuffer());
      if (body.length > options.maxRpcBodyBytes) return toResponse(Gateway.refuse(413));
      return toResponse(await handleRpc(body, config.registry, options.maxFrameSize));
    },
    websocket: {
      maxPayloadLength: options.maxFrameSize,
      perMessageDeflate: false,
      open: (ws: BunWebSocket) => {
        const adapter = new BunAdapter(ws);
        const carrier = new SocketCarrier(adapter, {
          maxBufferedBytes: options.maxSocketBufferBytes,
          highWaterMark: HIGH_WATER_MARK,
        });
        adapter.bind(carrier);
        ws.data.carrier = carrier;
        void bindCarrier(
          config.manager,
          carrier,
          ws.data.authSessionId,
          options.handshakeTimeoutMs,
        );
      },
      message: (ws: BunWebSocket, message: unknown) => {
        ws.data.carrier?.deliver(toBytes(message));
      },
      drain: (ws: BunWebSocket) => {
        ws.data.carrier?.resume();
      },
      close: (ws: BunWebSocket) => {
        ws.data.carrier?.notifyClose();
      },
    },
  });

  return Promise.resolve({
    host: server.hostname,
    port: server.port,
    close: async () => {
      server.stop(true);
      await Promise.resolve();
    },
  });
}

/** The Bun half of the socket pump. */
class BunAdapter implements SocketAdapter {
  readonly #ws: BunWebSocket;
  #carrier: SocketCarrier | null = null;

  constructor(ws: BunWebSocket) {
    this.#ws = ws;
  }

  bind(carrier: SocketCarrier): void {
    this.#carrier = carrier;
  }

  get buffered(): number {
    return this.#ws.getBufferedAmount();
  }

  write(bytes: Uint8Array): WriteOutcome {
    const written = this.#ws.send(bytes, false);
    // Bun's contract: a positive count is bytes sent, `-1` means the frame was
    // queued behind backpressure (a `drain` will follow), and `0` means it was
    // dropped — which for a byte-ordered protocol is a dead connection, not a
    // retry.
    if (written === 0) return 'failed';
    if (written < 0) return 'pause';
    return 'ok';
  }

  close(code: number, reason: string): void {
    this.#ws.close(code, reason);
    this.#carrier = null;
  }
}

function toResponse(spec: GatewayResponse): Response {
  const headers = new Headers();
  for (const [name, value] of spec.headers) {
    // `Content-Length` is the runtime's to set; a body and a stale length
    // disagree the moment Bun re-encodes anything.
    if (name.toLowerCase() === 'content-length') continue;
    headers.append(name, value);
  }
  // The body is handed over as an `ArrayBuffer`: it is the one binary body
  // type every runtime's `Response` accepts, whichever DOM or Node typings
  // the consumer compiles against.
  const body =
    spec.body === null
      ? null
      : spec.body.buffer.slice(
          spec.body.byteOffset,
          spec.body.byteOffset + spec.body.byteLength,
        );
  return new Response(body as ArrayBuffer | null, { status: spec.status, headers });
}

