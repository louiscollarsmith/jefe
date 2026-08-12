// @ts-check

import { ShopifyAdminGraphqlClient } from "../shopify/admin-graphql.server.js";
import { logger as baseLogger } from "../observability/logger.server.js";

// The merchant's own brand logo, for the app-home header — so the embedded app wears
// the merchant's brand rather than a generic mark. Read from the shop's Admin GraphQL
// brand settings (`shop.brand.squareLogo` / `logo`, the merchant's own asset), and
// cached in `rawPayload.shopify.brandLogoUrl` so it's a FREE read on the home load
// thereafter (the loader already has rawPayload for the timezone).
//
// Best-effort and independent of getPersistedStoreName (which early-returns once the
// store name is cached and would otherwise skip this). Degrades to the initial-monogram
// fallback whenever there's no logo, or the `brand` field isn't accessible under the
// app's scopes — never a fake photo, and never a throw into the loader. (v1: a store
// with no logo is re-checked on each load, cheaply and off the render path, so a logo
// added later appears next load; caching a "checked" sentinel is a later optimisation.)

const log = baseLogger.child({ component: "shop-brand" });

const SHOP_BRAND_QUERY = `#graphql
  query JefeShopBrand {
    shop {
      brand {
        squareLogo {
          image {
            url
          }
        }
        logo {
          image {
            url
          }
        }
      }
    }
  }
`;

/** @param {unknown} value @returns {string | null} */
function normalizeUrl(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Read the persisted brand-logo URL from the shop rawPayload, or null when unknown.
 * Pure — safe to call in a loader against the already-loaded rawPayload.
 * @param {unknown} rawPayload
 * @returns {string | null}
 */
export function brandLogoFromPayload(rawPayload) {
  if (!rawPayload || typeof rawPayload !== "object") return null;
  const shopify = /** @type {{ shopify?: unknown }} */ (rawPayload).shopify;
  if (!shopify || typeof shopify !== "object") return null;
  return normalizeUrl(
    /** @type {{ brandLogoUrl?: unknown }} */ (shopify).brandLogoUrl,
  );
}

/**
 * Pick the best logo URL from a `shop.brand` result: the SQUARE logo first (it fits the
 * square header mark), then the primary logo. Pure — exported for tests.
 * @param {unknown} brand
 * @returns {string | null}
 */
export function pickBrandLogoUrl(brand) {
  if (!brand || typeof brand !== "object") return null;
  const record = /** @type {{ squareLogo?: any; logo?: any }} */ (brand);
  return (
    normalizeUrl(record.squareLogo?.image?.url) ??
    normalizeUrl(record.logo?.image?.url)
  );
}

/**
 * Ensure `rawPayload.shopify.brandLogoUrl` is populated. Idempotent and best-effort
 * (never throws into the caller): returns early when a URL is already cached, otherwise
 * fetches `shop.brand` via Admin GraphQL and persists the URL. A `client` may be
 * injected for tests; otherwise one is built from shopDomain + accessToken.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{
 *   shopId: string;
 *   shopDomain?: string | null;
 *   accessToken?: string | null;
 *   client?: { request: (query: string, variables?: Record<string, unknown>) => Promise<any> } | null;
 * }} input
 * @returns {Promise<{ status: string; hasLogo: boolean }>}
 */
export async function ensureShopBrandLogo(prisma, input) {
  try {
    const shop = await prisma.shop.findUnique({
      where: { id: input.shopId },
      select: { rawPayload: true },
    });
    if (!shop) return { status: "shop_not_found", hasLogo: false };
    if (brandLogoFromPayload(shop.rawPayload)) {
      return { status: "already_set", hasLogo: true };
    }

    const client =
      input.client ??
      (input.shopDomain && input.accessToken
        ? new ShopifyAdminGraphqlClient({
            shopDomain: input.shopDomain,
            accessToken: input.accessToken,
            logger: log,
            maxRetries: 1,
          })
        : null);
    if (!client) return { status: "no_client", hasLogo: false };

    const data = await client.request(SHOP_BRAND_QUERY);
    const url = pickBrandLogoUrl(data?.shop?.brand ?? null);
    if (!url) return { status: "no_logo", hasLogo: false };

    await persist(prisma, input.shopId, shop.rawPayload, url);
    return { status: "persisted", hasLogo: true };
  } catch (error) {
    log.warn("failed to ensure shop brand logo", {
      shopId: input.shopId,
      err: error,
    });
    return { status: "error", hasLogo: false };
  }
}

/**
 * Merge the logo URL into rawPayload.shopify.brandLogoUrl (read-modify-write; a lost
 * race just re-persists the same URL next load, so it's harmless).
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} shopId
 * @param {unknown} currentPayload
 * @param {string} url
 */
async function persist(prisma, shopId, currentPayload, url) {
  const current =
    currentPayload &&
    typeof currentPayload === "object" &&
    !Array.isArray(currentPayload)
      ? /** @type {Record<string, unknown>} */ (currentPayload)
      : {};
  const shopify =
    current.shopify &&
    typeof current.shopify === "object" &&
    !Array.isArray(current.shopify)
      ? /** @type {Record<string, unknown>} */ (current.shopify)
      : {};
  await prisma.shop.update({
    where: { id: shopId },
    data: { rawPayload: { ...current, shopify: { ...shopify, brandLogoUrl: url } } },
  });
  // The URL is a public CDN asset, safe to log; keep it terse.
  log.info("persisted shop brand logo", { shopId, hasLogo: true });
}
