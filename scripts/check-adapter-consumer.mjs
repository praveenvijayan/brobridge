#!/usr/bin/env node
/**
 * The consumer check for `@brobridge/adapters`.
 *
 * Subpath exports and peer dependencies are the two things a workspace hides:
 * inside the monorepo every import resolves through `node_modules/.pnpm`
 * whether or not the published package declares it. So this packs all four
 * packages, installs the tarballs into a throwaway project with npm, and
 * compiles a file that imports every adapter — under both `node16` and
 * `bundler` resolution, because a subpath map can satisfy one and not the
 * other.
 *
 * Run after `pnpm build`. Exits non-zero on the first failure, leaving the
 * temporary project in place so the failure can be inspected.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** The file the throwaway project compiles: every adapter, both directions. */
const CONSUMER = `import { createORPCClient } from '@orpc/client';
import type { RouterClient } from '@orpc/server';
import { os } from '@orpc/server';
import { createTRPCClient } from '@trpc/client';
import { initTRPC } from '@trpc/server';
import { z } from 'zod';

import { connect } from '@brobridge/client';
import { createBridge } from 'brobridge';
import { createBirpcLink, mount as mountBirpc } from '@brobridge/adapters/birpc';
import { createORPCLink, mount as mountORPC } from '@brobridge/adapters/orpc';
import { createTRPCLink, mount as mountTRPC } from '@brobridge/adapters/trpc';

interface HostFunctions {
  add(a: number, b: number): number;
}

const orpcRouter = {
  greet: os.input(z.object({ name: z.string() })).handler(({ input }) => 'hello ' + input.name),
};

const t = initTRPC.create();
const appRouter = t.router({
  greet: t.procedure.input(z.object({ name: z.string() })).query(({ input }) => input.name),
});

export async function host(): Promise<void> {
  const bridge = await createBridge();
  mountBirpc<Record<string, never>, HostFunctions>(bridge, { add: (a, b) => a + b });
  mountORPC(bridge, orpcRouter);
  mountTRPC(bridge, appRouter);
  await bridge.close();
}

export async function browser(url: string): Promise<void> {
  const bridge = await connect(url);

  const rpc = await createBirpcLink<HostFunctions>(bridge, {});
  const sum: number = await rpc.add(1, 2);

  const orpc: RouterClient<typeof orpcRouter> = createORPCClient(await createORPCLink(bridge));
  const greeting: string = await orpc.greet({ name: 'ada' });

  const trpc = createTRPCClient<typeof appRouter>({ links: [createTRPCLink<typeof appRouter>(bridge, {})] });
  const echoed: string = await trpc.greet.query({ name: 'ada' });

  console.log(sum, greeting, echoed);
  await bridge.close();
}
`;

const root = process.cwd();
const PACKAGES = ['core', 'server', 'client', 'adapters'];
const FRAMEWORKS = {
  birpc: '4.2.0',
  '@orpc/client': '1.15.0',
  '@orpc/server': '1.15.0',
  '@trpc/client': '11.18.0',
  '@trpc/server': '11.18.0',
  zod: '4.5.4',
  typescript: '5.9.3',
  '@types/node': '22.20.0',
  '@types/ws': '8.18.1',
};

const work = mkdtempSync(join(tmpdir(), 'brobridge-consumer-'));
const tarballs = join(work, 'tarballs');
mkdirSync(tarballs);
console.log(`workspace: ${work}`);

for (const pkg of PACKAGES) {
  run('pnpm', ['pack', '--pack-destination', tarballs], join(root, 'packages', pkg));
}

/** Map published name -> the tarball that must satisfy it, transitively too. */
const packed = readdirSync(tarballs).map((file) => join(tarballs, file));
const overrides = {};
for (const [name, file] of [
  ['@brobridge/core', find(packed, 'brobridge-core-')],
  ['brobridge', find(packed, /(^|\/)brobridge-\d/)],
  ['@brobridge/client', find(packed, 'brobridge-client-')],
  ['@brobridge/adapters', find(packed, 'brobridge-adapters-')],
]) {
  overrides[name] = `file:${file}`;
}

const project = join(work, 'app');
mkdirSync(project);
writeFileSync(
  join(project, 'package.json'),
  `${JSON.stringify(
    {
      name: 'brobridge-consumer-check',
      private: true,
      version: '0.0.0',
      type: 'module',
      dependencies: { ...Object.fromEntries(Object.entries(overrides)), ...FRAMEWORKS },
      overrides,
    },
    null,
    2,
  )}\n`,
);
writeFileSync(join(project, 'app.ts'), CONSUMER);

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
      // The workspace compiles with `skipLibCheck`, and so does everyone
      // else: without it the output is dominated by faults in the
      // frameworks' own declarations. What is under test here is whether
      // `app.ts` resolves and typechecks against the packed tarballs.
      '--skipLibCheck',
      '--module', module,
      '--moduleResolution', moduleResolution,
      'app.ts',
    ],
    project,
  );
}

console.log('\nconsumer check passed');

function find(files, needle) {
  const match = files.find((file) =>
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
