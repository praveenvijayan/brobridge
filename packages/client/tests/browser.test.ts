/**
 * The demo, in a real browser.
 *
 * Everything else in this suite drives the client from Node with a socket
 * factory supplying the headers a browser supplies on its own. This test
 * removes that helper entirely: Chromium loads the page the host serves,
 * redeems the launch token by navigating to it, and runs the client with the
 * platform's own `WebSocket`, `fetch` and cookie jar.
 *
 * It skips — loudly, in the test name — when no browser is installed, because
 * a missing Chromium is a machine fact, not a defect in the client. The rest
 * of the suite still covers every behaviour asserted here except the one this
 * test exists for: that the code path a browser takes is the one that works.
 */
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../..', import.meta.url));

/** The demo host, started exactly the way its documentation says to. */
let demo: ChildProcessWithoutNullStreams | null = null;
let demoUrl = '';
let ready = false;
let skipReason = '';

/**
 * The demo is TypeScript and its documented command is Node's type stripping,
 * which arrives in Node 22.6. On Node 20 — the declared `engines` floor, and a
 * cell in the CI matrix — there is nothing to spawn, so say that instead of
 * waiting out the start-up timeout on a process that exited immediately.
 */
function typeStrippingAvailable(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 6);
}

beforeAll(async () => {
  if (!typeStrippingAvailable()) {
    skipReason =
      `Node ${process.versions.node} cannot run scripts/demo.ts: ` +
      '--experimental-strip-types needs Node >= 22.6';
    return;
  }

  try {
    const { chromium } = await import('playwright');
    const probe = await chromium.launch();
    await probe.close();
  } catch (cause) {
    skipReason = `no Chromium available: ${String(cause).split('\n')[0] ?? 'unknown'}`;
    return;
  }

  demo = spawn('node', ['--experimental-strip-types', 'scripts/demo.ts'], { cwd: root });
  demoUrl = await new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('the demo did not print a URL')), 30_000);
    demo?.stdout.on('data', (chunk: Buffer) => {
      const match = /open (\S+)/.exec(chunk.toString());
      if (match?.[1] !== undefined) {
        clearTimeout(deadline);
        resolve(match[1]);
      }
    });
    demo?.on('error', reject);
  });
  ready = true;
}, 60_000);

afterAll(() => {
  demo?.kill();
});

describe('the demo page in Chromium', () => {
  it('calls, streams, and resumes across a socket the page kills', async ({ skip }) => {
    if (!ready) {
      skip(skipReason);
      return;
    }

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      // Navigating the token-bearing URL is the whole bootstrap: the host
      // burns the token, sets the cookie, and redirects to a URL without it.
      await page.goto(demoUrl);
      expect(page.url()).not.toContain('bt=');

      await page.waitForFunction(
        () => document.querySelector('#echo')?.textContent?.includes('echoed by the host') === true,
        undefined,
        { timeout: 15_000 },
      );
      expect(await page.textContent('#state')).toBe('open');

      // Let the ticker run, then cut the socket from inside the page.
      await page.waitForFunction(
        () => (document.querySelector('#ticks')?.textContent ?? '').trim().split(' ').length >= 3,
        undefined,
        { timeout: 15_000 },
      );
      const before = (await page.textContent('#ticks')) ?? '';
      await page.click('#kill');

      await page.waitForFunction(
        (previous: string) => (document.querySelector('#ticks')?.textContent ?? '').length > previous.length + 4,
        before,
        { timeout: 15_000 },
      );

      const states = (await page.textContent('#states')) ?? '';
      expect(states).toContain('resuming');
      expect(states.trim().split(' ').pop()).toBe('open');

      // The ticker's numbers are the proof: a resume that lost or repeated a
      // frame shows up as a hole or a duplicate in this sequence.
      const ticks = ((await page.textContent('#ticks')) ?? '').trim().split(/\s+/);
      expect(ticks.length).toBeGreaterThan(before.trim().split(/\s+/).length);
      expect(ticks).toEqual(ticks.map((_value, index) => String(index)));
    } finally {
      await browser.close();
    }
  }, 90_000);
});
