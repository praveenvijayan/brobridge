/**
 * What the two backends share.
 *
 * Node and Bun differ in how a socket is obtained and how bytes are written.
 * Everything that decides *whether* a request is allowed, and everything that
 * happens once a connection exists, lives outside them — here, in
 * `gateway.ts` and in `manager.ts` — so the two backends cannot drift apart
 * on anything that matters.
 */
import type { SocketCarrier } from './carrier.js';
import type { Gateway } from './gateway.js';
import type { SessionManager } from './manager.js';
import type { ResolvedOptions } from './options.js';
import type { ServiceRegistry } from './services.js';

/** A bound listener, whichever runtime produced it. */
export interface HostListener {
  /** The interface actually bound. */
  readonly host: string;
  /** The port actually bound, resolved when `port: 0` was requested. */
  readonly port: number;
  /** Stop accepting, and release the listener. */
  close(): Promise<void>;
}

/** What a backend needs to run. */
export interface RuntimeConfig {
  readonly options: ResolvedOptions;
  readonly manager: SessionManager;
  readonly registry: ServiceRegistry;
  /**
   * The armed gateway.
   *
   * `null` until the bound port is known, because the port is part of the
   * authority every check compares against. A request that arrives in that
   * window is refused with `503` — the listener opens closed.
   */
  gateway(): Gateway | null;
}

/** True when this process is Bun. */
export function isBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
}

/**
 * Bind a WebSocket carrier to a session, under the `HELLO` deadline.
 *
 * `PROTOCOL.md` §6.1 requires the first frame to be `HELLO` or `RESUME`;
 * `THREAT-MODEL.md` §5.11 requires that a peer which sends neither cannot
 * hold the socket forever.
 */
export async function bindCarrier(
  manager: SessionManager,
  carrier: SocketCarrier,
  authSessionId: string,
  handshakeTimeoutMs: number,
): Promise<void> {
  const deadline = setTimeout(() => {
    carrier.close();
  }, handshakeTimeoutMs);
  deadline.unref?.();
  try {
    await manager.accept(carrier, authSessionId);
  } catch {
    // A connection that never completed a handshake is simply gone; the
    // carrier's close handler has already released everything.
    carrier.close();
  } finally {
    clearTimeout(deadline);
  }
}

/** Reduce any of the shapes a runtime hands us to one `Uint8Array`. */
export function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    const parts = data.map((part) => toBytes(part));
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return new Uint8Array(0);
}
