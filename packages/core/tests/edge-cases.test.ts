import { describe, expect, it, vi } from 'vitest';

import type { BridgeStream, Carrier, Frame } from '../src/index.js';
import {
  BridgeEndpoint,
  ErrorCode,
  FrameDecoder,
  FrameFlags,
  FrameType,
  MAX_CREDIT,
  SessionHost,
  encodeFrame,
  generateSessionId,
  readAll,
} from '../src/index.js';
import { connectPair } from './helpers/pair.js';
import { createPipe, flush } from './helpers/pipe.js';

/** A server that has completed HELLO with a hand-driven peer. */
async function serverWithRawPeer(options?: {
  initialCredit?: number;
  onStream?: (stream: BridgeStream) => void;
}): Promise<{
  server: BridgeEndpoint;
  send(frame: Frame): void;
  received: Frame[];
  carrier: Carrier;
}> {
  const pipe = createPipe();
  const host = new SessionHost({
    ...(options?.initialCredit === undefined ? {} : { initialCredit: options.initialCredit }),
    ...(options?.onStream === undefined ? {} : { onStream: options.onStream }),
  });
  const accepted = host.accept(pipe.server);
  const parser = new FrameDecoder();
  const received: Frame[] = [];
  pipe.client.onMessage((bytes) => {
    received.push(...parser.push(bytes).frames);
  });
  pipe.client.onClose(() => undefined);
  const send = (frame: Frame): void => {
    pipe.client.send(encodeFrame(frame));
  };
  send({
    type: FrameType.HELLO,
    streamId: 0,
    seq: 0,
    flags: FrameFlags.NONE,
    payload: { versions: [1] },
  });
  await flush();
  return { server: await accepted, send, received, carrier: pipe.client };
}

function errorFor(frames: readonly Frame[], streamId: number): Frame | undefined {
  return [...frames].reverse().find((f) => f.type === FrameType.ERROR && f.streamId === streamId);
}

describe('stream write guards', () => {
  it('rejects a second end() on the same direction', async () => {
    const { client } = await connectPair({ onStream: () => undefined });
    const stream = client.openStream('once');
    await stream.end();
    await expect(stream.end()).rejects.toMatchObject({ code: ErrorCode.STREAM_STATE_ERROR });
  });

  it('rejects a write on a stream the caller declared read-only', async () => {
    const { client } = await connectPair({ onStream: () => undefined });
    const stream = client.openStream('inbound', { mode: 'read' });
    await expect(stream.write(new Uint8Array(1))).rejects.toMatchObject({
      code: ErrorCode.STREAM_STATE_ERROR,
    });
  });

  it('rejects a write on a cancelled stream with the original failure', async () => {
    const { client } = await connectPair({ onStream: () => undefined });
    const stream = client.openStream('doomed');
    stream.cancel('gone');
    await expect(stream.write(new Uint8Array(1))).rejects.toMatchObject({
      code: ErrorCode.CANCELLED,
    });
  });

  it('exposes both credit windows and resolves opened on OPEN_ACK', async () => {
    const { client } = await connectPair({
      client: { initialCredit: 512 },
      server: { initialCredit: 512 },
      onStream: () => undefined,
    });
    const stream = client.openStream('windows');
    expect(stream.sendCredit).toBe(512);
    expect(stream.peerCredit).toBe(512);
    await expect(stream.opened).resolves.toBeUndefined();
  });

  it('reads a whole stream through the readAll helper', async () => {
    const { client } = await connectPair({
      onStream: (stream) => {
        void stream.end(new Uint8Array([1, 2, 3]));
      },
    });
    const stream = client.openStream('bytes');
    expect(Array.from(await readAll(stream))).toEqual([1, 2, 3]);
  });
});

describe('stream state faults', () => {
  it('rejects a second OPEN_ACK', async () => {
    const pipe = createPipe();
    const host = new SessionHost({ onStream: () => undefined });
    void host.accept(pipe.server);
    const client = new BridgeEndpoint({ role: 'client' });
    await client.attach(pipe.client);
    const stream = client.openStream('acked');
    await flush();

    // The server already acknowledged the OPEN; a second one is the fault.
    const server = host.get(client.sessionId as string) as BridgeEndpoint;
    const raw = pipe.server;
    raw.send(
      encodeFrame({
        type: FrameType.OPEN_ACK,
        streamId: stream.id,
        seq: 0,
        flags: FrameFlags.NONE,
        payload: {},
      }),
    );
    await flush();
    expect(stream.failure?.code).toBe(ErrorCode.STREAM_STATE_ERROR);
    expect(client.state).toBe('open');
    expect(server.state).toBe('open');
  });

  it('rejects DATA after the peer ended its direction', async () => {
    const peer = await serverWithRawPeer({ onStream: () => undefined });
    peer.send({
      type: FrameType.OPEN,
      streamId: 1,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { name: 'x' },
    });
    peer.send({
      type: FrameType.END,
      streamId: 1,
      seq: 1,
      flags: FrameFlags.NONE,
      payload: {},
    });
    await flush();
    peer.send({
      type: FrameType.DATA,
      streamId: 1,
      seq: 2,
      flags: FrameFlags.NONE,
      payload: new Uint8Array([1]),
    });
    await flush();
    expect(errorFor(peer.received, 1)?.payload).toMatchObject({
      code: ErrorCode.STREAM_STATE_ERROR,
    });
  });

  it('rejects a duplicate END', async () => {
    const peer = await serverWithRawPeer({ onStream: () => undefined });
    peer.send({
      type: FrameType.OPEN,
      streamId: 1,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { name: 'x' },
    });
    peer.send({ type: FrameType.END, streamId: 1, seq: 1, flags: FrameFlags.NONE, payload: {} });
    await flush();
    peer.send({ type: FrameType.END, streamId: 1, seq: 2, flags: FrameFlags.NONE, payload: {} });
    await flush();
    expect(errorFor(peer.received, 1)?.payload).toMatchObject({
      code: ErrorCode.STREAM_STATE_ERROR,
    });
  });

  it('rejects a seq gap on a live connection', async () => {
    const peer = await serverWithRawPeer({ onStream: () => undefined });
    peer.send({
      type: FrameType.OPEN,
      streamId: 1,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { name: 'x' },
    });
    await flush();
    peer.send({
      type: FrameType.DATA,
      streamId: 1,
      seq: 4,
      flags: FrameFlags.NONE,
      payload: new Uint8Array([1]),
    });
    await flush();
    expect(errorFor(peer.received, 1)?.payload).toMatchObject({
      code: ErrorCode.PROTOCOL_VIOLATION,
    });
  });

  it('rejects a CREDIT grant that would overflow the window', async () => {
    const peer = await serverWithRawPeer({ onStream: () => undefined });
    peer.send({
      type: FrameType.OPEN,
      streamId: 1,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { name: 'x' },
    });
    await flush();
    peer.send({
      type: FrameType.CREDIT,
      streamId: 1,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { bytes: MAX_CREDIT },
    });
    await flush();
    expect(errorFor(peer.received, 1)?.payload).toMatchObject({
      code: ErrorCode.FLOW_CONTROL_ERROR,
    });
  });

  it('refuses to reuse a stream identifier', async () => {
    const peer = await serverWithRawPeer({ onStream: () => undefined });
    for (let i = 0; i < 2; i += 1) {
      peer.send({
        type: FrameType.OPEN,
        streamId: 1,
        seq: 0,
        flags: FrameFlags.NONE,
        payload: { name: 'x' },
      });
      await flush();
    }
    expect(errorFor(peer.received, 1)?.payload).toMatchObject({
      code: ErrorCode.STREAM_STATE_ERROR,
    });
  });

  it('rejects an OPEN past the negotiated stream limit', async () => {
    const pipe = createPipe();
    const host = new SessionHost({ maxStreams: 1, onStream: () => undefined });
    void host.accept(pipe.server);
    const parser = new FrameDecoder();
    const received: Frame[] = [];
    pipe.client.onMessage((bytes) => {
      received.push(...parser.push(bytes).frames);
    });
    pipe.client.onClose(() => undefined);
    const send = (frame: Frame): void => {
      pipe.client.send(encodeFrame(frame));
    };
    send({
      type: FrameType.HELLO,
      streamId: 0,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { versions: [1] },
    });
    await flush();
    for (const id of [1, 3]) {
      send({
        type: FrameType.OPEN,
        streamId: id,
        seq: 0,
        flags: FrameFlags.NONE,
        payload: { name: 'x' },
      });
      await flush();
    }
    expect(errorFor(received, 3)?.payload).toMatchObject({
      code: ErrorCode.STREAM_LIMIT_EXCEEDED,
    });
  });

  it('turns a handler that throws a plain Error into INTERNAL_ERROR', async () => {
    const peer = await serverWithRawPeer({
      onStream: () => {
        throw new Error('boom');
      },
    });
    peer.send({
      type: FrameType.OPEN,
      streamId: 1,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { name: 'x' },
    });
    await flush();
    expect(errorFor(peer.received, 1)?.payload).toMatchObject({
      code: ErrorCode.INTERNAL_ERROR,
    });
  });

  it('answers a frame for a closed but unreaped stream with STREAM_STATE_ERROR', async () => {
    const peer = await serverWithRawPeer({
      onStream: (stream) => {
        void stream.end();
      },
    });
    peer.send({
      type: FrameType.OPEN,
      streamId: 1,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { name: 'brief' },
    });
    peer.send({ type: FrameType.END, streamId: 1, seq: 1, flags: FrameFlags.NONE, payload: {} });
    await flush();
    expect(peer.server.streams.has(1)).toBe(false);

    peer.send({
      type: FrameType.DATA,
      streamId: 1,
      seq: 2,
      flags: FrameFlags.NONE,
      payload: new Uint8Array([1]),
    });
    await flush();
    expect(errorFor(peer.received, 1)?.payload).toMatchObject({
      code: ErrorCode.STREAM_STATE_ERROR,
    });
  });

  it('discards CREDIT, CANCEL and ERROR for an unknown stream', async () => {
    const peer = await serverWithRawPeer({ onStream: () => undefined });
    const before = peer.received.length;
    for (const frame of [
      { type: FrameType.CREDIT, payload: { bytes: 4 } },
      { type: FrameType.CANCEL, payload: {} },
      { type: FrameType.ERROR, payload: { code: ErrorCode.CANCELLED } },
    ] as const) {
      peer.send({ ...frame, streamId: 99, seq: 0, flags: FrameFlags.NONE } as Frame);
    }
    await flush();
    expect(peer.received.length).toBe(before);
    expect(peer.server.state).toBe('open');
  });
});

describe('connection faults', () => {
  it('closes when the peer sends a connection-scoped ERROR', async () => {
    const peer = await serverWithRawPeer();
    peer.send({
      type: FrameType.ERROR,
      streamId: 0,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { code: ErrorCode.INTERNAL_ERROR, message: 'client gave up' },
    });
    await flush();
    expect(peer.server.state).toBe('closed');
    expect(peer.server.closeError?.code).toBe(ErrorCode.INTERNAL_ERROR);
  });

  it('rejects a second HELLO on an established connection', async () => {
    const peer = await serverWithRawPeer();
    peer.send({
      type: FrameType.HELLO,
      streamId: 0,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { versions: [1] },
    });
    await flush();
    expect(errorFor(peer.received, 0)?.payload).toMatchObject({
      code: ErrorCode.PROTOCOL_VIOLATION,
    });
  });

  it('rejects RESUME once a session is already established', async () => {
    const peer = await serverWithRawPeer();
    peer.send({
      type: FrameType.RESUME,
      streamId: 0,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { sessionId: 'whatever', streams: [] },
    });
    await flush();
    expect(errorFor(peer.received, 0)?.payload).toMatchObject({
      code: ErrorCode.PROTOCOL_VIOLATION,
    });
  });

  it('rejects a stream frame that arrives before the handshake', async () => {
    const pipe = createPipe();
    const server = new BridgeEndpoint({ role: 'server' });
    const parser = new FrameDecoder();
    const received: Frame[] = [];
    pipe.client.onMessage((bytes) => {
      received.push(...parser.push(bytes).frames);
    });
    pipe.client.onClose(() => undefined);
    void server.attach(pipe.server).catch(() => undefined);
    pipe.client.send(
      encodeFrame({
        type: FrameType.DATA,
        streamId: 1,
        seq: 1,
        flags: FrameFlags.NONE,
        payload: new Uint8Array([1]),
      }),
    );
    await flush();
    expect(errorFor(received, 0)?.payload).toMatchObject({ code: ErrorCode.PROTOCOL_VIOLATION });
    expect(server.state).toBe('closed');
  });

  it.each([
    ['an unexpected HELLO_ACK', FrameType.HELLO_ACK],
    ['an unexpected RESUME_ACK', FrameType.RESUME_ACK],
  ])('treats %s from a client as a protocol violation', async (_label, type) => {
    const pipe = createPipe();
    const client = new BridgeEndpoint({ role: 'client' });
    const parser = new FrameDecoder();
    const received: Frame[] = [];
    pipe.server.onMessage((bytes) => {
      received.push(...parser.push(bytes).frames);
    });
    pipe.server.onClose(() => undefined);
    const attached = client.attach(pipe.client);
    await flush();
    const payload =
      type === FrameType.HELLO_ACK
        ? {
            version: 1,
            sessionId: 's',
            maxFrameSize: 1024,
            maxStreams: 8,
            initialCredit: 64,
            resumeWindow: { bytes: 64, frames: 4 },
            heartbeatMs: 1000,
          }
        : { sessionId: 's', resumed: [], failed: [] };
    pipe.server.send(
      encodeFrame({ type, streamId: 0, seq: 0, flags: FrameFlags.NONE, payload } as Frame),
    );
    await flush();
    if (type === FrameType.HELLO_ACK) {
      await expect(attached).resolves.toMatchObject({ kind: 'hello' });
    } else {
      await expect(attached).rejects.toBeDefined();
      expect(errorFor(received, 0)?.payload).toMatchObject({
        code: ErrorCode.PROTOCOL_VIOLATION,
      });
    }
  });

  it('rejects a server that advertises a maxFrameSize above the hard maximum', async () => {
    const pipe = createPipe();
    const client = new BridgeEndpoint({ role: 'client' });
    pipe.server.onMessage(() => {
      pipe.server.send(
        encodeFrame({
          type: FrameType.HELLO_ACK,
          streamId: 0,
          seq: 0,
          flags: FrameFlags.NONE,
          payload: {
            version: 1,
            sessionId: 'oversized',
            maxFrameSize: 1 << 30,
            maxStreams: 8,
            initialCredit: 64,
            resumeWindow: { bytes: 64, frames: 4 },
            heartbeatMs: 1000,
          },
        }),
      );
    });
    pipe.server.onClose(() => undefined);
    await expect(client.attach(pipe.client)).rejects.toMatchObject({
      code: ErrorCode.PROTOCOL_VIOLATION,
    });
  });

  it('rejects a server that selects a version it was never offered', async () => {
    const pipe = createPipe();
    const client = new BridgeEndpoint({ role: 'client' });
    pipe.server.onMessage(() => {
      pipe.server.send(
        encodeFrame({
          type: FrameType.HELLO_ACK,
          streamId: 0,
          seq: 0,
          flags: FrameFlags.NONE,
          payload: {
            version: 2,
            sessionId: 'future',
            maxFrameSize: 1024,
            maxStreams: 8,
            initialCredit: 64,
            resumeWindow: { bytes: 64, frames: 4 },
            heartbeatMs: 1000,
          },
        }),
      );
    });
    pipe.server.onClose(() => undefined);
    await expect(client.attach(pipe.client)).rejects.toMatchObject({
      code: ErrorCode.UNSUPPORTED_VERSION,
    });
  });
});

describe('detached endpoints', () => {
  it('refuses to open streams, ping or renegotiate without a carrier', async () => {
    const pair = await connectPair({ onStream: () => undefined });
    pair.pipe.break();
    await flush();

    expect(pair.client.state).toBe('detached');
    expect(() => pair.client.openStream('late')).toThrow(/detached/);
    await expect(pair.client.ping()).rejects.toMatchObject({ code: ErrorCode.INTERNAL_ERROR });
    expect(pair.server.attached).toBe(false);
  });

  it('refuses to renegotiate on the server side', async () => {
    const { server } = await connectPair();
    await expect(server.renegotiate()).rejects.toMatchObject({ code: ErrorCode.INTERNAL_ERROR });
  });

  it('refuses to attach a closed endpoint', async () => {
    const client = new BridgeEndpoint({ role: 'client' });
    client.close();
    await expect(client.attach(createPipe().client)).rejects.toMatchObject({
      code: ErrorCode.INTERNAL_ERROR,
    });
  });

  it('holds client writes while detached and flushes them after RESUME', async () => {
    const seen: number[] = [];
    const pair = await connectPair({
      onStream: (stream) => {
        void (async () => {
          for await (const chunk of stream) seen.push(...chunk);
        })();
      },
    });
    const stream = pair.client.openStream('outbound');
    await flush();

    pair.pipe.break();
    await flush();
    await stream.write(new Uint8Array([7, 8, 9]));
    expect(seen).toEqual([]);

    await pair.reconnect();
    await flush();
    expect(seen).toEqual([7, 8, 9]);
  });

  it('drops unsequenced frames raised while detached rather than queueing them', async () => {
    const pair = await connectPair({ onStream: () => undefined });
    const stream = pair.client.openStream('cancelled-offline');
    await flush();
    pair.pipe.break();
    await flush();
    stream.cancel('offline');
    expect(stream.state).toBe('closed');
    expect(pair.client.state).toBe('detached');
  });
});

describe('generateSessionId', () => {
  it('produces 128 bits of hex', () => {
    const first = generateSessionId();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(generateSessionId()).not.toBe(first);
  });

  it('fails loudly when the runtime has no Web Crypto', () => {
    vi.stubGlobal('crypto', undefined);
    try {
      expect(() => generateSessionId()).toThrow(/Web Crypto/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
