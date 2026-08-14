import type { LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticateAppRequest } from "../lib/auth/authenticate-app-request.server.js";
import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server";
import { listChatsFocusedOnAction } from "../lib/merchant-memory/focused-action-chat.server.js";
import { getMerchantAction } from "../lib/actions/merchant-action.server";
import { splitScopes } from "../services/shopify-backfill-status.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticateAppRequest(request);
  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: splitScopes(session.scope),
    rawPayload: { source: "app_home_action_chats_resource" },
  });
  const actionId = new URL(request.url).searchParams.get("actionId");
  if (!actionId) {
    return json({ ok: false, error: "actionId is required.", chats: [] }, 400);
  }

  const action = await getMerchantAction(prisma, {
    merchantId: merchant.id,
    shopId: shop.id,
    actionId,
  });
  if (!action) {
    return json({ ok: false, error: "That action could not be found.", chats: [] }, 404);
  }

  const chats = await listChatsFocusedOnAction(prisma, {
    merchantId: merchant.id,
    shopId: shop.id,
    actionId,
  });
  return json({ ok: true, actionId, chats });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
}
