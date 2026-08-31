/**
 * The trust fence, one test per attack row in `THREAT-MODEL.md` §5.
 *
 * These run without a socket, which is the point of the fence being a pure
 * function: the table below is the security policy, readable in one screen.
 */
import { describe, expect, it } from 'vitest';

import { checkRequest } from '../src/trust.js';
import type { FenceCheck, FencePolicy, RawHeader } from '../src/trust.js';

const AUTHORITY = '127.0.0.1:7777';
const POLICY: FencePolicy = {
  authority: AUTHORITY,
  allowedOrigins: [`http://${AUTHORITY}`],
};

/** Headers a legitimate browser request carries. */
function browser(overrides: Readonly<Record<string, string | null>> = {}): RawHeader[] {
  const base: Record<string, string | null> = {
    Host: AUTHORITY,
    Origin: `http://${AUTHORITY}`,
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    ...overrides,
  };
  return Object.entries(base)
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([name, value]) => [name, value] as RawHeader);
}

interface Row {
  readonly name: string;
  readonly threat: string;
  readonly target?: string;
  readonly headers: RawHeader[];
  readonly upgrade?: boolean;
  readonly refusedBy: FenceCheck | null;
}

const ROWS: readonly Row[] = [
  {
    name: 'a legitimate same-origin request',
    threat: '—',
    headers: browser(),
    refusedBy: null,
  },
  {
    name: 'a non-browser client that omits Origin and Sec-Fetch-*',
    threat: '§5.5 — allowed here, stopped by the credential instead',
    headers: browser({ Origin: null, 'Sec-Fetch-Site': null, 'Sec-Fetch-Mode': null }),
    refusedBy: null,
  },

  // §5.1 DNS rebinding.
  {
    name: 'a rebound Host naming the attacker domain',
    threat: '§5.1 DNS rebinding',
    headers: browser({ Host: 'evil.test:7777', Origin: 'http://evil.test:7777' }),
    refusedBy: 'host-mismatch',
  },

  // §5.2 Host normalisation bypasses. Every one of these parses to the bound
  // address; every one is refused, because the fence compares and never
  // normalises.
  ...(
    [
      ['0x7f.0.0.1:7777', 'hexadecimal octet'],
      ['0177.0.0.1:7777', 'octal octet'],
      ['2130706433:7777', 'integer form'],
      ['127.0.0.1.:7777', 'trailing dot'],
      ['127.000.000.001:7777', 'zero-padded octets'],
      ['127.0.0.1:07777', 'zero-padded port'],
      ['[::ffff:127.0.0.1]:7777', 'IPv4-mapped IPv6'],
      ['localhost:7777', 'name for a bound address'],
      ['[::1]:7777', 'IPv6 loopback for a bound IPv4'],
      ['127.0.0.1', 'authority without the port'],
      ['127.0.0.1:7778', 'a neighbouring port'],
    ] as const
  ).map(
    ([host, why]): Row => ({
      name: `Host ${host} (${why})`,
      threat: '§5.2 Host normalisation bypass',
      headers: browser({ Host: host, Origin: null }),
      refusedBy: 'host-mismatch',
    }),
  ),
  {
    name: 'Host with embedded userinfo',
    threat: '§5.2',
    headers: browser({ Host: `user@${AUTHORITY}`, Origin: null }),
    refusedBy: 'host-userinfo',
  },
  {
    name: 'two Host headers that disagree',
    threat: '§5.2 duplicate Host',
    headers: [
      ['Host', AUTHORITY],
      ['Host', 'evil.test:7777'],
    ],
    refusedBy: 'host-count',
  },
  {
    name: 'two Host headers that agree',
    threat: '§5.2 duplicate Host',
    headers: [
      ['Host', AUTHORITY],
      ['Host', AUTHORITY],
    ],
    refusedBy: 'host-count',
  },
  {
    name: 'a Host value a runtime already joined',
    threat: '§5.2 duplicate Host through a collapsing runtime',
    headers: browser({ Host: `${AUTHORITY}, evil.test:7777`, Origin: null }),
    refusedBy: 'host-count',
  },
  {
    name: 'no Host header at all',
    threat: '§5.2',
    headers: [['Origin', `http://${AUTHORITY}`]],
    refusedBy: 'host-count',
  },
  {
    name: 'an absolute-form request line',
    threat: '§5.2 absolute-form request line',
    target: 'http://127.0.0.1:7777/rpc',
    headers: browser(),
    refusedBy: 'request-line',
  },
  {
    name: 'an authority-form request line',
    threat: '§5.2',
    target: '127.0.0.1:7777',
    headers: browser(),
    refusedBy: 'request-line',
  },

  // §5.3 CSRF from another site.
  {
    name: 'Sec-Fetch-Site: cross-site',
    threat: '§5.3 CSRF',
    headers: browser({ 'Sec-Fetch-Site': 'cross-site', Origin: 'http://evil.test' }),
    refusedBy: 'sec-fetch-site',
  },
  {
    name: 'Sec-Fetch-Site: same-site',
    threat: '§5.3 CSRF from a sibling origin',
    headers: browser({ 'Sec-Fetch-Site': 'same-site', Origin: null }),
    refusedBy: 'sec-fetch-site',
  },
  {
    name: 'Sec-Fetch-Site: none (a user-initiated navigation)',
    threat: '§5.3 — allowed',
    headers: browser({ 'Sec-Fetch-Site': 'none', Origin: null }),
    refusedBy: null,
  },
  {
    name: 'an evil Origin with the right Host',
    threat: '§5.3, §5.5',
    headers: browser({ Origin: 'http://evil.test', 'Sec-Fetch-Site': null }),
    refusedBy: 'origin',
  },
  {
    name: 'an opaque Origin',
    threat: '§5.3 sandboxed iframe',
    headers: browser({ Origin: 'null', 'Sec-Fetch-Site': null }),
    refusedBy: 'origin',
  },

  // §5.4 Cross-origin WebSocket: the same fence, on the upgrade.
  {
    name: 'a cross-site WebSocket upgrade',
    threat: '§5.4 cross-origin WebSocket',
    headers: browser({ 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'websocket' }),
    upgrade: true,
    refusedBy: 'sec-fetch-site',
  },
  {
    name: 'an upgrade from a browser that claims a non-websocket mode',
    threat: '§6 rule 7',
    headers: browser({ 'Sec-Fetch-Mode': 'cors' }),
    upgrade: true,
    refusedBy: 'sec-fetch-mode',
  },
  {
    name: 'a same-origin WebSocket upgrade',
    threat: '§5.4 — allowed',
    headers: browser({ 'Sec-Fetch-Mode': 'websocket' }),
    upgrade: true,
    refusedBy: null,
  },
  {
    name: 'a non-browser upgrade with no Sec-Fetch-* headers',
    threat: '§5.5 — allowed, credential still required',
    headers: browser({ 'Sec-Fetch-Site': null, 'Sec-Fetch-Mode': null, Origin: null }),
    upgrade: true,
    refusedBy: null,
  },
];

describe('the trust fence', () => {
  for (const row of ROWS) {
    const verdictName = row.refusedBy === null ? 'allows' : `refuses (${row.refusedBy})`;
    it(`${verdictName} ${row.name} [${row.threat}]`, () => {
      const verdict = checkRequest(
        {
          target: row.target ?? '/ws',
          rawHeaders: row.headers,
          ...(row.upgrade === true ? { upgrade: true } : {}),
        },
        POLICY,
      );
      if (row.refusedBy === null) {
        expect(verdict).toEqual({ ok: true });
        return;
      }
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.check).toBe(row.refusedBy);
    });
  }

  it('accepts localhost only when localhost is what was bound', () => {
    const policy: FencePolicy = {
      authority: 'localhost:7777',
      allowedOrigins: ['http://localhost:7777'],
    };
    expect(
      checkRequest({ target: '/', rawHeaders: [['Host', 'localhost:7777']] }, policy).ok,
    ).toBe(true);
    expect(
      checkRequest({ target: '/', rawHeaders: [['Host', '127.0.0.1:7777']] }, policy).ok,
    ).toBe(false);
  });

  it('honours a configured Origin allowlist', () => {
    const policy: FencePolicy = {
      authority: AUTHORITY,
      allowedOrigins: [`http://${AUTHORITY}`, 'http://localhost:5173'],
    };
    expect(
      checkRequest(
        { target: '/', rawHeaders: browser({ Origin: 'http://localhost:5173' }) },
        policy,
      ).ok,
    ).toBe(true);
    expect(
      checkRequest(
        { target: '/', rawHeaders: browser({ Origin: 'http://localhost:5174' }) },
        policy,
      ).ok,
    ).toBe(false);
  });

  it('never reveals which check failed beyond the verdict object', () => {
    const verdict = checkRequest(
      { target: '/', rawHeaders: browser({ Host: 'evil.test:7777' }) },
      POLICY,
    );
    expect(verdict.ok).toBe(false);
    // The refusal detail exists for tests and local diagnostics. What reaches
    // the wire is decided by the gateway, and is an empty 403 body.
    if (!verdict.ok) expect(typeof verdict.detail).toBe('string');
  });
});
