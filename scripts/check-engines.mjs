#!/usr/bin/env node
/**
 * The Node floor, stated once and checked everywhere.
 *
 * Three places declare a Node version and they answer different questions:
 *
 * - the root `engines.node` is the floor the *published packages* support,
 * - every package's `engines.node` must repeat it exactly, because that is
 *   the field a consumer's package manager reads,
 * - `.nvmrc` is the *development* toolchain, which is deliberately newer
 *   (pnpm 11 needs `node:sqlite`, so it will not start on Node 20). It has
 *   to satisfy the floor, not equal it.
 *
 * CI runs the test matrix down to the floor, so a floor that drifts out of
 * one of these files is a release bug rather than a preference.
 *
 * Run: `node scripts/check-engines.mjs`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Read a JSON file, relative to the repo root. */
function manifest(...parts) {
  return JSON.parse(readFileSync(join(root, ...parts), 'utf8'));
}

const rootManifest = manifest('package.json');
const floor = rootManifest.engines?.node;
const problems = [];

if (typeof floor !== 'string' || !/^>=\d+$/.test(floor)) {
  problems.push(`root engines.node is ${JSON.stringify(floor)}; expected a ">=<major>" range`);
}
const floorMajor = Number((floor ?? '').replace('>=', ''));

const packages = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

for (const pkg of packages) {
  const declared = manifest('packages', pkg, 'package.json').engines?.node;
  if (declared !== floor) {
    problems.push(
      `packages/${pkg}/package.json engines.node is ${JSON.stringify(declared)}, ` +
        `root says ${JSON.stringify(floor)}`,
    );
  }
}

const nvmrc = readFileSync(join(root, '.nvmrc'), 'utf8').trim();
const nvmrcMajor = Number(nvmrc.replace(/^v/, '').split('.')[0]);
if (!Number.isInteger(nvmrcMajor)) {
  problems.push(`.nvmrc is ${JSON.stringify(nvmrc)}; expected a Node version`);
} else if (nvmrcMajor < floorMajor) {
  problems.push(`.nvmrc pins Node ${String(nvmrcMajor)}, below the ${floor} floor`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL ${problem}`);
  process.exit(1);
}

console.log(
  `engines consistent: ${String(packages.length)} packages at "${floor}", ` +
    `.nvmrc on Node ${nvmrc}`,
);
