import type { LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticateAppRequest } from "../lib/auth/authenticate-app-request.server.js";
import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server";
import { splitScopes } from "../services/shopify-backfill-status.server";
import { getStoreHygieneFindings } from "../lib/store-hygiene/store-hygiene-scan.server";
import { logger } from "../lib/observability/logger.server";

const log = logger.child({ component: "store-hygiene" });

// Deferred store-hygiene findings for the Daily Home Brief. `DailyHome` loads this via
// `useFetcher` AFTER first paint, so the scan's ~5 bounded reads stay OFF the LCP-critical
// `app._index` loader (chat 10's critical-vs-deferred split — heavier / below-the-fold reads
// stream in). Read-only + best-effort: any failure (incl. an auth hiccup on a background
// fetch) returns no findings rather than a redirect/5xx — the Brief's honest "nothing's on
// fire" stands, and the primary page load is never disrupted by this enhancement.
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
