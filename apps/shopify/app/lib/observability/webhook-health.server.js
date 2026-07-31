// @ts-check

/**
 * In-process webhook-delivery health.
 *
 * Shopify delivers webhooks synchronously — our route processes, then ACKs — so
 * slow processing risks Shopify's delivery timeout (~5s), which it counts as a
 * failed delivery on the Partner Dashboard even though our handler logs a
 * "processed" success and we'd otherwise never notice. There is no clean Partner
 * API for the delivery %, so we monitor our own side: the webhook route records
 * each outcome here, `/health` surfaces the current window, and the worker
 * periodically alerts #jefe-slack if the window degrades. In-memory and
 * per-process (resets on deploy) — enough to catch a live regression, not a
 * historical store.
 */

/** Processing slower than this risks Shopify's delivery timeout — flagged "slow". */
export const WEBHOOK_SLOW_MS = 3000;

/**
 * @typedef {object} WebhookWindow
 * @property {number} received
 * @property {number} ok
 * @property {number} failed
 * @property {number} slow
 * @property {number} maxMs
 * @property {number} since
 */

/**
 * @param {number} now
 * @returns {WebhookWindow}
 */
function freshWindow(now) {
  return { received: 0, ok: 0, failed: 0, slow: 0, maxMs: 0, since: now };
}

/** @type {WebhookWindow} */
let windowState = freshWindow(Date.now());

/** Evaluate + roll the window at most this often (checked every worker tick). */
const CHECK_INTERVAL_MS = 15 * 60_000;
let lastCheckAt = Date.now();

/**
 * Record one webhook processing outcome. Called by the webhook route.
 * @param {{ ok: boolean, ms?: number }} outcome
 */
export function recordWebhookOutcome(outcome) {
  windowState.received += 1;
  if (outcome.ok) windowState.ok += 1;
  else windowState.failed += 1;
  const ms = Number(outcome.ms);
  if (Number.isFinite(ms) && ms >= 0) {
    if (ms > WEBHOOK_SLOW_MS) windowState.slow += 1;
    if (ms > windowState.maxMs) windowState.maxMs = ms;
  }
}

/**
 * Snapshot of the current window (for `/health`).
 * @param {number} [now]
 */
export function getWebhookHealth(now = Date.now()) {
  const { received, ok, failed, slow, maxMs, since } = windowState;
  return {
    received,
    ok,
    failed,
    slow,
    maxMs,
    successRate: received ? ok / received : 1,
    windowMs: Math.max(0, now - since),
  };
}

/**
 * Reset the window. The worker calls this after each evaluation so each window
 * spans one check interval; tests use it to isolate.
 * @param {number} [now]
 */
export function resetWebhookHealth(now = Date.now()) {
  windowState = freshWindow(now);
  lastCheckAt = now;
}

/**
 * Decide whether the current window is degraded enough to alert. Pure — takes a
 * snapshot + thresholds, returns the verdict + human reasons. Guards on a minimum
 * volume so a single failure in a quiet window can't page.
 *
 * @param {ReturnType<typeof getWebhookHealth>} health
 * @param {{ minVolume?: number, minSuccessRate?: number, maxSlowRate?: number }} [opts]
 * @returns {{ degraded: boolean, reasons: string[] }}
 */
export function evaluateWebhookHealth(health, opts = {}) {
  const minVolume = opts.minVolume ?? 20;
  const minSuccessRate = opts.minSuccessRate ?? 0.9;
  const maxSlowRate = opts.maxSlowRate ?? 0.25;
  /** @type {string[]} */
  const reasons = [];
  if (!health || health.received < minVolume) {
    return { degraded: false, reasons };
  }
  if (health.successRate < minSuccessRate) {
    reasons.push(
      `success rate ${(health.successRate * 100).toFixed(0)}% < ${(minSuccessRate * 100).toFixed(0)}% (${health.failed}/${health.received} failed)`,
    );
  }
  const slowRate = health.slow / health.received;
  if (slowRate > maxSlowRate) {
    reasons.push(
      `${(slowRate * 100).toFixed(0)}% slow (>${WEBHOOK_SLOW_MS}ms — delivery-timeout risk; max ${health.maxMs}ms)`,
    );
  }
  return { degraded: reasons.length > 0, reasons };
}

/**
 * Called on the worker tick: at most once per `CHECK_INTERVAL_MS`, evaluate the
 * accumulated window and — if degraded — alert #jefe-slack via the logger's
 * error→alerter path (deduped by the `webhook-health` component), then roll the
 * window. A one-off slow/failed webhook is just a WARN at the route; this is the
 * sustained-regression pager. Never throws.
 *
 * @param {{ logger?: { error: (msg: string, ctx?: Record<string, unknown>) => void }, now?: number }} [opts]
 * @returns {boolean} whether it evaluated this call (false = interval not elapsed)
 */
export function maybeAlertWebhookHealth(opts = {}) {
  const now = opts.now ?? Date.now();
  if (now - lastCheckAt < CHECK_INTERVAL_MS) return false;
  const health = getWebhookHealth(now);
  const verdict = evaluateWebhookHealth(health);
  if (verdict.degraded && opts.logger) {
    opts.logger.error("Webhook delivery health degraded", {
      component: "webhook-health",
      received: health.received,
      failed: health.failed,
      slow: health.slow,
      successRate: Number(health.successRate.toFixed(3)),
      maxMs: health.maxMs,
      reasons: verdict.reasons,
    });
  }
  resetWebhookHealth(now); // roll the window + reset the interval clock
  return true;
}
