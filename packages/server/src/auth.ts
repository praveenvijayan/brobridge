/**
 * Authentication: the one-time launch token, the session cookie, and the
 * failure limiter that sits in front of both.
 *
 * The header checks in `trust.ts` stop browsers. They do not stop a
 * non-browser client, which can send any header it likes
 * (`THREAT-MODEL.md` §5.5). What stops that client is this module: an
 * unguessable credential, compared in constant time, that no page and no
 * local script can obtain.
 *
 * @see THREAT-MODEL.md §7 "Authentication, precisely"
 */

/** The cookie the bridge mints and requires. */
export const SESSION_COOKIE_NAME = 'bb_session';

/**
 * The cookie attributes, exactly as `THREAT-MODEL.md` §7.1 specifies.
 *
 * `Secure` is deliberately absent: the bootstrap URL is `http://` on
 * loopback, and browsers do not universally set a `Secure` cookie over plain
 * `http://127.0.0.1`. The compensating control is that the value is a MAC,
 * worthless without the per-instance key.
 */
export const SESSION_COOKIE_ATTRIBUTES = 'HttpOnly; SameSite=Strict; Path=/';

/** The query parameter carrying the launch token. */
export const LAUNCH_TOKEN_PARAM = 'bt';

/** Why a credential was refused. Local diagnostics only — never sent. */
export type AuthFailure =
  | 'absent'
  | 'malformed'
  | 'mismatch'
  | 'expired'
  | 'spent'
  | 'unknown-session';

/** The result of presenting a credential. */
export type AuthOutcome =
  | { readonly ok: true; readonly sessionId: string }
  | { readonly ok: false; readonly reason: AuthFailure };

/** How the failure limiter answers. */
export interface RateVerdict {
  readonly limited: boolean;
  /** Seconds until the current window ends. For `Retry-After`. */
  readonly retryAfterSeconds: number;
}

/** Construction options for {@link AuthGuard}. */
export interface AuthGuardOptions {
  /** The bound authority. Mixed into the MAC so a cookie from another port is inert. */
  readonly authority: string;
  /** Validity window of the launch token. */
  readonly launchTokenTtlMs: number;
  /** How long a minted session cookie stays valid. */
  readonly sessionCookieTtlMs: number;
  /** Fixed rate-limit window for authentication failures. */
  readonly authFailureWindowMs: number;
  /** Failures allowed per window per remote address. */
  readonly authFailuresPerWindow: number;
  /** Injectable clock, for deterministic tests. */
  readonly now?: () => number;
}

/**
 * The Web Crypto key handle, named without importing a runtime's type
 * package: `CryptoKey` is not a global in every `lib` combination this
 * package compiles under, but the return of `importKey` always is.
 */
type SigningKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/** Bytes of CSPRNG output behind the launch token, the MAC key and a session id. */
const TOKEN_BYTES = 32;
const KEY_BYTES = 32;
const SESSION_ID_BYTES = 16;
const MAC_BYTES = 32;

/** Separator inside the MAC input; see {@link AuthGuard.cookieFor}. */
const NUL = '\u0000';

/**
 * Distinct remote addresses the limiter tracks.
 *
 * On a loopback bind there is exactly one, so this cap only matters in the
 * non-loopback opt-in — where it keeps the limiter itself from becoming the
 * memory-exhaustion vector it exists to prevent.
 */
const MAX_TRACKED_REMOTES = 4096;

interface FailureWindow {
  windowStart: number;
  failures: number;
}

/**
 * Everything the bridge knows about who may talk to it.
 *
 * One guard per server instance. Its key never leaves memory and is never
 * persisted, so every credential it ever minted dies with the process.
 */
export class AuthGuard {
  readonly #authority: string;
  readonly #launchTokenTtlMs: number;
  readonly #sessionCookieTtlMs: number;
  readonly #failureWindowMs: number;
  readonly #failuresPerWindow: number;
  readonly #now: () => number;
  readonly #key: SigningKey;
  readonly #sessions = new Map<string, number>();
  readonly #failures = new Map<string, FailureWindow>();

  #tokenBytes: Uint8Array | null;
  readonly #tokenIssuedAt: number;
  readonly #launchToken: string;

  private constructor(options: AuthGuardOptions, key: SigningKey, token: Uint8Array) {
    this.#authority = options.authority;
    this.#launchTokenTtlMs = options.launchTokenTtlMs;
    this.#sessionCookieTtlMs = options.sessionCookieTtlMs;
    this.#failureWindowMs = options.authFailureWindowMs;
    this.#failuresPerWindow = options.authFailuresPerWindow;
    this.#now = options.now ?? Date.now;
    this.#key = key;
    this.#tokenBytes = token;
    this.#launchToken = base64url(token);
    this.#tokenIssuedAt = this.#now();
  }

  /**
   * Mint a guard: 256 bits of MAC key and 256 bits of launch token, both from
   * the Web Crypto CSPRNG.
   */
  static async create(options: AuthGuardOptions): Promise<AuthGuard> {
    const keyMaterial = randomBytes(KEY_BYTES);
    const key = await crypto.subtle.importKey(
      'raw',
      keyMaterial,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    keyMaterial.fill(0);
    return new AuthGuard(options, key, randomBytes(TOKEN_BYTES));
  }

  /** The launch token, for the `?bt=` bootstrap URL. Never log this. */
  get launchToken(): string {
    return this.#launchToken;
  }

  /** True once the token has been burnt by a valid presentation. */
  get tokenSpent(): boolean {
    return this.#tokenBytes === null;
  }

  /** Sessions this guard currently recognises. */
  get sessions(): readonly string[] {
    this.#pruneSessions();
    return [...this.#sessions.keys()];
  }

  /**
   * Present the launch token.
   *
   * A valid presentation burns the token atomically and mints a session, so
   * the copy left in browser history, in shell scrollback or in a `Referer`
   * is already spent (`THREAT-MODEL.md` §5.6). Comparison is constant time
   * over fixed-length inputs, and a wrong length still pays for a full
   * comparison so length is not an oracle.
   */
  redeemToken(presented: string | undefined): AuthOutcome {
    if (presented === undefined || presented === '') return fail('absent');
    const expected = this.#tokenBytes;
    if (expected === null) {
      // Still compare, against a decoy, so a spent token and a wrong token
      // cost the same.
      timingSafeEqual(decodeFixed(presented, TOKEN_BYTES), new Uint8Array(TOKEN_BYTES));
      return fail('spent');
    }
    const offered = decodeFixed(presented, TOKEN_BYTES);
    const matches = timingSafeEqual(offered, expected);
    if (!matches) return fail('mismatch');
    if (this.#now() - this.#tokenIssuedAt > this.#launchTokenTtlMs) {
      this.#tokenBytes = null;
      expected.fill(0);
      return fail('expired');
    }
    expected.fill(0);
    this.#tokenBytes = null;
    return { ok: true, sessionId: this.#mintSession() };
  }

  /**
   * Verify a `Cookie` header.
   *
   * Any failure — absent, malformed, wrong MAC, expired, unknown session — is
   * the same answer to the caller, which turns it into the same status and the
   * same body (`THREAT-MODEL.md` §9 invariant 10). The `reason` exists for
   * tests and local diagnostics and never reaches the wire.
   */
  async verifyCookie(cookieHeader: string | undefined): Promise<AuthOutcome> {
    const value = readCookie(cookieHeader, SESSION_COOKIE_NAME);
    if (value === undefined) return fail('absent');

    const parts = value.split('.');
    if (parts.length !== 3) return fail('malformed');
    const [sessionId, issuedAtText, macText] = parts as [string, string, string];
    if (sessionId.length === 0 || sessionId.length > 128) return fail('malformed');
    if (!/^\d{1,15}$/.test(issuedAtText)) return fail('malformed');
    const issuedAt = Number(issuedAtText);

    // The MAC is recomputed over the server's OWN authority, never a presented
    // one: that is what makes a cookie planted by a bridge on another loopback
    // port inert here (`THREAT-MODEL.md` §5.8).
    const expected = await this.#sign(sessionId, issuedAt);
    const offered = decodeFixed(macText, MAC_BYTES);
    if (!timingSafeEqual(offered, expected)) return fail('mismatch');

    if (this.#now() - issuedAt > this.#sessionCookieTtlMs) return fail('expired');
    if (!this.#sessions.has(sessionId)) return fail('unknown-session');
    return { ok: true, sessionId };
  }

  /**
   * The `Set-Cookie` value for `sessionId`.
   *
   * The MAC covers `sessionId`, the bound authority and `issuedAt`, separated
   * by NUL so no other cut of the same bytes produces the same input.
   */
  async cookieFor(sessionId: string): Promise<string> {
    const issuedAt = this.#sessions.get(sessionId) ?? this.#now();
    const mac = await this.#sign(sessionId, issuedAt);
    const value = `${sessionId}.${String(issuedAt)}.${base64url(mac)}`;
    return `${SESSION_COOKIE_NAME}=${value}; ${SESSION_COOKIE_ATTRIBUTES}`;
  }

  /** Whether `remote` has spent its failure budget for the current window. */
  checkRate(remote: string): RateVerdict {
    const window = this.#failures.get(remote);
    const now = this.#now();
    if (window === undefined) return { limited: false, retryAfterSeconds: 0 };
    const elapsed = now - window.windowStart;
    if (elapsed >= this.#failureWindowMs) {
      this.#failures.delete(remote);
      return { limited: false, retryAfterSeconds: 0 };
    }
    if (window.failures < this.#failuresPerWindow) return { limited: false, retryAfterSeconds: 0 };
    return {
      limited: true,
      retryAfterSeconds: Math.max(1, Math.ceil((this.#failureWindowMs - elapsed) / 1000)),
    };
  }

  /** Record one authentication failure against `remote`. */
  noteFailure(remote: string): void {
    const now = this.#now();
    const window = this.#failures.get(remote);
    if (window === undefined || now - window.windowStart >= this.#failureWindowMs) {
      if (this.#failures.size >= MAX_TRACKED_REMOTES) this.#pruneFailures(now);
      this.#failures.set(remote, { windowStart: now, failures: 1 });
      return;
    }
    window.failures += 1;
  }

  /** Forget a session, so its cookie stops verifying. */
  revoke(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  /** Drop every session, every limiter window and the launch token. */
  clear(): void {
    this.#sessions.clear();
    this.#failures.clear();
    this.#tokenBytes?.fill(0);
    this.#tokenBytes = null;
  }

  #mintSession(): string {
    const sessionId = base64url(randomBytes(SESSION_ID_BYTES));
    this.#sessions.set(sessionId, this.#now());
    return sessionId;
  }

  async #sign(sessionId: string, issuedAt: number): Promise<Uint8Array> {
    const message = new TextEncoder().encode(
      `${sessionId}${NUL}${this.#authority}${NUL}${String(issuedAt)}`,
    );
    const signature = await crypto.subtle.sign('HMAC', this.#key, message);
    return new Uint8Array(signature);
  }

  #pruneSessions(): void {
    const cutoff = this.#now() - this.#sessionCookieTtlMs;
    for (const [id, issuedAt] of this.#sessions) {
      if (issuedAt < cutoff) this.#sessions.delete(id);
    }
  }

  #pruneFailures(now: number): void {
    for (const [remote, window] of this.#failures) {
      if (now - window.windowStart >= this.#failureWindowMs) this.#failures.delete(remote);
    }
    if (this.#failures.size < MAX_TRACKED_REMOTES) return;
    // Still full: drop the oldest insertion, which Map iteration order gives
    // us for free.
    const oldest = this.#failures.keys().next();
    if (oldest.done !== true) this.#failures.delete(oldest.value);
  }
}

function fail(reason: AuthFailure): AuthOutcome {
  return { ok: false, reason };
}

/**
 * `n` bytes from the Web Crypto CSPRNG.
 *
 * The buffer type is spelled out because `BufferSource` under DOM typings
 * excludes a view over a `SharedArrayBuffer`, and an unparameterised
 * `Uint8Array` is exactly that union.
 */
function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** Base64url without padding. */
function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * Decode base64url to exactly `length` bytes.
 *
 * Anything that does not decode, decodes to the wrong length, or is not the
 * canonical spelling of its bytes yields a zero-filled buffer of the right
 * length rather than an early return: the caller then still runs a full
 * constant-time comparison, so malformed and wrong are one timing class.
 *
 * The canonical-spelling check closes base64 malleability: without it, a
 * final character that differs only in the bits padding discards decodes to
 * the same bytes, so more than one string presents as the same token.
 */
function decodeFixed(text: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return out;
  const padded = text.replaceAll('-', '+').replaceAll('_', '/');
  let binary: string;
  try {
    binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  } catch {
    return out;
  }
  if (binary.length !== length) return out;
  for (let i = 0; i < length; i += 1) out[i] = binary.charCodeAt(i) & 0xff;
  if (base64url(out) !== text) {
    out.fill(0);
    return out;
  }
  return out;
}

/**
 * Constant-time comparison of two buffers.
 *
 * No `===` on secret material anywhere on the auth path
 * (`THREAT-MODEL.md` §9 invariant 5). Callers pass fixed-length buffers, so
 * the loop count never depends on a secret.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** The value of one cookie in a `Cookie` header, or `undefined`. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() !== name) continue;
    return pair.slice(eq + 1).trim();
  }
  return undefined;
}
