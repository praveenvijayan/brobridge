/**
 * Reconnect backoff.
 *
 * `PROTOCOL.md` §11.1 fixes the shape: exponential from `reconnectMinMs` to
 * `reconnectMaxMs`, doubling per attempt, with **full jitter** —
 * `delay = random(0, min(max, min * 2^n))`. Full jitter rather than a jittered
 * exponential because every tab in a browser that just woke from sleep
 * reconnects at once; spreading them across the whole window is what stops
 * them arriving as one thundering herd.
 */

/**
 * The delay before retry number `attempt`, where `attempt` is `0` for the
 * first retry after a failure.
 */
export function backoffDelay(
  attempt: number,
  minMs: number,
  maxMs: number,
  random: () => number,
): number {
  const exponent = Math.min(attempt, 31);
  const ceiling = Math.min(maxMs, minMs * 2 ** exponent);
  return Math.floor(random() * ceiling);
}

/**
 * Resolve after `ms`, or as soon as `until` settles, whichever comes first.
 *
 * The timer is cleared on the short path. A pending `setTimeout` keeps a Node
 * process alive, so a bridge closed mid-backoff would otherwise hold the
 * process open for the rest of a ten-second sleep it no longer cares about.
 */
export function delay(ms: number, until?: Promise<void>): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void until?.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
