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

/**
 * Record that the worker loop is alive — at the start of a tick, and again after each unit of
 * work inside one.
 *
 * A tick is not instant: it drains several ready jobs and then runs the whole maintenance
 * chain, all sequentially. Stamping only at the top means a BUSY worker and a WEDGED worker
 * look identical to `/health` after 90 seconds — and the busiest case is a merchant
 * onboarding, which enqueues phase after phase deliberately so onboarding doesn't feel
 * stalled. Being told the worker is dead while it is importing a new merchant's store is
 * exactly backwards.
 *
 * Stamping per completed unit keeps the signal honest in both directions: real progress keeps
 * it fresh, and a loop that is genuinely stuck still goes stale, because nothing completes.
 *
 * @param {number} [now]
 */
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
