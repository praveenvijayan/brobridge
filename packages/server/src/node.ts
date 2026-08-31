/**
 * The Node backend: `node:http` plus `ws`.
 *
 * Node has no WebSocket *server* of its own (the global `WebSocket` is a
 * client), so `ws` is the one runtime dependency this package takes. It is
 * confined to this file: nothing else in the package imports it, and the Bun
 * backend never loads it.
 */
import type { IncomingMessage, Server } from 'node:http';
import { createServer } from 'node:http';
import type { Duplex } from 'node:stream';

import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';

import { SocketCarrier } from './carrier.js';
import type { SocketAdapter, WriteOutcome } from './carrier.js';
import { Gateway } from './gateway.js';
import type { GatewayResponse } from './gateway.js';
import { handleRpc } from './rpc.js';
import type { HostListener, RuntimeConfig } from './runtime.js';
import { bindCarrier, toBytes } from './runtime.js';
import type { RawHeader } from './trust.js';

/** Status text for the few statuses this backend writes by hand. */
const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  413: 'Payload Too Large',
  426: 'Upgrade Required',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/** Bind the Node listener. */
export async function startNodeServer(config: RuntimeConfig): Promise<HostListener> {
  const { options } = config;
  const server = createServer({
    maxHeaderSize: options.maxHeaderBytes,
    // Node sweeps for timed-out connections on an interval, and its default
    // sweep is 30 s — long enough that a 10 s `handshakeTimeoutMs` would not
    // actually be enforced for half a minute. Sweep in step with the deadline.
    connectionsCheckingInterval: Math.max(250, Math.floor(options.handshakeTimeoutMs / 4)),
  });

  // `THREAT-MODEL.md` §5.11: a client that dribbles headers, or connects and
  // says nothing, must lose its socket rather than hold one.
  server.headersTimeout = options.handshakeTimeoutMs;
  server.requestTimeout = options.handshakeTimeoutMs;

  const sockets = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    skipUTF8Validation: true,
    maxPayload: options.maxFrameSize,
  });

  server.on('request', (request, response) => {
    void (async () => {
      const gateway = config.gateway();
      if (gateway === null) {
        writeResponse(response, Gateway.refuse(503));
        return;
      }
      const decision = await gateway.handle({
        method: request.method ?? 'GET',
        target: request.url ?? '',
        rawHeaders: pairs(request.rawHeaders),
        remote: request.socket.remoteAddress ?? 'unknown',
        upgrade: false,
      });
      if (decision.kind === 'respond') {
        writeResponse(response, decision.response);
        return;
      }
      if (decision.kind === 'upgrade') {
        // A `/ws` request that reached the request handler is not an upgrade.
        writeResponse(response, Gateway.refuse(426, [['Upgrade', 'websocket']]));
        return;
      }
      const body = await readBody(request, options.maxRpcBodyBytes);
      if (body === null) {
        // Answer, then drop the socket: the rest of an oversized body is not
        // worth reading, and the peer still gets a status rather than a reset.
        writeResponse(response, Gateway.refuse(413));
        response.once('finish', () => {
          request.destroy();
        });
        return;
      }
      writeResponse(response, await handleRpc(body, config.registry, options.maxFrameSize));
    })();
  });

  server.on('upgrade', (request, socket, head) => {
    void (async () => {
      const gateway = config.gateway();
      if (gateway === null) {
        writeRaw(socket, Gateway.refuse(503));
        return;
      }
      const decision = await gateway.handle({
        method: request.method ?? 'GET',
        target: request.url ?? '',
        rawHeaders: pairs(request.rawHeaders),
        remote: request.socket.remoteAddress ?? 'unknown',
        upgrade: true,
      });
      if (decision.kind !== 'upgrade') {
        // The handshake is never completed for a refused upgrade: a completed
        // handshake is already an authenticated channel from the page's point
        // of view (`THREAT-MODEL.md` §5.4).
        writeRaw(socket, decision.kind === 'respond' ? decision.response : Gateway.refuse(403));
        return;
      }
      const authSessionId = decision.authSessionId;
      sockets.handleUpgrade(request, socket, head, (ws) => {
        void bindCarrier(
          config.manager,
          attach(ws, options.maxSocketBufferBytes),
          authSessionId,
          options.handshakeTimeoutMs,
        );
      });
    })();
  });

  // An authority-form request line (`CONNECT host:port`) carries an authority
  // the `Host` check would never see. There is nothing to answer.
  server.on('connect', (_request, socket) => {
    socket.destroy();
  });

  // A malformed request never reaches the fence, because there is nothing
  // well-formed enough to check.
  server.on('clientError', (_error, socket) => {
    writeRaw(socket as Duplex, Gateway.refuse(400));
  });

  await listen(server, options.host, options.port);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the Node listener did not report a TCP address');
  }

  return {
    host: address.address,
    port: address.port,
    close: async () => {
      for (const ws of sockets.clients) ws.terminate();
      sockets.close();
      // Drop the connections first: `server.close` only calls back once every
      // one of them is gone, so closing them afterwards would wait forever.
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

/** Wrap a `ws` socket as a carrier. */
function attach(ws: WebSocket, maxBufferedBytes: number): SocketCarrier {
  const adapter = new WsAdapter(ws);
  const carrier = new SocketCarrier(adapter, { maxBufferedBytes });
  adapter.bind(carrier);

  ws.binaryType = 'nodebuffer';
  ws.on('message', (data: unknown) => {
    carrier.deliver(toBytes(data));
  });
  ws.on('close', () => {
    carrier.notifyClose();
  });
  ws.on('error', () => {
    carrier.notifyClose();
  });
  return carrier;
}

/** The `ws` half of the socket pump. */
class WsAdapter implements SocketAdapter {
  readonly #ws: WebSocket;
  #carrier: SocketCarrier | null = null;

  constructor(ws: WebSocket) {
    this.#ws = ws;
  }

  bind(carrier: SocketCarrier): void {
    this.#carrier = carrier;
  }

  get buffered(): number {
    return this.#ws.bufferedAmount;
  }

  write(bytes: Uint8Array): WriteOutcome {
    if (this.#ws.readyState !== this.#ws.OPEN) return 'failed';
    this.#ws.send(bytes, { binary: true }, (error) => {
      // `ws` reports success as either no argument or `null`, depending on
      // which layer completed the write; only a real value is a failure.
      if (error !== undefined && error !== null) {
        this.#carrier?.notifyClose();
        return;
      }
      // The socket flushed: whatever the pump paused for is now gone.
      this.#carrier?.resume();
    });
    // `ws` accepts every write and buffers what the kernel would not take, so
    // congestion is visible through `bufferedAmount` rather than through a
    // return value. The pump reads it before each frame; the callback above is
    // what releases the pump once the socket has caught up.
    return 'ok';
  }

  close(code: number, reason: string): void {
    if (this.#ws.readyState === this.#ws.OPEN) this.#ws.close(code, reason);
    else this.#ws.terminate();
  }
}

/** Read a request body, refusing anything past `limit`. */
async function readBody(request: IncomingMessage, limit: number): Promise<Uint8Array | null> {
  const declared = request.headers['content-length'];
  if (declared !== undefined && Number(declared) > limit) {
    request.pause();
    return null;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = toBytes(chunk);
    total += bytes.length;
    if (total > limit) {
      request.pause();
      return null;
    }
    chunks.push(bytes);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function pairs(raw: readonly string[]): RawHeader[] {
  const out: RawHeader[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    out.push([raw[i] as string, raw[i + 1] as string]);
  }
  return out;
}

function writeResponse(
  response: import('node:http').ServerResponse,
  spec: GatewayResponse,
): void {
  if (response.headersSent) return;
  for (const [name, value] of spec.headers) response.setHeader(name, value);
  response.statusCode = spec.status;
  response.end(spec.body === null ? undefined : spec.body);
}

/** Write a response onto a raw socket, for the upgrade path. */
function writeRaw(socket: Duplex, spec: GatewayResponse): void {
  const text = STATUS_TEXT[spec.status] ?? 'Error';
  const head = [`HTTP/1.1 ${String(spec.status)} ${text}`];
  for (const [name, value] of spec.headers) head.push(`${name}: ${value}`);
  head.push('Connection: close', '', '');
  socket.write(head.join('\r\n'));
  if (spec.body !== null) socket.write(spec.body);
  socket.destroy();
}
