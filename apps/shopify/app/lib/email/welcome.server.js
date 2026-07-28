// @ts-check

import { normalizeShopDomain } from "../shopify/admin-graphql.server.js";
import { sendEmail } from "./resend.server.js";
import { loadTemplateHtml, interpolate } from "./template.server.js";

/**
 * The WELCOME email (Day 0, trigger "Shopify OAuth completes", one ask
 * "watch me work"). Renders the ship-as-is design template and dispatches it
 * through the ENABLE_EMAIL-gated Resend adapter.
 */

const TEMPLATE_NAME = "jefe-welcome";

/** Base URL for the Jefe web app used by the CTA + settings/unsubscribe links. */
export const DEFAULT_APP_URL = "https://app.mynamejefe.com";
/**
 * Hosted inverted lockup for the header. Served from the Shopify app's own
 * `public/email/` dir (Vite serves `public/`), so it lives on the app origin.
 * See README blocker: host this asset + point the app custom domain at Railway.
 */
export const DEFAULT_LOGO_URL =
  "https://app.mynamejefe.com/email/jefe-lockup-inverted.png";

/**
 * @typedef {Object} RenderWelcomeInput
 * @property {string} shopDomain Used to derive a store label + unsubscribe token.
 * @property {string} [to] Recipient address (shown in the footer receipt line).
 * @property {string | null} [merchantName] First name for the greeting, if known.
 * @property {string | null} [storeName] Store label; derived from shopDomain if omitted.
 * @property {string} [appUrl] Overrides DEFAULT_APP_URL (or EMAIL_APP_URL).
 * @property {string} [logoUrl] Overrides DEFAULT_LOGO_URL (or EMAIL_LOGO_URL).
 * @property {string} [unsubscribeUrl] Overrides the derived one-click URL.
 * @property {string} [historyDetail] Overrides the generic "reading history" line.
 * @property {string} [firstBriefEta] Overrides the generic first-brief ETA.
 */

/**
 * @typedef {RenderWelcomeInput & { to: string }} SendWelcomeInput
 */

/**
 * @typedef {Object} RenderedWelcome
 * @property {string} subject
 * @property {string} html
 * @property {string} text
 * @property {string} unsubscribeUrl
 */

/**
 * Turn a shop domain into a human store label as a fallback when the real store
 * name is unknown, e.g. "northwind-supply.myshopify.com" -> "Northwind Supply".
 *
 * @param {string} shopDomain
 * @returns {string}
 */
export function deriveStoreName(shopDomain) {
  const host = String(shopDomain || "").trim().toLowerCase();
  if (!host) return "your store";
  const label = host
    .replace(/^https?:\/\//, "")
    .replace(/\.myshopify\.com$/, "")
    .split(".")[0];
  const words = label
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return words.length ? words.join(" ") : "your store";
}

/**
 * Build a placeholder one-click unsubscribe token. The real signed token + the
 * `/e/unsubscribe` page are documented follow-ups; this only has to produce a
 * stable `?t=…` value so the link and RFC 8058 header point at the right path.
 *
 * @param {string} shopDomain
 * @returns {string}
 */
export function buildUnsubscribeToken(shopDomain) {
  return Buffer.from(`shop:${normalizeShopDomain(shopDomain)}`, "utf8").toString(
    "base64url",
  );
}

/** @param {string} url */
function trimTrailingSlash(url) {
  return url.replace(/\/+$/, "");
}

/**
 * Resolve the effective app + logo URLs, honouring env overrides.
 * @param {RenderWelcomeInput} input
 */
function resolveUrls(input) {
  const appUrl = trimTrailingSlash(
    input.appUrl || process.env.EMAIL_APP_URL || DEFAULT_APP_URL,
  );
  const logoUrl = input.logoUrl || process.env.EMAIL_LOGO_URL || DEFAULT_LOGO_URL;
  const unsubscribeUrl =
    input.unsubscribeUrl ||
    `${appUrl}/e/unsubscribe?t=${buildUnsubscribeToken(input.shopDomain)}`;
  return { appUrl, logoUrl, unsubscribeUrl };
}

/**
 * Render the welcome email to subject + HTML + text. Pure: no side effects, no
 * network. Every `{{placeholder}}` in the template gets a concrete value.
 *
 * @param {RenderWelcomeInput} input
 * @returns {RenderedWelcome}
 */
export function renderWelcomeEmail(input) {
  const storeName =
    (input.storeName && input.storeName.trim()) ||
    deriveStoreName(input.shopDomain);
  const merchantName = input.merchantName ? input.merchantName.trim() : "";
  const greeting = merchantName ? `Alright, ${merchantName}` : "Alright";
  const { appUrl, logoUrl, unsubscribeUrl } = resolveUrls(input);
  const recipientEmail = input.to || "";

  const vars = {
    greeting,
    storeName,
    historyDetail:
      input.historyDetail || "Your full order history and product catalogue",
    firstBriefEta: input.firstBriefEta || "Tomorrow, 7:30am",
    logoUrl,
    ctaUrl: appUrl,
    guardrailsUrl: `${appUrl}/settings/guardrails`,
    notificationsUrl: `${appUrl}/settings/notifications`,
    unsubscribeUrl,
    recipientEmail,
  };

  const html = interpolate(loadTemplateHtml(TEMPLATE_NAME), vars);
  const subject = `I'm in — here's what happens next on ${storeName}`;
  const text = renderWelcomeText({ greeting, storeName, appUrl, unsubscribeUrl });

  return { subject, html, text, unsubscribeUrl };
}

/**
 * Plaintext alternative — improves deliverability and covers text-only clients.
 * @param {{ greeting: string; storeName: string; appUrl: string; unsubscribeUrl: string }} vars
 */
function renderWelcomeText(vars) {
  return [
    `${vars.greeting} — I'm in.`,
    "",
    `${vars.storeName} is connected. I'm reading your order history, current inventory and ad accounts right now. Nothing changes in your store while I'm reading.`,
    "",
    "Next 24 hours:",
    "- Finish reading your history",
    "- Send you a tidy-up list (broken links, stale stock, unclaimed refunds)",
    "- Your first morning brief: what I'd do today, and why",
    "",
    "What I won't do without asking: change a price, spend more than $200/day moving ad budget, email a customer, or cancel/refund an order. Anything on that list comes to you first.",
    "",
    `Watch me work: ${vars.appUrl}`,
    "",
    "Reply to this email and it reaches me — same thread, same memory as the app.",
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
 * Render the welcome email and send it through the (gated) Resend adapter.
 *
 * @param {SendWelcomeInput} input
 * @returns {Promise<import("./resend.server.js").SendEmailResult>}
 */
export async function sendWelcomeEmail(input) {
  const { subject, html, text, unsubscribeUrl } = renderWelcomeEmail(input);
  return sendEmail({
    to: input.to,
    subject,
    html,
    text,
    headers: unsubscribeHeaders(unsubscribeUrl),
  });
}

/**
 * @typedef {Object} WelcomeInstallInput
 * @property {string} shopDomain
 * @property {string | null} [recipientEmail] Where to send; skipped if absent.
 * @property {string | null} [merchantName]
 * @property {string | null} [storeName]
 * @property {string} [appUrl]
 */

/**
 * @typedef {Object} WelcomeInstallResult
 * @property {boolean} sent True when this call claimed the guard and dispatched.
 * @property {string} reason
 * @property {boolean} [delivered]
 * @property {boolean} [disabled]
 */

/**
 * Install trigger: send the welcome email exactly once per shop.
 *
 * Idempotency: the `shops.welcome_email_sent_at` timestamp is claimed
 * atomically with a conditional `updateMany` (WHERE welcome_email_sent_at IS
 * NULL). Only the caller that flips it from NULL dispatches; every later
 * afterAuth is a no-op. The guard is claimed even in the disabled default (the
 * adapter still runs as a logging no-op), so flipping ENABLE_EMAIL on later does
 * not retroactively email shops that installed while it was off.
 *
 * Never throws: a failed email must not break install. Callers should also
 * fire-and-forget this off the auth critical path.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {WelcomeInstallInput} input
 * @returns {Promise<WelcomeInstallResult>}
 */
export async function sendWelcomeEmailOnInstall(prisma, input) {
  try {
    const shopDomain = normalizeShopDomain(input.shopDomain);
    const recipient = input.recipientEmail || null;
    if (!recipient) {
      console.warn(
        `[welcome-email] no recipient resolved for ${shopDomain} — skipping (see README: resolve merchant email before first real send)`,
      );
      return { sent: false, reason: "no_recipient" };
    }

    const shop = await prisma.shop.findUnique({
      where: { platform_shopDomain: { platform: "shopify", shopDomain } },
      select: { id: true, welcomeEmailSentAt: true },
    });
    if (!shop) {
      console.warn(`[welcome-email] shop not found for ${shopDomain} — skipping`);
      return { sent: false, reason: "shop_not_found" };
    }
    if (shop.welcomeEmailSentAt) {
      return { sent: false, reason: "already_sent" };
    }

    // Atomic claim: only the transition NULL -> now wins.
    const claim = await prisma.shop.updateMany({
      where: { id: shop.id, welcomeEmailSentAt: null },
      data: { welcomeEmailSentAt: new Date() },
    });
    if (claim.count === 0) {
      return { sent: false, reason: "already_sent" };
    }

    const result = await sendWelcomeEmail({
      to: recipient,
      shopDomain,
      merchantName: input.merchantName ?? null,
      storeName: input.storeName ?? null,
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
    // (prioritise "never send twice"). Retry-on-failure is a documented
    // follow-up. Swallow so install is never affected.
    console.error(
      `[welcome-email] failed for ${input.shopDomain}:`,
      error instanceof Error ? error.message : error,
    );
    return { sent: false, reason: "error" };
  }
}
