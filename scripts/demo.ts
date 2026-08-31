#!/usr/bin/env node
/**
 * A runnable demo of the whole bridge: host, page, client.
 *
 * `node --experimental-strip-types scripts/demo.ts` (Node >= 22.6) or
 * `bun scripts/demo.ts` starts a host on loopback, prints a URL with a
 * one-time launch token, and serves a page that connects back over the bridge
 * and drives it: an echo call, a ticker stream, a connection-state badge, and
 * a button that kills the socket so a resume can be watched happening.
 *
 * The page carries the client inline. The bridge serves exactly three routes —
 * `/`, `/ws`, `/rpc` — and reads nothing from disk, so a demo that wanted a
 * `<script src>` would have to add a static file server, which is precisely
 * the surface the threat model keeps out of the product.
 */
import { build } from 'esbuild';
import { createBridge } from 'brobridge';

/** Bundle the built client into one inlineable ES module. */
async function bundleClient(): Promise<string> {
  const result = await build({
    entryPoints: [new URL('../packages/client/dist/index.js', import.meta.url).pathname],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  });
  return result.outputFiles[0]?.text ?? '';
}

/** The demo page: the client, plus the smallest UI that exercises it. */
export function page(clientSource: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>brobridge demo</title>
<style>
  body { font: 14px/1.5 ui-monospace, monospace; margin: 2rem; max-width: 48rem; }
  #state { font-weight: bold; }
  #ticks { white-space: pre-wrap; }
</style>
</head>
<body>
<h1>brobridge</h1>
<p>state: <span id="state">starting</span> <small>(<span id="states"></span>)</small></p>
<p>echo: <span id="echo">-</span></p>
<p>ticks: <span id="ticks"></span></p>
<button id="kill">kill the socket</button>
<script type="module">
${clientSource}
// The client is inlined above, in this same module scope, so everything the
// page declares is prefixed: an unprefixed name here would collide with one
// of the bundle's own top-level declarations.
const demoShow = (id, value) => { document.getElementById(id).textContent = value; };

// The socket factory is a public option, so the demo can keep a handle on the
// live socket and cut it on demand. An application has no reason to do this;
// a demo of resume has every reason to.
let demoSocket = null;
const bridge = await connect(location.href, { socket: (url) => (demoSocket = new WebSocket(url)) });
demoShow('state', bridge.state);
bridge.on('state', (state) => {
  demoShow('state', state);
  document.getElementById('states').textContent += state + ' ';
});
document.getElementById('kill').addEventListener('click', () => demoSocket?.close());

demoShow('echo', await bridge.call('demo.echo', 'hello from the tab'));

const demoTicker = await bridge.openStream('demo.ticker', { everyMs: 250 });
const demoDecoder = new TextDecoder();
for await (const chunk of demoTicker) {
  document.getElementById('ticks').textContent += demoDecoder.decode(chunk);
}
</script>
</body>
</html>`;
}

/** Start the demo host. Exported so a browser test can drive the same setup. */
export async function startDemo(): Promise<Awaited<ReturnType<typeof createBridge>>> {
  const clientSource = await bundleClient();
  const bridge = await createBridge({
    index: { body: page(clientSource), contentType: 'text/html; charset=utf-8' },
  });

  bridge.expose('demo', {
    echo: (message: string) => `${message} (echoed by the host)`,
  });

  bridge.stream('demo.ticker', async (stream, { params }) => {
    const everyMs = Number(params['everyMs'] ?? 1_000);
    const encoder = new TextEncoder();
    for (let tick = 0; ; tick += 1) {
      await stream.write(encoder.encode(`${String(tick)} `));
      await new Promise((resolve) => setTimeout(resolve, everyMs));
    }
  });

  return bridge;
}

// Only when run directly, so the browser test can import the setup instead.
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  const bridge = await startDemo();
  console.log(`open ${bridge.url}`);
  process.on('SIGINT', () => {
    void bridge.close().then(() => process.exit(0));
  });
}
