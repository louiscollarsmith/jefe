// @ts-check

/**
 * In-process inbound-email health, mirroring the webhook-health module.
 *
 * The inbound route acks fast and processes out-of-band (like the Slack DM path),
 * so a failure there is invisible unless we count it. Each processing outcome is
 * recorded here; `/health` surfaces the current window, and the worker periodically
 * pages #jefe-slack if the window degrades. In-memory + per-process (resets on
 * deploy) — enough to catch a live regression, not a historical store (the
 * `inbound_email_events` ledger is the durable record).
 *
 * "Parked" (unverified auth, unknown sender, disabled flag) is NOT a failure — it
 * is the system correctly declining to act — so it is counted separately and never
 * pages.
 */

/**
 * @typedef {object} InboundWindow
 * @property {number} received
 * @property {number} replied
 * @property {number} forwarded
 * @property {number} parked
 * @property {number} failed
 * @property {number} maxMs
 * @property {number} since
 */

/** @param {number} now @returns {InboundWindow} */
function freshWindow(now) {
  return { received: 0, replied: 0, forwarded: 0, parked: 0, failed: 0, maxMs: 0, since: now };
}

/** @type {InboundWindow} */
let windowState = freshWindow(Date.now());

const CHECK_INTERVAL_MS = 15 * 60_000;
let lastCheckAt = Date.now();

/**
 * Record one inbound-email processing outcome. Called by the service.
 * @param {{ outcome: "replied" | "forwarded" | "parked" | "failed"; ms?: number }} result
 */
export function recordInboundEmailOutcome(result) {
  windowState.received += 1;
  if (result.outcome === "replied") windowState.replied += 1;
  else if (result.outcome === "forwarded") windowState.forwarded += 1;
  else if (result.outcome === "parked") windowState.parked += 1;
  else if (result.outcome === "failed") windowState.failed += 1;
  const ms = Number(result.ms);
  if (Number.isFinite(ms) && ms >= 0 && ms > windowState.maxMs) {
    windowState.maxMs = ms;
  }
}

/**
 * Snapshot of the current window (for `/health`).
 * @param {number} [now]
 */
export function getInboundEmailHealth(now = Date.now()) {
  const { received, replied, forwarded, parked, failed, maxMs, since } = windowState;
  const actioned = replied + forwarded + failed;
  return {
    received,
    replied,
    forwarded,
    parked,
    failed,
    maxMs,
    successRate: actioned ? (replied + forwarded) / actioned : 1,
    windowMs: Math.max(0, now - since),
  };
}

/**
 * Reset the window. The worker calls this after each evaluation; tests use it to
 * isolate.
 * @param {number} [now]
 */
export function resetInboundEmailHealth(now = Date.now()) {
  windowState = freshWindow(now);
  lastCheckAt = now;
}

/**
 * Decide whether the current window is degraded enough to alert. Pure. Guards on a
 * minimum volume of *actioned* mail so a single failure in a quiet window can't
 * page. Parked mail is excluded from the rate — declining to act is not a fault.
 *
 * @param {ReturnType<typeof getInboundEmailHealth>} health
 * @param {{ minVolume?: number; minSuccessRate?: number }} [opts]
 * @returns {{ degraded: boolean; reasons: string[] }}
 */
export function evaluateInboundEmailHealth(health, opts = {}) {
  const minVolume = opts.minVolume ?? 10;
  const minSuccessRate = opts.minSuccessRate ?? 0.9;
  /** @type {string[]} */
  const reasons = [];
  const actioned = health.replied + health.forwarded + health.failed;
  if (!health || actioned < minVolume) return { degraded: false, reasons };
  if (health.successRate < minSuccessRate) {
    reasons.push(
      `inbound-email success rate ${(health.successRate * 100).toFixed(0)}% < ${(minSuccessRate * 100).toFixed(0)}% (${health.failed}/${actioned} failed)`,
    );
  }
  return { degraded: reasons.length > 0, reasons };
}

/**
 * Called on the worker tick: at most once per interval, evaluate the window and —
 * if degraded — alert #jefe-slack via the logger's error→alerter path, then roll
 * the window. Never throws.
 * @param {{ logger?: { error: (msg: string, ctx?: Record<string, unknown>) => void }; now?: number }} [opts]
 * @returns {boolean} whether it evaluated this call
 */
export function maybeAlertInboundEmailHealth(opts = {}) {
  const now = opts.now ?? Date.now();
  if (now - lastCheckAt < CHECK_INTERVAL_MS) return false;
  const health = getInboundEmailHealth(now);
  const verdict = evaluateInboundEmailHealth(health);
  if (verdict.degraded && opts.logger) {
    opts.logger.error("Inbound email health degraded", {
      component: "inbound-email-health",
      received: health.received,
      replied: health.replied,
      forwarded: health.forwarded,
      parked: health.parked,
      failed: health.failed,
      successRate: Number(health.successRate.toFixed(3)),
      reasons: verdict.reasons,
    });
  }
  resetInboundEmailHealth(now);
  return true;
}
