import type { LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import {
  FEEDBACK_REASONS,
  verifyFeedbackToken,
} from "../lib/email/feedback.server.js";
import { logger as baseLogger } from "../lib/observability/logger.server";
import { track } from "../services/analytics/event-log.server.js";

/**
 * Public win-back feedback endpoint (the "What made you uninstall?" one-tap
 * links in the farewell email).
 *
 * GET /e/feedback?t=TOKEN → records the reason and renders a thank-you page.
 *
 * The token is HMAC-signed and binds shop + recipient email hash + one locked
 * reason code, so a link can't be forged or edited to attribute a reason to a
 * different store. Recording is one-tap by design (GET), and append-only: it
 * emits a PII-free `shop_uninstall_feedback` lifecycle event — the same
 * event-log the churn snapshot uses — never a destructive mutation. Email
 * scanners may pre-fetch several links; readback should take the LATEST event
 * per shop as the merchant's real answer (chat 8 folds it onto the churn record).
 *
 * Not embedded/authenticated — this is opened from an email, outside Shopify.
 */

const log = baseLogger.child({ component: "email" });

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const token = new URL(request.url).searchParams.get("t");
  const parsed = verifyFeedbackToken(token);
  if (!parsed) return htmlResponse(invalidPage(), 400);

  const label = FEEDBACK_REASONS[parsed.reason] ?? "your reason";
  const shop = await resolveShop(parsed.shopDomain);
  if (shop) {
    try {
      await track(prisma, {
        type: "shop_uninstall_feedback",
        topic: "lifecycle",
        merchantId: shop.merchantId,
        shopId: shop.id,
        shopDomain: parsed.shopDomain,
        summary: `Uninstall reason: ${label}`,
        properties: { reason: parsed.reason },
      });
      log.info("winback feedback recorded", {
        shopDomain: parsed.shopDomain,
        reason: parsed.reason,
      });
    } catch (error) {
      // Never fail the merchant's tap on a logging error — still say thanks.
      log.error("winback feedback capture failed", {
        shopDomain: parsed.shopDomain,
        err: error,
      });
    }
  } else {
    log.warn("winback feedback: shop not found for a valid token", {
      shopDomain: parsed.shopDomain,
    });
  }
  return htmlResponse(thanksPage(label));
};

function resolveShop(shopDomain: string) {
  return prisma.shop.findUnique({
    where: { platform_shopDomain: { platform: "shopify", shopDomain } },
    select: { id: true, merchantId: true },
  });
}

function htmlResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html;charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function shell(title: string, inner: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color: #17202f; background: #f8f3ea; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { align-items: center; display: flex; justify-content: center; margin: 0; min-height: 100vh; padding: 24px; }
      main { background: #fffdf8; border: 1px solid rgba(23, 32, 47, 0.14); border-radius: 8px; box-shadow: 0 16px 48px rgba(23, 32, 47, 0.12); max-width: 440px; padding: 32px; text-align: center; }
      h1 { font-family: Georgia, "Times New Roman", serif; font-size: 26px; font-weight: 500; line-height: 1.15; margin: 0 0 12px; }
      p { color: rgba(23, 32, 47, 0.72); font-size: 15px; line-height: 1.55; margin: 0 0 20px; }
      .r { color: #8c4030; font-weight: 650; }
    </style>
  </head>
  <body><main>${inner}</main></body>
</html>`;
}

function thanksPage(label: string) {
  return shell(
    "Thanks for the feedback",
    `<h1>Noted — thank you.</h1>
     <p>You said: <span class="r">${escapeHtml(label)}</span>. That's genuinely useful, and it's the kind of thing that makes Jefe better. If there's more to it, just reply to the email — it reaches me directly.</p>
     <p>— Jefe</p>`,
  );
}

function invalidPage() {
  return shell(
    "Link not valid",
    `<h1>This link isn't valid</h1>
     <p>This feedback link is invalid or has expired. If you'd still like to tell us why you left, reply to any Jefe email and it'll reach us.</p>`,
  );
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
