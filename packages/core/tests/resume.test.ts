import { describe, expect, it } from 'vitest';

import type { BridgeStream, SequencedFrame } from '../src/index.js';
import {
  BridgeEndpoint,
  DEFAULT_REPLAY_WINDOW,
  ErrorCode,
  FrameFlags,
  FrameType,
  MAX_SEQ,
  ProtocolError,
  ReplayBuffer,
  SeqCounter,
  SeqTracker,
  SessionHost,
  SnapshotRequiredError,
  planReplay,
} from '../src/index.js';
import { connectPair } from './helpers/pair.js';
import { createPipe, flush } from './helpers/pipe.js';

function dataFrame(seq: number, size: number, streamId = 1): SequencedFrame {
  return {
    type: FrameType.DATA,
    streamId,
    seq,
    flags: FrameFlags.NONE,
    payload: new Uint8Array(size),
  };
}

describe('SeqCounter', () => {
  it('starts at zero so the first sequenced frame carries seq 1', () => {
    const counter = new SeqCounter();
    expect(counter.value).toBe(0);
    expect(counter.next()).toBe(1);
    expect(counter.next()).toBe(2);
  });

  it('refuses to wrap the u32 space', () => {
    const counter = new SeqCounter(MAX_SEQ - 1);
    expect(counter.exhausted).toBe(false);
    expect(counter.next()).toBe(MAX_SEQ);
    expect(counter.exhausted).toBe(true);
    expect(() => counter.next(7)).toThrow(
      expect.objectContaining({ code: ErrorCode.SEQ_EXHAUSTED, streamId: 7 }),
    );
  });
});

describe('SeqTracker', () => {
  it('delivers frames in order and rejects a gap on a live connection', () => {
    const tracker = new SeqTracker();
    expect(tracker.accept(1, false)).toBe('deliver');
    expect(tracker.accept(2, false)).toBe('deliver');
    expect(tracker.accept(4, false)).toBeInstanceOf(ProtocolError);
    expect(tracker.lastSeq).toBe(2);
  });

  it('discards an already-processed frame during replay instead of erroring', () => {
    const tracker = new SeqTracker(5);
    expect(tracker.accept(3, true)).toBe('discard');
    expect(tracker.accept(5, true)).toBe('discard');
    expect(tracker.accept(6, true)).toBe('deliver');
  });

  it('still rejects a forward gap during replay', () => {
    const tracker = new SeqTracker(5);
    expect(tracker.accept(8, true)).toBeInstanceOf(ProtocolError);
  });
});

describe('ReplayBuffer', () => {
  it('retains everything inside the window', () => {
    const buffer = new ReplayBuffer({ bytes: 4096, frames: 8 });
    for (let seq = 1; seq <= 5; seq += 1) buffer.append(dataFrame(seq, 10));
    expect(buffer.frameCount).toBe(5);
    expect(buffer.oldestReplaySeq).toBe(1);
    expect(buffer.highestSeq).toBe(5);
    expect(buffer.replayFrom(2).map((f) => f.seq)).toEqual([3, 4, 5]);
  });

  it('marks replayed frames with the REPLAY flag and keeps their seq', () => {
    const buffer = new ReplayBuffer();
    buffer.append(dataFrame(1, 4));
    const [replayed] = buffer.replayFrom(0);
    expect(replayed?.seq).toBe(1);
    expect((replayed?.flags ?? 0) & FrameFlags.REPLAY).toBe(FrameFlags.REPLAY);
  });

  it('evicts the oldest frame when the frame bound bites first', () => {
    const buffer = new ReplayBuffer({ bytes: 1 << 20, frames: 3 });
    for (let seq = 1; seq <= 6; seq += 1) buffer.append(dataFrame(seq, 8));
    expect(buffer.frameCount).toBe(3);
    expect(buffer.oldestReplaySeq).toBe(4);
  });

  it('evicts the oldest frame when the byte bound bites first', () => {
    // Each frame costs its 16-byte header plus payload.
    const buffer = new ReplayBuffer({ bytes: 100, frames: 1000 });
    for (let seq = 1; seq <= 10; seq += 1) buffer.append(dataFrame(seq, 34));
    expect(buffer.byteLength).toBeLessThanOrEqual(100);
    expect(buffer.frameCount).toBe(2);
  });

  it('reports the §9.4 decision for each cursor position', () => {
    const buffer = new ReplayBuffer({ bytes: 1 << 20, frames: 3 });
    for (let seq = 1; seq <= 6; seq += 1) buffer.append(dataFrame(seq, 8));
    expect(buffer.canReplayFrom(6)).toBeNull();
    expect(buffer.canReplayFrom(3)).toBeNull();
    expect(buffer.canReplayFrom(2)).toBe(ErrorCode.SNAPSHOT_REQUIRED);
    expect(buffer.canReplayFrom(7)).toBe(ErrorCode.PROTOCOL_VIOLATION);
  });

  it('treats an empty ring as caught up at the highest seq', () => {
    const buffer = new ReplayBuffer(DEFAULT_REPLAY_WINDOW);
    expect(buffer.oldestReplaySeq).toBe(1);
    buffer.append(dataFrame(1, 8));
    buffer.clear();
    expect(buffer.oldestReplaySeq).toBe(2);
    expect(buffer.canReplayFrom(1)).toBeNull();
  });
});

describe('planReplay', () => {
  it('applies the decision table across a whole RESUME request', () => {
    const fresh = new ReplayBuffer({ bytes: 1 << 20, frames: 8 });
    for (let seq = 1; seq <= 4; seq += 1) fresh.append(dataFrame(seq, 8, 1));
    const aged = new ReplayBuffer({ bytes: 1 << 20, frames: 1 });
    for (let seq = 1; seq <= 6; seq += 1) aged.append(dataFrame(seq, 8, 3));

    const plan = planReplay(
      [
        { streamId: 1, lastSeq: 2 },
        { streamId: 3, lastSeq: 1 },
        { streamId: 5, lastSeq: 0 },
      ],
      new Map([
        [1, fresh],
        [3, aged],
      ]),
    );

    expect(plan.resumed).toEqual([1]);
    expect(plan.failed).toEqual([
      { streamId: 3, code: ErrorCode.SNAPSHOT_REQUIRED },
      { streamId: 5, code: ErrorCode.STREAM_CLOSED },
    ]);
    expect(plan.cursors.get(1)).toBe(2);
  });
});

describe('resume over a broken connection', () => {
  it('delivers every byte exactly once, in order, across a reconnect', async () => {
    const chunkCount = 64;
    const chunkSize = 100;
    let served!: BridgeStream;
    const pair = await connectPair({
      client: { initialCredit: 1 << 20 },
      server: { initialCredit: 1 << 20, resumeWindow: { bytes: 1 << 20, frames: 512 } },
      onStream: (stream) => {
        served = stream;
      },
    });

    const stream = pair.client.openStream('bulk');
    await flush();

    // Every chunk is stamped with its index, so a duplicate or a gap is
    // visible in the assertion rather than merely in the byte count.
    const producer = (async () => {
      for (let i = 0; i < chunkCount; i += 1) {
        const chunk = new Uint8Array(chunkSize).fill(i & 0xff);
        await served.write(chunk);
      }
      await served.end();
    })();

    const received: number[] = [];
    const reader = stream[Symbol.asyncIterator]();
    let bytes = 0;
    let broken = false;
    for (;;) {
      const next = await reader.next();
      if (next.done === true) break;
      for (const byte of next.value) received.push(byte);
      bytes += next.value.length;
      if (!broken && bytes >= chunkSize * 8) {
        broken = true;
        pair.pipe.break();
        await flush();
        await pair.reconnect();
      }
    }

    await producer;
    expect(broken).toBe(true);
    expect(bytes).toBe(chunkCount * chunkSize);
    const expected: number[] = [];
    for (let i = 0; i < chunkCount; i += 1) {
      for (let j = 0; j < chunkSize; j += 1) expected.push(i & 0xff);
    }
    expect(received).toEqual(expected);
    expect(stream.state).toBe('half-closed-remote');
  });

  it('reports SNAPSHOT_REQUIRED when the cursor aged out of the ring', async () => {
    let served!: BridgeStream;
    const pair = await connectPair({
      client: { initialCredit: 1 << 20 },
      server: { initialCredit: 1 << 20, resumeWindow: { bytes: 160, frames: 2 } },
      onStream: (stream) => {
        served = stream;
      },
    });

    const stream = pair.client.openStream('aging');
    await flush();
    await served.write(new Uint8Array(32).fill(1));
    await flush();
    expect(stream.bufferedBytes).toBe(32);

    pair.pipe.break();
    await flush();

    // Everything written now lands only in the ring, which is too small to
    // hold it all: the client cursor falls off the back.
    for (let i = 0; i < 6; i += 1) await served.write(new Uint8Array(32).fill(i + 2));
    await flush();

    await pair.reconnect();
    await flush();

    expect(stream.state).toBe('closed');
    expect(stream.failure).toBeInstanceOf(SnapshotRequiredError);
    expect(stream.failure?.code).toBe(ErrorCode.SNAPSHOT_REQUIRED);
  });

  it('cancels streams the client did not list in RESUME', async () => {
    const served: BridgeStream[] = [];
    const pair = await connectPair({
      onStream: (stream) => {
        served.push(stream);
      },
    });
    const keep = pair.client.openStream('keep');
    const drop = pair.client.openStream('drop');
    await flush();

    drop.cancel('no longer needed');
    pair.pipe.break();
    await flush();
    await pair.reconnect();
    await flush();

    expect(keep.state).not.toBe('closed');
    const droppedServerSide = served.find((s) => s.name === 'drop');
    expect(droppedServerSide?.state).toBe('closed');
  });

  it('reaps a closed stream once the client acknowledges its final frame', async () => {
    const pair = await connectPair({
      onStream: (stream) => {
        void stream.end(new Uint8Array([1, 2, 3]));
      },
    });
    const stream = pair.client.openStream('short');
    await stream.end();
    expect(Array.from(await stream.readAll())).toEqual([1, 2, 3]);
    await flush();
    expect(stream.state).toBe('closed');
    expect(pair.server.retainedStreams).toEqual([stream.id]);

    // The stream is closed on both sides and the client's cursor is at the
    // final seq, so the reconnect is what releases the replay buffer.
    pair.pipe.break();
    await flush();
    await pair.reconnect();
    await flush();
    expect(pair.server.retainedStreams).toEqual([]);
  });

  it('answers RESUME for an unknown session with RESUME_FAIL and allows a fresh HELLO', async () => {
    const pair = await connectPair();
    const sessionId = pair.client.sessionId;
    expect(sessionId).not.toBeNull();

    pair.pipe.break();
    await flush();
    pair.host.close();

    const next = createPipe();
    void pair.host.accept(next.server).catch(() => undefined);
    await expect(pair.client.attach(next.client)).rejects.toMatchObject({
      code: ErrorCode.SESSION_UNKNOWN,
    });

    const outcome = await pair.client.renegotiate();
    expect(outcome.kind).toBe('hello');
    expect(pair.client.sessionId).not.toBe(sessionId);
    expect(pair.client.state).toBe('open');
  });

  it('reaps a session once it has been detached longer than the TTL', async () => {
    let clock = 1_000;
    const pipe = createPipe();
    const host = new SessionHost({ now: () => clock });
    void host.accept(pipe.server);
    const client = new BridgeEndpoint({ role: 'client' });
    await client.attach(pipe.client);
    const sessionId = client.sessionId as string;
    expect(host.get(sessionId)).toBeDefined();

    pipe.break();
    await flush();
    expect(host.reap(60_000)).toEqual([]);

    clock += 60_001;
    expect(host.reap(60_000)).toEqual([sessionId]);
    expect(host.get(sessionId)).toBeUndefined();
  });
});
