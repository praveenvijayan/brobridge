/**
 * Protocol sessions, and the wall between them.
 *
 * A reconnecting client names the session it wants to resume. That name is
 * not a credential: it is honoured only for the authenticated identity that
 * created it (`THREAT-MODEL.md` §9 invariant 8). The wall here is structural
 * — one core {@link SessionHost} per authenticated cookie session — so a
 * `RESUME` for another cookie's session cannot be routed to it even by a bug
 * in the routing code. It answers `SESSION_UNKNOWN`, indistinguishable from a
 * session that never existed.
 *
 * @see PROTOCOL.md §9.3 "Resume handshake"
 */
import type { BridgeEndpoint, BridgeStream, OpenStreamOptions } from '@brobridge/core';
import { ErrorCode, SessionHost } from '@brobridge/core';

import type { SocketCarrier } from './carrier.js';
import type { ResolvedOptions } from './options.js';
import type { ServiceRegistry } from './services.js';

/** A live protocol session, as the host application sees it. */
export interface BridgeSession {
  /** The protocol session identifier, as advertised in `HELLO_ACK`. */
  readonly id: string;
  /** The authenticated cookie session that owns it. */
  readonly authSessionId: string;
  /** The core endpoint, for adapters that need the full protocol surface. */
  readonly endpoint: BridgeEndpoint;
  /** Push a stream to this tab. */
  openStream(name: string, options?: OpenStreamOptions): BridgeStream;
  /** Make a unary call into this tab. */
  call(name: string, request: Uint8Array, options?: OpenStreamOptions): Promise<Uint8Array>;
}

/** What the manager needs from the bridge around it. */
export interface SessionManagerConfig {
  readonly options: ResolvedOptions;
  readonly registry: ServiceRegistry;
  /** Called once per protocol session, when its `HELLO` handshake completes. */
  readonly onSession: ((session: BridgeSession) => void) | undefined;
}

/** A connection the manager is keeping alive. */
interface LiveConnection {
  readonly carrier: SocketCarrier;
  readonly endpoint: BridgeEndpoint;
  heartbeat: ReturnType<typeof setInterval> | null;
}

/** Owns every session and every live socket for one bridge. */
export class SessionManager {
  readonly #config: SessionManagerConfig;
  readonly #hosts = new Map<string, SessionHost>();
  readonly #sessions = new Map<string, BridgeSession>();
  readonly #connections = new Set<LiveConnection>();
  #reaper: ReturnType<typeof setInterval> | null = null;
  #closed = false;

  constructor(config: SessionManagerConfig) {
    this.#config = config;
    const { sessionTtlMs } = config.options;
    this.#reaper = setInterval(() => {
      this.#reap();
    }, Math.max(1_000, Math.floor(sessionTtlMs / 2)));
    this.#reaper.unref?.();
  }

  /** Every protocol session currently alive. */
  get sessions(): readonly BridgeSession[] {
    return [...this.#sessions.values()];
  }

  /** Live connections, for tests that assert nothing leaked. */
  get connectionCount(): number {
    return this.#connections.size;
  }

  /**
   * Take a freshly authenticated socket.
   *
   * Authentication has already happened: `authSessionId` names the cookie
   * session that got past the gateway, and it selects which family of
   * protocol sessions this connection may resume.
   */
  async accept(carrier: SocketCarrier, authSessionId: string): Promise<BridgeEndpoint> {
    const host = this.#hostFor(authSessionId);
    const endpoint = await host.accept(carrier);
    const connection: LiveConnection = { carrier, endpoint, heartbeat: null };
    this.#connections.add(connection);
    carrier.addCloseListener(() => {
      this.#release(connection);
    });
    this.#startHeartbeat(connection);
    return endpoint;
  }

  /**
   * Graceful shutdown: tell each peer to stop opening streams, end what is
   * open, then close.
   *
   * Bounded by `closeTimeoutMs`, because a peer that never reads must not be
   * able to hold the host process open.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#reaper !== null) clearInterval(this.#reaper);
    this.#reaper = null;

    const connections = [...this.#connections];
    for (const connection of connections) {
      connection.endpoint.goaway(ErrorCode.SERVER_SHUTDOWN, 'server is shutting down');
    }

    const ending = connections.flatMap((connection) =>
      [...connection.endpoint.streams.values()].map(async (stream) => {
        try {
          await stream.end();
        } catch {
          // The stream was already failing; the close below covers it.
        }
      }),
    );
    await Promise.race([
      Promise.allSettled(ending),
      delay(this.#config.options.closeTimeoutMs),
    ]);

    for (const connection of connections) {
      connection.endpoint.close();
      connection.carrier.close();
      this.#release(connection);
    }
    for (const host of this.#hosts.values()) host.close();
    this.#hosts.clear();
    this.#sessions.clear();
  }

  #hostFor(authSessionId: string): SessionHost {
    const existing = this.#hosts.get(authSessionId);
    if (existing !== undefined) return existing;

    const { options, registry } = this.#config;
    const host = new SessionHost({
      maxFrameSize: options.maxFrameSize,
      maxStreams: options.maxStreams,
      initialCredit: options.initialCredit,
      resumeWindow: options.resumeWindow,
      heartbeatMs: options.heartbeatMs,
      onStream: (stream) => {
        registry.handleStream(stream, authSessionId);
      },
      onSession: (endpoint) => {
        this.#registerSession(endpoint, authSessionId);
      },
    });
    this.#hosts.set(authSessionId, host);
    return host;
  }

  #registerSession(endpoint: BridgeEndpoint, authSessionId: string): void {
    const id = endpoint.sessionId;
    if (id === null) return;
    const session: BridgeSession = {
      id,
      authSessionId,
      endpoint,
      openStream: (name, options) => endpoint.openStream(name, options),
      call: async (name, request, options) => endpoint.call(name, request, options),
    };
    this.#sessions.set(id, session);
    this.#config.onSession?.(session);
  }

  /**
   * `PING` on a timer, and treat silence as death (`PROTOCOL.md` §11).
   *
   * The timer is unref'd: a heartbeat is not a reason for the host process to
   * stay alive.
   */
  #startHeartbeat(connection: LiveConnection): void {
    const { heartbeatMs, heartbeatTimeoutMs } = this.#config.options;
    const timer = setInterval(() => {
      const settled = { done: false };
      connection.endpoint.ping().then(
        () => {
          settled.done = true;
        },
        () => {
          // A rejected ping means the endpoint is already gone; the close
          // handler has run or is about to.
          settled.done = true;
        },
      );
      const deadline = setTimeout(() => {
        if (settled.done) return;
        connection.carrier.close();
        this.#release(connection);
      }, heartbeatTimeoutMs);
      deadline.unref?.();
    }, heartbeatMs);
    timer.unref?.();
    connection.heartbeat = timer;
  }

  #release(connection: LiveConnection): void {
    if (connection.heartbeat !== null) clearInterval(connection.heartbeat);
    connection.heartbeat = null;
    this.#connections.delete(connection);
  }

  #reap(): void {
    const ttl = this.#config.options.sessionTtlMs;
    for (const host of this.#hosts.values()) {
      for (const id of host.reap(ttl)) this.#sessions.delete(id);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
