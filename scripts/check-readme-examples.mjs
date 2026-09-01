#!/usr/bin/env node
/**
 * Compile every README example against the *published* packages.
 *
 * A README is the first API anyone uses, and inside the workspace its examples
 * typecheck against `src`, which is not what a consumer installs. This packs
 * all four packages into a throwaway project and compiles each fenced `ts`
 * block against the tarballs, under `node16` and `bundler` resolution.
 *
 * A block that only makes sense as a continuation of the prose around it —
 * it uses a `bridge` an earlier block created, say — marks itself
 * `<!-- check-readme: fragment -->` on the line before the fence. Everything
 * else is treated as an example a reader may copy on its own, and must
 * compile on its own. Keeping the distinction in the README source is the
 * point: it says out loud which snippets are complete.
 *
 * Run after `pnpm build`. Exits non-zero on the first failure and leaves the
 * temporary project in place so the failure can be inspected.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = process.cwd();
const PACKAGES = ['core', 'server', 'client', 'adapters'];

/** READMEs whose examples are part of the public promise. */
const READMES = [
  'README.md',
  'packages/core/README.md',
  'packages/server/README.md',
  'packages/client/README.md',
  'packages/adapters/README.md',
];

const DEPENDENCIES = {
  birpc: '4.2.0',
  '@orpc/client': '1.15.0',
  '@orpc/server': '1.15.0',
  '@trpc/client': '11.18.0',
  '@trpc/server': '11.18.0',
  zod: '4.5.4',
  typescript: '5.9.3',
  '@types/node': '22.20.0',
};

/** Every fenced `ts`/`tsx` block in `markdown`, with its line number. */
function extractBlocks(markdown, source) {
  const lines = markdown.split('\n');
  const blocks = [];
  let current = null;

  for (const [index, line] of lines.entries()) {
    if (current === null) {
      const fence = /^```(ts|tsx|typescript)\s*$/.exec(line);
      if (fence === null) continue;
      const previous = (lines[index - 1] ?? '').trim();
      const fragment = /check-readme:\s*(fragment|skip)/.test(previous);
      current = { source, line: index + 1, fragment, code: [] };
      continue;
    }
    if (line.trimEnd() === '```') {
      blocks.push({ ...current, code: current.code.join('\n') });
      current = null;
      continue;
    }
    current.code.push(line);
  }
  return blocks;
}

const work = mkdtempSync(join(tmpdir(), 'brobridge-readme-'));
const tarballs = join(work, 'tarballs');
mkdirSync(tarballs);
console.log(`workspace: ${work}`);

for (const pkg of PACKAGES) {
  run('pnpm', ['pack', '--pack-destination', tarballs], join(root, 'packages', pkg));
}

const packed = readdirSync(tarballs).map((file) => join(tarballs, file));
const overrides = {};
for (const [name, needle] of [
  ['@brobridgejs/core', 'brobridgejs-core-'],
  ['brobridge', /(^|\/)brobridge-\d/],
  ['@brobridgejs/client', 'brobridgejs-client-'],
  ['@brobridgejs/adapters', 'brobridgejs-adapters-'],
]) {
  overrides[name] = `file:${find(packed, needle)}`;
}

const project = join(work, 'app');
mkdirSync(project);
writeFileSync(
  join(project, 'package.json'),
  `${JSON.stringify(
    {
      name: 'brobridge-readme-check',
      private: true,
      version: '0.0.0',
      type: 'module',
      dependencies: { ...overrides, ...DEPENDENCIES },
      overrides,
    },
    null,
    2,
  )}\n`,
);

const all = [];
for (const source of READMES) {
  all.push(...extractBlocks(readFileSync(join(root, source), 'utf8'), source));
}
const blocks = all.filter((block) => !block.fragment);
const fragments = all.length - blocks.length;
console.log(
  `\n${String(all.length)} TypeScript block(s) across ${String(READMES.length)} READMEs: ` +
    `${String(blocks.length)} standalone, ${String(fragments)} marked as continuations`,
);

// Each standalone block becomes its own module, because that is how a reader
// uses it: copied out on its own, with nothing else around it.
const files = blocks.map((block, index) => {
  const name = `example-${String(index).padStart(2, '0')}.ts`;
  // A top-level `await` needs the file to be a module; an example with no
  // import is one anyway once this export is appended.
  writeFileSync(join(project, name), `${block.code}\nexport {};\n`);
  console.log(`  ${name}  <- ${block.source}:${String(block.line)}`);
  return name;
});

run('npm', ['install', '--no-audit', '--no-fund'], project);

for (const moduleResolution of ['node16', 'bundler']) {
  const module = moduleResolution === 'node16' ? 'node16' : 'preserve';
  console.log(`\n=== tsc --moduleResolution ${moduleResolution} ===`);
  run(
    'npx',
    [
      'tsc',
      '--noEmit',
      '--strict',
      '--exactOptionalPropertyTypes',
      '--target', 'es2022',
      '--lib', 'es2023,es2022.error,esnext.disposable,dom',
      '--skipLibCheck',
      '--module', module,
      '--moduleResolution', moduleResolution,
      ...files,
    ],
    project,
  );
}

console.log('\nREADME examples compile against the packed tarballs.');

function find(files_, needle) {
  const match = files_.find((file) =>
    typeof needle === 'string' ? file.includes(needle) : needle.test(file),
  );
  if (match === undefined) throw new Error(`no packed tarball matching ${String(needle)}`);
  return resolve(match);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\n${command} ${args.join(' ')} failed in ${cwd}`);
    process.exit(result.status ?? 1);
  }
}
