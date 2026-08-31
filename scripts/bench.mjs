#!/usr/bin/env node
/**
 * The performance verification of Phase 6 §4.
 *
 * Every number here is measured over a real loopback WebSocket between a real
 * `brobridge` host and the real `@brobridge/client`, not over an in-memory
 * pipe: the point is to verify what an application gets, including the socket,
 * the framing and the credit accounting.
 *
 * Run: `node scripts/bench.mjs` (needs `pnpm build` first).
 * Add `--json` to print the results as one JSON object.
 *
 * Targets, from the Phase 6 brief:
 *   firehose   >= 300 MiB/s for 100 MiB of 1-4 KiB chunks on one stream
 *   isolation  a paused consumer buffers only its window; p99 inter-chunk
 *              latency on the others < 5 ms
 *   unary      >= 5 000 echo calls/s on one connection
 *   resume     zero byte loss and a gap < 2 s across a dropped socket
 */
import { createBridge } from 'brobridge';
import { connect } from '@brobridge/client';
import { WebSocket as NodeWebSocket } from 'ws';

const MIB = 1024 * 1024;

/**
 * The two things a browser brings that a Node process does not: a cookie jar,
 * and headers on the WebSocket upgrade. Everything else the client does is
 * unchanged, over a real socket to a real listener.
 */
function browserEnv(origin) {
  const jar = { cookie: '' };
  const sockets = [];

  const fetchLike = async (input, init) => {
    const headers = new Headers(init?.headers ?? {});
    headers.set('origin', origin);
    if (jar.cookie !== '') headers.set('cookie', jar.cookie);
    const response = await globalThis.fetch(input, { ...init, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie !== null) jar.cookie = setCookie.split(';')[0] ?? '';
    return response;
  };

  const socket = (url) => {
    const ws = new NodeWebSocket(url, {
      headers: { Origin: origin, ...(jar.cookie === '' ? {} : { Cookie: jar.cookie }) },
    });
    ws.binaryType = 'arraybuffer';
    const shim = {
      binaryType: 'arraybuffer',
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      get readyState() {
        return ws.readyState;
      },
      send(data) {
        ws.send(data, { binary: true });
      },
      close(code, reason) {
        ws.close(code, reason);
      },
    };
    ws.on('open', () => shim.onopen?.({}));
    ws.on('message', (data) => shim.onmessage?.({ data }));
    ws.on('close', () => shim.onclose?.({}));
    ws.on('error', () => shim.onerror?.({}));
    // Kept so a benchmark can cut the connection the way a network does,
    // without touching the session behind it.
    sockets.push(ws);
    return shim;
  };

  return {
    fetch: fetchLike,
    socket,
    killSocket: () => sockets[sockets.length - 1]?.terminate(),
  };
}

/**
 * Connect the real client to a running host, through the browser shim.
 *
 * @returns The client, plus `killSocket()` for the reconnect benchmark.
 */
async function openClient(bridge, options = {}) {
  const env = browserEnv(bridge.origin);
  const client = await connect(bridge.url, {
    fetch: env.fetch,
    socket: env.socket,
    ...options,
  });
  return Object.assign(client, { killSocket: env.killSocket });
}
const json = process.argv.includes('--json');
const results = {};

/** Print a line unless `--json` was asked for. */
function say(line) {
  if (!json) console.log(line);
}

function record(name, outcome) {
  results[name] = outcome;
  const verdict = outcome.pass ? 'PASS' : 'FAIL';
  say(`${verdict}  ${name}: ${outcome.summary}`);
}

/** Deterministic filler, so the numbers are not measuring a CSPRNG. */
function filler(bytes) {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 1) out[i] = i & 0xff;
  return out;
}

/** The p-th percentile of `values`, which this mutates by sorting. */
function percentile(values, p) {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  const index = Math.min(values.length - 1, Math.ceil((p / 100) * values.length) - 1);
  return values[index];
}

/* -------------------------------------------------------------------------- */
/*  1. PTY firehose                                                            */
/* -------------------------------------------------------------------------- */

async function benchFirehose() {
  const TOTAL = 100 * MIB;
  const source = filler(4096);

  const bridge = await createBridge({
    initialCredit: 4 * MIB,
    maxFrameSize: 1 * MIB,
  });
  bridge.stream('firehose', (stream) => {
    void (async () => {
      let sent = 0;
      let i = 0;
      try {
        while (sent < TOTAL) {
          // 1-4 KiB chunks, the shape a PTY actually produces.
          const size = 1024 + ((i * 977) % 3073);
          const take = Math.min(size, TOTAL - sent);
          await stream.write(source.subarray(0, take));
          sent += take;
          i += 1;
        }
        await stream.end();
      } catch {
        // The consumer went away; the measurement below reports the shortfall.
      }
    })();
  });

  const client = await openClient(bridge);
  const stream = await client.openStream('firehose');

  const heapBefore = process.memoryUsage().heapUsed;
  let heapPeak = heapBefore;
  let received = 0;
  let checksum = 0;
  const started = process.hrtime.bigint();

  for await (const chunk of stream) {
    received += chunk.length;
    // Touch the bytes, so the run cannot be optimised into a byte counter.
    checksum = (checksum + chunk[0] + chunk[chunk.length - 1]) >>> 0;
    if ((received & 0x3ffffff) === 0) {
      const heap = process.memoryUsage().heapUsed;
      if (heap > heapPeak) heapPeak = heap;
    }
  }

  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const heapAfter = process.memoryUsage().heapUsed;
  const throughput = received / MIB / (elapsedMs / 1000);

  await client.close();
  await bridge.close();

  const lossless = received === TOTAL;
  const heapGrowthMiB = (heapAfter - heapBefore) / MIB;
  // "Heap stable" for a streaming consumer means it did not retain the
  // stream: growth is bounded by the credit window, not by the 100 MiB.
  const heapStable = heapGrowthMiB < 64;

  record('firehose', {
    pass: lossless && heapStable && throughput >= 300,
    target: '>= 300 MiB/s, no frame loss, heap stable',
    throughputMiBs: Number(throughput.toFixed(1)),
    bytes: received,
    expectedBytes: TOTAL,
    elapsedMs: Number(elapsedMs.toFixed(1)),
    heapGrowthMiB: Number(heapGrowthMiB.toFixed(1)),
    heapPeakMiB: Number(((heapPeak - heapBefore) / MIB).toFixed(1)),
    checksum,
    summary:
      `${throughput.toFixed(1)} MiB/s, ${String(received)}/${String(TOTAL)} bytes, ` +
      `heap +${heapGrowthMiB.toFixed(1)} MiB`,
  });
}

/* -------------------------------------------------------------------------- */
/*  2. Stream isolation with one paused consumer                               */
/* -------------------------------------------------------------------------- */

/**
 * One run of the isolation load.
 *
 * `paused` decides whether stream 0's consumer stops reading. Running it both
 * ways is what separates the claim under test — a stalled consumer costs the
 * other streams nothing — from the cost of the concurrency itself.
 */
async function isolationRun({ streams: STREAMS, credit: CREDIT, paused }) {
  const PER_STREAM_CHUNKS = 200;
  const CHUNK = 2048;

  const bridge = await createBridge({ initialCredit: CREDIT, maxStreams: 128 });
  const parked = [];
  // Built once. Generating payload inside the loop would put the benchmark's
  // own work on the event loop it is timing.
  const payload = filler(CHUNK);
  bridge.stream('ticker', (stream) => {
    parked.push(stream);
    void (async () => {
      try {
        for (let i = 0; i < PER_STREAM_CHUNKS; i += 1) await stream.write(payload);
        await stream.end();
      } catch {
        // Cancelled with the run.
      }
    })();
  });

  const client = await openClient(bridge);
  const streams = [];
  for (let i = 0; i < STREAMS; i += 1) {
    streams.push(await client.openStream('ticker', undefined, { credit: CREDIT }));
  }

  // With `paused`, stream 0's consumer never reads. Everyone else drains.
  const parkedStream = paused ? streams[0] : null;
  const gaps = [];
  const active = (paused ? streams.slice(1) : streams).map(async (stream) => {
    let last = null;
    let bytes = 0;
    for await (const chunk of stream) {
      const now = process.hrtime.bigint();
      // The wait before the *first* chunk is the OPEN round trip, not an
      // inter-chunk gap; sampling it would measure stream setup instead.
      if (last !== null) gaps.push(Number(now - last) / 1e6);
      last = now;
      bytes += chunk.length;
    }
    return bytes;
  });

  const delivered = await Promise.all(active);
  const expected = PER_STREAM_CHUNKS * CHUNK;
  const complete = delivered.every((bytes) => bytes === expected);
  const parkedBytes = parkedStream === null ? 0 : parkedStream.bufferedBytes;

  const outcome = {
    complete,
    parkedBytes,
    drained: delivered.length,
    p50: Number(percentile(gaps.slice(), 50).toFixed(3)),
    p99: Number(percentile(gaps.slice(), 99).toFixed(3)),
    samples: gaps.length,
  };

  await client.close();
  await bridge.close();
  return outcome;
}

async function benchIsolation() {
  const STREAMS = 50;
  const CREDIT = 64 * 1024;

  const test = await isolationRun({ streams: STREAMS, credit: CREDIT, paused: true });
  // The control: the same load with nothing paused. If its p99 matches the
  // test's, the latency is the price of 49 concurrent consumers on one event
  // loop, not something the paused stream did to them.
  const control = await isolationRun({ streams: STREAMS - 1, credit: CREDIT, paused: false });
  // The same load with a window wide enough that a credit refill never lands
  // after the consumer has run dry.
  const wide = await isolationRun({ streams: STREAMS, credit: 512 * 1024, paused: true });

  // The property under test: a stalled consumer holds only its own window and
  // costs the other streams neither bytes nor measurable latency.
  const isolated =
    test.complete && test.parkedBytes <= CREDIT && test.p99 <= control.p99 * 1.5;
  const latencyMet = test.p99 < 5;

  record('isolation', {
    pass: isolated && latencyMet,
    target: 'paused stream buffers <= its window; p99 inter-chunk latency < 5 ms',
    isolationHolds: isolated,
    latencyTargetMet: latencyMet,
    streams: STREAMS,
    creditWindow: CREDIT,
    pausedBufferedBytes: test.parkedBytes,
    othersComplete: test.complete,
    p50Ms: test.p50,
    p99Ms: test.p99,
    samples: test.samples,
    controlP99Ms: control.p99,
    controlNote: 'same load, no paused consumer',
    wideWindowP99Ms: wide.p99,
    wideWindowCredit: 512 * 1024,
    summary:
      `paused holds ${String(test.parkedBytes)}/${String(CREDIT)} B, ` +
      `${String(test.drained)} others complete, p99 ${test.p99.toFixed(3)} ms ` +
      `(control ${control.p99.toFixed(3)} ms, 512 KiB window ${wide.p99.toFixed(3)} ms)`,
  });
}

/* -------------------------------------------------------------------------- */
/*  3. Unary throughput                                                        */
/* -------------------------------------------------------------------------- */

async function benchUnary() {
  const CALLS = 20_000;
  const CONCURRENCY = 64;

  const bridge = await createBridge();
  bridge.expose('echo', { say: (text) => text });

  const client = await openClient(bridge);
  // Warm the path so the measurement is steady state, not first-call JIT.
  for (let i = 0; i < 200; i += 1) await client.call('echo.say', 'warm');

  const started = process.hrtime.bigint();
  let issued = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const mine = issued;
      if (mine >= CALLS) return;
      issued += 1;
      await client.call('echo.say', 'ping');
    }
  });
  await Promise.all(workers);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const perSecond = CALLS / (elapsedMs / 1000);

  await client.close();
  await bridge.close();

  record('unary', {
    pass: perSecond >= 5000,
    target: '>= 5 000 echo calls/s on one connection',
    calls: CALLS,
    concurrency: CONCURRENCY,
    elapsedMs: Number(elapsedMs.toFixed(1)),
    callsPerSecond: Math.round(perSecond),
    summary: `${String(Math.round(perSecond))} calls/s over ${String(CALLS)} calls`,
  });
}

/* -------------------------------------------------------------------------- */
/*  4. Reconnect with resume, under load                                       */
/* -------------------------------------------------------------------------- */

async function benchResume() {
  const TOTAL_CHUNKS = 4000;
  const CHUNK = 4096;
  const expected = TOTAL_CHUNKS * CHUNK;

  const bridge = await createBridge({
    initialCredit: 256 * 1024,
    resumeWindow: { bytes: 8 * MIB, frames: 4096 },
  });
  bridge.stream('load', (stream) => {
    void (async () => {
      try {
        for (let i = 0; i < TOTAL_CHUNKS; i += 1) {
          const chunk = filler(CHUNK);
          // Stamp the sequence, so a gap is detectable rather than assumed.
          new DataView(chunk.buffer).setUint32(0, i, true);
          await stream.write(chunk);
        }
        await stream.end();
      } catch {
        // The socket died and the stream was resumed on a new one.
      }
    })();
  });

  const client = await openClient(bridge);
  const stream = await client.openStream('load');

  // A benchmark that hangs reports nothing, which is worse than a failure.
  const watchdog = setTimeout(() => {
    console.error('resume: consumers stalled — no completion within 60 s');
    process.exit(1);
  }, 60_000);
  watchdog.unref?.();

  let received = 0;
  let killed = false;
  let killedAt = 0n;
  let resumedAt = 0n;
  const pending = [];
  let nextIndex = 0;
  let gaps = 0;

  for await (const chunk of stream) {
    received += chunk.length;
    pending.push(chunk);
    // Reassemble and verify the stamped sequence across the reconnect.
    while (pending.length > 0) {
      const head = pending[0];
      if (head.length < 4) break;
      const index = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(0, true);
      if (head.length === CHUNK) {
        if (index !== nextIndex) gaps += 1;
        nextIndex += 1;
      }
      pending.shift();
    }

    if (!killed && received > expected / 4) {
      killed = true;
      killedAt = process.hrtime.bigint();
      // Cut the socket the way a dying network does — the session behind it
      // survives, which is what the client resumes onto.
      client.killSocket();
    }
    if (killed && resumedAt === 0n && client.state === 'open' && received > expected / 2) {
      resumedAt = process.hrtime.bigint();
    }
  }

  clearTimeout(watchdog);
  const gapMs = killed && resumedAt !== 0n ? Number(resumedAt - killedAt) / 1e6 : 0;

  await client.close();
  await bridge.close();

  record('resume', {
    pass: received === expected && gaps === 0 && gapMs < 2000,
    target: 'zero byte loss, gap < 2 s across an immediate reconnect',
    bytes: received,
    expectedBytes: expected,
    outOfOrderChunks: gaps,
    socketKilled: killed,
    gapMs: Number(gapMs.toFixed(1)),
    summary:
      `${String(received)}/${String(expected)} bytes, ${String(gaps)} gaps, ` +
      `recovery ${gapMs.toFixed(1)} ms`,
  });
}

/* -------------------------------------------------------------------------- */

const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length);
const suite = {
  firehose: benchFirehose,
  isolation: benchIsolation,
  unary: benchUnary,
  resume: benchResume,
};

say(`brobridge benchmarks — ${process.version} on ${process.platform}/${process.arch}\n`);
for (const [name, run] of Object.entries(suite)) {
  if (only !== undefined && only !== name) continue;
  await run();
}

if (json) console.log(JSON.stringify({ runtime: process.version, results }, null, 2));

const failed = Object.entries(results).filter(([, outcome]) => !outcome.pass);
if (failed.length > 0) {
  say(`\n${String(failed.length)} target(s) missed: ${failed.map(([name]) => name).join(', ')}`);
  process.exit(1);
}
say('\nall targets met.');
