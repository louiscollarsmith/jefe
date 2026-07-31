// @ts-check

import { logger as baseLogger } from "./logger.server.js";

/**
 * Install / uninstall lifecycle pings to the ops Slack (#jefe-slack via
 * ALERT_WEBHOOK_URL) — "we just got installed / uninstalled". Separate from the
 * error `alerting.server.js` (that has cooldowns + dedup for faults); this is a
 * plain one-line lifecycle notice.
 *
 * Best-effort + a hard no-op when ALERT_WEBHOOK_URL is unset; never throws — a
 * Slack hiccup must never touch the install/uninstall flow. Goes to our OWN
 * internal channel, so the shop domain (our ops data) is fine to include; no
 * customer PII is sent.
 */

const log = baseLogger.child({ component: "lifecycle-slack" });

/**
 * @typedef {Object} LifecycleInput
 * @property {"installed" | "uninstalled"} event
 * @property {string} shopDomain
 * @property {boolean} [reinstall] For installs: a churned shop coming back.
 * @property {number | null} [daysInstalled] For uninstalls: tenure, if known.
 */

// The Jefe ops panel base URL (merchant drill-down lives at /merchant?shop=…).
// Env-overridable, but the prod default is correct so no config is required.
const OPS_APP_URL = (process.env.OPS_APP_URL || "https://admin.mynamejefe.com").replace(/\/+$/, "");

/**
 * Primary Slack link: the shop domain → its Jefe **ops merchant view** (net
 * revenue, margin, COGS coverage, churn reason, activity) — the high-value "who
 * just (un)installed?" click for the team, not just the public storefront.
 * @param {string} shopDomain
 */
function shopLink(shopDomain) {
  return `<${OPS_APP_URL}/merchant?shop=${encodeURIComponent(shopDomain)}|${shopDomain}>`;
}

/**
 * Secondary link → the actual storefront, for a quick look at the real store.
 * @param {string} shopDomain
 */
function storeLink(shopDomain) {
  return `<https://${shopDomain}|store ↗>`;
}

/**
 * Format the Slack `{text}` line for a lifecycle event. Pure. The shop domain is
 * a clickable link to its storefront.
 * @param {LifecycleInput} input
 * @returns {string}
 */
export function formatLifecycleText(input) {
  const links = `${shopLink(input.shopDomain)} · ${storeLink(input.shopDomain)}`;
  if (input.event === "installed") {
    return input.reinstall
      ? `🔄 Jefe re-installed — ${links} (a churned shop came back)`
      : `🎉 Jefe installed — ${links}`;
  }
  const days = typeof input.daysInstalled === "number" && input.daysInstalled > 0
    ? ` (after ${input.daysInstalled} ${input.daysInstalled === 1 ? "day" : "days"})`
    : "";
  return `👋 Jefe uninstalled — ${links}${days}`;
}

/**
 * Post a lifecycle line to the ops Slack incoming webhook. No-op when the webhook
 * is unset; never throws.
 * @param {LifecycleInput} input
 * @param {{ webhookUrl?: string; fetchImpl?: typeof fetch }} [deps]
 * @returns {Promise<{ sent: boolean; reason?: string }>}
 */
export async function notifyShopLifecycleToSlack(input, deps = {}) {
  const webhookUrl = deps.webhookUrl ?? process.env.ALERT_WEBHOOK_URL ?? "";
  const fetchImpl = deps.fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);
  if (!webhookUrl || typeof fetchImpl !== "function") {
    return { sent: false, reason: "disabled" };
  }
  try {
    const res = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: formatLifecycleText(input) }),
    });
    if (!res.ok) {
      log.warn("lifecycle slack post non-2xx", {
        event: input.event,
        shopDomain: input.shopDomain,
        status: res.status,
      });
      return { sent: false, reason: `http_${res.status}` };
    }
    log.info("lifecycle slack posted", { event: input.event, shopDomain: input.shopDomain });
    return { sent: true };
  } catch (error) {
    log.error("lifecycle slack post failed", {
      event: input.event,
      shopDomain: input.shopDomain,
      err: error,
    });
    return { sent: false, reason: "error" };
  }
}
