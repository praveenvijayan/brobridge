/**
 * `@brobridge/client` — the browser client.
 *
 * Standards only: a `WebSocket` and a `fetch`, both injectable but neither
 * shimmed. Zero third-party runtime dependencies; the protocol itself comes
 * from `@brobridge/core`, which runs unchanged in the browser.
 *
 * ```ts
 * import { connect } from '@brobridge/client';
 *
 * const bridge = await connect(location.href);
 * const host = await bridge.call<string>('files.read', '/etc/hostname');
 *
 * const pty = await bridge.openStream('pty.attach', { cols: 80, rows: 24 });
 * for await (const chunk of pty) terminal.write(chunk);
 * ```
 *
 * The launch token in the URL is redeemed once and never retained. A dropped
 * socket is reconnected with backoff and the session resumed, so a consumer
 * sees every byte exactly once — and where the host can no longer serve the
 * resume, the stream fails with `SnapshotRequiredError` rather than silently
 * skipping bytes.
 *
 * @see PROTOCOL.md
 * @packageDocumentation
 */

export { connect } from './client.js';
export type { Bridge } from './client.js';

export { BridgeClientError, isClientError } from './errors.js';
export type { ClientErrorReason } from './errors.js';

export { RPC_CONTENT_TYPE } from './fallback.js';

export { makeProxy } from './proxy.js';
export type { ProxyTarget, RemoteService } from './proxy.js';

export { LAUNCH_TOKEN_PARAM, parseTarget } from './url.js';
export type { BridgeTarget, UpgradeVerdict } from './url.js';

export type {
  BridgeEvents,
  BridgeState,
  ConnectOptions,
  FetchLike,
  SocketFactory,
  SocketLike,
  Unsubscribe,
} from './types.js';

// The wire-level types an application handles are core's, and re-exporting
// them here means a browser app never needs a second dependency to name the
// error it just caught.
export {
  BridgeError,
  ConnectionClosedError,
  ErrorCode,
  ProtocolError,
  ResumeFailedError,
  SnapshotRequiredError,
  StreamError,
} from '@brobridge/core';
export type { BridgeStream, OpenStreamOptions, StreamMode, StreamState } from '@brobridge/core';
