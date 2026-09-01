#!/usr/bin/env node
/**
 * The client's bundle budget, enforced.
 *
 * Two numbers matter, and they are not the same number:
 *
 * - **own** — `@brobridgejs/client` with `@brobridgejs/core` left external. This
 *   is the code this package adds: bootstrap, reconnect, resume driving,
 *   fallback, proxy.
 * - **shipped** — client *and* core bundled, which is what a browser actually
 *   downloads, because core is where the protocol lives.
 *
 * `shipped.target` is the product goal from the design brief (10 KiB). It is
 * reported on every run, met or missed. `shipped.limit` is a ratchet: it stops
 * the number growing while the gap to the target is closed, and it is not a
 * restatement of the goal. Lower it whenever a run comes in under it.
 *
 * Run: `node scripts/check-client-size.mjs` (needs `pnpm build` first).
 */
import { gzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const entry = join(root, 'packages/client/dist/index.js');

const BUDGETS = {
  own: { limit: 10 * 1024 },
  shipped: { target: 10 * 1024, limit: 12.5 * 1024 },
};

const work = mkdtempSync(join(tmpdir(), 'brobridge-size-'));

/** Bundle `entry` and return its minified, gzipped size in bytes. */
async function measure(name, external) {
  const outfile = join(work, `${name}.js`);
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    external,
    legalComments: 'none',
  });
  return gzipSync(readFileSync(outfile), { level: 9 }).length;
}

function kib(bytes) {
  return `${(bytes / 1024).toFixed(2)} KiB`;
}

try {
  const own = await measure('own', ['@brobridgejs/core']);
  const shipped = await measure('shipped', []);

  console.log(`own      (core external): ${String(own)} bytes min+gzip (${kib(own)})`);
  console.log(`shipped  (core inlined):  ${String(shipped)} bytes min+gzip (${kib(shipped)})`);

  let failed = false;

  if (own > BUDGETS.own.limit) {
    console.error(`FAIL own is over its ${kib(BUDGETS.own.limit)} budget`);
    failed = true;
  }
  if (shipped > BUDGETS.shipped.limit) {
    console.error(`FAIL shipped is over its ${kib(BUDGETS.shipped.limit)} ratchet`);
    failed = true;
  }

  if (shipped > BUDGETS.shipped.target) {
    // Stated, not silently absorbed: the goal is missed, and by how much.
    console.log(
      `NOTE shipped misses the ${kib(BUDGETS.shipped.target)} target by ` +
        `${String(shipped - BUDGETS.shipped.target)} bytes. The protocol engine in ` +
        '@brobridgejs/core is the bulk of it; a browser-only core entry point that drops ' +
        'the replay buffer and session hosting is what would close the gap.',
    );
  } else {
    console.log(`shipped meets the ${kib(BUDGETS.shipped.target)} target.`);
  }

  process.exit(failed ? 1 : 0);
} finally {
  rmSync(work, { recursive: true, force: true });
}
