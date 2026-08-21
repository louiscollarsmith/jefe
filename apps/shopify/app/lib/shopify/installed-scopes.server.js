// @ts-check

import { ShopifyAdminGraphqlClient } from "./admin-graphql.server.js";

export const CURRENT_APP_INSTALLATION_SCOPES_QUERY =
  "query JefeCurrentAppInstallation { currentAppInstallation { accessScopes { handle } } }";

/** @param {{ request: (document: string, variables?: Record<string, unknown>) => Promise<any> }} client */
export async function fetchGrantedShopifyScopes(client) {
  const data = await client.request(CURRENT_APP_INSTALLATION_SCOPES_QUERY, {});
  return normalizeShopifyScopes(data?.currentAppInstallation?.accessScopes);
}

/**
 * @param {{
 *   shopDomain: string;
 *   accessToken?: string | null;
 *   fallbackScopes?: string[];
 *   logger?: Pick<Console, "warn" | "info" | "error">;
 *   apiVersion?: string;
 *   fetchImpl?: typeof fetch;
 * }} input
 * @returns {Promise<{ scopes: string[]; source: "live_shopify" | "fallback_session" }>}
 */
export async function resolveInstalledShopifyScopes(input) {
  const fallbackScopes = normalizeShopifyScopes(input.fallbackScopes ?? []);
  if (!input.accessToken) {
    return { scopes: fallbackScopes, source: "fallback_session" };
  }
  const client = new ShopifyAdminGraphqlClient({
    shopDomain: input.shopDomain,
    accessToken: input.accessToken,
    apiVersion: input.apiVersion,
    fetchImpl: input.fetchImpl,
    logger: input.logger,
  });
  try {
    const scopes = await fetchGrantedShopifyScopes(client);
    return { scopes, source: "live_shopify" };
  } catch (error) {
    input.logger?.warn?.("Shopify installed scope sync failed", {
      shopDomain: input.shopDomain,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return { scopes: fallbackScopes, source: "fallback_session" };
  }
}

/** @param {unknown} value */
export function normalizeShopifyScopes(value) {
  const rows = Array.isArray(value)
    ? value
    : String(value ?? "")
        .split(/[,\s]+/)
        .map((scope) => scope.trim())
        .filter(Boolean);
  return [
    ...new Set(
      rows
        .map((scope) =>
          typeof scope === "string"
            ? scope
            : typeof scope?.handle === "string"
              ? scope.handle
              : "",
        )
        .map((scope) => scope.trim())
        .filter(Boolean),
    ),
  ].sort();
}
