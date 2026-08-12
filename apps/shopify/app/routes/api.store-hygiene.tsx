import type { LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticateAppRequest } from "../lib/auth/authenticate-app-request.server.js";
import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server";
import { splitScopes } from "../services/shopify-backfill-status.server";
import { getStoreHygieneFindings } from "../lib/store-hygiene/store-hygiene-scan.server";
import { logger } from "../lib/observability/logger.server";

const log = logger.child({ component: "store-hygiene" });

// Store-hygiene findings endpoint — a read-only, best-effort scan (refund clusters, missing
// cost / product-type / SKU / description) returning `{ findings }`, each with a deep-link to the
// fix in Shopify admin. Never returns a redirect/5xx: any failure (incl. an auth hiccup on a
// background fetch) yields no findings instead.
//
// ⚠️ NO CALLER as of 2026-08-12. The original reader — a post-first-paint `useFetcher` in the
// (now-retired) 13a `DailyHome` — was dropped when the home was rewritten (PR #75), and the home
// is being rebuilt as a chat log, so findings are not going back onto it. The endpoint, the scan
// service and its tests all still work; placement is pending — proposed as a `/app/settings`
// tidy-up panel. Wire a caller there before relying on this.
export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { session } = await authenticateAppRequest(request);
    const { merchant, shop } = await ensureShopifyTenant(prisma, {
      shopDomain: session.shop,
      accessTokenSessionId: session.id,
      scopes: splitScopes(session.scope),
      rawPayload: { source: "store_hygiene_findings" },
    });
    const findings = await getStoreHygieneFindings(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      shopDomain: session.shop,
    });
    return { findings };
  } catch (error) {
    log.warn("store-hygiene findings load failed; returning none", { err: error });
    return { findings: [] };
  }
}
