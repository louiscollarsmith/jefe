// @ts-check

// Canonical Shopify-admin deep-link builder. Every merchant-facing "go fix this in your admin"
// link (Brief tidy-up findings, Horizon items, …) builds its URL through here so they're all
// shaped one way (chat 10's architecture call). This only builds the URL string — because the
// embedded app can't frame admin.shopify.com, the CALLER is responsible for opening the link
// top-level (e.g. `target="_top"`); see `Finding.primary.external` in app-home/sections.tsx.

/** @param {string | null | undefined} value */
function isBlank(value) {
  return value == null || String(value).trim() === "";
}

/**
 * The store handle is the myshopify subdomain: "everdew.myshopify.com" → "everdew".
 * @param {string | null | undefined} shopDomain
 */
export function storeHandle(shopDomain) {
  if (isBlank(shopDomain)) return null;
  const first = String(shopDomain).trim().split(".")[0];
  return first || null;
}

/** A Shopify GID or numeric id → the trailing numeric id. @param {string | null | undefined} externalId */
export function numericId(externalId) {
  if (isBlank(externalId)) return null;
  const parts = String(externalId).split("/");
  const last = parts[parts.length - 1];
  return last || null;
}

/**
 * Build a unified-admin deep-link for a store + path. Returns null when the handle is unknown
 * (a caller then renders label-only rather than pointing somewhere wrong).
 * @param {string | null | undefined} shopDomain e.g. "everdew.myshopify.com"
 * @param {string | null | undefined} [path] e.g. "products/123" or "products"
 * @returns {string | null}
 */
export function adminDeepLink(shopDomain, path) {
  const handle = storeHandle(shopDomain);
  if (!handle) return null;
  const clean = String(path ?? "").replace(/^\/+/, "");
  return clean
    ? `https://admin.shopify.com/store/${handle}/${clean}`
    : `https://admin.shopify.com/store/${handle}`;
}

/**
 * A small convenience over `adminDeepLink` for the common product targets.
 * @param {string | null | undefined} shopDomain
 */
export function buildAdminDeepLinker(shopDomain) {
  return {
    /** @param {string | null | undefined} externalId */
    product(externalId) {
      const id = numericId(externalId);
      return adminDeepLink(shopDomain, id ? `products/${id}` : "products");
    },
    products() {
      return adminDeepLink(shopDomain, "products");
    },
  };
}
