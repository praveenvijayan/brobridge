/**
 * Server-side session routing.
 *
 * A reconnecting client sends `RESUME` as the first frame of a *new*
 * connection, so something has to read that frame before it can know which
 * session — which {@link BridgeEndpoint} — the connection belongs to.
 * {@link SessionHost} is that something: it peeks the first frame, then hands
 * the carrier to a fresh endpoint (`HELLO`) or to the one that already owns
 * the named session (`RESUME`).
 *
 * It holds no timers. Session expiry is a server-package policy
 * (`PROTOCOL.md` §13 `sessionTtlMs`), so this class only records when a
 * session went idle and offers {@link SessionHost.reap} for the host to call.
 *
 * @see PROTOCOL.md §9.3 "Resume handshake"
 */

import { FrameDecoder } from './codec.js';
import { ConnectionClosedError, ErrorCode, ProtocolError } from './errors.js';
import type { AttachOutcome, BridgeEndpointOptions } from './mux.js';
import { BridgeEndpoint, generateSessionId } from './mux.js';
import type { Carrier, Frame } from './types.js';
import { FrameType } from './types.js';

/** Options for {@link SessionHost}. */
export interface SessionHostOptions extends Omit<BridgeEndpointOptions, 'role' | 'sessionId'> {
  /** Mints session identifiers. Defaults to 128 bits of Web Crypto output. */
  readonly createSessionId?: () => string;
  /** Called once per session, when its first `HELLO` handshake completes. */
  readonly onSession?: (endpoint: BridgeEndpoint) => void;
  /** Injectable clock, for deterministic tests. Default `Date.now`. */
  readonly now?: () => number;
}

interface SessionRecord {
  readonly endpoint: BridgeEndpoint;
  /** When the last carrier for this session went away; `null` while connected. */
  detachedAt: number | null;
}

/**
 * A registry of live sessions and the front door for inbound connections.
 */
export class SessionHost {
  readonly #options: SessionHostOptions;
  readonly #now: () => number;
  readonly #createSessionId: () => string;
  readonly #sessions = new Map<string, SessionRecord>();

  constructor(options: SessionHostOptions = {}) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#createSessionId = options.createSessionId ?? generateSessionId;
  }

  /** Live sessions, by identifier. */
  get sessions(): ReadonlyMap<string, BridgeEndpoint> {
    const view = new Map<string, BridgeEndpoint>();
    for (const [id, record] of this.#sessions) view.set(id, record.endpoint);
    return view;
  }

  /** The endpoint owning `sessionId`, if it is still live. */
  get(sessionId: string): BridgeEndpoint | undefined {
    return this.#sessions.get(sessionId)?.endpoint;
  }

  /**
   * Take ownership of a freshly authenticated connection.
   *
   * The trust fence and cookie check happen before this call: a valid
   * `sessionId` is never a substitute for authentication (`PROTOCOL.md` §9.3).
   *
   * @returns The endpoint that took the carrier, once the first frame has
   *   identified it.
   */
  accept(carrier: Carrier): Promise<BridgeEndpoint> {
    return new Promise<BridgeEndpoint>((resolve, reject) => {
      const maxFrameSize = this.#options.maxFrameSize;
      const decoder = new FrameDecoder(maxFrameSize === undefined ? {} : { maxFrameSize });
      let settled = false;

      const finish = (endpoint: BridgeEndpoint, frames: readonly Frame[]): void => {
        settled = true;
        void endpoint.attach(carrier, { decoder, frames }).catch(() => undefined);
        resolve(endpoint);
      };

      carrier.onClose(() => {
        if (settled) return;
        settled = true;
        reject(new ConnectionClosedError(ErrorCode.INTERNAL_ERROR, 'carrier closed during handshake'));
      });

      carrier.onMessage((bytes) => {
        if (settled) return;
        const { frames, error } = decoder.push(bytes);
        if (error !== null) {
          settled = true;
          carrier.close?.();
          reject(error);
          return;
        }
        const first = frames[0];
        if (first === undefined) return;

        if (first.type === FrameType.HELLO) {
          finish(this.#createSession(), frames);
          return;
        }
        if (first.type === FrameType.RESUME) {
          const existing = this.#sessions.get(first.payload.sessionId);
          if (existing !== undefined) {
            existing.detachedAt = null;
            finish(existing.endpoint, frames);
            return;
          }
          // Unknown session. A fresh endpoint answers RESUME_FAIL and then
          // accepts the client's HELLO on the same connection (§6.1).
          finish(this.#createSession(), frames);
          return;
        }

        settled = true;
        carrier.close?.();
        reject(
          new ProtocolError(
            ErrorCode.PROTOCOL_VIOLATION,
            'the first frame on a connection must be HELLO or RESUME',
          ),
        );
      });
    });
  }

  /**
   * Discard sessions that have been without a carrier for longer than
   * `ttlMs`, releasing their streams and replay buffers.
   *
   * @returns The identifiers reaped.
   * @see PROTOCOL.md §9.5 "Reaping"
   */
  reap(ttlMs: number): readonly string[] {
    const deadline = this.#now() - ttlMs;
    const reaped: string[] = [];
    for (const [id, record] of [...this.#sessions]) {
      if (record.detachedAt !== null && record.detachedAt <= deadline) {
        record.endpoint.close(
          new ConnectionClosedError(ErrorCode.SESSION_EXPIRED, `session ${id} expired`),
        );
        this.#sessions.delete(id);
        reaped.push(id);
      }
    }
    return reaped;
  }

  /** Close every session and drop the registry. */
  close(): void {
    for (const [, record] of this.#sessions) {
      record.endpoint.close(
        new ConnectionClosedError(ErrorCode.SERVER_SHUTDOWN, 'session host closed'),
      );
    }
    this.#sessions.clear();
  }

  #createSession(): BridgeEndpoint {
    const sessionId = this.#createSessionId();
    const endpoint = new BridgeEndpoint({
      ...this.#options,
      role: 'server',
      sessionId,
      onHandshake: (outcome: AttachOutcome) => {
        if (outcome.kind === 'hello') this.#register(outcome.ack.sessionId, endpoint);
        this.#options.onHandshake?.(outcome);
      },
      onClose: (error) => {
        const record = this.#sessions.get(endpoint.sessionId ?? sessionId);
        if (record !== undefined) record.detachedAt = this.#now();
        this.#options.onClose?.(error);
      },
    });
    return endpoint;
  }

  #register(sessionId: string, endpoint: BridgeEndpoint): void {
    if (this.#sessions.has(sessionId)) return;
    this.#sessions.set(sessionId, { endpoint, detachedAt: null });
    this.#options.onSession?.(endpoint);
  }
}
