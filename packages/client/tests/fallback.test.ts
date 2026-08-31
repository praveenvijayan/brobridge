/**
 * The `POST /rpc` path, without a host.
 *
 * The happy path is covered end to end against the real server; what is left
 * here is everything that can go wrong on a surface with no session to recover
 * into, where the client must fail by name rather than guess.
 */
import type { Frame } from '@brobridge/core';
import { ErrorCode, FrameFlags, FrameType, StreamError, encodeFrame } from '@brobridge/core';
import { describe, expect, it } from 'vitest';

import { callOverHttp } from '../src/fallback.js';
import type { FetchLike } from '../src/types.js';

const options = (fetchImpl: FetchLike) => ({
  fetch: fetchImpl,
  maxFrameSize: 1024 * 1024,
  streamId: 1,
});

/** A fetch that answers with these frames, and remembers what it was sent. */
function answering(frames: readonly Frame[], init: ResponseInit = { status: 200 }) {
  const seen: { url: string; body: Uint8Array }[] = [];
  const bodies = frames.map((frame) => encodeFrame(frame));
  let total = 0;
  for (const body of bodies) total += body.length;
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const body of bodies) {
    joined.set(body, offset);
    offset += body.length;
  }
  const fetchImpl: FetchLike = async (url, requestInit) => {
    const body = new Uint8Array((await new Response(requestInit?.body).arrayBuffer()));
    seen.push({ url, body });
    return new Response(joined, init);
  };
  return { fetchImpl, seen };
}

const data = (payload: Uint8Array): Frame => ({
  type: FrameType.DATA,
  streamId: 1,
  seq: 1,
  flags: FrameFlags.FIN,
  payload,
});

describe('callOverHttp', () => {
  it('sends OPEN then DATA(FIN), and reads the answering payload', async () => {
    const { fetchImpl, seen } = answering([
      { type: FrameType.OPEN_ACK, streamId: 1, seq: 0, flags: FrameFlags.NONE, payload: {} },
      data(new Uint8Array([7, 8])),
    ]);

    const result = await callOverHttp(
      'http://host/rpc',
      'math.add',
      new Uint8Array([1]),
      options(fetchImpl),
    );

    expect([...result]).toEqual([7, 8]);
    expect(seen[0]?.url).toBe('http://host/rpc');
    // Two frames in one body, exactly as PROTOCOL.md §10.1 describes.
    expect(seen[0]?.body.length).toBeGreaterThan(32);
  });

  it('turns an ERROR frame into the error the host named', async () => {
    const { fetchImpl } = answering([
      {
        type: FrameType.ERROR,
        streamId: 1,
        seq: 0,
        flags: FrameFlags.NONE,
        payload: { code: ErrorCode.NOT_FOUND, message: 'no route named "nope"' },
      },
    ]);

    const failure = await callOverHttp('http://host/rpc', 'nope', new Uint8Array(), options(fetchImpl)).catch(
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(StreamError);
    expect(failure).toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('reports a refusal as unauthorized and other statuses as a fallback failure', async () => {
    const refused: FetchLike = () => Promise.resolve(new Response(null, { status: 403 }));
    await expect(
      callOverHttp('http://host/rpc', 'x.y', new Uint8Array(), options(refused)),
    ).rejects.toMatchObject({ reason: 'unauthorized' });

    const broken: FetchLike = () => Promise.resolve(new Response(null, { status: 500 }));
    await expect(
      callOverHttp('http://host/rpc', 'x.y', new Uint8Array(), options(broken)),
    ).rejects.toMatchObject({ reason: 'fallback-failed' });
  });

  it('refuses a malformed or truncated body rather than inventing a result', async () => {
    const garbage: FetchLike = () =>
      Promise.resolve(new Response(new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9])));
    await expect(
      callOverHttp('http://host/rpc', 'x.y', new Uint8Array(), options(garbage)),
    ).rejects.toMatchObject({ reason: 'fallback-failed' });

    const { fetchImpl } = answering([
      { type: FrameType.OPEN_ACK, streamId: 1, seq: 0, flags: FrameFlags.NONE, payload: {} },
    ]);
    await expect(
      callOverHttp('http://host/rpc', 'x.y', new Uint8Array(), options(fetchImpl)),
    ).rejects.toMatchObject({ reason: 'fallback-failed' });
  });

  it('reports a transport failure as a fallback failure', async () => {
    const offline: FetchLike = () => Promise.reject(new Error('offline'));
    await expect(
      callOverHttp('http://host/rpc', 'x.y', new Uint8Array(), options(offline)),
    ).rejects.toMatchObject({ reason: 'fallback-failed' });
  });
});
