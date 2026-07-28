// @ts-check

/**
 * Ops alerting: forwards error-level log records to a Slack-compatible incoming
 * webhook (`ALERT_WEBHOOK_URL`) so a failure reaches a human instead of only
 * sitting in the log stream.
 *
 * Constraints that make this safe to call from inside the logger:
 * - **Never throws and never blocks.** The webhook POST is fire-and-forget; any
 *   error (including a rejected fetch) is swallowed.
 * - **No dependency on the logger** — avoids an alert→log→alert cycle.
 * - **Rate limited.** Identical failures are de-duplicated within a cooldown and
 *   a per-minute cap bounds alert storms.
 * - Records arrive already redacted by the logger, so no secrets/PII are posted.
 * - Disabled (a no-op) unless `ALERT_WEBHOOK_URL` is set.
 */

const DEFAULT_COOLDOWN_MS = 5 * 60_000; // per identical-failure signature
const DEFAULT_MAX_PER_WINDOW = 20;
const WINDOW_MS = 60_000;
const MAX_MESSAGE_CHARS = 500;

/**
 * @param {Record<string, unknown>} record
 * @returns {string}
 */
function signatureFor(record) {
  const err = /** @type {{ name?: string; message?: string }} */ (
    record.err ?? {}
  );
  return [
    record.msg,
    err.name ?? "",
    (err.message ?? "").slice(0, 120),
    record.path ?? record.component ?? "",
  ].join("|");
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} environment
 * @returns {string}
 */
function formatAlert(record, environment) {
  const err = /** @type {{ name?: string; message?: string }} */ (
    record.err ?? {}
  );
  const lines = [`:rotating_light: [${environment}] ${record.msg}`];
  if (err.name || err.message) {
    lines.push(`${err.name ?? "Error"}: ${err.message ?? ""}`.slice(0, 300));
  }
  const meta = [
    record.component ? `component=${record.component}` : null,
    record.path ? `path=${record.path}` : null,
    record.jobType ? `jobType=${record.jobType}` : null,
    record.shopDomain ? `shop=${record.shopDomain}` : null,
    record.correlationId ? `cid=${record.correlationId}` : null,
  ].filter(Boolean);
  if (meta.length) lines.push(meta.join("  "));
  return lines.join("\n").slice(0, MAX_MESSAGE_CHARS);
}

/**
 * @typedef {object} AlerterOptions
 * @property {Record<string, string | undefined>} [env]
 * @property {string} [webhookUrl]
 * @property {typeof fetch} [fetch]
 * @property {() => number} [now]
 * @property {number} [cooldownMs]
 * @property {number} [maxPerWindow]
 */

/**
 * @param {AlerterOptions} [options]
 */
export function createAlerter(options = {}) {
  const env = options.env ?? process.env;
  const webhookUrl = options.webhookUrl ?? env.ALERT_WEBHOOK_URL ?? "";
  const fetchImpl =
    options.fetch ?? (typeof fetch === "function" ? fetch : undefined);
  const now = options.now ?? (() => Date.now());
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const maxPerWindow = options.maxPerWindow ?? DEFAULT_MAX_PER_WINDOW;
  const environment = env.APP_ENV || env.NODE_ENV || "development";
  const enabled = Boolean(webhookUrl) && typeof fetchImpl === "function";

  /** @type {Map<string, number>} */
  const lastSentBySignature = new Map();
  let windowStart = now();
  let sentInWindow = 0;

  /**
   * @param {string} signature
   * @param {number} ts
   * @returns {boolean}
   */
  function shouldSend(signature, ts) {
    if (ts - windowStart >= WINDOW_MS) {
      windowStart = ts;
      sentInWindow = 0;
    }
    if (sentInWindow >= maxPerWindow) return false;
    const last = lastSentBySignature.get(signature);
    if (last !== undefined && ts - last < cooldownMs) return false;
    return true;
  }

  return {
    enabled,
    /**
     * @param {Record<string, unknown>} record An already-redacted log record.
     */
    notify(record) {
      if (!enabled) return;
      try {
        const ts = now();
        const signature = signatureFor(record);
        if (!shouldSend(signature, ts)) return;
        lastSentBySignature.set(signature, ts);
        sentInWindow += 1;
        const body = JSON.stringify({ text: formatAlert(record, environment) });
        // Fire-and-forget: never block the caller, never surface a rejection.
        Promise.resolve(
          fetchImpl(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          }),
        ).catch(() => {});
      } catch {
        // Alerting must never throw into the logger.
      }
    },
  };
}
