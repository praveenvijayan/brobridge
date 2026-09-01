/**
 * The route table: exposed services and stream handlers.
 *
 * This is the raw call surface. It is deliberately thin — JSON arguments in,
 * JSON result out — because the typed surfaces belong to the adapters
 * (`@brobridgejs/adapters`), which sit on top of it. It must nonetheless work
 * standalone, so a host application can use the bridge without an RPC
 * framework at all.
 *
 * @see PROTOCOL.md §10 "Unary calls"
 */
import type { BridgeStream } from '@brobridgejs/core';
import { BridgeError, ErrorCode } from '@brobridgejs/core';

/** A method callable over the bridge. Arguments and result must be JSON-encodable. */
export type ServiceMethod = (...args: never[]) => unknown;

/** An object whose methods become callable as `"<name>.<method>"`. */
export type ServiceObject = Record<string, unknown>;

/** Context handed to a stream route. */
export interface StreamContext {
  /** Route parameters carried by `OPEN`. */
  readonly params: Readonly<Record<string, unknown>>;
  /** The authenticated session this stream belongs to. */
  readonly sessionId: string;
}

/**
 * A stream route.
 *
 * Write to `stream` to push, iterate it to read. Returning does not close the
 * stream — call `stream.end()` when the data is finished. A rejected promise
 * becomes a stream-level `ERROR`, and the connection survives it.
 */
export type StreamHandler = (stream: BridgeStream, context: StreamContext) => unknown;

/** The outcome of a unary invocation, before it is framed. */
export type UnaryOutcome =
  | { readonly ok: true; readonly payload: Uint8Array }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

const EMPTY = new Uint8Array(0);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Registered services and stream routes.
 *
 * One registry per bridge, shared by every session: a route is a property of
 * the host application, not of a connection.
 */
export class ServiceRegistry {
  readonly #services = new Map<string, ServiceObject>();
  readonly #streams = new Map<string, StreamHandler>();

  /**
   * Register a service. Its methods become callable as `"<name>.<method>"`.
   *
   * Only own, enumerable function properties are callable, and only those
   * that exist at registration time — a name resolved through the prototype
   * chain would expose `constructor`, `toString` and friends to a peer.
   */
  expose(name: string, service: ServiceObject): void {
    if (name.includes('.')) {
      throw new TypeError(`service name ${JSON.stringify(name)} must not contain "."`);
    }
    if (this.#services.has(name)) {
      throw new TypeError(`service ${JSON.stringify(name)} is already exposed`);
    }
    this.#services.set(name, service);
  }

  /** Register a stream route. */
  stream(name: string, handler: StreamHandler): void {
    if (this.#streams.has(name)) {
      throw new TypeError(`stream route ${JSON.stringify(name)} is already registered`);
    }
    this.#streams.set(name, handler);
  }

  /** Names currently routable, for diagnostics and tests. */
  get routes(): { readonly services: readonly string[]; readonly streams: readonly string[] } {
    return { services: [...this.#services.keys()], streams: [...this.#streams.keys()] };
  }

  /**
   * Dispatch a peer-opened stream. Wired to `BridgeEndpoint.onStream`.
   *
   * An unknown route throws {@link BridgeError} synchronously, which is how
   * core answers `OPEN` with `NOT_FOUND` before acknowledging it. A failure
   * *after* that point is a stream-level `ERROR` instead.
   */
  handleStream(stream: BridgeStream, sessionId: string): void {
    const handler = this.#streams.get(stream.name);
    if (handler !== undefined) {
      const context: StreamContext = { params: stream.params, sessionId };
      void run(() => handler(stream, context), stream);
      return;
    }
    if (!this.#resolves(stream.name)) {
      throw new BridgeError(ErrorCode.NOT_FOUND, `no route named ${JSON.stringify(stream.name)}`);
    }
    void run(async () => {
      const request = await stream.readAll();
      const outcome = await this.invoke(stream.name, request);
      if (!outcome.ok) {
        stream.error(outcome.code, outcome.message);
        return;
      }
      await stream.end(outcome.payload);
    }, stream);
  }

  /**
   * Invoke a unary route by name with a JSON-encoded argument array.
   *
   * Used by the stream path above and, unchanged, by the `POST /rpc`
   * fallback — one implementation, so the two surfaces cannot drift.
   */
  async invoke(route: string, request: Uint8Array): Promise<UnaryOutcome> {
    const target = this.#resolve(route);
    if (target === null) {
      return { ok: false, code: ErrorCode.NOT_FOUND, message: `no route named ${JSON.stringify(route)}` };
    }

    let args: unknown;
    try {
      args = request.length === 0 ? [] : JSON.parse(decoder.decode(request));
    } catch {
      return {
        ok: false,
        code: ErrorCode.PROTOCOL_VIOLATION,
        message: 'request payload is not JSON',
      };
    }
    if (!Array.isArray(args)) {
      return {
        ok: false,
        code: ErrorCode.PROTOCOL_VIOLATION,
        message: 'request payload must be a JSON array of arguments',
      };
    }

    try {
      const result: unknown = await Reflect.apply(target.method, target.service, args);
      return { ok: true, payload: result === undefined ? EMPTY : encoder.encode(JSON.stringify(result)) };
    } catch (cause) {
      // A `BridgeError` is the host application saying something the peer may
      // see. Anything else is reduced to `INTERNAL_ERROR`, because an
      // exception message can carry paths and internal state
      // (`THREAT-MODEL.md` §5.14).
      if (cause instanceof BridgeError) {
        return { ok: false, code: cause.code, message: cause.message };
      }
      return { ok: false, code: ErrorCode.INTERNAL_ERROR, message: 'internal error' };
    }
  }

  #resolves(route: string): boolean {
    return this.#resolve(route) !== null;
  }

  #resolve(route: string): { service: ServiceObject; method: ServiceMethod } | null {
    const cut = route.lastIndexOf('.');
    if (cut <= 0 || cut === route.length - 1) return null;
    const service = this.#services.get(route.slice(0, cut));
    if (service === undefined) return null;
    const methodName = route.slice(cut + 1);
    if (!Object.prototype.hasOwnProperty.call(service, methodName)) return null;
    const method = service[methodName];
    if (typeof method !== 'function') return null;
    return { service, method: method as ServiceMethod };
  }
}

/**
 * Run a route body, turning a rejection into a stream-level `ERROR`.
 *
 * Nothing a handler throws may reach the connection: one broken route must
 * not cost the peer its other streams.
 */
async function run(body: () => unknown, stream: BridgeStream): Promise<void> {
  try {
    await body();
  } catch (cause) {
    if (stream.state === 'closed' || stream.state === 'reaped') return;
    if (cause instanceof BridgeError) {
      stream.error(cause.code, cause.message);
      return;
    }
    stream.error(ErrorCode.INTERNAL_ERROR, 'internal error');
  }
}
