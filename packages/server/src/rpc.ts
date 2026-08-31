/**
 * The `POST /rpc` fallback.
 *
 * Some environments block WebSockets — a corporate proxy, an extension, a
 * hardened browser profile. Unary calls still work there, over exactly the
 * same authentication and the same trust fence, and over exactly the same
 * framing: the body is an `OPEN` frame followed by a `DATA` frame with `FIN`,
 * and the response is the answering frames. No second wire format, no second
 * dispatch path.
 *
 * Streams and resume are *not* available here. The client is told so by name
 * rather than degraded silently (`PROTOCOL.md` §10.1).
 */
import type { Frame } from '@brobridge/core';
import { ErrorCode, FrameDecoder, FrameFlags, FrameType, ProtocolError, encodeFrame } from '@brobridge/core';

import type { GatewayResponse } from './gateway.js';
import type { RawHeader } from './trust.js';
import type { ServiceRegistry } from './services.js';

/** Media type of a body carrying brobridge frames. */
export const RPC_CONTENT_TYPE = 'application/vnd.brobridge.frames';

const RESPONSE_HEADERS: readonly RawHeader[] = [
  ['Referrer-Policy', 'no-referrer'],
  ['Cache-Control', 'no-store'],
  ['X-Content-Type-Options', 'nosniff'],
  ['Content-Type', RPC_CONTENT_TYPE],
];

/**
 * Answer one fallback call.
 *
 * The body must be exactly `OPEN` + `DATA(FIN)` on a single stream. Anything
 * else is a `400`: this surface has no state to recover into, so there is
 * nothing to negotiate about.
 */
export async function handleRpc(
  body: Uint8Array,
  registry: ServiceRegistry,
  maxFrameSize: number,
): Promise<GatewayResponse> {
  const decoder = new FrameDecoder({ maxFrameSize });
  const { frames, error } = decoder.push(body);
  if (error !== null || decoder.hasPartialFrame) return status(400);
  if (frames.length !== 2) return status(400);

  const [open, data] = frames as [Frame, Frame];
  if (open.type !== FrameType.OPEN || data.type !== FrameType.DATA) return status(400);
  if (open.streamId === 0 || open.streamId !== data.streamId) return status(400);
  if ((data.flags & FrameFlags.FIN) === 0) return status(400);

  const streamId = open.streamId;
  const outcome = await registry.invoke(open.payload.name, data.payload);

  if (!outcome.ok) {
    return frameResponse(200, [
      errorFrame(streamId, outcome.code, outcome.message),
    ]);
  }
  if (outcome.payload.length > maxFrameSize) {
    return frameResponse(200, [
      errorFrame(streamId, ErrorCode.FRAME_TOO_LARGE, 'response exceeds the negotiated frame size'),
    ]);
  }

  return frameResponse(200, [
    { type: FrameType.OPEN_ACK, streamId, seq: 0, flags: FrameFlags.NONE, payload: {} },
    {
      type: FrameType.DATA,
      streamId,
      seq: 1,
      flags: FrameFlags.FIN,
      payload: outcome.payload,
    },
  ]);
}

function errorFrame(streamId: number, code: ErrorCode, message: string): Frame {
  return {
    type: FrameType.ERROR,
    streamId,
    seq: 0,
    flags: FrameFlags.NONE,
    payload: { code, message },
  };
}

function frameResponse(statusCode: number, frames: readonly Frame[]): GatewayResponse {
  const encoded: Uint8Array[] = [];
  let total = 0;
  for (const frame of frames) {
    try {
      const bytes = encodeFrame(frame);
      encoded.push(bytes);
      total += bytes.length;
    } catch (cause) {
      // The only encode fault reachable here is an oversized payload, which
      // the caller already checked; anything else is a defect, not a peer's
      // doing, so it must not leak.
      if (cause instanceof ProtocolError) return status(500);
      throw cause;
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const bytes of encoded) {
    body.set(bytes, offset);
    offset += bytes.length;
  }
  return {
    status: statusCode,
    headers: [...RESPONSE_HEADERS, ['Content-Length', String(body.length)]],
    body,
  };
}

function status(code: number): GatewayResponse {
  return {
    status: code,
    headers: [...RESPONSE_HEADERS.slice(0, 3), ['Content-Length', '0']],
    body: null,
  };
}
