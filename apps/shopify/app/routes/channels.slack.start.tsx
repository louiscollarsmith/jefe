import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import prisma from "../db.server";
import {
  channelActionError,
  startSlackConnection,
} from "../lib/channels/service.server.js";
import { resolveShopifyTenantForRequest } from "../lib/ingestion/shopify/tenant.server";
import { authenticate } from "../shopify.server";
import { splitScopes } from "../services/shopify-backfill-status.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const wantsJson = request.headers.get("Accept")?.includes("application/json");
  const { session } = await authenticate.admin(request);
  const { merchant, shop } = await resolveShopifyTenantForRequest(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: splitScopes(session.scope),
    rawPayload: { source: "slack_oauth_start_action" },
  });

  try {
    const result = await startSlackConnection(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      requestUrl: request.url,
    });

    if (wantsJson) {
      return Response.json({
        ok: true,
        provider: "slack",
        redirectUrl: result.authoriseUrl,
      });
    }

    return redirect(result.authoriseUrl);
  } catch (error) {
    if (wantsJson) {
      return Response.json(
        {
          ok: false,
          provider: "slack",
          error: channelActionError(error),
        },
        { status: 400 },
      );
    }
    throw error;
  }
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return redirect(slackChannelsPath(new URL(request.url).search));
};

function slackChannelsPath(search: string) {
  const params = new URLSearchParams(search);
  params.set("step", "channels");
  params.set("channelProvider", "slack");
  const nextSearch = params.toString();
  return nextSearch
    ? `/app?${nextSearch}`
    : "/app?step=channels&channelProvider=slack";
}
