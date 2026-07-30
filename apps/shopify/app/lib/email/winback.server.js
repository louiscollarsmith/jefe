// @ts-check

import { logger as baseLogger } from "../observability/logger.server.js";
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

const log = baseLogger.child({ component: "email" });

/**
 * The WIN-BACK email (Day 0 of churn, trigger "Shopify app/uninstalled", one
 * ask "what made you uninstall?"). Warm + un-needy: acknowledges the exit with
 * dignity, makes one honest feedback ask (four one-tap reason links + open
 * reply), and leaves a soft door open to reconnect. Same design system as the
 * welcome. Renders the template and dispatches through the ENABLE_EMAIL-gated
 * Resend adapter.
 */

const TEMPLATE_NAME = "jefe-winback";

/**
 * Second, win-back-specific kill switch on TOP of ENABLE_EMAIL. Sending a real
 * farewell email to a churned merchant is a one-way door, so the uninstall
 * trigger stays a hard no-op — it never resolves a recipient, claims the guard,
 * or contacts Resend — until this is explicitly set to "true". This lets all the
 * code ship + be exercised in prod (endpoint, tokens, template) while no email
 * actually leaves until a human flips the flag. Defaults to false.
 * @returns {boolean}
 */
export function isWinBackEmailEnabled() {
  return (
    String(process.env.ENABLE_WINBACK_EMAIL ?? "").trim().toLowerCase() ===
    "true"
  );
}

/**
 * Three subject-line options from the design brief. Index 0 is the send subject;
 * the rest are documented alternatives for a later A/B (kept here so the copy
 * lives with the template, not in a doc that drifts).
 * @type {[string, string, string]}
 */
export const SUBJECT_OPTIONS = [
  "No hard feelings — one quick question",
  "You've uninstalled Jefe — what made you leave?",
  "Before your store's memory fades…",
];

/**
 * @typedef {Object} RenderWinBackInput
 * @property {string} shopDomain Used to derive a store label + sign links.
 * @property {string} [to] Recipient address (shown in the footer receipt line).
 * @property {string | null} [merchantName] First name for the greeting, if known.
 * @property {string | null} [storeName] Store label; derived from shopDomain if omitted.
 * @property {number | null} [daysInstalled] Tenure in days, for a light "over N days" line.
 * @property {string} [appUrl] Overrides DEFAULT_APP_URL (or EMAIL_APP_URL).
 * @property {string} [logoUrl] Overrides DEFAULT_LOGO_URL (or EMAIL_LOGO_URL).
 * @property {string} [unsubscribeUrl] Overrides the derived one-click URL.
 * @property {string} [reinstallUrl] Overrides the derived reconnect deep link.
 */

/**
 * @typedef {RenderWinBackInput & { to: string }} SendWinBackInput
 */

/**
 * @typedef {Object} RenderedWinBack
 * @property {string} subject
 * @property {string} html
 * @property {string} text
 * @property {string} unsubscribeUrl
 */

/** @param {string} url */
function trimTrailingSlash(url) {
  return url.replace(/\/+$/, "");
}

/**
 * Deep-link the "Reconnect Jefe" CTA at the standalone landing, which redirects
 * `/?shop=<domain>` into the Shopify OAuth (re)install. Falls back to the bare
 * app URL if the shop domain is missing/invalid.
 * @param {string} appUrl @param {string} shopDomain
 */
function buildReconnectLink(appUrl, shopDomain) {
  const normalized = normalizeShopDomain(shopDomain);
  if (!normalized) return appUrl;
  const url = new URL(appUrl);
  url.searchParams.set("shop", normalized);
  return url.toString();
}

/**
 * Resolve the effective app / logo / unsubscribe / reconnect / feedback URLs,
 * honouring env overrides. Feedback links are HMAC-signed one-tap tokens.
 * @param {RenderWinBackInput} input
 */
function resolveUrls(input) {
  const appUrl = trimTrailingSlash(
    input.appUrl || process.env.EMAIL_APP_URL || DEFAULT_APP_URL,
  );
  const logoUrl = input.logoUrl || process.env.EMAIL_LOGO_URL || DEFAULT_LOGO_URL;
  const shopDomain = normalizeShopDomain(input.shopDomain);
  const emailHash = hashRecipient(input.to) ?? "";
  const unsubscribeUrl =
    input.unsubscribeUrl ||
    `${appUrl}/e/unsubscribe?t=${signUnsubscribeToken({ shopDomain, emailHash })}`;
  const reinstallUrl =
    input.reinstallUrl || buildReconnectLink(appUrl, input.shopDomain);
  /** @param {string} reason */
  const feedbackUrl = (reason) =>
    `${appUrl}/e/feedback?t=${signFeedbackToken({ shopDomain, emailHash, reason })}`;
  return { appUrl, logoUrl, unsubscribeUrl, reinstallUrl, feedbackUrl };
}

/**
 * Render the win-back email to subject + HTML + text. Pure: no side effects, no
 * network. Every `{{placeholder}}` in the template gets a concrete value.
 *
 * @param {RenderWinBackInput} input
 * @returns {RenderedWinBack}
 */
export function renderWinBackEmail(input) {
  const storeName =
    (input.storeName && input.storeName.trim()) ||
    deriveStoreName(input.shopDomain);
  const merchantName = input.merchantName ? input.merchantName.trim() : "";
  const greeting = merchantName || "Right then";
  const days =
    typeof input.daysInstalled === "number" && input.daysInstalled > 0
      ? Math.floor(input.daysInstalled)
      : 0;
  const daysDetail = days > 0 ? ` over ${days} ${days === 1 ? "day" : "days"}` : "";
  const { logoUrl, unsubscribeUrl, reinstallUrl, feedbackUrl } =
    resolveUrls(input);
  const recipientEmail = input.to || "";

  const vars = {
    greeting,
    storeName,
    daysDetail,
    logoUrl,
    reinstallUrl,
    feedbackTooEarlyUrl: feedbackUrl("too_early"),
    feedbackNoValueUrl: feedbackUrl("no_value"),
    feedbackTooComplexUrl: feedbackUrl("too_complex"),
    feedbackBrokeUrl: feedbackUrl("broke"),
    unsubscribeUrl,
    recipientEmail,
  };

  const html = interpolate(loadTemplateHtml(TEMPLATE_NAME), vars);
  const subject = SUBJECT_OPTIONS[0];
  const text = renderWinBackText({
    greeting,
    storeName,
    daysDetail,
    reinstallUrl,
    unsubscribeUrl,
  });

  return { subject, html, text, unsubscribeUrl };
}

/**
 * Plaintext alternative — improves deliverability and covers text-only clients.
 * The reason links are omitted from text (they carry per-recipient tokens); the
 * open-reply path is the plaintext feedback route.
 * @param {{ greeting: string; storeName: string; daysDetail: string; reinstallUrl: string; unsubscribeUrl: string }} vars
 */
function renderWinBackText(vars) {
  return [
    `${vars.greeting} — no hard feelings.`,
    "",
    `You've uninstalled me from ${vars.storeName}, so I've stopped. No emails after this one unless you come back.`,
    "",
    `What you're stepping away from is the Merchant Memory I built${vars.daysDetail} — what I'd learned about your orders, products and customers. I'll keep it safe for a little while, so if you reconnect soon I pick up where we left off rather than starting cold.`,
    "",
    "One question: what made you uninstall? Just reply to this email and tell me — it reaches me directly.",
    "",
    `Reconnect Jefe: ${vars.reinstallUrl}`,
    "",
    `Thanks for giving me a run. Genuinely — good luck with ${vars.storeName}.`,
    "— Jefe",
    "",
    `Turn off these emails: ${vars.unsubscribeUrl}`,
  ].join("\n");
}

/**
 * Build RFC 8058 one-click List-Unsubscribe headers for a given unsubscribe URL.
 * @param {string} unsubscribeUrl
 * @returns {Record<string, string>}
 */
export function unsubscribeHeaders(unsubscribeUrl) {
  return {
    "List-Unsubscribe": `<${unsubscribeUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/**
 * Render the win-back email and send it through the (gated) Resend adapter.
 *
 * @param {SendWinBackInput} input
 * @returns {Promise<import("./resend.server.js").SendEmailResult>}
 */
export async function sendWinBackEmail(input) {
  const { subject, html, text, unsubscribeUrl } = renderWinBackEmail(input);
  return sendEmail({
    to: input.to,
    subject,
    html,
    text,
    headers: unsubscribeHeaders(unsubscribeUrl),
  });
}

const DAY_MS = 86_400_000;

/**
 * Resolve who to send the farewell to at uninstall. The uninstall webhook has no
 * OAuth session, so — unlike the welcome, which reads the live
 * `associated_user` — the recipient comes from the persisted Shopify `Session`
 * rows for this shop (owner's email + first name). Prefers the account owner,
 * then the most recently-expiring session with an email. Returns null when no
 * session carries an email (older installs, collaborator-only) → the caller
 * no-ops gracefully.
 *
 * Sessions are read BEFORE `markShopifyInstallInactive` runs in the webhook, so
 * they are still present on the first (guard-claiming) delivery.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} shopDomain normalized myshopify domain
 * @returns {Promise<{ email: string; firstName: string | null } | null>}
 */
export async function resolveWinBackRecipient(prisma, shopDomain) {
  const sessions = await prisma.session.findMany({
    where: { shop: shopDomain, email: { not: null } },
    select: { email: true, firstName: true, accountOwner: true, expires: true },
    orderBy: [{ accountOwner: "desc" }, { expires: "desc" }],
    take: 1,
  });
  const chosen = sessions[0];
  if (!chosen?.email) return null;
  return { email: chosen.email, firstName: chosen.firstName ?? null };
}

/**
 * @typedef {Object} WinBackUninstallInput
 * @property {string} shopDomain
 * @property {string} shopId Already-resolved shop row id (webhook has it).
 * @property {string | null} [recipientEmail] Overrides Session resolution.
 * @property {string | null} [merchantName] Overrides the Session first name.
 * @property {string | null} [storeName] Overrides the domain-derived store label.
 * @property {Date | string | null} [installedAt] Shop createdAt, for the tenure line.
 * @property {string} [appUrl]
 */

/**
 * @typedef {Object} WinBackUninstallResult
 * @property {boolean} sent True when this call claimed the guard and dispatched.
 * @property {string} reason
 * @property {boolean} [delivered]
 * @property {boolean} [disabled]
 */

/**
 * Uninstall trigger: send the win-back email exactly once per shop.
 *
 * Idempotency mirrors the welcome guard: `shops.winback_email_sent_at` is
 * claimed atomically with a conditional `updateMany` (WHERE winback_email_sent_at
 * IS NULL). Only the caller that flips it from NULL dispatches; a reinstall +
 * later re-uninstall would re-send only if the column is reset (a documented
 * follow-up — for now one win-back per shop lifetime). The guard is claimed even
 * in the disabled default, so flipping ENABLE_EMAIL on later never retroactively
 * emails shops that churned while it was off.
 *
 * Never throws: a failed email must not break the uninstall webhook. Callers
 * should also fire-and-forget this off the webhook critical path.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {WinBackUninstallInput} input
 * @returns {Promise<WinBackUninstallResult>}
 */
export async function sendWinBackEmailOnUninstall(prisma, input) {
  try {
    // Dark by default: the one-way-door send stays off until a human flips
    // ENABLE_WINBACK_EMAIL. No recipient lookup, no guard claim, no Resend.
    if (!isWinBackEmailEnabled()) {
      return { sent: false, reason: "winback_disabled" };
    }

    const shopDomain = normalizeShopDomain(input.shopDomain);
    const resolved = input.recipientEmail
      ? { email: input.recipientEmail, firstName: input.merchantName ?? null }
      : await resolveWinBackRecipient(prisma, shopDomain);
    const recipient = resolved?.email || null;
    if (!recipient) {
      log.warn("winback email skipped: no recipient resolved", { shopDomain });
      return { sent: false, reason: "no_recipient" };
    }

    // Respect an existing unsubscribe (keyed by shop + email hash, no plaintext).
    const emailHash = hashRecipient(recipient);
    if (
      emailHash &&
      (await isEmailUnsubscribed(prisma, { shopId: input.shopId, emailHash }))
    ) {
      return { sent: false, reason: "unsubscribed" };
    }

    // Atomic claim: only the transition NULL -> now wins.
    const claim = await prisma.shop.updateMany({
      where: { id: input.shopId, winbackEmailSentAt: null },
      data: { winbackEmailSentAt: new Date() },
    });
    if (claim.count === 0) {
      return { sent: false, reason: "already_sent" };
    }

    const installedAt = input.installedAt ? new Date(input.installedAt) : null;
    const daysInstalled =
      installedAt && !Number.isNaN(installedAt.getTime())
        ? Math.max(0, Math.floor((Date.now() - installedAt.getTime()) / DAY_MS))
        : null;

    const result = await sendWinBackEmail({
      to: recipient,
      shopDomain,
      merchantName: input.merchantName ?? resolved?.firstName ?? null,
      storeName: input.storeName ?? null,
      daysInstalled,
      appUrl: input.appUrl,
    });

    return {
      sent: true,
      reason: result.disabled ? "disabled_stub" : "dispatched",
      delivered: Boolean(result.delivered),
      disabled: Boolean(result.disabled),
    };
  } catch (error) {
    // The guard may already be claimed; we intentionally do not release it
    // (prioritise "never send twice"). Swallow so uninstall is never affected.
    log.error("winback email failed", {
      shopDomain: input.shopDomain,
      err: error,
    });
    return { sent: false, reason: "error" };
  }
}
