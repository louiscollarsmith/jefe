// @ts-check

import { logger as baseLogger } from "../observability/logger.server.js";
import { track } from "../../services/analytics/event-log.server.js";
import { normalizeShopDomain } from "../shopify/admin-graphql.server.js";
import { signFeedbackToken } from "./feedback.server.js";
import { sendEmail } from "./resend.server.js";
import { loadTemplateHtml, interpolate } from "./template.server.js";
import {
  hashRecipient,
  isEmailUnsubscribed,
  signUnsubscribeToken,
} from "./unsubscribe.server.js";
import {
  DEFAULT_APP_URL,
  DEFAULT_LOGO_URL,
  deriveStoreName,
} from "./welcome.server.js";

/**
 * The WIN-BACK CAMPAIGN — emails 2 & 3 of the self-terminating uninstall sequence.
 * Day 0's farewell (winback.server.js) is one email; this extends it to a short,
 * cap-bounded follow-up that keeps reaching out UNTIL we get a "why" (feedback) or
 * they reinstall, then stops. Safety-first by construction: a hard cap of 3 emails
 * ever, four stop conditions re-checked before every send, one-click unsubscribe on
 * each, and the whole thing dark behind ENABLE_WINBACK_CAMPAIGN until a human flips it.
 *
 * ⚠️ Enabling requires softening Day-0's live close ("No emails after this one…"),
 * which would otherwise contradict the follow-ups. That copy change is a separate,
 * deliberate step (founder call).
 */

const log = baseLogger.child({ component: "email" });

const DAY_MS = 86_400_000;

// Cadence (days). Email 2 fires this long after the Day-0 farewell; email 3 this
// long after email 2 (≈ day 10 overall). Proposed rhythm 0 / 4 / 10 — tunable.
export const WINBACK_EMAIL2_AFTER_DAYS = 4;
export const WINBACK_EMAIL3_AFTER_DAYS = 6;

// Batch cap per worker tick — bounds the send blast radius per pass.
const CAMPAIGN_BATCH = 100;

const TEMPLATE_BY_STEP = /** @type {const} */ ({ 2: "jefe-winback-2", 3: "jefe-winback-3" });
const SUBJECT_BY_STEP = /** @type {const} */ ({
  2: "Still curious what made you leave",
  3: "Last note from me",
});

/**
 * Campaign kill switch on TOP of ENABLE_EMAIL + ENABLE_WINBACK_EMAIL. Sending
 * repeated emails to people who left is the highest-consequence path in the app,
 * so the follow-ups stay a hard no-op — no candidate scan, no recipient storage,
 * no send — until this is explicitly "true". Defaults to false.
 * @returns {boolean}
 */
export function isWinBackCampaignEnabled() {
  return (
    String(process.env.ENABLE_WINBACK_CAMPAIGN ?? "").trim().toLowerCase() === "true"
  );
}

/**
 * Which follow-up step (2 or 3) is due for a churned shop, or null. Pure.
 * A step is due once enough days have passed since the prior email and it hasn't
 * been sent; email 3 is the hard cap (nothing after it).
 * @param {{ winbackEmailSentAt: Date | string | null; winbackEmail2SentAt: Date | string | null; winbackEmail3SentAt: Date | string | null }} shop
 * @param {Date} now
 * @returns {2 | 3 | null}
 */
export function dueCampaignStep(shop, now) {
  const t1 = shop.winbackEmailSentAt ? new Date(shop.winbackEmailSentAt).getTime() : null;
  if (t1 == null) return null; // no Day-0 farewell → the sequence never started
  if (shop.winbackEmail3SentAt) return null; // hard cap reached — silence
  const nowMs = now.getTime();
  if (!shop.winbackEmail2SentAt) {
    return nowMs - t1 >= WINBACK_EMAIL2_AFTER_DAYS * DAY_MS ? 2 : null;
  }
  const t2 = new Date(shop.winbackEmail2SentAt).getTime();
  return nowMs - t2 >= WINBACK_EMAIL3_AFTER_DAYS * DAY_MS ? 3 : null;
}

/**
 * The reason to STOP the sequence for a shop this tick, or null to proceed. Pure.
 * Re-evaluated before every send so the campaign self-terminates the moment any
 * of the exit conditions is met (reinstall / feedback / unsubscribe).
 * @param {{ status?: string | null }} shop
 * @param {{ hasFeedback: boolean; isUnsubscribed: boolean }} signals
 * @returns {"reinstalled" | "feedback" | "unsubscribed" | null}
 */
export function campaignStopReason(shop, signals) {
  if (shop.status === "active") return "reinstalled"; // they're back — stop
  if (signals.hasFeedback) return "feedback"; // we got the "why" — the whole point
  if (signals.isUnsubscribed) return "unsubscribed"; // honoured immediately
  return null;
}

/** @param {string} url */
function trimTrailingSlash(url) {
  return url.replace(/\/+$/, "");
}

/** @param {string} appUrl @param {string} shopDomain */
function buildReconnectLink(appUrl, shopDomain) {
  const normalized = normalizeShopDomain(shopDomain);
  if (!normalized) return appUrl;
  const url = new URL(appUrl);
  url.searchParams.set("shop", normalized);
  return url.toString();
}

/** RFC 8058 one-click unsubscribe headers (mirrors the Day-0 email). @param {string} unsubscribeUrl */
function unsubscribeHeaders(unsubscribeUrl) {
  return {
    "List-Unsubscribe": `<${unsubscribeUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/**
 * @typedef {Object} RenderCampaignInput
 * @property {string} shopDomain
 * @property {string} to Recipient (persisted at Day 0; sessions are gone by now).
 * @property {string | null} [merchantName]
 * @property {string | null} [storeName]
 * @property {string} [appUrl]
 * @property {string} [logoUrl]
 */

/**
 * Render a campaign email (step 2 or 3) → subject + HTML + text. Pure. Reuses the
 * Day-0 design system + the same signed one-tap feedback / unsubscribe / reconnect
 * links, so a reply or a tap self-terminates the sequence.
 * @param {2 | 3} step
 * @param {RenderCampaignInput} input
 * @returns {{ subject: string; html: string; text: string; unsubscribeUrl: string }}
 */
export function renderWinBackCampaignEmail(step, input) {
  const appUrl = trimTrailingSlash(
    input.appUrl || process.env.EMAIL_APP_URL || DEFAULT_APP_URL,
  );
  const logoUrl = input.logoUrl || process.env.EMAIL_LOGO_URL || DEFAULT_LOGO_URL;
  const shopDomain = normalizeShopDomain(input.shopDomain);
  const storeName =
    (input.storeName && input.storeName.trim()) || deriveStoreName(input.shopDomain);
  const greeting = (input.merchantName && input.merchantName.trim()) || "Right then";
  const emailHash = hashRecipient(input.to) ?? "";
  const unsubscribeUrl = `${appUrl}/e/unsubscribe?t=${signUnsubscribeToken({ shopDomain, emailHash })}`;
  const reinstallUrl = buildReconnectLink(appUrl, input.shopDomain);
  /** @param {string} reason */
  const feedbackUrl = (reason) =>
    `${appUrl}/e/feedback?t=${signFeedbackToken({ shopDomain, emailHash, reason })}`;

  const vars = {
    greeting,
    storeName,
    logoUrl,
    reinstallUrl,
    feedbackTooEarlyUrl: feedbackUrl("too_early"),
    feedbackNoValueUrl: feedbackUrl("no_value"),
    feedbackTooComplexUrl: feedbackUrl("too_complex"),
    feedbackBrokeUrl: feedbackUrl("broke"),
    unsubscribeUrl,
    recipientEmail: input.to,
  };

  const html = interpolate(loadTemplateHtml(TEMPLATE_BY_STEP[step]), vars);
  const text = campaignText(step, { greeting, storeName, reinstallUrl, unsubscribeUrl });
  return { subject: SUBJECT_BY_STEP[step], html, text, unsubscribeUrl };
}

/**
 * @param {2 | 3} step
 * @param {{ greeting: string; storeName: string; reinstallUrl: string; unsubscribeUrl: string }} v
 */
function campaignText(step, v) {
  if (step === 2) {
    return [
      `${v.greeting} — still a little curious.`,
      "",
      `I know you've moved on from ${v.storeName}, and that's completely alright — no pitch here.`,
      "",
      "I'm still a little curious what tipped it, though — it's the only way I get better. One question: what made you uninstall? Just reply and tell me; it reaches me directly. That's it — I won't keep asking.",
      "",
      "Your store's memory is still safe, if you change your mind.",
      "— Jefe",
      "",
      `Turn off these emails: ${v.unsubscribeUrl}`,
    ].join("\n");
  }
  return [
    `${v.greeting} — that's me done.`,
    "",
    `This is the last you'll hear from me about ${v.storeName}. No more nudges — promise.`,
    "",
    `If you ever want to pick up where we left off, the memory I built is still safe for a little longer. Reconnect: ${v.reinstallUrl}`,
    "",
    "And if something we did put you off, I'd still genuinely love to know — just reply.",
    "",
    `Either way — good luck with ${v.storeName}. Truly.`,
    "— Jefe",
    "",
    `Turn off these emails: ${v.unsubscribeUrl}`,
  ].join("\n");
}

/**
 * @param {2 | 3} step
 * @param {RenderCampaignInput & { to: string }} input
 * @returns {Promise<import("./resend.server.js").SendEmailResult>}
 */
async function sendWinBackCampaignEmail(step, input) {
  const { subject, html, text, unsubscribeUrl } = renderWinBackCampaignEmail(step, input);
  return sendEmail({
    to: input.to,
    subject,
    html,
    text,
    headers: unsubscribeHeaders(unsubscribeUrl),
  });
}

/**
 * Worker-tick pass: send due win-back follow-ups (emails 2 & 3) to churned shops,
 * self-terminating on feedback / reinstall / unsubscribe / the 3-email cap. Dark
 * until ENABLE_WINBACK_CAMPAIGN. Never throws — a bad send must not break the tick.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ logger?: { info: (message: string, meta?: any) => void; error: (message: string, meta?: any) => void }; now?: Date }} [opts]
 * @returns {Promise<{ skipped: string | null; sent: number }>}
 */
export async function maybeSendWinBackCampaign(prisma, opts = {}) {
  const logger = opts.logger ?? log;
  if (!isWinBackCampaignEnabled()) return { skipped: "disabled", sent: 0 };
  const now = opts.now ?? new Date();
  let sent = 0;
  try {
    // Candidates: Day-0 sent, cap not reached, we have a recipient, not reinstalled.
    const candidates = await prisma.shop.findMany({
      where: {
        platform: "shopify",
        winbackEmailSentAt: { not: null },
        winbackEmail3SentAt: null,
        winbackRecipientEmail: { not: null },
        status: { not: "active" },
      },
      select: {
        id: true,
        shopDomain: true,
        status: true,
        winbackEmailSentAt: true,
        winbackEmail2SentAt: true,
        winbackEmail3SentAt: true,
        winbackRecipientEmail: true,
      },
      take: CAMPAIGN_BATCH,
    });

    for (const shop of candidates) {
      const step = dueCampaignStep(shop, now);
      if (!step) continue;
      const recipient = shop.winbackRecipientEmail;
      if (!recipient) continue;

      // Re-check all exit conditions immediately before firing.
      const emailHash = hashRecipient(recipient);
      const isUnsubscribed = emailHash
        ? await isEmailUnsubscribed(prisma, { shopId: shop.id, emailHash })
        : false;
      const hasFeedback =
        (await prisma.activityEvent.count({
          where: { shopId: shop.id, type: "shop_uninstall_feedback" },
        })) > 0;
      if (campaignStopReason(shop, { hasFeedback, isUnsubscribed })) continue;

      // Atomic per-step claim: only the NULL→now transition dispatches, so a
      // re-entrant tick can never double-send a step.
      const data =
        step === 2 ? { winbackEmail2SentAt: now } : { winbackEmail3SentAt: now };
      const where =
        step === 2
          ? { id: shop.id, winbackEmail2SentAt: null }
          : { id: shop.id, winbackEmail3SentAt: null };
      const claim = await prisma.shop.updateMany({ where, data });
      if (claim.count === 0) continue;

      const result = await sendWinBackCampaignEmail(step, {
        shopDomain: shop.shopDomain,
        to: recipient,
      });
      sent += 1;

      // PII-free health signal (kind + outcome only, no recipient).
      void track(prisma, {
        type: "email_sent",
        topic: "email",
        shopId: shop.id,
        shopDomain: shop.shopDomain,
        summary: `Win-back campaign email ${step} ${
          result.disabled
            ? "stubbed (disabled)"
            : result.delivered
              ? "delivered"
              : "not delivered"
        } for ${shop.shopDomain}`,
        properties: {
          kind: `winback_${step}`,
          step,
          delivered: Boolean(result.delivered),
          disabled: Boolean(result.disabled),
        },
      });
    }

    if (sent > 0) logger.info("win-back campaign tick sent follow-ups", { sent });
    return { skipped: null, sent };
  } catch (error) {
    // Best-effort: a campaign failure must never break the worker tick.
    logger.error("win-back campaign tick failed", { err: error });
    return { skipped: "error", sent };
  }
}
