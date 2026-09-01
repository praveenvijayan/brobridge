/**
 * `connect()` and the bridge handle it returns.
 *
 * The client's whole job is to make a socket that dies look like a socket that
 * did not. `@brobridgejs/core` already owns the part that makes that possible:
 * the session — stream table, sequence cursors, credit — lives in a
 * `BridgeEndpoint` that outlives any one carrier. This module keeps that
 * endpoint fed: it opens sockets, hands them over, and when one dies it waits
 * out a backoff and hands over the next, at which point core sends `RESUME`
 * and the consumer's `for await` keeps yielding where it left off.
 *
 * The states an application can render are the honest ones: `connecting`,
 * `open`, `resuming`, `degraded`, `closed`. Nothing is hidden behind a
 * pretence that the connection is fine, and nothing is lost silently — a
 * resume the host cannot serve arrives at the consumer as a
 * `SnapshotRequiredError`, never as a gap.
 *
 * @see PROTOCOL.md §9 "Resume", §11 "Keepalive"
 */
import type { BridgeStream, OpenStreamOptions } from '@brobridgejs/core';
import { BridgeEndpoint, ConnectionClosedError, ResumeFailedError } from '@brobridgejs/core';

import { backoffDelay, delay } from './backoff.js';
import { BridgeClientError } from './errors.js';
import { callOverHttp } from './fallback.js';
import { resolveOptions } from './options.js';
import type { ProxyTarget, RemoteService } from './proxy.js';
import { makeProxy } from './proxy.js';
import type { SocketConnection } from './socket.js';
import { openSocket } from './socket.js';
import type {
  BridgeEvents,
  BridgeState,
  ConnectOptions,
  ResolvedConnectOptions,
  Unsubscribe,
} from './types.js';
import type { BridgeTarget } from './url.js';
import { parseTarget, probeUpgrade, redeemToken } from './url.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A connected bridge. */
export interface Bridge extends ProxyTarget {
  /** The bridge's origin. Never contains the launch token. */
  readonly url: string;
  /** What the connection is doing right now. */
  readonly state: BridgeState;
  /** The protocol session identifier, once a handshake has settled. */
  readonly sessionId: string | null;

  /**
   * Call an exposed method: `call("files.read", "/etc/hostname")`.
   *
   * Arguments and the result are JSON. A call made while the connection is
   * down waits for it to come back; a call already in flight when it drops
   * rejects, because the host may have run it and retrying is not this
   * layer's decision to make.
   */
  call<T = unknown>(route: string, ...args: readonly unknown[]): Promise<T>;

  /** Call with raw bytes, bypassing the JSON convention. */
  callBytes(route: string, request: Uint8Array): Promise<Uint8Array>;

  /** A typed view of one exposed service. Type-level only; see {@link makeProxy}. */
  makeProxy<T>(service: string): RemoteService<T>;

  /**
   * Open a stream.
   *
   * Iterating the result is what grants credit, so a consumer that reads
   * slowly slows the producer instead of filling a buffer — and stalls only
   * this stream.
   *
   * Rejects with a `streams-unavailable` {@link BridgeClientError} while the
   * connection is degraded to the HTTP fallback, which carries unary calls
   * only (`PROTOCOL.md` §10.1).
   */
  openStream(
    name: string,
    params?: Readonly<Record<string, unknown>>,
    options?: Omit<OpenStreamOptions, 'params'>,
  ): Promise<BridgeStream>;

  /** Round-trip time to the host, in milliseconds. */
  ping(): Promise<number>;

  /** Subscribe to `state` or `error`. Returns the unsubscribe function. */
  on<K extends keyof BridgeEvents>(
    event: K,
    listener: (value: BridgeEvents[K]) => void,
  ): Unsubscribe;

  /** Close the bridge. Stops reconnecting, fails live streams, resolves once done. */
  close(): Promise<void>;
}

/**
 * Connect to a bridge.
 *
 * `url` may be anything the page has: `location.href`, the URL the host
 * printed, or a bare origin. A `?bt=` launch token in it is redeemed exactly
 * once, on one request, and never retained (`THREAT-MODEL.md` §5.6).
 *
 * Resolves when the connection is usable: attached over WebSocket, or — with
 * `httpFallback` — degraded to `POST /rpc` after the WebSocket has failed
 * `wsAttemptsBeforeFallback` times. Rejects when the host refuses to
 * authenticate the connection, which no amount of retrying would fix.
 */
export async function connect(url: string, options: ConnectOptions = {}): Promise<Bridge> {
  const resolved = resolveOptions(options);
  const target = parseTarget(url);
  if (target.bootstrapUrl !== null) await redeemToken(target.bootstrapUrl, resolved.fetch);
  const client = new BridgeClient(target, resolved);
  await client.start();
  return client;
}

/** A promise plus the handles to settle it from elsewhere. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** How a call may travel right now. */
type Route = 'socket' | 'http';

class BridgeClient implements Bridge {
  readonly #target: BridgeTarget;
  readonly #options: ResolvedConnectOptions;
  readonly #endpoint: BridgeEndpoint;
  readonly #listeners = new Map<keyof BridgeEvents, Set<(value: never) => void>>();

  #state: BridgeState = 'connecting';
  #connection: SocketConnection | null = null;
  /** Resolved on the first usable state, rejected if the first attempt is terminal. */
  #started: Deferred<void> | null = null;
  /** Woken on every state change, so waiters re-evaluate. */
  #changed: Deferred<void> = deferred();
  /** Consecutive failed socket attempts. Reset by a successful handshake. */
  #failures = 0;
  #closed = false;
  /** Resolved when the bridge closes, so a backoff sleep can be cut short. */
  readonly #stopped: Deferred<void> = deferred();
  #loop: Promise<void> | null = null;
  /** Identifier for the next HTTP-fallback exchange. Client parity: odd. */
  #httpStreamId = 1;

  constructor(target: BridgeTarget, options: ResolvedConnectOptions) {
    this.#target = target;
    this.#options = options;
    this.#endpoint = new BridgeEndpoint({
      role: 'client',
      clientName: options.clientName,
      ...(options.maxFrameSize === undefined ? {} : { maxFrameSize: options.maxFrameSize }),
      ...(options.maxStreams === undefined ? {} : { maxStreams: options.maxStreams }),
      ...(options.initialCredit === undefined ? {} : { initialCredit: options.initialCredit }),
      ...(options.onStream === undefined ? {} : { onStream: options.onStream }),
      now: options.now,
    });
  }

  /* -------------------------------------------------------------------- */
  /*  Lifecycle                                                            */
  /* -------------------------------------------------------------------- */

  /** Start the connect loop and wait for the first usable state. */
  start(): Promise<void> {
    const started = deferred<void>();
    this.#started = started;
    this.#loop = this.#run();
    return started.promise;
  }

  /**
   * Own the connection for as long as the bridge lives.
   *
   * One iteration is one socket: open it, hand it to core, live on it until it
   * dies, then wait out a backoff. Every exit from the loop is a decision
   * already made — closed by the application, refused by the host, or a drop
   * with reconnect switched off.
   */
  async #run(): Promise<void> {
    let attempt = 0;
    while (!this.#closed) {
      // `degraded` outranks the attempt states: once unary calls are riding
      // the HTTP fallback, the service level is what an application renders,
      // and flapping to `connecting` every backoff would say the opposite of
      // what is true. The socket is still being retried underneath.
      if (this.#state !== 'degraded') {
        this.#setState(this.#endpoint.sessionId === null ? 'connecting' : 'resuming');
      }
      try {
        const connection = await openSocket(this.#target.wsUrl, {
          socket: this.#options.socket,
          connectTimeoutMs: this.#options.connectTimeoutMs,
          heartbeatTimeoutMs: this.#options.heartbeatTimeoutMs,
          abort: this.#stopped.promise,
        });
        this.#connection = connection;
        await this.#handshake(connection);
        this.#failures = 0;
        attempt = 0;
        this.#setState('open');
        this.#started?.resolve();
        this.#started = null;

        await connection.closed;
        this.#connection = null;
        if (this.#closed) break;
        this.#emit('error', new ConnectionClosedError(undefined, 'the connection dropped'));
        if (!this.#options.reconnect) {
          this.#shutdown(new BridgeClientError('closed', 'the connection dropped'));
          break;
        }
      } catch (cause) {
        this.#connection?.close();
        this.#connection = null;
        if (this.#closed) break;

        const terminal = await this.#terminalFault(cause);
        if (terminal !== null) {
          this.#shutdown(terminal);
          break;
        }

        this.#failures += 1;
        this.#emit('error', asError(cause));
        if (this.#canDegrade()) {
          this.#setState('degraded');
          this.#started?.resolve();
          this.#started = null;
        } else if (!this.#options.reconnect) {
          this.#shutdown(asError(cause));
          break;
        } else if (
          // A bridge that has never been up must fail rather than retry
          // forever: `connect()` is still unresolved, and an application
          // cannot render a connection that may never exist.
          this.#started !== null &&
          this.#failures >= this.#options.wsAttemptsBeforeFallback
        ) {
          this.#shutdown(asError(cause));
          break;
        }
        attempt += 1;
      }
      if (this.#closed) break;
      // The stop signal cuts the sleep short: a bridge asked to shut down must
      // not sit out the rest of a ten-second backoff first.
      await delay(
        backoffDelay(
          attempt,
          this.#options.reconnectMinMs,
          this.#options.reconnectMaxMs,
          this.#options.random,
        ),
        this.#stopped.promise,
      );
    }
  }

  /**
   * Run the protocol handshake on a fresh socket.
   *
   * A `RESUME` the host cannot serve is not fatal to the connection: it means
   * this session is gone, so the client starts a new one on the same socket
   * (`PROTOCOL.md` §6.1). Streams from the old session are already failed by
   * core — with `SnapshotRequiredError` where the cursor merely aged out — so
   * the application learns about the gap instead of inheriting one.
   */
  async #handshake(connection: SocketConnection): Promise<void> {
    try {
      await this.#endpoint.attach(connection.carrier);
    } catch (cause) {
      if (cause instanceof ResumeFailedError) {
        this.#emit('error', cause);
        await this.#endpoint.renegotiate();
        return;
      }
      throw cause;
    }
  }

  /**
   * Decide whether a failed attempt is worth retrying.
   *
   * `PROTOCOL.md` §11.1: an authentication failure on the upgrade is terminal
   * and must be surfaced, never retried in a loop. A browser cannot read the
   * refusal's status, so the reason is confirmed with an HTTP probe of the
   * same route; anything less than a definite refusal is treated as transient.
   *
   * Only a refused *upgrade* is worth probing. An environment that would not
   * build a socket at all never reached the host, so there is nothing to ask
   * it about.
   */
  async #terminalFault(cause: unknown): Promise<Error | null> {
    if (cause instanceof BridgeClientError && cause.reason === 'unauthorized') {
      const verdict = await probeUpgrade(this.#target.origin, this.#options.fetch);
      if (verdict === 'unauthorized') {
        return new BridgeClientError(
          'unauthorized',
          'the host refused this connection; the session cookie is missing or expired',
        );
      }
    }
    return null;
  }

  /** True when the HTTP fallback should take over unary calls. */
  #canDegrade(): boolean {
    return this.#options.httpFallback && this.#failures >= this.#options.wsAttemptsBeforeFallback;
  }

  /** Terminal shutdown: no more attempts, everything in flight fails. */
  #shutdown(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#endpoint.close(
      error instanceof ConnectionClosedError
        ? error
        : new ConnectionClosedError(undefined, error.message),
    );
    this.#connection?.close();
    this.#connection = null;
    this.#setState('closed');
    this.#stopped.resolve();
    const started = this.#started;
    this.#started = null;
    started?.reject(error);
    if (started === null) this.#emit('error', error);
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#endpoint.close();
      this.#connection?.close();
      this.#connection = null;
      this.#setState('closed');
      this.#stopped.resolve();
      this.#started?.reject(new BridgeClientError('closed', 'the bridge was closed'));
      this.#started = null;
    }
    await this.#loop;
  }

  /* -------------------------------------------------------------------- */
  /*  State and events                                                     */
  /* -------------------------------------------------------------------- */

  get url(): string {
    return this.#target.origin;
  }

  get state(): BridgeState {
    return this.#state;
  }

  get sessionId(): string | null {
    return this.#endpoint.sessionId;
  }

  on<K extends keyof BridgeEvents>(
    event: K,
    listener: (value: BridgeEvents[K]) => void,
  ): Unsubscribe {
    let set = this.#listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    const listeners = set;
    listeners.add(listener as (value: never) => void);
    return () => {
      listeners.delete(listener as (value: never) => void);
    };
  }

  #setState(state: BridgeState): void {
    if (this.#state === state) return;
    this.#state = state;
    const changed = this.#changed;
    this.#changed = deferred();
    changed.resolve();
    this.#emit('state', state);
  }

  /**
   * Deliver an event.
   *
   * A listener that throws must not take the connection down with it: the
   * loop that emits `state` is the same loop that owns the socket.
   */
  #emit<K extends keyof BridgeEvents>(event: K, value: BridgeEvents[K]): void {
    const listeners = this.#listeners.get(event);
    if (listeners === undefined) return;
    for (const listener of [...listeners]) {
      try {
        (listener as (value: BridgeEvents[K]) => void)(value);
      } catch {
        /* a listener's fault is the listener's problem */
      }
    }
  }

  /* -------------------------------------------------------------------- */
  /*  Calls and streams                                                    */
  /* -------------------------------------------------------------------- */

  async call<T = unknown>(route: string, ...args: readonly unknown[]): Promise<T> {
    const payload = await this.callBytes(route, encoder.encode(JSON.stringify(args)));
    return (payload.length === 0 ? undefined : JSON.parse(decoder.decode(payload))) as T;
  }

  async callBytes(route: string, request: Uint8Array): Promise<Uint8Array> {
    const via = await this.#wait('call');
    if (via === 'http') {
      const streamId = this.#nextHttpStreamId();
      return callOverHttp(this.#target.rpcUrl, route, request, {
        fetch: this.#options.fetch,
        maxFrameSize: this.#endpoint.maxDataPayload,
        streamId,
      });
    }
    return this.#endpoint.call(route, request);
  }

  makeProxy<T>(service: string): RemoteService<T> {
    return makeProxy<T>(this, service);
  }

  async openStream(
    name: string,
    params?: Readonly<Record<string, unknown>>,
    options?: Omit<OpenStreamOptions, 'params'>,
  ): Promise<BridgeStream> {
    await this.#wait('stream');
    return this.#endpoint.openStream(name, {
      ...options,
      ...(params === undefined ? {} : { params }),
    });
  }

  async ping(): Promise<number> {
    await this.#wait('stream');
    return this.#endpoint.ping();
  }

  /**
   * Wait until the bridge can carry this kind of work, and say how.
   *
   * Waiting rather than failing is what makes a reconnect invisible to a
   * caller: a call issued while the socket is down goes out when it is back.
   * The endpoint's own state is checked too, because a socket that died
   * between the check and the send would otherwise have its `OPEN` dropped
   * silently — core does not replay unsequenced frames (`PROTOCOL.md` §9.4).
   */
  async #wait(kind: 'call' | 'stream'): Promise<Route> {
    for (;;) {
      if (this.#closed) {
        throw new BridgeClientError('closed', 'the bridge is closed');
      }
      if (this.#state === 'open' && this.#endpoint.state === 'open') return 'socket';
      if (this.#state === 'degraded') {
        if (kind === 'call') return 'http';
        throw new BridgeClientError(
          'streams-unavailable',
          'the connection is degraded to the POST /rpc fallback, which carries unary calls only',
        );
      }
      await this.#changed.promise;
    }
  }

  /**
   * The next identifier for a fallback exchange.
   *
   * Client-initiated identifiers are odd (`PROTOCOL.md` §4.1). Nothing on the
   * host correlates these across requests — each `POST /rpc` is its own
   * exchange — but keeping the parity right means the host's decoder and route
   * table need no special case for the fallback.
   */
  #nextHttpStreamId(): number {
    const id = this.#httpStreamId;
    this.#httpStreamId = id >= 0xffff_fffd ? 1 : id + 2;
    return id;
  }
}

/** Present an unknown throwable as an `Error`, without inventing a stack. */
function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
