// @ts-check

import { ShopifyAdminGraphqlClient } from "../shopify/admin-graphql.server.js";
import { normalizeEmail } from "../ingestion/shopify/canonical.server.js";
import { logger as baseLogger } from "../observability/logger.server.js";

// The merchant's store-contact email — the real, stable "to" for notifications.
//
// Why this exists: the app uses OFFLINE Shopify tokens, so `session.email` /
// `onlineAccessInfo` are empty in the app loader, and there is no Merchant.email.
// The one honest, always-available source is the shop's own contact address via
// Admin GraphQL (`shop { contactEmail email }`) — the merchant's own address, not
// customer PII. We persist it once to Shop.contactEmail so the Settings surface
// can show a REAL address (never a fabricated one) and a sender can reach it.
//
// Deliberately independent of getPersistedStoreName (app._index), which
// early-returns once the store name is cached and would otherwise skip this.
// The plaintext address is never logged — only its presence.

const log = baseLogger.child({ component: "notifications" });

const SHOP_CONTACT_EMAIL_QUERY = `#graphql
  query JefeShopContactEmail {
    shop {
      contactEmail
      email
    }
  }
`;

/** @param {unknown} value @returns {string | null} */
function normalizeAddress(value) {
  if (typeof value !== "string") return null;
  const normalized = normalizeEmail(value);
  return normalized || null;
}

/** @param {unknown} payload @returns {string | null} */
function contactEmailFromPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const shopify = /** @type {{ shopify?: unknown }} */ (payload).shopify;
  if (!shopify || typeof shopify !== "object") return null;
  const record = /** @type {{ contactEmail?: unknown; email?: unknown }} */ (shopify);
  return normalizeAddress(record.contactEmail) ?? normalizeAddress(record.email);
}

/**
 * Read the persisted merchant store-contact email, or null when unknown.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopId: string }} input
 * @returns {Promise<string | null>}
 */
export async function getShopContactEmail(prisma, input) {
  const shop = await prisma.shop.findUnique({
    where: { id: input.shopId },
    select: { contactEmail: true },
  });
  return shop?.contactEmail ?? null;
}

/**
 * Ensure Shop.contactEmail is populated. Idempotent and best-effort (never throws
 * into the caller). Resolution order, cheapest first:
 *   1. already-set column → no-op;
 *   2. an address already captured in rawPayload.shopify (by the store-name fetch);
 *   3. a fresh `shop { contactEmail email }` Admin GraphQL query.
 * A `client` may be injected for tests; otherwise one is constructed from
 * shopDomain + accessToken (as fetchShopMetadata does).
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{
 *   shopId: string;
 *   shopDomain?: string | null;
 *   accessToken?: string | null;
 *   client?: { request: (query: string, variables?: Record<string, unknown>) => Promise<any> } | null;
 * }} input
 * @returns {Promise<{ status: string; hasAddress: boolean }>}
 */
export async function ensureShopContactEmail(prisma, input) {
  try {
    const shop = await prisma.shop.findUnique({
      where: { id: input.shopId },
      select: { contactEmail: true, rawPayload: true },
    });
    if (!shop) return { status: "shop_not_found", hasAddress: false };
    if (shop.contactEmail) return { status: "already_set", hasAddress: true };

    // Cheap path: the store-name fetch may have already carried the address.
    const fromPayload = contactEmailFromPayload(shop.rawPayload);
    if (fromPayload) {
      await persist(prisma, input.shopId, fromPayload);
      return { status: "persisted_from_payload", hasAddress: true };
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
    if (!client) return { status: "no_client", hasAddress: false };

    const data = await client.request(SHOP_CONTACT_EMAIL_QUERY);
    const shopData = data?.shop ?? null;
    const address =
      normalizeAddress(shopData?.contactEmail) ?? normalizeAddress(shopData?.email);
    if (!address) return { status: "no_address", hasAddress: false };

    await persist(prisma, input.shopId, address);
    return { status: "persisted", hasAddress: true };
  } catch (error) {
    log.warn("failed to ensure shop contact email", {
      shopId: input.shopId,
      err: error,
    });
    return { status: "error", hasAddress: false };
  }
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} shopId
 * @param {string} address
 */
async function persist(prisma, shopId, address) {
  await prisma.shop.update({
    where: { id: shopId },
    data: { contactEmail: address },
  });
  // Never log the address itself — only that one is now known.
  log.info("persisted shop contact email", { shopId, hasAddress: true });
}
