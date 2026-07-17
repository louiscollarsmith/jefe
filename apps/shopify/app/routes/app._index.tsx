import type { LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server";
import { getDailyBriefReadiness } from "../services/daily-brief-readiness.server";
import { getOnboardingState } from "../services/onboarding.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: session.scope?.split(",").filter(Boolean) ?? [],
    rawPayload: { source: "app_index" },
  });
  const onboarding = await getOnboardingState(prisma, shop.id);

  if (!onboarding.onboardingComplete) {
    throw redirect("/app/onboarding");
  }

  const readiness = await getDailyBriefReadiness(prisma, {
    merchantId: merchant.id,
    shopId: shop.id,
    shopDomain: session.shop,
    sessionId: session.id,
    scopes: session.scope?.split(",").filter(Boolean) ?? [],
    source: "app_index_backfill_guard",
    generateIfImportComplete: true,
  });

  if (readiness.briefReady) {
    throw redirect("/app/daily-brief");
  }

  throw redirect("/app/onboarding");
};

export default function AppIndex() {
  return null;
}
