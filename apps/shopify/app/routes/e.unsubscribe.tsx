import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import {
  isEmailUnsubscribed,
  recordUnsubscribe,
  verifyUnsubscribeToken,
} from "../lib/email/unsubscribe.server.js";
import { logger as baseLogger } from "../lib/observability/logger.server";

/**
 * Public one-click unsubscribe endpoint (RFC 8058).
 *
 * GET  /e/unsubscribe?t=TOKEN  → a human confirm page. A GET (link prefetch,
 *                                antivirus scanners) must never unsubscribe, so
 *                                the GET only renders a button.
 * POST /e/unsubscribe?t=TOKEN  → performs the unsubscribe. Mail clients issue
 *                                this automatically for List-Unsubscribe-Post=
 *                                One-Click; the confirm page's button posts here
 *                                too. The token is HMAC-signed and binds the shop
 *                                + recipient email hash, so it can't be forged to
 *                                silence someone else.
 *
 * Not embedded/authenticated — this is opened from an email, outside Shopify.
 */

const log = baseLogger.child({ component: "email" });

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const token = new URL(request.url).searchParams.get("t");
  const parsed = verifyUnsubscribeToken(token);
  if (!parsed) return htmlResponse(invalidPage(), 400);

  const shop = await resolveShop(parsed.shopDomain);
  if (
    shop &&
    (await isEmailUnsubscribed(prisma, {
      shopId: shop.id,
      emailHash: parsed.emailHash,
    }))
  ) {
    return htmlResponse(donePage());
  }
  return htmlResponse(confirmPage(token ?? ""));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  let token = new URL(request.url).searchParams.get("t");
  if (!token) {
    try {
      const value = (await request.formData()).get("t");
      token = typeof value === "string" ? value : null;
    } catch {
      token = null;
    }
  }
  const parsed = verifyUnsubscribeToken(token);
  if (!parsed) return htmlResponse(invalidPage(), 400);

  const shop = await resolveShop(parsed.shopDomain);
  if (shop) {
    await recordUnsubscribe(prisma, {
      shopId: shop.id,
      emailHash: parsed.emailHash,
      source: "one_click",
    });
    log.info("email unsubscribe recorded", {
      shopDomain: parsed.shopDomain,
      emailHash: parsed.emailHash,
    });
  } else {
    // Valid token but the shop is gone (uninstalled) — nothing left to suppress.
    log.warn("email unsubscribe: shop not found for a valid token", {
      shopDomain: parsed.shopDomain,
    });
  }
  return htmlResponse(donePage());
};

function resolveShop(shopDomain: string) {
  return prisma.shop.findUnique({
    where: { platform_shopDomain: { platform: "shopify", shopDomain } },
    select: { id: true },
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
      button { background: #17202f; border: 0; border-radius: 8px; color: #f8ece7; cursor: pointer; font-size: 15px; font-weight: 650; padding: 12px 22px; }
      button:hover { opacity: 0.92; }
    </style>
  </head>
  <body><main>${inner}</main></body>
</html>`;
}

function confirmPage(token: string) {
  return shell(
    "Unsubscribe from Jefe emails",
    `<h1>Turn off Jefe emails?</h1>
     <p>You'll stop getting Jefe emails for this store. You can turn them back on anytime from the app.</p>
     <form method="post" action="/e/unsubscribe?t=${escapeAttr(token)}">
       <button type="submit">Unsubscribe</button>
     </form>`,
  );
}

function donePage() {
  return shell(
    "You're unsubscribed",
    `<h1>You're unsubscribed</h1>
     <p>Done — you won't get Jefe emails for this store anymore. Changed your mind? You can turn them back on from the app's settings.</p>`,
  );
}

function invalidPage() {
  return shell(
    "Link not valid",
    `<h1>This link isn't valid</h1>
     <p>This unsubscribe link is invalid or has expired. If you're still getting emails you didn't want, reply to any Jefe email and we'll sort it out.</p>`,
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

function escapeAttr(value: string) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}
