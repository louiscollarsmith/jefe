// @ts-check

import { normalizeShopDomain } from "../shopify/admin-graphql.server.js";
import { logger as baseLogger } from "../observability/logger.server.js";

// The merchant's own brand logo, for the app-home header — so the embedded app wears
// the merchant's brand rather than a generic mark.
//
// `shop.brand` is a Storefront API field. It does not exist on Admin GraphQL `Shop`
// (querying it there throws `undefinedField` on every home load). We read it from the
// tokenless Storefront endpoint, which exposes public brand assets without extra scopes,
// and cache the URL in `rawPayload.shopify.brandLogoUrl` so later home loads are a FREE
// read (the loader already has rawPayload for the timezone).
//
// Best-effort and independent of getPersistedStoreName (which early-returns once the
// store name is cached and would otherwise skip this). Degrades to the initial-monogram
// fallback whenever there's no logo, the storefront is unreachable, or the response is
// not an https URL — never a fake photo, and never a throw into the loader. A miss is
// remembered for a day so we do not log the same GraphQL error on every refresh.

const log = baseLogger.child({ component: "shop-brand" });

const DEFAULT_API_VERSION = "2026-07";
const CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;

export const SHOP_BRAND_QUERY = `#graphql
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
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // Only persist https CDN assets — this URL is rendered as <img src>.
  if (!trimmed || !/^https:\/\//i.test(trimmed)) return null;
  return trimmed;
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
 * @param {unknown} rawPayload
 * @param {number} now
 * @returns {boolean}
 */
export function hasFreshBrandLogoCheck(rawPayload, now = Date.now()) {
  if (brandLogoFromPayload(rawPayload)) return true;
  if (!rawPayload || typeof rawPayload !== "object") return false;
  const shopify = /** @type {{ shopify?: unknown }} */ (rawPayload).shopify;
  if (!shopify || typeof shopify !== "object") return false;
  const checkedAt = /** @type {{ brandLogoCheckedAt?: unknown }} */ (shopify)
    .brandLogoCheckedAt;
  if (typeof checkedAt !== "string" || !checkedAt.trim()) return false;
  const at = Date.parse(checkedAt);
  if (!Number.isFinite(at)) return false;
  return now - at < CHECK_TTL_MS;
}

/**
 * Ensure `rawPayload.shopify.brandLogoUrl` is populated. Idempotent and best-effort
 * (never throws into the caller): returns early when a URL is already cached, or when
 * we recently checked and found nothing. Otherwise fetches `shop.brand` from the
 * tokenless Storefront API. A `client` (or `fetchImpl`) may be injected for tests.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{
 *   shopId: string;
 *   shopDomain?: string | null;
 *   now?: number;
 *   fetchImpl?: typeof fetch;
 *   client?: { request: (query: string, variables?: Record<string, unknown>) => Promise<any> } | null;
 * }} input
 * @returns {Promise<{ status: string; hasLogo: boolean }>}
 */
export async function ensureShopBrandLogo(prisma, input) {
  /** @type {unknown} */
  let rawPayload = null;
  try {
    const shop = await prisma.shop.findUnique({
      where: { id: input.shopId },
      select: { rawPayload: true },
    });
    if (!shop) return { status: "shop_not_found", hasLogo: false };
    rawPayload = shop.rawPayload;
    if (brandLogoFromPayload(rawPayload)) {
      return { status: "already_set", hasLogo: true };
    }
    const now = input.now ?? Date.now();
    if (hasFreshBrandLogoCheck(rawPayload, now)) {
      return { status: "recently_checked", hasLogo: false };
    }

    const brand = input.client
      ? pickBrandFromClientData(
          await input.client.request(SHOP_BRAND_QUERY),
        )
      : input.shopDomain
        ? await fetchBrandFromStorefront(input.shopDomain, {
            fetchImpl: input.fetchImpl,
          })
        : null;

    if (brand === null && !input.client && !input.shopDomain) {
      return { status: "no_shop_domain", hasLogo: false };
    }

    if (brand && typeof brand === "object" && "unavailable" in brand) {
      await persistShopifyPatch(prisma, input.shopId, {
        brandLogoCheckedAt: new Date(now).toISOString(),
      });
      log.info("shop brand logo unavailable", {
        shopId: input.shopId,
        reason: brand.unavailable,
      });
      return { status: String(brand.unavailable), hasLogo: false };
    }

    const url = pickBrandLogoUrl(brand);
    if (!url) {
      await persistShopifyPatch(prisma, input.shopId, {
        brandLogoCheckedAt: new Date(now).toISOString(),
      });
      return { status: "no_logo", hasLogo: false };
    }

    await persistShopifyPatch(prisma, input.shopId, {
      brandLogoUrl: url,
      brandLogoCheckedAt: new Date(now).toISOString(),
    });
    log.info("persisted shop brand logo", { shopId: input.shopId, hasLogo: true });
    return { status: "persisted", hasLogo: true };
  } catch (error) {
    try {
      if (rawPayload !== null) {
        await persistShopifyPatch(prisma, input.shopId, {
          brandLogoCheckedAt: new Date(input.now ?? Date.now()).toISOString(),
        });
      }
    } catch {
      // The original fetch error is the one that matters; a persist miss just retries later.
    }
    log.info("shop brand logo skipped", {
      shopId: input.shopId,
      reason: error instanceof Error ? error.message : "error",
    });
    return { status: "error", hasLogo: false };
  }
}

/** @param {any} data @returns {unknown} */
function pickBrandFromClientData(data) {
  return data?.shop?.brand ?? null;
}

/**
 * Tokenless Storefront query for public `shop.brand`. Never sends the Admin access
 * token — that token belongs to `/admin/api`, and using it here is how the previous
 * implementation produced `Field 'brand' doesn't exist on type 'Shop'`.
 *
 * @param {string} shopDomain
 * @param {{ fetchImpl?: typeof fetch; apiVersion?: string }} [options]
 * @returns {Promise<unknown | { unavailable: string }>}
 */
async function fetchBrandFromStorefront(shopDomain, options = {}) {
  const domain = normalizeShopDomain(shopDomain);
  const apiVersion =
    options.apiVersion || process.env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION;
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(
    `https://${domain}/api/${apiVersion}/graphql.json`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: SHOP_BRAND_QUERY }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    return { unavailable: "http_error" };
  }

  const body = await readJson(response);
  if (body?.data?.shop) {
    return body.data.shop.brand ?? null;
  }
  if (Array.isArray(body?.errors) && body.errors.length) {
    return { unavailable: classifyStorefrontErrors(body.errors) };
  }
  return { unavailable: "invalid_response" };
}

/** @param {Response} response */
async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** @param {unknown} errors @returns {string} */
function classifyStorefrontErrors(errors) {
  if (!Array.isArray(errors)) return "storefront_error";
  const undefinedBrand = errors.some((error) => {
    const extensions = error?.extensions;
    return (
      extensions?.code === "undefinedField" &&
      extensions?.fieldName === "brand"
    );
  });
  if (undefinedBrand) return "unsupported";
  return "storefront_error";
}

/**
 * Merge a patch into rawPayload.shopify (read-modify-write). Re-reads so a parallel
 * persist of the URL cannot be wiped by a later "checked, no logo" write.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} shopId
 * @param {Record<string, unknown>} patch
 */
async function persistShopifyPatch(prisma, shopId, patch) {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { rawPayload: true },
  });
  if (!shop) return;
  const current =
    shop.rawPayload &&
    typeof shop.rawPayload === "object" &&
    !Array.isArray(shop.rawPayload)
      ? /** @type {Record<string, unknown>} */ (shop.rawPayload)
      : {};
  const shopify =
    current.shopify &&
    typeof current.shopify === "object" &&
    !Array.isArray(current.shopify)
      ? /** @type {Record<string, unknown>} */ (current.shopify)
      : {};
  const existingUrl = brandLogoFromPayload(current);
  const nextShopify = { ...shopify, ...patch };
  if (existingUrl && !normalizeUrl(nextShopify.brandLogoUrl)) {
    nextShopify.brandLogoUrl = existingUrl;
  }
  await prisma.shop.update({
    where: { id: shopId },
    data: { rawPayload: /** @type {any} */ ({ ...current, shopify: nextShopify }) },
  });
}
