/**
 * `@brobridgejs/core` — the brobridge protocol implementation.
 *
 * This package is pure logic: frame codec, stream multiplexing, credit-based
 * flow control and resume. It owns no sockets and has zero runtime
 * dependencies, so it runs unchanged in Node, Bun, Deno and the browser.
 *
 * The normative description of everything implemented here lives in
 * `PROTOCOL.md` at the repository root. Code and spec must never drift: a
 * behaviour change requires a spec change in the same commit.
 *
 * @packageDocumentation
 */

export { FrameDecoder, decodeFrame, encodeFrame } from './codec.js';
export type { DecodeResult } from './codec.js';

export {
  BridgeError,
  ConnectionClosedError,
  ERROR_CODES,
  ErrorCode,
  ProtocolError,
  ResumeFailedError,
  SnapshotRequiredError,
  StreamError,
  isErrorCode,
} from './errors.js';
export type { ErrorScope } from './errors.js';

export { BridgeEndpoint, BridgeStream, generateSessionId, readAll } from './mux.js';
export type {
  AttachOptions,
  AttachOutcome,
  BridgeEndpointOptions,
  EndpointState,
  OpenStreamOptions,
} from './mux.js';

export {
  DEFAULT_REPLAY_WINDOW,
  ReplayBuffer,
  SeqCounter,
  SeqTracker,
  planReplay,
} from './resume.js';
export type { ReplayPlan, ReplayWindow, SeqVerdict } from './resume.js';

export { SessionHost } from './sessions.js';
export type { SessionHostOptions } from './sessions.js';

export {
  FRAME_HEADER_SIZE,
  FrameFlags,
  FrameType,
  HARD_MAX_FRAME_SIZE,
  MAX_CREDIT,
  MAX_SEQ,
  MAX_STREAM_ID,
  PROTOCOL_DEFAULTS,
  PROTOCOL_VERSION,
  defaultCreditGrantThreshold,
  isSequencedType,
} from './types.js';
export type {
  CancelPayload,
  Carrier,
  CreditPayload,
  EndPayload,
  ErrorPayload,
  Frame,
  FrameOf,
  GoawayPayload,
  HelloAckPayload,
  HelloPayload,
  OpenAckPayload,
  OpenPayload,
  PingPayload,
  ResumeAckPayload,
  ResumeCursor,
  ResumeFailPayload,
  ResumeFailure,
  ResumePayload,
  StreamGrant,
  SequencedFrame,
  StreamMode,
  StreamState,
} from './types.js';
