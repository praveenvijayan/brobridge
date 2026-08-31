/**
 * `@brobridge/core` — the brobridge protocol implementation.
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

/**
 * Wire protocol version carried in the frame header and negotiated by
 * `HELLO` / `HELLO_ACK`.
 *
 * @see PROTOCOL.md §3 "Frame header"
 */
export const PROTOCOL_VERSION = 1 as const;

export {};
