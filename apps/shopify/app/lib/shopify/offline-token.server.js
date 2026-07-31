// @ts-check

import { logger as baseLogger } from "../observability/logger.server.js";

const log = baseLogger.child({ component: "offline-token" });

/**
 * @typedef {(shop: string) => Promise<{ session?: { accessToken?: string | null } | null }>} UnauthenticatedAdmin
 */

/**
 * Lazily wire the real `unauthenticated.admin`. Kept behind a dynamic import so
 * this module stays loadable under plain `node --test` (importing
 * `shopify.server` would construct the app and start the backfill loop). Tests
 * inject `deps.unauthenticatedAdmin` and never reach here. Same seam pattern as
 * `authenticate-app-request.server.js`.
 * @returns {Promise<{ unauthenticatedAdmin: UnauthenticatedAdmin }>}
 */
async function defaultDeps() {
  const mod = await import("../../shopify.server");
  return { unauthenticatedAdmin: (shop) => mod.unauthenticated.admin(shop) };
}

/**
 * Load a FRESH offline Shopify access token for a shop, refreshing it first when
 * it is within ~5 min of expiry (or already expired).
 *
 * Shopify 403s stale offline tokens (the `expiringOfflineAccessTokens` future
 * flag is on). Embedded requests self-heal — `authenticate.admin` re-exchanges
 * the offline token on the way in when it's expiring — but pure BACKGROUND paths
 * (the backfill worker, an autonomous action write) ride no request and carry no
 * session-token JWT, so they must refresh explicitly. `unauthenticated.admin`
 * runs the library's `ensureValidOfflineSession`, which refreshes via the stored
 * refresh-token grant (no JWT needed) and persists the fresh token, then returns
 * the session — we hand back its now-fresh accessToken.
 *
 * Throws when there is no offline session for the shop, or the refresh itself
 * fails (an invalid/expired refresh token → the merchant must reconnect). Callers
 * treat that exactly as they already treat a missing token (clearance reverts;
 * backfill retries then fails) — never a silent stale-token write.
 *
 * The Shopify fn is INJECTED so this stays unit-testable without importing
 * `shopify.server`.
 *
 * @param {string} shop  the shop's myshopify domain
 * @param {{ unauthenticatedAdmin?: UnauthenticatedAdmin }} [deps]
 * @returns {Promise<string>} a fresh offline access token
 */
export async function loadFreshOfflineToken(shop, deps) {
  const unauthenticatedAdmin =
    deps?.unauthenticatedAdmin ?? (await defaultDeps()).unauthenticatedAdmin;
  let ctx;
  try {
    ctx = await unauthenticatedAdmin(shop);
  } catch (error) {
    // No offline session, or the stored refresh token is itself invalid/expired
    // (merchant must reconnect). Surface a clear, classified signal for ops; the
    // caller degrades the same way it does for a missing token today.
    log.warn("offline token refresh/load failed — merchant may need to reconnect", {
      shop,
      err: error instanceof Error ? error.message : String(error),
    });
    throw error instanceof Error
      ? error
      : new Error(`No offline Shopify session token for shop ${shop}`);
  }
  const accessToken = ctx?.session?.accessToken;
  if (!accessToken) {
    throw new Error(`No offline Shopify session token for shop ${shop}`);
  }
  return accessToken;
}
