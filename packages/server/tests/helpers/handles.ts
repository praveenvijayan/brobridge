/**
 * A leak guard for the socket tests.
 *
 * A test that leaves a listener behind is a test that will hang someone
 * else's CI, and `--forceExit` hides exactly the bug worth finding. This
 * helper is what lets every socket suite assert, after each case, that the
 * server it started is really gone.
 */

/** Handle kinds Node reports for a TCP listener or connection. */
const TCP_KINDS = new Set(['TCPServerWrap', 'TCPSocketWrap', 'TCPWrap']);

/** Live TCP-ish handles this process is holding. */
export function activeTcpHandles(): readonly string[] {
  return process.getActiveResourcesInfo().filter((kind) => TCP_KINDS.has(kind));
}

/** Live listening sockets. A leaked bridge shows up here. */
export function activeListeners(): readonly string[] {
  return process.getActiveResourcesInfo().filter((kind) => kind === 'TCPServerWrap');
}

/**
 * Wait until `predicate` holds or the deadline passes.
 *
 * Sockets close on the event loop, so an assertion made in the same tick as
 * `close()` measures the wrong moment.
 */
export async function settle(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
