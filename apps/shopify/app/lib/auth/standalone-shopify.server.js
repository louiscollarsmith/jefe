// @ts-check

import "@shopify/shopify-api/adapters/web-api";
import { ApiVersion, shopifyApi } from "@shopify/shopify-api";

import { logger } from "../observability/logger.server.js";
import { standaloneAppHost } from "./auth-mode.server.js";

/**
 * A dedicated `@shopify/shopify-api` instance for the STANDALONE
 * (out-of-iframe) OAuth flow only — scoped to `hostName = app.mynamejefe.com`
 * so `auth.begin` mints a `redirect_uri` on the standalone host and the whole
 * handshake + signed cookie stay on that origin (per architecture steer).
 *
 * WHY A SECOND INSTANCE: the primary app (`shopify.server`) is configured with
 * `application_url = SHOPIFY_APP_URL` (jefe-production…) for the embedded app —
 * deliberately unchanged. `auth.begin` derives the callback host from that
 * config, so reusing it would send the standalone OAuth callback (and its
 * cookie) to the wrong host. A second instance with `hostName =
 * app.mynamejefe.com`, `isEmbeddedApp:false`, and the SAME apiKey/secret/scopes
 * gives us the library's tested begin/callback on the right host — no manual
 * authorize-URL/HMAC/token-exchange.
 *
 * NO SESSION DIVERGENCE: the offline session id is the deterministic
 * `offline_<shop>` regardless of which instance mints it, and the standalone
 * callback persists it through the SAME Prisma session store the embedded flow
 * uses — so `unauthenticated.admin(shop)` (primary app) later resolves exactly
 * that per-shop offline session.
 */

/** @type {Record<string, ApiVersion>} */
const API_VERSIONS_BY_ENV_VALUE = {
  "2025-10": ApiVersion.October25,
  "2026-01": ApiVersion.January26,
  "2026-04": ApiVersion.April26,
  "2026-07": ApiVersion.July26,
};

/**
 * Resolve the configured Shopify API version, matching `shopify.server`'s
 * mapping so the standalone instance speaks the same version as embedded.
 * @param {Record<string, string | undefined>} [env]
 * @returns {ApiVersion}
 */
export function resolveStandaloneApiVersion(env = process.env) {
  return (
    API_VERSIONS_BY_ENV_VALUE[env.SHOPIFY_API_VERSION ?? ""] ?? ApiVersion.July26
  );
}

const log = logger.child({ component: "standalone-auth" });

/**
 * Build a standalone Shopify-API instance from env. Exported for tests; app
 * code should use the memoized {@link standaloneShopify}.
 * @param {Record<string, string | undefined>} [env]
 */
export function buildStandaloneShopify(env = process.env) {
  const apiSecretKey = (env.SHOPIFY_API_SECRET || "").trim();
  if (!apiSecretKey) {
    // Fail loud on a misdeploy (consistent with the cookie's SESSION_SECRET
    // check) rather than silently minting an instance whose HMAC checks reject
    // every callback.
    throw new Error(
      "SHOPIFY_API_SECRET must be set for the standalone Shopify OAuth flow",
    );
  }
  return shopifyApi({
    apiKey: env.SHOPIFY_API_KEY,
    apiSecretKey,
    scopes: env.SCOPES?.split(",").map((scope) => scope.trim()).filter(Boolean),
    hostName: standaloneAppHost(env),
    hostScheme: "https",
    apiVersion: resolveStandaloneApiVersion(env),
    // Standalone is NOT embedded — this drives the standard (non-App-Bridge)
    // OAuth begin/callback and a plain redirect we control afterward.
    isEmbeddedApp: false,
    // Route the SDK's own logs through the structured logger (never console);
    // these are operational strings (no request payloads / secrets).
    logger: {
      log: (_severity, message) => {
        log.debug("shopify-api", { message });
      },
    },
  });
}

/** @type {ReturnType<typeof buildStandaloneShopify> | undefined} */
let cached;

/**
 * The memoized standalone Shopify-API instance (built once from `process.env`).
 * @returns {ReturnType<typeof buildStandaloneShopify>}
 */
export function standaloneShopify() {
  if (!cached) cached = buildStandaloneShopify();
  return cached;
}
