#!/usr/bin/env node
/**
 * Runs publint and @arethetypeswrong/cli against every workspace package.
 *
 * Both tools inspect the packed tarball, so `pnpm build` must have run first.
 * Exits non-zero if any package reports a problem.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const packagesDir = join(process.cwd(), 'packages');
const packages = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

let failed = false;

for (const pkg of packages) {
  const cwd = join(packagesDir, pkg);

  // Both tools inspect the packed tarball, so a missing dist reports as a
  // wall of "file does not exist" errors rather than the real cause.
  // `tsc -b` will also skip emit when a stale .tsbuildinfo survives a manual
  // `rm -rf dist`, so say plainly what to run.
  if (!existsSync(join(cwd, 'dist'))) {
    console.error(
      `${pkg}: packages/${pkg}/dist is missing. Run \`pnpm build\` first ` +
        '(after a manual dist delete, run `pnpm build:clean && pnpm build`).',
    );
    process.exit(1);
  }

  for (const [label, command, args] of [
    ['publint', 'pnpm', ['exec', 'publint', '--strict']],
    ['attw', 'pnpm', ['exec', 'attw', '--pack', '.', '--profile', 'esm-only']],
  ]) {
    process.stdout.write(`\n=== ${pkg}: ${label} ===\n`);
    const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
    if (result.status !== 0) {
      failed = true;
      process.stdout.write(`--- ${pkg}: ${label} FAILED (exit ${result.status})\n`);
    }
  }
}

process.exit(failed ? 1 : 0);
