// @ts-check
//
// The single pinned Shopify Admin API version this app targets — set once, explicitly, via
// SHOPIFY_API_VERSION. Every Shopify-facing module (the Gateway, the universal execution
// pipeline, every agentic-runtime agent) reads it from here rather than each hardcoding its own
// default, so an API-version upgrade is a one-line env change, not a multi-file audit.

const DEFAULT_API_VERSION = "2026-07";

/** @param {NodeJS.ProcessEnv} [env] */
export function getConfiguredShopifyApiVersion(env = process.env) {
  return env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION;
}
