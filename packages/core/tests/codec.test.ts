import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  FRAME_HEADER_SIZE,
  FrameDecoder,
  FrameFlags,
  FrameType,
  HARD_MAX_FRAME_SIZE,
  PROTOCOL_VERSION,
  ProtocolError,
  decodeFrame,
  encodeFrame,
} from '../src/index.js';
import type { Frame } from '../src/index.js';
import { isSequencedType } from '../src/index.js';

describe('frame classification', () => {
  it('marks only DATA and END as sequenced', () => {
    expect(isSequencedType(FrameType.DATA)).toBe(true);
    expect(isSequencedType(FrameType.END)).toBe(true);
    expect(isSequencedType(FrameType.CREDIT)).toBe(false);
    expect(isSequencedType(FrameType.PING)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  Arbitraries                                                                */
/* -------------------------------------------------------------------------- */

const u32 = fc.integer({ min: 0, max: 0xffff_ffff });
const streamId = fc.integer({ min: 1, max: 0xffff_ffff });
const flags = fc.constantFrom(FrameFlags.NONE, FrameFlags.FIN, FrameFlags.REPLAY);
const bytes = fc.uint8Array({ maxLength: 512 });

/** Only include an optional member when it is present, never as `undefined`. */
function optional<T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> {
  return fc.option(arb, { nil: undefined });
}

function spread<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : ({ [key]: value } as Record<string, T>);
}

const arbFrame: fc.Arbitrary<Frame> = fc.oneof(
  fc
    .record({
      seq: u32,
      flags,
      versions: fc.array(fc.integer({ min: 0, max: 8 }), { maxLength: 4 }),
      maxFrameSize: optional(fc.integer({ min: 0, max: HARD_MAX_FRAME_SIZE })),
      client: optional(fc.string()),
    })
    .map(
      (r): Frame => ({
        type: FrameType.HELLO,
        streamId: 0,
        seq: r.seq,
        flags: r.flags,
        payload: {
          versions: r.versions,
          ...spread('maxFrameSize', r.maxFrameSize),
          ...spread('client', r.client),
        },
      }),
    ),
  fc
    .record({
      seq: u32,
      flags,
      sessionId: fc.string({ minLength: 1, maxLength: 40 }),
      initialCredit: fc.integer({ min: 0, max: 1 << 20 }),
    })
    .map(
      (r): Frame => ({
        type: FrameType.HELLO_ACK,
        streamId: 0,
        seq: r.seq,
        flags: r.flags,
        payload: {
          version: PROTOCOL_VERSION,
          sessionId: r.sessionId,
          maxFrameSize: HARD_MAX_FRAME_SIZE,
          maxStreams: 1024,
          initialCredit: r.initialCredit,
          resumeWindow: { bytes: 1024, frames: 8 },
          heartbeatMs: 30_000,
        },
      }),
    ),
  fc
    .record({
      streamId,
      flags,
      name: fc.string({ maxLength: 32 }),
      mode: optional(fc.constantFrom('read' as const, 'write' as const, 'duplex' as const)),
      credit: optional(fc.integer({ min: 0, max: 1 << 20 })),
    })
    .map(
      (r): Frame => ({
        type: FrameType.OPEN,
        streamId: r.streamId,
        seq: 0,
        flags: r.flags,
        payload: { name: r.name, ...spread('mode', r.mode), ...spread('credit', r.credit) },
      }),
    ),
  fc.record({ streamId, flags, seq: u32, payload: bytes }).map(
    (r): Frame => ({
      type: FrameType.DATA,
      streamId: r.streamId,
      seq: r.seq,
      flags: r.flags,
      payload: r.payload,
    }),
  ),
  fc.record({ streamId, flags, bytes: fc.integer({ min: 1, max: 1 << 20 }) }).map(
    (r): Frame => ({
      type: FrameType.CREDIT,
      streamId: r.streamId,
      seq: 0,
      flags: r.flags,
      payload: { bytes: r.bytes },
    }),
  ),
  fc.record({ streamId, flags, seq: u32 }).map(
    (r): Frame => ({
      type: FrameType.END,
      streamId: r.streamId,
      seq: r.seq,
      flags: r.flags,
      payload: {},
    }),
  ),
  fc
    .record({ streamId, flags, code: fc.string({ minLength: 1 }), message: optional(fc.string()) })
    .map(
      (r): Frame => ({
        type: FrameType.ERROR,
        streamId: r.streamId,
        seq: 0,
        flags: r.flags,
        payload: { code: r.code, ...spread('message', r.message) },
      }),
    ),
  fc.record({ streamId, flags, reason: optional(fc.string()) }).map(
    (r): Frame => ({
      type: FrameType.CANCEL,
      streamId: r.streamId,
      seq: 0,
      flags: r.flags,
      payload: { ...spread('reason', r.reason) },
    }),
  ),
  fc
    .record({
      sessionId: fc.string({ minLength: 1, maxLength: 40 }),
      streams: fc.array(fc.record({ streamId, lastSeq: u32 }), { maxLength: 6 }),
    })
    .map(
      (r): Frame => ({
        type: FrameType.RESUME,
        streamId: 0,
        seq: 0,
        flags: FrameFlags.NONE,
        payload: { sessionId: r.sessionId, streams: r.streams },
      }),
    ),
  fc
    .record({
      sessionId: fc.string({ minLength: 1, maxLength: 40 }),
      resumed: fc.array(streamId, { maxLength: 6 }),
      failed: fc.array(fc.record({ streamId, code: fc.string({ minLength: 1 }) }), { maxLength: 3 }),
    })
    .map(
      (r): Frame => ({
        type: FrameType.RESUME_ACK,
        streamId: 0,
        seq: 0,
        flags: FrameFlags.NONE,
        payload: { sessionId: r.sessionId, resumed: r.resumed, failed: r.failed },
      }),
    ),
  fc.constantFrom('SESSION_UNKNOWN' as const, 'SESSION_EXPIRED' as const).map(
    (code): Frame => ({
      type: FrameType.RESUME_FAIL,
      streamId: 0,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { code },
    }),
  ),
  fc.record({ nonce: fc.string({ maxLength: 24 }), at: optional(fc.nat()) }).map(
    (r): Frame => ({
      type: FrameType.PING,
      streamId: 0,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { nonce: r.nonce, ...spread('at', r.at) },
    }),
  ),
  fc.record({ nonce: fc.string({ maxLength: 24 }) }).map(
    (r): Frame => ({
      type: FrameType.PONG,
      streamId: 0,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { nonce: r.nonce },
    }),
  ),
  fc.record({ code: fc.string({ minLength: 1 }), lastStreamId: u32 }).map(
    (r): Frame => ({
      type: FrameType.GOAWAY,
      streamId: 0,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { code: r.code, lastStreamId: r.lastStreamId },
    }),
  ),
  fc.record({ streamId, credit: optional(fc.integer({ min: 0, max: 1 << 20 })) }).map(
    (r): Frame => ({
      type: FrameType.OPEN_ACK,
      streamId: r.streamId,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { ...spread('credit', r.credit) },
    }),
  ),
);

/** Split `bytes` at the given cut points. */
function chunk(bytes: Uint8Array, cuts: readonly number[]): Uint8Array[] {
  const points = [...new Set(cuts.filter((c) => c > 0 && c < bytes.length))].sort((a, b) => a - b);
  const out: Uint8Array[] = [];
  let start = 0;
  for (const point of [...points, bytes.length]) {
    out.push(bytes.subarray(start, point));
    start = point;
  }
  return out.length === 0 ? [bytes] : out;
}

/** Compare frames ignoring the `seq` of frames the protocol says are unsequenced. */
function normalise(frame: Frame): unknown {
  return {
    type: frame.type,
    streamId: frame.streamId,
    seq: frame.seq,
    flags: frame.flags,
    payload:
      frame.payload instanceof Uint8Array ? Array.from(frame.payload) : frame.payload,
  };
}

/* -------------------------------------------------------------------------- */

describe('encodeFrame', () => {
  it('writes the header layout PROTOCOL.md §3 specifies', () => {
    const encoded = encodeFrame({
      type: FrameType.DATA,
      streamId: 0x0a0b0c0d,
      seq: 7,
      flags: FrameFlags.FIN,
      payload: new Uint8Array([1, 2, 3]),
    });
    const view = new DataView(encoded.buffer);
    expect(encoded[0]).toBe(PROTOCOL_VERSION);
    expect(encoded[1]).toBe(FrameType.DATA);
    expect(encoded[2]).toBe(FrameFlags.FIN);
    expect(encoded[3]).toBe(0);
    expect(view.getUint32(4, true)).toBe(0x0a0b0c0d);
    expect(view.getUint32(8, true)).toBe(7);
    expect(view.getUint32(12, true)).toBe(3);
    expect(encoded.length).toBe(FRAME_HEADER_SIZE + 3);
  });

  it('refuses to emit a frame larger than the effective limit', () => {
    expect(() =>
      encodeFrame(
        {
          type: FrameType.DATA,
          streamId: 1,
          seq: 1,
          flags: FrameFlags.NONE,
          payload: new Uint8Array(64),
        },
        { maxFrameSize: 16 },
      ),
    ).toThrow(ProtocolError);
  });
});

describe('FrameDecoder round-trip', () => {
  it('survives encode -> arbitrary chunk split -> decode', () => {
    fc.assert(
      fc.property(fc.array(arbFrame, { minLength: 1, maxLength: 8 }), fc.array(fc.nat()), (frames, cuts) => {
        const encoded = frames.map((frame) => encodeFrame(frame));
        const total = new Uint8Array(encoded.reduce((n, f) => n + f.length, 0));
        let offset = 0;
        for (const frame of encoded) {
          total.set(frame, offset);
          offset += frame.length;
        }

        const decoder = new FrameDecoder();
        const decoded: Frame[] = [];
        for (const piece of chunk(total, cuts)) {
          const result = decoder.push(piece);
          expect(result.error).toBeNull();
          decoded.push(...result.frames);
        }
        expect(decoder.hasPartialFrame).toBe(false);
        expect(decoded.map(normalise)).toEqual(frames.map(normalise));
      }),
      { numRuns: 300 },
    );
  });

  it('accepts many frames in a single chunk and a frame split byte by byte', () => {
    const frame: Frame = {
      type: FrameType.DATA,
      streamId: 3,
      seq: 1,
      flags: FrameFlags.NONE,
      payload: new Uint8Array([9, 8, 7, 6, 5]),
    };
    const encoded = encodeFrame(frame);
    const decoder = new FrameDecoder();
    const decoded: Frame[] = [];
    for (const byte of encoded) {
      decoded.push(...decoder.push(new Uint8Array([byte])).frames);
    }
    expect(decoded).toHaveLength(1);
    expect(normalise(decoded[0] as Frame)).toEqual(normalise(frame));
  });
});

describe('FrameDecoder fuzz', () => {
  it('never throws on random bytes; it parses or reports a ProtocolError', () => {
    let parsed = 0;
    let rejected = 0;
    for (let run = 0; run < 10_000; run += 1) {
      const size = 1 + Math.floor(Math.random() * 96);
      const buffer = new Uint8Array(size);
      for (let i = 0; i < size; i += 1) buffer[i] = Math.floor(Math.random() * 256);
      const decoder = new FrameDecoder({ maxFrameSize: 4096 });
      const result = decoder.push(buffer);
      if (result.error !== null) {
        expect(result.error).toBeInstanceOf(ProtocolError);
        rejected += 1;
      } else {
        parsed += result.frames.length;
      }
    }
    expect(rejected).toBeGreaterThan(0);
    expect(parsed).toBeGreaterThanOrEqual(0);
  });

  it('rejects a version-1 header with a plausible but corrupt payload without throwing', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 0x20 }),
        fc.uint8Array({ maxLength: 64 }),
        (type, payload) => {
          const buffer = new Uint8Array(FRAME_HEADER_SIZE + payload.length);
          const view = new DataView(buffer.buffer);
          buffer[0] = PROTOCOL_VERSION;
          buffer[1] = type;
          view.setUint32(4, 1, true);
          view.setUint32(12, payload.length, true);
          buffer.set(payload, FRAME_HEADER_SIZE);
          const result = new FrameDecoder().push(buffer);
          expect(result.error === null || result.error instanceof ProtocolError).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('FrameDecoder limits', () => {
  function header(overrides: {
    version?: number;
    type?: number;
    streamId?: number;
    length?: number;
  }): Uint8Array {
    const buffer = new Uint8Array(FRAME_HEADER_SIZE);
    const view = new DataView(buffer.buffer);
    buffer[0] = overrides.version ?? PROTOCOL_VERSION;
    buffer[1] = overrides.type ?? FrameType.DATA;
    view.setUint32(4, overrides.streamId ?? 1, true);
    view.setUint32(12, overrides.length ?? 0, true);
    return buffer;
  }

  it('rejects an unsupported wire version', () => {
    const result = new FrameDecoder().push(header({ version: 2 }));
    expect(result.error?.code).toBe('UNSUPPORTED_VERSION');
  });

  it('rejects an oversized length before allocating for it', () => {
    const result = new FrameDecoder({ maxFrameSize: 32 }).push(header({ length: 1 << 24 }));
    expect(result.error?.code).toBe('FRAME_TOO_LARGE');
  });

  it('rejects an unknown frame type', () => {
    const result = new FrameDecoder().push(header({ type: 0x7f }));
    expect(result.error?.code).toBe('PROTOCOL_VIOLATION');
  });

  it('rejects a stream frame addressed to streamId 0', () => {
    const result = new FrameDecoder().push(header({ type: FrameType.DATA, streamId: 0 }));
    expect(result.error?.code).toBe('PROTOCOL_VIOLATION');
  });

  it('rejects a connection frame addressed to a stream', () => {
    const result = new FrameDecoder().push(header({ type: FrameType.PING, streamId: 5 }));
    expect(result.error?.code).toBe('PROTOCOL_VIOLATION');
  });

  it('stays poisoned once it has reported a fault', () => {
    const decoder = new FrameDecoder();
    const first = decoder.push(header({ version: 9 }));
    expect(first.error).not.toBeNull();
    const second = decoder.push(encodeFrame({
      type: FrameType.PING,
      streamId: 0,
      seq: 0,
      flags: FrameFlags.NONE,
      payload: { nonce: 'x' },
    }));
    expect(second.frames).toHaveLength(0);
    expect(second.error).toBe(first.error);
  });

  it('never widens maxFrameSize past the protocol hard maximum', () => {
    const decoder = new FrameDecoder({ maxFrameSize: HARD_MAX_FRAME_SIZE * 4 });
    expect(decoder.maxFrameSize).toBe(HARD_MAX_FRAME_SIZE);
    decoder.setMaxFrameSize(1024);
    expect(decoder.maxFrameSize).toBe(1024);
  });
});

describe('control payload validation', () => {
  function control(type: number, json: string): Uint8Array {
    const payload = new TextEncoder().encode(json);
    const buffer = new Uint8Array(FRAME_HEADER_SIZE + payload.length);
    const view = new DataView(buffer.buffer);
    buffer[0] = PROTOCOL_VERSION;
    buffer[1] = type;
    const streamScoped = new Set<number>([
      FrameType.OPEN,
      FrameType.OPEN_ACK,
      FrameType.DATA,
      FrameType.CREDIT,
      FrameType.END,
      FrameType.CANCEL,
    ]);
    view.setUint32(4, streamScoped.has(type) ? 1 : 0, true);
    view.setUint32(12, payload.length, true);
    buffer.set(payload, FRAME_HEADER_SIZE);
    return buffer;
  }

  it.each([
    ['not JSON', FrameType.PING, '{'],
    ['not an object', FrameType.PING, '[1,2,3]'],
    ['missing nonce', FrameType.PING, '{}'],
    ['missing OPEN.name', FrameType.OPEN, '{"credit":1}'],
    ['bad OPEN.mode', FrameType.OPEN, '{"name":"x","mode":"sideways"}'],
    ['bad HELLO.versions', FrameType.HELLO, '{"versions":"one"}'],
    ['bad RESUME_FAIL.code', FrameType.RESUME_FAIL, '{"code":"NOPE"}'],
    ['bad RESUME.streams', FrameType.RESUME, '{"sessionId":"a","streams":[{}]}'],
    ['bad GOAWAY.lastStreamId', FrameType.GOAWAY, '{"code":"X","lastStreamId":-1}'],
    ['bad CREDIT.bytes type', FrameType.CREDIT, '{"bytes":"lots"}'],
  ])('rejects %s', (_label, type, json) => {
    const result = new FrameDecoder().push(control(type, json));
    expect(result.error?.code).toBe('PROTOCOL_VIOLATION');
  });

  const HELLO_ACK_BASE =
    '"version":1,"sessionId":"s","maxFrameSize":1024,"maxStreams":8,' +
    '"initialCredit":64,"resumeWindow":{"bytes":64,"frames":4},"heartbeatMs":1000';

  it.each([
    ['HELLO.maxFrameSize', FrameType.HELLO, '{"versions":[1],"maxFrameSize":-1}'],
    ['HELLO.maxStreams', FrameType.HELLO, '{"versions":[1],"maxStreams":"many"}'],
    ['HELLO.client', FrameType.HELLO, '{"versions":[1],"client":7}'],
    ['HELLO_ACK.version', FrameType.HELLO_ACK, `{${HELLO_ACK_BASE.replace('"version":1', '"version":"one"')}}`],
    ['HELLO_ACK.sessionId', FrameType.HELLO_ACK, `{${HELLO_ACK_BASE.replace('"sessionId":"s"', '"sessionId":""')}}`],
    ['HELLO_ACK.maxFrameSize', FrameType.HELLO_ACK, `{${HELLO_ACK_BASE.replace('"maxFrameSize":1024', '"maxFrameSize":null')}}`],
    ['HELLO_ACK.maxStreams', FrameType.HELLO_ACK, `{${HELLO_ACK_BASE.replace('"maxStreams":8', '"maxStreams":1.5')}}`],
    ['HELLO_ACK.initialCredit', FrameType.HELLO_ACK, `{${HELLO_ACK_BASE.replace('"initialCredit":64', '"initialCredit":-1')}}`],
    ['HELLO_ACK.heartbeatMs', FrameType.HELLO_ACK, `{${HELLO_ACK_BASE.replace('"heartbeatMs":1000', '"heartbeatMs":"soon"')}}`],
    ['HELLO_ACK.resumeWindow', FrameType.HELLO_ACK, `{${HELLO_ACK_BASE.replace('"resumeWindow":{"bytes":64,"frames":4}', '"resumeWindow":5')}}`],
    ['HELLO_ACK.resumeWindow.bytes', FrameType.HELLO_ACK, `{${HELLO_ACK_BASE.replace('"bytes":64', '"bytes":"lots"')}}`],
    ['OPEN.params', FrameType.OPEN, '{"name":"x","params":[]}'],
    ['OPEN.credit', FrameType.OPEN, '{"name":"x","credit":-4}'],
    ['OPEN_ACK.credit', FrameType.OPEN_ACK, '{"credit":"lots"}'],
    ['ERROR.code', FrameType.ERROR, '{"message":"no code"}'],
    ['ERROR.message', FrameType.ERROR, '{"code":"X","message":9}'],
    ['ERROR.retryable', FrameType.ERROR, '{"code":"X","retryable":"yes"}'],
    ['CANCEL.reason', FrameType.CANCEL, '{"reason":42}'],
    ['RESUME.sessionId', FrameType.RESUME, '{"sessionId":"","streams":[]}'],
    ['RESUME.streams type', FrameType.RESUME, '{"sessionId":"a","streams":"none"}'],
    ['RESUME_ACK.sessionId', FrameType.RESUME_ACK, '{"resumed":[],"failed":[]}'],
    ['RESUME_ACK.resumed', FrameType.RESUME_ACK, '{"sessionId":"a","resumed":"1","failed":[]}'],
    ['RESUME_ACK.failed type', FrameType.RESUME_ACK, '{"sessionId":"a","resumed":[],"failed":{}}'],
    ['RESUME_ACK.failed entry', FrameType.RESUME_ACK, '{"sessionId":"a","resumed":[],"failed":[{"streamId":1}]}'],
    ['RESUME_FAIL.message', FrameType.RESUME_FAIL, '{"code":"SESSION_UNKNOWN","message":5}'],
    ['PING.at', FrameType.PING, '{"nonce":"n","at":1.5}'],
    ['GOAWAY.code', FrameType.GOAWAY, '{"lastStreamId":1}'],
    ['GOAWAY.message', FrameType.GOAWAY, '{"code":"X","lastStreamId":1,"message":[]}'],
  ])('rejects a malformed %s', (_label, type, json) => {
    const result = new FrameDecoder().push(control(type, json));
    expect(result.error?.code).toBe('PROTOCOL_VIOLATION');
  });

  it('accepts every optional member at its documented type', () => {
    const frame = decodeFrame(
      control(FrameType.OPEN, '{"name":"x","params":{"cols":80},"mode":"read","credit":32}'),
    );
    expect((frame as Frame).payload).toEqual({
      name: 'x',
      params: { cols: 80 },
      mode: 'read',
      credit: 32,
    });
  });

  it('rejects a control payload that is not valid UTF-8', () => {
    const buffer = new Uint8Array(FRAME_HEADER_SIZE + 2);
    const view = new DataView(buffer.buffer);
    buffer[0] = PROTOCOL_VERSION;
    buffer[1] = FrameType.PING;
    view.setUint32(12, 2, true);
    buffer[FRAME_HEADER_SIZE] = 0xc3;
    buffer[FRAME_HEADER_SIZE + 1] = 0x28;
    expect(new FrameDecoder().push(buffer).error?.code).toBe('PROTOCOL_VIOLATION');
  });

  it('ignores unknown members so a version-1 peer survives an extension', () => {
    const frame = decodeFrame(control(FrameType.PING, '{"nonce":"n","future":true}'));
    expect(frame).not.toBeInstanceOf(ProtocolError);
    expect((frame as Frame).payload).toEqual({ nonce: 'n' });
  });

  it('passes a non-integer CREDIT increment up to the mux', () => {
    const frame = decodeFrame(control(FrameType.CREDIT, '{"bytes":1.5}'));
    expect(frame).not.toBeInstanceOf(ProtocolError);
  });
});

describe('decodeFrame', () => {
  const ping: Frame = {
    type: FrameType.PING,
    streamId: 0,
    seq: 0,
    flags: FrameFlags.NONE,
    payload: { nonce: 'abc' },
  };

  it('decodes exactly one frame', () => {
    expect(normalise(decodeFrame(encodeFrame(ping)) as Frame)).toEqual(normalise(ping));
  });

  it('reports a truncated buffer', () => {
    const result = decodeFrame(encodeFrame(ping).subarray(0, 8));
    expect(result).toBeInstanceOf(ProtocolError);
  });

  it('reports a buffer holding more than one frame', () => {
    const one = encodeFrame(ping);
    const two = new Uint8Array(one.length * 2);
    two.set(one, 0);
    two.set(one, one.length);
    expect(decodeFrame(two)).toBeInstanceOf(ProtocolError);
  });
});
