import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import prisma from "../db.server";
import { parseShopDomain } from "../lib/auth/shop-domain.server.js";
import {
  managedInstallPath,
  resolveStandaloneStart,
  STANDALONE_CALLBACK_PATH,
} from "../lib/auth/standalone-auth-flow.server.js";
import { standaloneShopify } from "../lib/auth/standalone-shopify.server.js";

/**
 * Standalone sign-in entry (`/standalone/auth`), served on app.mynamejefe.com.
 * Validates the shop, gates on an existing install (unknown shop → canonical
 * managed install), then hands off to the dedicated standalone Shopify-API
 * instance's OAuth begin — which redirects to Shopify with a `redirect_uri` on
 * the standalone host. Embedded auth (`auth.$.tsx`) is entirely untouched.
 */

async function shopIsInstalled(shop: string): Promise<boolean> {
  const shopRow = await prisma.shop.findFirst({
    where: { platform: "shopify", shopDomain: shop },
    select: { id: true },
  });
  return Boolean(shopRow);
}

async function startStandaloneAuth(request: Request): Promise<Response> {
  const url = new URL(request.url);
  let shopInput = url.searchParams.get("shop");
  if (!shopInput && request.method !== "GET") {
    const form = await request.formData();
    const value = form.get("shop");
    shopInput = typeof value === "string" ? value : null;
  }

  const shop = parseShopDomain(shopInput);
  const isInstalled = shop ? await shopIsInstalled(shop) : false;
  const decision = resolveStandaloneStart({ shop, isInstalled });

  if (decision.action === "invalid") throw redirect("/");
  if (decision.action === "install") throw redirect(managedInstallPath(decision.shop));

  return standaloneShopify().auth.begin({
    shop: decision.shop,
    callbackPath: STANDALONE_CALLBACK_PATH,
    isOnline: false,
    rawRequest: request,
  });
}

export const loader = ({ request }: LoaderFunctionArgs) =>
  startStandaloneAuth(request);

export const action = ({ request }: ActionFunctionArgs) =>
  startStandaloneAuth(request);
