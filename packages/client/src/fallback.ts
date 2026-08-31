/**
 * The `POST /rpc` fallback path.
 *
 * Some environments block WebSockets outright. `PROTOCOL.md` §10.1 keeps unary
 * calls working there by putting the *same frames* in an HTTP body — `OPEN`
 * followed by `DATA` with `FIN` — over the same cookie and the same trust
 * fence. There is no second wire format and no second dispatch path on the
 * host, which is what keeps the two surfaces from drifting apart.
 *
 * Streams and resume are not available here, and the client says so by name
 * rather than degrading them silently.
 */
import type { Frame } from '@brobridge/core';
import { FrameDecoder, FrameFlags, FrameType, StreamError, encodeFrame, isErrorCode } from '@brobridge/core';
import { ErrorCode } from '@brobridge/core';

import { BridgeClientError } from './errors.js';
import type { FetchLike } from './types.js';

/** Media type of a body carrying brobridge frames. Matches the server's. */
export const RPC_CONTENT_TYPE = 'application/vnd.brobridge.frames';

/** What {@link callOverHttp} needs from the client around it. */
export interface HttpCallOptions {
  readonly fetch: FetchLike;
  /** Largest frame either side will accept on this connection. */
  readonly maxFrameSize: number;
  /** A client-parity (odd) identifier, unique enough to correlate the pair. */
  readonly streamId: number;
}

/**
 * Make one unary call over HTTP.
 *
 * The stream identifier is cosmetic here — the request and its answer are one
 * exchange with no session behind them — but it is still spelled the way the
 * protocol spells it, so the host's decoder and the host's route table are
 * the very same code that serves the WebSocket.
 */
export async function callOverHttp(
  rpcUrl: string,
  route: string,
  request: Uint8Array,
  options: HttpCallOptions,
): Promise<Uint8Array> {
  const body = concat([
    encodeFrame(
      {
        type: FrameType.OPEN,
        streamId: options.streamId,
        seq: 0,
        flags: FrameFlags.NONE,
        payload: { name: route, mode: 'duplex' },
      },
      { maxFrameSize: options.maxFrameSize },
    ),
    encodeFrame(
      {
        type: FrameType.DATA,
        streamId: options.streamId,
        seq: 1,
        flags: FrameFlags.FIN,
        payload: request,
      },
      { maxFrameSize: options.maxFrameSize },
    ),
  ]);

  let response: Response;
  try {
    response = await options.fetch(rpcUrl, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': RPC_CONTENT_TYPE },
      body,
    });
  } catch (cause) {
    throw new BridgeClientError('fallback-failed', 'the HTTP fallback request failed', { cause });
  }

  if (response.status === 401 || response.status === 403) {
    throw new BridgeClientError('unauthorized', 'the host refused the HTTP fallback request');
  }
  if (!response.ok) {
    throw new BridgeClientError(
      'fallback-failed',
      `the HTTP fallback answered ${String(response.status)}`,
    );
  }

  const decoder = new FrameDecoder({ maxFrameSize: options.maxFrameSize });
  const { frames, error } = decoder.push(new Uint8Array(await response.arrayBuffer()));
  if (error !== null || decoder.hasPartialFrame) {
    throw new BridgeClientError('fallback-failed', 'the HTTP fallback answered with a malformed body');
  }
  return readAnswer(frames, options.streamId);
}

/**
 * Reduce the answering frames to a payload.
 *
 * The shapes `PROTOCOL.md` §10.1 permits are exactly two: `OPEN_ACK` then
 * `DATA(FIN)`, or a stream-level `ERROR`. Anything else is the host speaking a
 * protocol this client does not know, which is a fault rather than data.
 */
function readAnswer(frames: readonly Frame[], streamId: number): Uint8Array {
  for (const frame of frames) {
    if (frame.type === FrameType.ERROR) {
      const code = isErrorCode(frame.payload.code) ? frame.payload.code : ErrorCode.INTERNAL_ERROR;
      throw new StreamError(code, frame.payload.message ?? 'the call failed', {
        streamId,
        remote: true,
      });
    }
    if (frame.type === FrameType.DATA && (frame.flags & FrameFlags.FIN) !== 0) {
      return frame.payload;
    }
  }
  throw new BridgeClientError('fallback-failed', 'the HTTP fallback answered without a result');
}

/**
 * Join byte chunks into one buffer.
 *
 * Returns the `ArrayBuffer` rather than a view over it: that is what `fetch`
 * takes as a body, and handing over the buffer makes it plain that this
 * request owns those bytes outright.
 */
function concat(chunks: readonly Uint8Array[]): ArrayBuffer {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const buffer = new ArrayBuffer(total);
  const out = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return buffer;
}
