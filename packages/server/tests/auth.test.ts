/**
 * Authentication: the token, the cookie, the limiter.
 *
 * `THREAT-MODEL.md` §5.6, §5.7 and §5.8 are the specification these tests
 * enforce, plus invariant 10 — the refusal reason must never depend on
 * *which* way a credential was wrong in a way the wire can see.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  AuthGuard,
  SESSION_COOKIE_ATTRIBUTES,
  SESSION_COOKIE_NAME,
  readCookie,
  timingSafeEqual,
} from '../src/auth.js';

const BASE = {
  authority: '127.0.0.1:7777',
  launchTokenTtlMs: 120_000,
  sessionCookieTtlMs: 60_000,
  authFailureWindowMs: 60_000,
  authFailuresPerWindow: 3,
};

/** A guard with a clock the test drives. */
async function guardAt(clock: { now: number }, overrides: Partial<typeof BASE> = {}) {
  return AuthGuard.create({ ...BASE, ...overrides, now: () => clock.now });
}

function cookieHeader(setCookie: string): string {
  return setCookie.split(';')[0] as string;
}

describe('the launch token', () => {
  it('works exactly once', async () => {
    const clock = { now: 1_000 };
    const guard = await guardAt(clock);

    const first = guard.redeemToken(guard.launchToken);
    expect(first.ok).toBe(true);

    const second = guard.redeemToken(guard.launchToken);
    expect(second).toEqual({ ok: false, reason: 'spent' });
    expect(guard.tokenSpent).toBe(true);
  });

  it('refuses a wrong token, an absent token and a malformed one', async () => {
    const clock = { now: 1_000 };
    const guard = await guardAt(clock);

    expect(guard.redeemToken(undefined)).toEqual({ ok: false, reason: 'absent' });
    expect(guard.redeemToken('')).toEqual({ ok: false, reason: 'absent' });
    expect(guard.redeemToken('not-a-token').ok).toBe(false);
    expect(guard.redeemToken('%%%%').ok).toBe(false);
    // A near miss is still a miss.
    const flipped = `${guard.launchToken.slice(0, -1)}${guard.launchToken.endsWith('A') ? 'B' : 'A'}`;
    expect(guard.redeemToken(flipped).ok).toBe(false);
    // None of that burnt it.
    expect(guard.redeemToken(guard.launchToken).ok).toBe(true);
  });

  it('expires after launchTokenTtlMs even if unused', async () => {
    const clock = { now: 1_000 };
    const guard = await guardAt(clock, { launchTokenTtlMs: 5_000 });
    clock.now += 5_001;
    expect(guard.redeemToken(guard.launchToken)).toEqual({ ok: false, reason: 'expired' });
    // And it is burnt, so a later clock skew cannot revive it.
    expect(guard.tokenSpent).toBe(true);
  });

  it('is at least 128 bits of CSPRNG output', async () => {
    const clock = { now: 0 };
    const seen = new Set<string>();
    for (let i = 0; i < 16; i += 1) {
      const guard = await guardAt(clock);
      expect(guard.launchToken.length).toBeGreaterThanOrEqual(22);
      seen.add(guard.launchToken);
    }
    expect(seen.size).toBe(16);
  });
});

describe('the session cookie', () => {
  it('has exactly the attributes the threat model specifies', async () => {
    const clock = { now: 1_000 };
    const guard = await guardAt(clock);
    const redeemed = guard.redeemToken(guard.launchToken);
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) return;

    const setCookie = await guard.cookieFor(redeemed.sessionId);
    expect(setCookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
    expect(setCookie.endsWith(`; ${SESSION_COOKIE_ATTRIBUTES}`)).toBe(true);
    expect(SESSION_COOKIE_ATTRIBUTES).toBe('HttpOnly; SameSite=Strict; Path=/');
    // Deliberately not `Secure`: the bootstrap URL is plain http on loopback.
    expect(setCookie).not.toContain('Secure');
  });

  it('verifies the cookie it minted', async () => {
    const clock = { now: 1_000 };
    const guard = await guardAt(clock);
    const redeemed = guard.redeemToken(guard.launchToken);
    if (!redeemed.ok) throw new Error('token should have redeemed');
    const cookie = cookieHeader(await guard.cookieFor(redeemed.sessionId));

    await expect(guard.verifyCookie(cookie)).resolves.toEqual({
      ok: true,
      sessionId: redeemed.sessionId,
    });
  });

  it('refuses a tampered MAC, a tampered session id and a tampered timestamp', async () => {
    const clock = { now: 1_000 };
    const guard = await guardAt(clock);
    const redeemed = guard.redeemToken(guard.launchToken);
    if (!redeemed.ok) throw new Error('token should have redeemed');
    const cookie = cookieHeader(await guard.cookieFor(redeemed.sessionId));
    const [id, issuedAt, mac] = (readCookie(cookie, SESSION_COOKIE_NAME) as string).split('.') as [
      string,
      string,
      string,
    ];

    // Flip a leading character: base64url without padding carries slack in
    // its final character, so the last one need not change the decoded bytes.
    const swap = (text: string): string =>
      `${text.startsWith('A') ? 'B' : 'A'}${text.slice(1)}`;

    for (const forged of [
      `${SESSION_COOKIE_NAME}=${id}.${issuedAt}.${swap(mac)}`,
      `${SESSION_COOKIE_NAME}=${swap(id)}.${issuedAt}.${mac}`,
      `${SESSION_COOKIE_NAME}=${id}.${String(Number(issuedAt) + 1)}.${mac}`,
      `${SESSION_COOKIE_NAME}=${id}.${issuedAt}`,
      `${SESSION_COOKIE_NAME}=${id}.${issuedAt}.${mac}.extra`,
      `${SESSION_COOKIE_NAME}=`,
      `${SESSION_COOKIE_NAME}=....`,
    ]) {
      const outcome = await guard.verifyCookie(forged);
      expect(outcome.ok, forged).toBe(false);
    }
  });

  it('refuses a cookie minted by a bridge on another port', async () => {
    const clock = { now: 1_000 };
    // Same key material is impossible to share, so the sharper test is: same
    // guard construction, different authority — the MAC input differs even
    // when everything else matches.
    const here = await guardAt(clock, { authority: '127.0.0.1:7777' });
    const there = await guardAt(clock, { authority: '127.0.0.1:7778' });

    const redeemed = there.redeemToken(there.launchToken);
    if (!redeemed.ok) throw new Error('token should have redeemed');
    const foreign = cookieHeader(await there.cookieFor(redeemed.sessionId));

    await expect(here.verifyCookie(foreign)).resolves.toEqual({ ok: false, reason: 'mismatch' });
  });

  it('refuses a cookie whose session was revoked, and one that aged out', async () => {
    const clock = { now: 1_000 };
    const guard = await guardAt(clock, { sessionCookieTtlMs: 10_000 });
    const redeemed = guard.redeemToken(guard.launchToken);
    if (!redeemed.ok) throw new Error('token should have redeemed');
    const cookie = cookieHeader(await guard.cookieFor(redeemed.sessionId));

    clock.now += 10_001;
    await expect(guard.verifyCookie(cookie)).resolves.toEqual({ ok: false, reason: 'expired' });

    clock.now = 1_000;
    guard.revoke(redeemed.sessionId);
    await expect(guard.verifyCookie(cookie)).resolves.toEqual({
      ok: false,
      reason: 'unknown-session',
    });
  });

  it('ignores other cookies in the jar', async () => {
    const clock = { now: 1_000 };
    const guard = await guardAt(clock);
    const redeemed = guard.redeemToken(guard.launchToken);
    if (!redeemed.ok) throw new Error('token should have redeemed');
    const cookie = cookieHeader(await guard.cookieFor(redeemed.sessionId));

    // The loopback jar is shared with every other local service (§5.8).
    const jar = `theme=dark; ${cookie}; other_app_session=whatever`;
    await expect(guard.verifyCookie(jar)).resolves.toEqual({
      ok: true,
      sessionId: redeemed.sessionId,
    });
  });
});

describe('the failure limiter', () => {
  it('limits after the configured number of failures, then recovers', async () => {
    const clock = { now: 1_000 };
    const guard = await guardAt(clock, { authFailuresPerWindow: 3, authFailureWindowMs: 60_000 });

    for (let i = 0; i < 3; i += 1) {
      expect(guard.checkRate('127.0.0.1').limited).toBe(false);
      guard.noteFailure('127.0.0.1');
    }
    const verdict = guard.checkRate('127.0.0.1');
    expect(verdict.limited).toBe(true);
    expect(verdict.retryAfterSeconds).toBeGreaterThan(0);

    // Another address is unaffected.
    expect(guard.checkRate('127.0.0.2').limited).toBe(false);

    clock.now += 60_000;
    expect(guard.checkRate('127.0.0.1').limited).toBe(false);
  });
});

describe('constant-time comparison', () => {
  it('is used instead of === on secret material', () => {
    // Invariant 5. The check is structural: no `===` or `!==` against the
    // things this module holds secret.
    const source = readFileSync(fileURLToPath(new URL('../src/auth.ts', import.meta.url)), 'utf8');
    for (const [line, index] of source.split('\n').map((l, i) => [l, i] as const)) {
      // A null check is not a comparison of secret material.
      if (!/[=!]==/.test(line) || /[=!]==\s*null/.test(line)) continue;
      expect(
        /#tokenBytes\s*[=!]==|expected\s*[=!]==|offered\s*[=!]==|\bmac\w*\s*[=!]==/.test(line),
        `line ${String(index + 1)}: ${line.trim()}`,
      ).toBe(false);
    }
  });

  it('reports equality only for identical buffers', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });
});
