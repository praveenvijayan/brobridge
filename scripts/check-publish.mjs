#!/usr/bin/env node
/**
 * `npm publish --dry-run` for every published package.
 *
 * What it is actually checking is not npm's willingness to upload — it is that
 * each package's `files` whitelist, `exports` map and version agree with what
 * the build produced, before a real publish makes the answer permanent.
 *
 * Run: `node scripts/check-publish.mjs` (needs `pnpm build` first).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const packages = ['core', 'server', 'client', 'adapters'];

let failed = 0;
const versions = new Set();

for (const name of packages) {
  const dir = join(root, 'packages', name);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  versions.add(manifest.version);

  console.log(`\n=== ${manifest.name}@${manifest.version} — npm publish --dry-run ===`);
  try {
    // npm, not pnpm: this is the tool that will do the real publish, and its
    // view of the tarball is the one that matters.
    const out = execFileSync('npm', ['publish', '--dry-run', '--access', 'public'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log(out.trim());
  } catch (error) {
    failed += 1;
    console.error(error.stdout?.toString() ?? '');
    console.error(error.stderr?.toString() ?? String(error));
  }

  if (manifest.publishConfig?.provenance !== true) {
    console.error(`FAIL ${manifest.name} does not enable publish provenance`);
    failed += 1;
  }
  if (manifest.publishConfig?.access !== 'public') {
    console.error(`FAIL ${manifest.name} does not publish with public access`);
    failed += 1;
  }
}

// The four packages are released as one version (see .changeset/README.md), so
// a drift between them is a release bug, not a preference.
if (versions.size !== 1) {
  console.error(`\nFAIL versions disagree across the workspace: ${[...versions].join(', ')}`);
  failed += 1;
}

console.log(failed === 0 ? '\npublish dry-run clean.' : `\n${String(failed)} problem(s).`);
process.exit(failed === 0 ? 0 : 1);
