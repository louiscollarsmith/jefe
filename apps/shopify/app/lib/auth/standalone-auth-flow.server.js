// @ts-check

/**
 * Pure decision logic for the standalone `/standalone/auth` entry, kept out of
 * the route so it is unit-testable (the route does the DB lookup + the actual
 * Shopify OAuth begin).
 *
 * Standalone is EXISTING-merchant sign-in only (architecture steer): a shop we
 * have no install record for is sent to the canonical embedded / App-Store
 * install, which owns webhook registration + backfill + welcome. That keeps
 * exactly ONE install path — the raw standalone OAuth callback does not register
 * webhooks the way the managed install does, so it must never mint a new install.
 */

/**
 * @param {{ shop: string | null, isInstalled: boolean }} params
 *   `shop` is the already-validated `<shop>.myshopify.com` (or null if the input
 *   wasn't a valid shop domain); `isInstalled` is whether we hold an install
 *   record for it.
 * @returns {{ action: "invalid" } | { action: "install", shop: string } | { action: "begin", shop: string }}
 */
export function resolveStandaloneStart({ shop, isInstalled }) {
  if (!shop) return { action: "invalid" };
  if (!isInstalled) return { action: "install", shop };
  return { action: "begin", shop };
}

/**
 * Where an unknown shop is redirected to install through the canonical managed
 * (embedded) flow — which owns webhooks + backfill + welcome. Passing `shop`
 * lets the managed login kick straight into OAuth.
 * @param {string} shop
 * @returns {string}
 */
export function managedInstallPath(shop) {
  return `/auth/login?shop=${encodeURIComponent(shop)}`;
}

/** Where the standalone OAuth callback returns the merchant on success. */
export const STANDALONE_CALLBACK_PATH = "/standalone/callback";
