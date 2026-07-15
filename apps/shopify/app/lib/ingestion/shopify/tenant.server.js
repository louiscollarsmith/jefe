// @ts-check

import { normalizeShopDomain } from "../../shopify/admin-graphql.server.js";

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopDomain: string; accessTokenSessionId?: string | null; scopes?: string[]; rawPayload?: unknown }} input
 */
export async function ensureShopifyTenant(prisma, input) {
  const shopDomain = normalizeShopDomain(input.shopDomain);
  const existingShop = await prisma.shop.findUnique({
    where: { platform_shopDomain: { platform: "shopify", shopDomain } },
    include: { merchant: true },
  });

  if (existingShop) {
    await upsertConnectorAccount(prisma, {
      merchantId: existingShop.merchant.id,
      shopId: existingShop.id,
      shopDomain,
      accessTokenSessionId: input.accessTokenSessionId,
      scopes: input.scopes,
      rawPayload: input.rawPayload,
    });

    return { merchant: existingShop.merchant, shop: existingShop };
  }

  const merchant = await prisma.merchant.create({
    data: {
      name: shopDomain,
      shops: {
        create: {
          platform: "shopify",
          shopDomain,
          rawPayload: input.rawPayload ?? {},
        },
      },
    },
    include: { shops: true },
  });
  const shop = merchant.shops[0];

  await upsertConnectorAccount(prisma, {
    merchantId: merchant.id,
    shopId: shop.id,
    shopDomain,
    accessTokenSessionId: input.accessTokenSessionId,
    scopes: input.scopes,
    rawPayload: input.rawPayload,
  });

  return { merchant, shop };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; shopDomain: string; accessTokenSessionId?: string | null; scopes?: string[]; rawPayload?: unknown }} input
 */
async function upsertConnectorAccount(prisma, input) {
  await prisma.connectorAccount.upsert({
    where: {
      merchantId_connector_accountExternalId: {
        merchantId: input.merchantId,
        connector: "shopify",
        accountExternalId: input.shopDomain,
      },
    },
    create: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      connector: "shopify",
      accountExternalId: input.shopDomain,
      status: "active",
      scopes: input.scopes ?? [],
      readTokenRef: input.accessTokenSessionId
        ? `shopify_session:${input.accessTokenSessionId}`
        : null,
      authMetadata: { tokenStorage: "shopify_session_storage" },
      rawPayload: input.rawPayload ?? {},
      connectedAt: new Date(),
    },
    update: {
      shopId: input.shopId,
      status: "active",
      scopes: input.scopes ?? undefined,
      readTokenRef: input.accessTokenSessionId
        ? `shopify_session:${input.accessTokenSessionId}`
        : undefined,
      authMetadata: { tokenStorage: "shopify_session_storage" },
      rawPayload: input.rawPayload ?? undefined,
      connectedAt: new Date(),
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} shopDomain
 */
export async function markShopifyInstallInactive(prisma, shopDomain) {
  const normalized = normalizeShopDomain(shopDomain);
  const shop = await prisma.shop.findUnique({
    where: {
      platform_shopDomain: { platform: "shopify", shopDomain: normalized },
    },
  });

  if (!shop) return null;

  await prisma.$transaction([
    prisma.connectorAccount.updateMany({
      where: { shopId: shop.id, connector: "shopify" },
      data: { status: "inactive" },
    }),
    prisma.shop.update({
      where: { id: shop.id },
      data: { status: "uninstalled", setupStatus: "uninstalled" },
    }),
    prisma.backfillJob.updateMany({
      where: {
        shopId: shop.id,
        status: { in: ["queued", "running", "failed"] },
      },
      data: {
        status: "cancelled",
        failedAt: null,
        completedAt: new Date(),
        lastError: null,
      },
    }),
    prisma.session.deleteMany({ where: { shop: normalized } }),
  ]);

  return shop;
}
