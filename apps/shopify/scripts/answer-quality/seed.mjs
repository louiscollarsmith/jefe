// @ts-check
//
// Seed an archetype store into a LOCAL database and build its Merchant Memory with the
// real derivation pipeline.
//
// Refuses to touch anything that is not obviously a local database. The harness exists to
// let a chat be replayed dozens of times, and a replay writes conversation rows — pointing
// that at production would put harness chatter in a real merchant's thread.

import { randomUUID } from "node:crypto";

import { generateStore } from "./fixtures.mjs";
import { refreshBeliefs } from "../../app/lib/merchant-memory/service.server.js";

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "host.docker.internal"];

/** @param {string | undefined} url */
export function assertLocalDatabase(url) {
  if (!url) throw new Error("DATABASE_URL is not set. Start one with: npm run db:up");
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("DATABASE_URL is not a parseable URL.");
  }
  if (!LOCAL_HOSTS.includes(host)) {
    throw new Error(
      `Refusing to seed a non-local database (host: ${host}). The harness writes conversation rows; point it at a local DB (npm run db:up).`,
    );
  }
  return host;
}

const quiet = { info: () => {}, warn: () => {}, error: (...args) => console.error(...args) };

/**
 * Wipe and rebuild one archetype. Idempotent: the merchant is deleted first, and every
 * canonical row cascades from it, so repeated runs start from the same state.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {import("./fixtures.mjs").Archetype} spec
 * @param {{ asOf?: Date; logger?: Pick<Console, "info" | "warn" | "error"> }} [options]
 */
export async function seedArchetype(prisma, spec, options = {}) {
  const asOf = options.asOf ?? new Date();
  const log = options.logger ?? console;
  const { products, orders, refunds, identities } = generateStore(spec, asOf);

  await prisma.merchant.deleteMany({ where: { name: spec.name } });
  const merchant = await prisma.merchant.create({ data: { name: spec.name, status: "active" } });
  const shop = await prisma.shop.create({
    data: {
      merchantId: merchant.id,
      platform: "shopify",
      shopDomain: spec.shopDomain,
      externalShopId: `synthetic-${spec.key}`,
      status: "active",
      setupStatus: "ready",
      // Honest about what the fixture actually contains, the way the corpus loader learned
      // to be: claiming "full" history for a 120-day slice made downstream beliefs lie.
      historicalOrderAccess: "partial",
      availableOrderHistoryDays: spec.days,
      backfillCompletedAt: asOf,
      onboardingCompletedAt: asOf,
      // Timezone rides in rawPayload the way the Shopify shop payload delivers it; base
      // currency is not stored at all — the derivation layer reads it from priced records.
      rawPayload: { iana_timezone: "Europe/London", currency: spec.currency },
    },
  });

  const productRows = new Map();
  for (const product of products) {
    const created = await prisma.product.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        externalId: product.externalId,
        title: product.title,
        handle: product.handle,
        status: product.status,
        vendor: product.vendor,
        productType: product.productType,
        sourceCreatedAt: asOf,
        sourceUpdatedAt: asOf,
      },
    });
    const variant = await prisma.variant.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        productId: created.id,
        externalId: product.variant.externalId,
        sku: product.variant.sku,
        title: "Default",
        price: product.variant.price,
        currency: spec.currency,
        unitCost: product.variant.unitCost,
        inventoryItemExternalId: product.variant.inventoryItemExternalId,
        sourceCreatedAt: asOf,
        sourceUpdatedAt: asOf,
      },
    });
    await prisma.inventoryLevel.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        variantId: variant.id,
        inventoryItemExternalId: product.variant.inventoryItemExternalId,
        locationExternalId: `gid://synthetic/Location/${spec.key}/1`,
        available: product.variant.available,
        committed: 0,
        incoming: 0,
        sourceUpdatedAt: asOf,
        observedAt: asOf,
      },
    });
    productRows.set(product.externalId, { productId: created.id, variantId: variant.id });
  }

  // Bulk inserts with client-side ids. Row-at-a-time creates made a reseed take minutes,
  // which is the difference between a harness that gets run before every change and one
  // that doesn't. Ids are generated here because createMany cannot return them.
  const orderIds = orders.map(() => randomUUID());
  await prisma.order.createMany({
    data: orders.map((order, index) => ({
      id: orderIds[index],
      merchantId: merchant.id,
      shopId: shop.id,
      externalId: order.externalId,
      orderName: order.orderName,
      customerExternalId: order.customerExternalId,
      financialStatus: order.financialStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      sourceName: order.sourceName,
      shippingCountry: order.shippingCountry,
      currency: order.currency,
      subtotalPrice: order.subtotalPrice,
      totalPrice: order.totalPrice,
      totalDiscount: order.totalDiscount,
      totalTax: order.totalTax,
      totalShipping: order.totalShipping,
      sourceCreatedAt: order.processedAt,
      sourceUpdatedAt: order.processedAt,
      processedAt: order.processedAt,
    })),
  });

  await prisma.orderLineItem.createMany({
    data: orders.flatMap((order, orderIndex) =>
      order.lines.map((line, lineIndex) => {
        const ids = productRows.get(line.product.externalId);
        return {
          merchantId: merchant.id,
          shopId: shop.id,
          orderId: orderIds[orderIndex],
          productId: ids?.productId ?? null,
          variantId: ids?.variantId ?? null,
          externalId: `${order.externalId}/line/${lineIndex + 1}`,
          sku: line.product.variant.sku,
          title: line.product.title,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          totalPrice: line.totalPrice,
          discount: 0,
        };
      }),
    ),
  });

  await prisma.refund.createMany({
    data: refunds.map((refund) => ({
      merchantId: merchant.id,
      shopId: shop.id,
      orderId: orderIds[refund.orderIndex],
      externalId: refund.externalId,
      amount: refund.amount,
      currency: spec.currency,
      reason: "customer_changed_mind",
      sourceCreatedAt: refund.processedAt,
      processedAt: refund.processedAt,
    })),
  });

  await prisma.customerIdentity.createMany({
    data: identities.map((identity) => ({
      merchantId: merchant.id,
      shopId: shop.id,
      emailHash: identity.emailHash,
      maskedEmail: identity.maskedEmail,
      firstSeenOrderAt: identity.firstSeenOrderAt,
      lastOrderAt: identity.lastOrderAt,
      orderCount: identity.orderCount,
      totalSpend: identity.totalSpend,
      averageOrderValue: identity.averageOrderValue,
      source: "synthetic_fixture",
      shopifyCustomerId: identity.externalId,
    })),
  });

  // The real thing: beliefs are DERIVED from the rows above, never hand-written.
  //
  // The model is explicitly disabled for this pass. A full_rebuild also triggers the
  // store-understanding LLM pass, which stalled seeding indefinitely against a flaky
  // provider — and it is not what the harness measures. Deterministic derivation is, and it
  // needs no model, so seeding stays fast and reproducible instead of inheriting the
  // provider's mood.
  const refresh = await refreshBeliefs(prisma, {
    merchantId: merchant.id,
    shopId: shop.id,
    refreshType: "full_rebuild",
    llmProvider: /** @type {any} */ ({ enabled: false, provider: "disabled", model: "none" }),
    logger: quiet,
  });
  const beliefCount = await prisma.merchantMemoryBelief.count({ where: { merchantId: merchant.id } });

  log.info?.(
    `seeded ${spec.key}: ${orders.length} orders, ${products.length} products, ${identities.length} customers, ${beliefCount} beliefs`,
  );
  return { merchantId: merchant.id, shopId: shop.id, beliefCount, refresh };
}
