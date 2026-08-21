import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import {
  queueInstallShopifyBackfill,
  splitScopes,
} from "../services/shopify-backfill-status.server";
import { logger } from "../lib/observability/logger.server";
import { resolveInstalledShopifyScopes } from "../lib/shopify/installed-scopes.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const scopes = await resolveScopesForAuthenticatedSession(session);

  await queueInstallShopifyBackfill(prisma, {
    shopDomain: session.shop,
    sessionId: session.id,
    scopes,
    rawPayload: { source: "oauth_callback" },
  });

  return null;
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

async function resolveScopesForAuthenticatedSession(session: {
  shop: string;
  id?: string;
  scope?: string | null;
  accessToken?: string | null;
}) {
  const fallbackScopes = splitScopes(session.scope);
  const resolved = await resolveInstalledShopifyScopes({
    shopDomain: session.shop,
    accessToken: session.accessToken,
    fallbackScopes,
    logger,
  });
  if (resolved.source === "live_shopify") {
    await prisma.session
      .updateMany({
        where: { shop: session.shop },
        data: { scope: resolved.scopes.join(",") },
      })
      .catch((error) => {
        logger.warn("Shopify callback session scope sync write failed", {
          shopDomain: session.shop,
          error: error instanceof Error ? error.name : "UnknownError",
        });
      });
  }
  return resolved.scopes;
}
