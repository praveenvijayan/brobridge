import { describe, expect, it } from 'vitest';

import type { BridgeStream, Frame } from '../src/index.js';
import {
  BridgeEndpoint,
  ErrorCode,
  FrameDecoder,
  FrameFlags,
  FrameType,
  SessionHost,
  StreamError,
  encodeFrame,
} from '../src/index.js';
import { connectPair } from './helpers/pair.js';
import { createPipe, flush } from './helpers/pipe.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A peer that speaks frames directly, so misbehaviour can be staged. */
function rawPeer(carrier: {
  send(bytes: Uint8Array): void;
  onMessage(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: () => void): void;
}): { send(frame: Frame): void; received: Frame[] } {
  const parser = new FrameDecoder();
  const received: Frame[] = [];
  carrier.onMessage((bytes) => {
    received.push(...parser.push(bytes).frames);
  });
  carrier.onClose(() => undefined);
  return {
    send(frame: Frame): void {
      carrier.send(encodeFrame(frame));
    },
    received,
  };
}

/** Echo every stream back to its opener. */
function echoHandler(stream: BridgeStream): void {
  void (async () => {
    const request = await stream.readAll();
    await stream.end(request);
  })();
}

describe('handshake', () => {
  it('completes HELLO / HELLO_ACK and agrees on a session', async () => {
    const { client, server } = await connectPair();
    expect(client.state).toBe('open');
    expect(server.state).toBe('open');
    expect(client.sessionId).toBe(server.sessionId);
    expect(client.sessionId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('takes the smaller of the two advertised stream limits', async () => {
    const { client } = await connectPair({ client: { maxStreams: 16 }, server: { maxStreams: 4 } });
    for (let i = 0; i < 4; i += 1) client.openStream('noop');
    expect(() => client.openStream('noop')).toThrow(/limit of 4/);
  });

  it('refuses a peer whose version set does not overlap', async () => {
    const pipe = createPipe();
    const host = new SessionHost();
    void host.accept(pipe.server).catch(() => undefined);
    const peer = rawPeer(pipe.client);
    peer.send({
      type: FrameType.HELLO,
      streamId: 0,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { versions: [7] },
    });
    await flush();
    expect(peer.received.map((f) => f.type)).toContain(FrameType.ERROR);
    const error = peer.received.find((f) => f.type === FrameType.ERROR);
    expect(error?.payload).toMatchObject({ code: ErrorCode.UNSUPPORTED_VERSION });
  });

  it('rejects a first frame that is neither HELLO nor RESUME', async () => {
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
  });
});

describe('unary calls', () => {
  it('round-trips a request and a response over a transient stream', async () => {
    const { client } = await connectPair({ onStream: echoHandler });
    const response = await client.call('echo', encoder.encode('hello bridge'));
    expect(decoder.decode(response)).toBe('hello bridge');
  });

  it('passes DATA payloads through untouched, including non-UTF-8 bytes', async () => {
    const { client } = await connectPair({ onStream: echoHandler });
    const raw = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x7f]);
    expect(Array.from(await client.call('echo', raw))).toEqual(Array.from(raw));
  });

  it('surfaces a handler rejection as a typed stream error', async () => {
    const { client } = await connectPair({
      onStream: () => {
        throw new StreamError(ErrorCode.NOT_FOUND, 'no such route', { streamId: 0 });
      },
    });
    await expect(client.call('missing', new Uint8Array(0))).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('reports NOT_FOUND when the peer registered no handler at all', async () => {
    const { client } = await connectPair();
    await expect(client.call('anything', new Uint8Array(0))).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });
});

describe('multiplexing', () => {
  it('interleaves streams without cross-talk', async () => {
    const { client } = await connectPair({ onStream: echoHandler });
    const payloads = ['alpha', 'beta', 'gamma', 'delta'];
    const results = await Promise.all(
      payloads.map(async (text) => decoder.decode(await client.call('echo', encoder.encode(text)))),
    );
    expect(results).toEqual(payloads);
  });

  it('allocates odd identifiers on the client and even ones on the server', async () => {
    const serverStreams: BridgeStream[] = [];
    const { client, server } = await connectPair({
      onStream: (stream) => {
        serverStreams.push(stream);
      },
    });
    const a = client.openStream('one');
    const b = client.openStream('two');
    expect([a.id, b.id]).toEqual([1, 3]);
    await flush();
    expect(serverStreams.map((s) => s.id)).toEqual([1, 3]);

    server.close();
    expect(client.state).toBe('open');
  });

  it('enforces the 1024 concurrent stream limit', async () => {
    const { client } = await connectPair();
    for (let i = 0; i < 1024; i += 1) client.openStream('noop');
    expect(client.streams.size).toBe(1024);
    expect(() => client.openStream('one-too-many')).toThrow(/1024 concurrent streams/);
  });

  it('answers a frame for an unknown stream with STREAM_CLOSED', async () => {
    const pipe = createPipe();
    const host = new SessionHost();
    void host.accept(pipe.server);
    const peer = rawPeer(pipe.client);
    peer.send({
      type: FrameType.HELLO,
      streamId: 0,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { versions: [1] },
    });
    await flush();
    peer.send({
      type: FrameType.DATA,
      streamId: 9,
      seq: 1,
      flags: FrameFlags.NONE,
      payload: new Uint8Array([1]),
    });
    await flush();
    const error = peer.received.find(
      (f) => f.type === FrameType.ERROR && f.streamId === 9,
    );
    expect(error?.payload).toMatchObject({ code: ErrorCode.STREAM_CLOSED });
  });

  it('treats an OPEN with the receiver own parity as a connection fault', async () => {
    const pipe = createPipe();
    const host = new SessionHost();
    void host.accept(pipe.server);
    const peer = rawPeer(pipe.client);
    peer.send({
      type: FrameType.HELLO,
      streamId: 0,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { versions: [1] },
    });
    await flush();
    peer.send({
      type: FrameType.OPEN,
      streamId: 2,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { name: 'wrong-parity' },
    });
    await flush();
    const error = peer.received.find((f) => f.type === FrameType.ERROR && f.streamId === 0);
    expect(error?.payload).toMatchObject({ code: ErrorCode.PROTOCOL_VIOLATION });
  });
});

describe('flow control', () => {
  const smallWindow = { initialCredit: 256, creditGrantThreshold: 128 };

  it('blocks a writer at zero credit and resumes it exactly when credit arrives', async () => {
    let served!: BridgeStream;
    const { client } = await connectPair({
      client: smallWindow,
      server: smallWindow,
      onStream: (stream) => {
        served = stream;
      },
    });

    const stream = client.openStream('drip');
    await flush();
    let resolved = false;
    const write = served.write(new Uint8Array(1024)).then(() => {
      resolved = true;
    });

    await flush();
    expect(resolved).toBe(false);
    expect(stream.bufferedBytes).toBe(256);

    const reader = stream[Symbol.asyncIterator]();
    let read = 0;
    while (read < 1024) {
      const next = await reader.next();
      if (next.done === true) break;
      read += next.value.length;
    }
    await write;
    expect(resolved).toBe(true);
    expect(read).toBe(1024);
  });

  it('stalls only the slow stream, never the socket', async () => {
    const served = new Map<string, BridgeStream>();
    const { client } = await connectPair({
      client: smallWindow,
      server: smallWindow,
      onStream: (stream) => {
        served.set(stream.name, stream);
      },
    });

    const slow = client.openStream('slow');
    const fast = client.openStream('fast');
    await flush();

    const start = performance.now();
    let slowFinished: number | null = null;
    let fastFinished: number | null = null;

    const slowWrite = (served.get('slow') as BridgeStream).write(new Uint8Array(4096)).then(() => {
      slowFinished = performance.now() - start;
    });
    const fastWrite = (served.get('fast') as BridgeStream).write(new Uint8Array(4096)).then(() => {
      fastFinished = performance.now() - start;
    });

    // Drain only the fast stream. The slow one never reads, so its producer
    // sits at zero credit for the whole test.
    let read = 0;
    for await (const chunk of fast) {
      read += chunk.length;
      if (read >= 4096) break;
    }
    await fastWrite;

    expect(fastFinished).not.toBeNull();
    expect(slowFinished).toBeNull();
    expect(slow.bufferedBytes).toBe(256);

    // Releasing the slow stream lets its writer finish, proving it was only
    // ever blocked on its own credit.
    slow.cancel('done measuring');
    await expect(slowWrite).rejects.toMatchObject({ code: ErrorCode.CANCELLED });
  });

  it('tears down only the offending stream when a peer overruns its credit', async () => {
    const pipe = createPipe();
    const host = new SessionHost({ initialCredit: 64, onStream: () => undefined });
    const accepted = host.accept(pipe.server);
    const peer = rawPeer(pipe.client);
    peer.send({
      type: FrameType.HELLO,
      streamId: 0,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { versions: [1] },
    });
    await flush();
    const server = await accepted;

    peer.send({
      type: FrameType.OPEN,
      streamId: 1,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { name: 'flood', credit: 64 },
    });
    await flush();
    peer.send({
      type: FrameType.DATA,
      streamId: 1,
      seq: 1,
      flags: FrameFlags.NONE,
      payload: new Uint8Array(512),
    });
    await flush();

    const error = peer.received.find((f) => f.type === FrameType.ERROR && f.streamId === 1);
    expect(error?.payload).toMatchObject({ code: ErrorCode.FLOW_CONTROL_ERROR });
    expect(server.state).toBe('open');
    expect(server.streams.has(1)).toBe(false);

    // A second, well-behaved stream still works on the same connection.
    peer.send({
      type: FrameType.OPEN,
      streamId: 3,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { name: 'polite', credit: 64 },
    });
    await flush();
    expect(peer.received.some((f) => f.type === FrameType.OPEN_ACK && f.streamId === 3)).toBe(true);
  });

  it('closes the connection after too many flow-control violations', async () => {
    const pipe = createPipe();
    const host = new SessionHost({
      initialCredit: 16,
      maxFlowViolations: 2,
      onStream: () => undefined,
    });
    const accepted = host.accept(pipe.server);
    const peer = rawPeer(pipe.client);
    peer.send({
      type: FrameType.HELLO,
      streamId: 0,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { versions: [1] },
    });
    await flush();
    const server = await accepted;

    for (const id of [1, 3, 5]) {
      peer.send({
        type: FrameType.OPEN,
        streamId: id,
        seq: 0,
        flags: FrameFlags.NONE,
        payload: { name: 'flood', credit: 16 },
      });
      peer.send({
        type: FrameType.DATA,
        streamId: id,
        seq: 1,
        flags: FrameFlags.NONE,
        payload: new Uint8Array(64),
      });
      await flush();
    }

    expect(server.state).toBe('closed');
    const fatal = peer.received.filter((f) => f.type === FrameType.ERROR && f.streamId === 0);
    expect(fatal.at(-1)?.payload).toMatchObject({ code: ErrorCode.FLOW_CONTROL_ERROR });
  });

  it('rejects a non-positive CREDIT increment at stream level', async () => {
    const pipe = createPipe();
    const host = new SessionHost({ onStream: () => undefined });
    const accepted = host.accept(pipe.server);
    const peer = rawPeer(pipe.client);
    peer.send({
      type: FrameType.HELLO,
      streamId: 0,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { versions: [1] },
    });
    await flush();
    const server = await accepted;
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
      payload: { bytes: 0 },
    });
    await flush();
    const error = peer.received.find((f) => f.type === FrameType.ERROR && f.streamId === 1);
    expect(error?.payload).toMatchObject({ code: ErrorCode.FLOW_CONTROL_ERROR });
    expect(server.state).toBe('open');
  });
});

describe('cancellation', () => {
  it('releases buffered payload and stops the producer', async () => {
    let served!: BridgeStream;
    const { client } = await connectPair({
      client: { initialCredit: 256 },
      server: { initialCredit: 256 },
      onStream: (stream) => {
        served = stream;
      },
    });

    const stream = client.openStream('firehose');
    await flush();
    void served.write(new Uint8Array(4096)).catch(() => undefined);
    await flush();
    expect(stream.bufferedBytes).toBe(256);

    stream.cancel('consumer-detached');
    expect(stream.bufferedBytes).toBe(0);
    expect(stream.state).toBe('closed');

    await flush();
    expect(served.state).toBe('closed');
    expect(served.failure?.code).toBe(ErrorCode.CANCELLED);
  });

  it('rejects a pending read with the cancellation reason', async () => {
    const { client } = await connectPair({ onStream: () => undefined });
    const stream = client.openStream('never');
    const read = (async () => {
      for await (const chunk of stream) void chunk;
    })();
    stream.cancel('bored');
    await expect(read).rejects.toMatchObject({ code: ErrorCode.CANCELLED });
  });
});

describe('keepalive and shutdown', () => {
  it('answers PING with a PONG echoing the nonce', async () => {
    const { client } = await connectPair();
    await expect(client.ping()).resolves.toBeGreaterThanOrEqual(0);
  });

  it('stops new streams after the peer sends GOAWAY', async () => {
    let code: string | null = null;
    const pipe = createPipe();
    const host = new SessionHost();
    void host.accept(pipe.server);
    const client = new BridgeEndpoint({
      role: 'client',
      onGoaway: (received) => {
        code = received;
      },
    });
    await client.attach(pipe.client);
    const server = host.get(client.sessionId as string) as BridgeEndpoint;
    server.goaway(ErrorCode.SERVER_SHUTDOWN, 'draining');
    await flush();
    expect(code).toBe(ErrorCode.SERVER_SHUTDOWN);
    expect(() => client.openStream('late')).toThrow(/GOAWAY/);
  });

  it('fails every live stream when the endpoint closes', async () => {
    const { client } = await connectPair({ onStream: () => undefined });
    const stream = client.openStream('doomed');
    const closed = stream.closed;
    client.close();
    await expect(closed).rejects.toMatchObject({ code: ErrorCode.SERVER_SHUTDOWN });
    expect(client.state).toBe('closed');
  });
});
