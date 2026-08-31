/**
 * `brobridge` — the server (host) package.
 *
 * Binds an HTTP listener on the loopback interface, enforces the trust fence
 * described in `THREAT-MODEL.md`, performs the one-time launch-token
 * bootstrap, and wires each accepted WebSocket into a `@brobridge/core`
 * endpoint. Runs on Node >= 20 and on Bun behind one public API.
 *
 * Implementation lands in Phase 3.
 *
 * @packageDocumentation
 */

export {};
