import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import prisma from "../db.server";
import { startSlackConnection } from "../lib/channels/service.server.js";
import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server";
import { authenticate } from "../shopify.server";
import { splitScopes } from "../services/shopify-backfill-status.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: splitScopes(session.scope),
    rawPayload: { source: "slack_oauth_start_action" },
  });
  const result = await startSlackConnection(prisma, {
    merchantId: merchant.id,
    shopId: shop.id,
    requestUrl: request.url,
  });

  return redirect(result.authoriseUrl);
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return redirect(slackChannelsPath(new URL(request.url).search));
};

function slackChannelsPath(search: string) {
  const params = new URLSearchParams(search);
  params.set("step", "channels");
  params.set("channelProvider", "slack");
  const nextSearch = params.toString();
  return nextSearch ? `/app?${nextSearch}` : "/app?step=channels&channelProvider=slack";
}
