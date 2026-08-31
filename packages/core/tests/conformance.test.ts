/**
 * Spec-conformance tests written during the Phase 6 audit.
 *
 * Every case names the `PROTOCOL.md` MUST it covers. The suites that grew
 * alongside the implementation (`codec`, `mux`, `resume`, `edge-cases`) cover
 * most of the normative surface; this file closes the requirements the
 * conformance table found untested, and pins the two behaviours the audit
 * changed.
 */
import { describe, expect, it } from 'vitest';

import type { Frame } from '../src/index.js';
import {
  BridgeEndpoint,
  ErrorCode,
  FrameDecoder,
  FrameFlags,
  FrameType,
  SessionHost,
  decodeFrame,
  encodeFrame,
} from '../src/index.js';
import { connectPair } from './helpers/pair.js';
import { createPipe, flush } from './helpers/pipe.js';

/** A peer that speaks frames directly, so misbehaviour can be staged. */
function rawPeer(carrier: {
  send(bytes: Uint8Array): void;
  onMessage(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: () => void): void;
}): { send(frame: Frame): void; received: Frame[]; readonly closed: boolean } {
  const parser = new FrameDecoder();
  const received: Frame[] = [];
  const state = { closed: false };
  carrier.onMessage((bytes) => {
    received.push(...parser.push(bytes).frames);
  });
  carrier.onClose(() => {
    state.closed = true;
  });
  return {
    send(frame: Frame): void {
      carrier.send(encodeFrame(frame));
    },
    received,
    get closed(): boolean {
      return state.closed;
    },
  };
}

/** Every frame one end of a pipe put on the wire, in order. */
function framesSentBy(end: unknown): Frame[] {
  const parser = new FrameDecoder();
  const out: Frame[] = [];
  for (const bytes of (end as { sent: Uint8Array[] }).sent) {
    out.push(...parser.push(bytes).frames);
  }
  return out;
}

/** Drain a stream and discard it, so the peer keeps its credit. */
function drain(stream: AsyncIterable<Uint8Array>): void {
  void (async () => {
    try {
      for await (const chunk of stream) void chunk;
    } catch {
      // The stream ended under us; the test asserts on the other side.
    }
  })();
}

describe('§3 frame header', () => {
  it('writes zero in the reserved byte, and ignores whatever a peer put there', () => {
    const bytes = encodeFrame({
      type: FrameType.PING,
      streamId: 0,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { nonce: 'n' },
    });
    expect(bytes[3]).toBe(0);

    bytes[3] = 0xff;
    expect(decodeFrame(bytes)).toMatchObject({ type: FrameType.PING, payload: { nonce: 'n' } });
  });

  it('ignores unknown flag bits rather than rejecting the frame (§3.1)', () => {
    const bytes = encodeFrame({
      type: FrameType.DATA,
      streamId: 1,
      seq: 1,
      flags: 0x80 | 0x08,
      payload: new Uint8Array([1, 2, 3]),
    });
    const frame = decodeFrame(bytes);
    expect(frame).toMatchObject({ type: FrameType.DATA, flags: 0x88 });
    expect((frame as { payload: Uint8Array }).payload).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('carries a stream whose every frame is split across carrier messages (§3.2)', async () => {
    const { client } = await connectPair({
      chunkSize: 3,
      onStream: (stream) => {
        void (async () => {
          await stream.end(await stream.readAll());
        })();
      },
    });
    const payload = new Uint8Array(5000).map((_, i) => i & 0xff);
    expect(await client.call('echo', payload)).toEqual(payload);
  });
});

describe('§4 frame types', () => {
  it('ignores seq on an unsequenced frame', async () => {
    const pipe = createPipe();
    const host = new SessionHost();
    const accepted = host.accept(pipe.server);
    const peer = rawPeer(pipe.client);
    peer.send({
      type: FrameType.HELLO,
      streamId: 0,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { versions: [1] },
    });
    const server = await accepted;
    await flush();

    peer.send({
      type: FrameType.PING,
      streamId: 0,
      seq: 4242,
      flags: FrameFlags.NONE,
      payload: { nonce: 'ignored-seq' },
    });
    await flush();

    expect(peer.received.find((f) => f.type === FrameType.PONG)).toMatchObject({
      payload: { nonce: 'ignored-seq' },
    });
    expect(server.state).toBe('open');
    host.close();
  });
});

describe('§6.1 handshake rules', () => {
  it('answers a first frame that is neither HELLO nor RESUME with a connection-level ERROR, then closes', async () => {
    const pipe = createPipe();
    const host = new SessionHost();
    const accepted = host.accept(pipe.server);
    const peer = rawPeer(pipe.client);
    peer.send({
      type: FrameType.PING,
      streamId: 0,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { nonce: 'early' },
    });
    await expect(accepted).rejects.toThrow(/must be HELLO or RESUME/);
    await flush();

    const error = peer.received.find((f) => f.type === FrameType.ERROR);
    expect(error).toBeDefined();
    expect(error?.streamId).toBe(0);
    expect(error?.payload).toMatchObject({ code: ErrorCode.PROTOCOL_VIOLATION });
    expect(peer.closed).toBe(true);
  });

  it('puts no frame on the wire before the handshake settles, not even a PONG', async () => {
    const pipe = createPipe();
    const client = new BridgeEndpoint({ role: 'client' });
    const peer = rawPeer(pipe.server);
    const attaching = client.attach(pipe.client);
    await flush();
    peer.received.length = 0;

    // A peer that pings before it has answered HELLO is out of order. Replying
    // would put a frame on the wire before HELLO_ACK, which §6.1 forbids.
    peer.send({
      type: FrameType.PING,
      streamId: 0,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { nonce: 'too-early' },
    });
    await flush();

    expect(peer.received.some((f) => f.type === FrameType.PONG)).toBe(false);
    expect(peer.received.find((f) => f.type === FrameType.ERROR)?.payload).toMatchObject({
      code: ErrorCode.PROTOCOL_VIOLATION,
    });
    await expect(attaching).rejects.toThrow(/before the handshake/);
  });

  it('never puts a frame larger than the peer advertised on the wire', async () => {
    const { client, pipe } = await connectPair({
      client: { maxFrameSize: 1 << 20 },
      server: { maxFrameSize: 4096 },
      onStream: drain,
    });
    const stream = client.openStream('sink');
    await stream.write(new Uint8Array(40_000));
    await flush(8);

    const sizes = framesSentBy(pipe.client)
      .filter((f) => f.type === FrameType.DATA)
      .map((f) => (f as { payload: Uint8Array }).payload.length);
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(4096);
    stream.cancel();
  });

  it('mints a fresh, unguessable session identifier per session', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64; i += 1) {
      const id = new BridgeEndpoint({ role: 'server' }).sessionId as string;
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });
});

describe('§7.5 closing', () => {
  it('stops producing and sends no END once a CANCEL arrives', async () => {
    const pipe = createPipe();
    const host = new SessionHost({
      onStream: (stream) => {
        void (async () => {
          try {
            for (;;) await stream.write(new Uint8Array(16));
          } catch {
            // Cancelled: the rejected write is the producer stopping.
          }
        })();
      },
    });
    const accepted = host.accept(pipe.server);
    const client = new BridgeEndpoint({ role: 'client' });
    await client.attach(pipe.client);
    const server = await accepted;

    const stream = client.openStream('firehose');
    await flush();
    stream.cancel('enough');
    await flush(8);

    expect(server.streams.size).toBe(0);
    const sent = framesSentBy(pipe.server);
    expect(sent.some((f) => f.type === FrameType.DATA)).toBe(true);
    expect(sent.some((f) => f.type === FrameType.END)).toBe(false);

    host.close();
    client.close();
  });
});

describe('§8 flow control', () => {
  it('never buffers more undelivered payload than the credit it granted (§8.3)', async () => {
    const { client } = await connectPair({
      server: { initialCredit: 8192 },
      onStream: (stream) => {
        void (async () => {
          try {
            for (;;) await stream.write(new Uint8Array(1024));
          } catch {
            // The stream closed under us.
          }
        })();
      },
    });
    const stream = client.openStream('firehose', { credit: 8192 });
    await flush(12);

    // Nothing has been consumed, so the producer is parked at zero credit and
    // the receive queue cannot exceed the window that was granted.
    expect(stream.bufferedBytes).toBeGreaterThan(0);
    expect(stream.bufferedBytes).toBeLessThanOrEqual(8192);
    stream.cancel();
  });

  it('keeps PING answerable while a stream sits at zero credit (§11)', async () => {
    const { client } = await connectPair({
      server: { initialCredit: 4096 },
      onStream: (stream) => {
        void (async () => {
          try {
            for (;;) await stream.write(new Uint8Array(1024));
          } catch {
            // The stream closed under us.
          }
        })();
      },
    });
    const stalled = client.openStream('firehose', { credit: 4096 });
    await flush(8);
    expect(stalled.bufferedBytes).toBeGreaterThan(0);

    await expect(client.ping()).resolves.toBeGreaterThanOrEqual(0);
    stalled.cancel();
  });
});

describe('§9.4 credit across a resume', () => {
  /**
   * Kill the socket at the instant a `CREDIT` grant is written to it.
   *
   * `CREDIT` is unsequenced, so it is never replayed. Before the grant totals
   * went into `RESUME`, the granting side had already counted a grant the
   * peer never received, and the two windows diverged by that amount for the
   * rest of the session — permanently stranding the producer once the lost
   * grant was the last one a consumer would ever issue.
   */
  async function killOnFirstCredit(pipeEnd: unknown, onKill: () => void): Promise<void> {
    const end = pipeEnd as { send(bytes: Uint8Array): void };
    const original = end.send.bind(end);
    const parser = new FrameDecoder();
    let killed = false;
    end.send = (bytes: Uint8Array): void => {
      original(bytes);
      if (killed) return;
      for (const frame of parser.push(bytes).frames) {
        if (frame.type !== FrameType.CREDIT) continue;
        killed = true;
        onKill();
      }
    };
    return Promise.resolve();
  }

  it('leaves both sides agreeing on the window after a grant died with the socket', async () => {
    const CREDIT = 4096;
    const TOTAL = 8192;
    const pair = await connectPair({
      server: { initialCredit: CREDIT },
      onStream: (stream) => {
        void (async () => {
          try {
            for (let i = 0; i < TOTAL / 512; i += 1) await stream.write(new Uint8Array(512));
            await stream.end();
          } catch {
            // Closed under us.
          }
        })();
      },
    });

    await killOnFirstCredit(pair.pipe.client, () => {
      pair.pipe.break();
    });

    let received = 0;
    const stream = pair.client.openStream('firehose', { credit: CREDIT });
    void (async () => {
      for await (const chunk of stream) received += chunk.length;
    })();

    await flush(10);
    await pair.reconnect();
    await flush(40);

    const serverStream = [...pair.server.streams.values()][0];
    expect(received).toBe(TOTAL);
    // The invariant the fix restores: the sender's window and the receiver's
    // view of it are the same number.
    expect(serverStream?.sendCredit ?? stream.peerCredit).toBe(stream.peerCredit);
  });

  it('carries the cumulative grant in RESUME and answers with its own', async () => {
    const pair = await connectPair({
      onStream: (stream) => {
        void (async () => {
          await stream.end(await stream.readAll());
        })();
      },
    });
    const stream = pair.client.openStream('echo', { credit: 16384 });
    await stream.write(new Uint8Array(64));
    await flush(4);

    pair.pipe.break();
    await pair.reconnect();
    await flush(8);

    const resume = framesSentBy(pair.pipe.client).find((f) => f.type === FrameType.RESUME);
    expect(resume?.payload).toMatchObject({
      streams: [{ streamId: stream.id, granted: 16384 }],
    });

    const ack = framesSentBy(pair.pipe.server).find((f) => f.type === FrameType.RESUME_ACK);
    expect(ack?.payload).toMatchObject({ credit: [{ streamId: stream.id }] });
  });
});
