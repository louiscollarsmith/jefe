// @ts-check

/**
 * Worker-loop liveness heartbeat. The Shopify backfill loop runs *in the web
 * process* (startShopifyBackfillLoop is called from shopify.server.ts), so this
 * shared module lets the `/health` route read the loop's last-tick timestamp
 * directly — no DB round-trip — to detect a wedged loop (the biggest blind spot:
 * a hung loop is invisible today). Non-gating: `/health` reports it, never fails
 * on it.
 */

let lastWorkerTickAt = /** @type {number | null} */ (null);

/** Record that the worker loop just began a tick. @param {number} [now] */
export function recordWorkerTick(now = Date.now()) {
  lastWorkerTickAt = now;
}

/** Epoch ms of the last worker tick, or null if it hasn't ticked yet. */
export function getWorkerLastTickAt() {
  return lastWorkerTickAt;
}

/** Test helper. */
export function __resetHeartbeat() {
  lastWorkerTickAt = null;
}
