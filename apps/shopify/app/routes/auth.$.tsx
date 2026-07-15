import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import {
  queueInstallShopifyBackfill,
  splitScopes,
} from "../services/shopify-backfill-status.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  await queueInstallShopifyBackfill(prisma, {
    shopDomain: session.shop,
    sessionId: session.id,
    scopes: splitScopes(session.scope),
    rawPayload: { source: "oauth_callback" },
  });

  return null;
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
