import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import prisma from "../db.server";
import { serializeStandaloneSession } from "../lib/auth/standalone-session.server.js";
import { standaloneShopify } from "../lib/auth/standalone-shopify.server.js";
import { logger } from "../lib/observability/logger.server";
import {
  queueInstallShopifyBackfill,
  splitScopes,
} from "../services/shopify-backfill-status.server";
import { sessionStorage } from "../shopify.server";

/**
 * Standalone OAuth callback (`/standalone/callback`) on app.mynamejefe.com.
 *
 * Uses the dedicated standalone instance's `auth.callback` — the library's
 * tested state+HMAC verification and token exchange — then:
 *  1. persists the OFFLINE session through the SAME session store the embedded
 *     flow uses (deterministic `offline_<shop>` id → zero divergence, so
 *     `unauthenticated.admin(shop)` later resolves exactly this session);
 *  2. queues the (idempotent) backfill — a no-op for an existing merchant;
 *  3. sets our signed standalone cookie and redirects to `/app`.
 *
 * Deliberately emits NO App Bridge / embedded headers — a plain 302 to `/app`.
 * It carries over the SDK's response headers (which clear the `shopify_app_state`
 * cookie) and appends our session cookie.
 */

const log = logger.child({ component: "standalone-auth" });

/** Collect Set-Cookie values from the SDK callback headers (Headers | record). */
function setCookiesFrom(headers: unknown): string[] {
  if (!headers) return [];
  if (headers instanceof Headers) {
    const many = headers.getSetCookie?.();
    if (many && many.length) return many;
    const one = headers.get("set-cookie");
    return one ? [one] : [];
  }
  const record = headers as Record<string, string | string[]>;
  const value = record["Set-Cookie"] ?? record["set-cookie"];
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  let callbackResult;
  try {
    callbackResult = await standaloneShopify().auth.callback({
      rawRequest: request,
    });
  } catch (error) {
    // Invalid/expired state, HMAC mismatch, denied consent — never surface
    // details; send the merchant back to the standalone sign-in.
    log.warn("standalone OAuth callback rejected", { err: error });
    throw redirect("/");
  }

  const { session, headers } = callbackResult;

  await sessionStorage.storeSession(session);

  // Idempotent: no-op for an already-backfilled shop. Never block the redirect.
  try {
    await queueInstallShopifyBackfill(prisma, {
      shopDomain: session.shop,
      sessionId: session.id,
      scopes: splitScopes(session.scope),
      rawPayload: { source: "standalone_callback" },
    });
  } catch (error) {
    log.error("standalone backfill enqueue failed", {
      err: error,
      shopDomain: session.shop,
    });
  }

  const responseHeaders = new Headers();
  for (const cookie of setCookiesFrom(headers)) {
    responseHeaders.append("Set-Cookie", cookie);
  }
  responseHeaders.append("Set-Cookie", await serializeStandaloneSession(session.shop));
  responseHeaders.set("Location", "/app");
  return new Response(null, { status: 302, headers: responseHeaders });
};
