import type { LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticateAppRequest } from "../lib/auth/authenticate-app-request.server.js";
import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server";
import { getDailyChatThread } from "../lib/merchant-memory/general-chat.server.js";
import { listMerchantFilePicks } from "../lib/attachments/merchant-file.server.js";
import { splitScopes } from "../services/shopify-backfill-status.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticateAppRequest(request);
  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: splitScopes(session.scope),
    rawPayload: { source: "app_home_conversation_resource" },
  });
  const conversationId = new URL(request.url).searchParams.get("conversationId");
  if (!conversationId) {
    return json({ ok: false, error: "conversationId is required." }, 400);
  }

  const [conversation, libraryFiles] = await Promise.all([
    getDailyChatThread(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      conversationId,
    }),
    listMerchantFilePicks(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    }),
  ]);
  if (!conversation.conversation) {
    return json({ ok: false, conversation, libraryFiles: [], error: "That chat could not be found." }, 404);
  }
  return json({ ok: true, conversation, libraryFiles });
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
