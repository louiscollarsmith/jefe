// @ts-check

import { ShopifyAdminGraphqlClient } from "../../shopify/admin-graphql.server.js";
import {
  INVENTORY_ITEMS_QUERY,
  ORDERS_QUERY,
  PRODUCTS_QUERY,
} from "../../shopify/queries.server.js";
import { edgesToNodes, jsonObject, parseDate } from "./normalize.server.js";
import { ensureShopifyTenant } from "./tenant.server.js";
import { writeLedgerEvent } from "./ledger.server.js";
import {
  upsertShopifyInventoryLevel,
  upsertShopifyOrder,
  upsertShopifyProduct,
} from "./canonical.server.js";

const DEFAULT_PAGE_SIZE = 50;

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopDomain: string; accessToken: string; sessionId?: string | null; apiVersion?: string; pageSize?: number; logger?: Pick<Console, "info" | "warn" | "error">; fetchImpl?: typeof fetch }} input
 */
export async function runShopifyBackfill(prisma, input) {
  const logger = input.logger || console;
  const client = new ShopifyAdminGraphqlClient({
    shopDomain: input.shopDomain,
    accessToken: input.accessToken,
    apiVersion: input.apiVersion,
    logger,
    fetchImpl: input.fetchImpl,
  });
  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain: input.shopDomain,
    accessTokenSessionId: input.sessionId,
  });
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const totals = {
    products: 0,
    variants: 0,
    inventoryLevels: 0,
    orders: 0,
    lineItems: 0,
    refunds: 0,
    ledgerEventsCreated: 0,
  };

  await backfillConnection({
    client,
    query: PRODUCTS_QUERY,
    pageSize,
    connectionName: "products",
    onNode: async (product) => {
      const productPayload = jsonObject(product);
      const productId = stringValue(productPayload.id);
      if (!productId) return;

      const productLedger = await writeLedgerEvent(prisma, {
        merchantId: merchant.id,
        shopId: shop.id,
        eventType: "shopify.backfill.product",
        source: "shopify",
        sourceEventId: productId,
        dedupeKey: `shopify:backfill:product:${shop.shopDomain}:${productId}`,
        payload: { shopDomain: shop.shopDomain, productId },
        rawPayload: productPayload,
        eventTs: parseDate(productPayload.updatedAt) ?? new Date(),
      });
      if (productLedger.created) totals.ledgerEventsCreated += 1;

      const variants = edgesToNodes(productPayload.variants);
      for (const variant of variants) {
        const variantPayload = jsonObject(variant);
        const variantId = stringValue(variantPayload.id);
        if (!variantId) continue;
        const variantLedger = await writeLedgerEvent(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
          eventType: "shopify.backfill.variant",
          source: "shopify",
          sourceEventId: variantId,
          dedupeKey: `shopify:backfill:variant:${shop.shopDomain}:${variantId}`,
          payload: { shopDomain: shop.shopDomain, productId, variantId },
          rawPayload: variantPayload,
          eventTs: parseDate(variantPayload.updatedAt) ?? new Date(),
        });
        if (variantLedger.created) totals.ledgerEventsCreated += 1;
        totals.variants += 1;
      }

      await upsertShopifyProduct(prisma, {
        merchantId: merchant.id,
        shopId: shop.id,
        product: productPayload,
      });
      totals.products += 1;
    },
  });

  await backfillConnection({
    client,
    query: INVENTORY_ITEMS_QUERY,
    pageSize,
    connectionName: "inventoryItems",
    onNode: async (inventoryItem) => {
      const itemPayload = jsonObject(inventoryItem);
      const inventoryItemId = stringValue(itemPayload.id);
      const variantExternalId = stringValue(itemPayload.variant?.id);
      if (!inventoryItemId) return;

      for (const level of edgesToNodes(itemPayload.inventoryLevels)) {
        const levelPayload = jsonObject(level);
        const locationId = stringValue(levelPayload.location?.id);
        if (!locationId) continue;

        const inventoryLedger = await writeLedgerEvent(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
          eventType: "shopify.backfill.inventory_level",
          source: "shopify",
          sourceEventId: `${inventoryItemId}:${locationId}`,
          dedupeKey: `shopify:backfill:inventory_level:${shop.shopDomain}:${inventoryItemId}:${locationId}`,
          payload: { shopDomain: shop.shopDomain, inventoryItemId, locationId },
          rawPayload: {
            inventoryItem: itemPayload,
            inventoryLevel: levelPayload,
          },
          eventTs:
            parseDate(levelPayload.updatedAt ?? itemPayload.updatedAt) ??
            new Date(),
        });
        if (inventoryLedger.created) totals.ledgerEventsCreated += 1;

        await upsertShopifyInventoryLevel(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
          inventoryItemId,
          variantExternalId,
          inventoryLevel: levelPayload,
        });
        totals.inventoryLevels += 1;
      }
    },
  });

  await backfillConnection({
    client,
    query: ORDERS_QUERY,
    pageSize,
    connectionName: "orders",
    onNode: async (order) => {
      const orderPayload = jsonObject(order);
      const orderId = stringValue(orderPayload.id);
      if (!orderId) return;

      const orderLedger = await writeLedgerEvent(prisma, {
        merchantId: merchant.id,
        shopId: shop.id,
        eventType: "shopify.backfill.order",
        source: "shopify",
        sourceEventId: orderId,
        dedupeKey: `shopify:backfill:order:${shop.shopDomain}:${orderId}`,
        payload: { shopDomain: shop.shopDomain, orderId },
        rawPayload: orderPayload,
        eventTs: parseDate(orderPayload.updatedAt) ?? new Date(),
      });
      if (orderLedger.created) totals.ledgerEventsCreated += 1;

      for (const lineItem of edgesToNodes(orderPayload.lineItems)) {
        const lineItemPayload = jsonObject(lineItem);
        const lineItemId = stringValue(lineItemPayload.id);
        if (!lineItemId) continue;
        const lineLedger = await writeLedgerEvent(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
          eventType: "shopify.backfill.order_line_item",
          source: "shopify",
          sourceEventId: lineItemId,
          dedupeKey: `shopify:backfill:order_line_item:${shop.shopDomain}:${lineItemId}`,
          payload: { shopDomain: shop.shopDomain, orderId, lineItemId },
          rawPayload: lineItemPayload,
          eventTs: parseDate(orderPayload.updatedAt) ?? new Date(),
        });
        if (lineLedger.created) totals.ledgerEventsCreated += 1;
        totals.lineItems += 1;
      }

      if (Array.isArray(orderPayload.refunds)) {
        for (const refund of orderPayload.refunds) {
          const refundPayload = jsonObject(refund);
          const refundId = stringValue(refundPayload.id);
          if (!refundId) continue;
          const refundLedger = await writeLedgerEvent(prisma, {
            merchantId: merchant.id,
            shopId: shop.id,
            eventType: "shopify.backfill.refund",
            source: "shopify",
            sourceEventId: refundId,
            dedupeKey: `shopify:backfill:refund:${shop.shopDomain}:${refundId}`,
            payload: { shopDomain: shop.shopDomain, orderId, refundId },
            rawPayload: refundPayload,
            eventTs: parseDate(refundPayload.createdAt) ?? new Date(),
          });
          if (refundLedger.created) totals.ledgerEventsCreated += 1;
          totals.refunds += 1;
        }
      }

      await upsertShopifyOrder(prisma, {
        merchantId: merchant.id,
        shopId: shop.id,
        order: orderPayload,
      });
      totals.orders += 1;
    },
  });

  return totals;
}

/**
 * @param {{ client: ShopifyAdminGraphqlClient; query: string; pageSize: number; connectionName: string; onNode: (node: unknown) => Promise<void> }} input
 */
async function backfillConnection(input) {
  let after = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await input.client.request(input.query, {
      first: input.pageSize,
      after,
    });
    const connection = data?.[input.connectionName];
    for (const node of edgesToNodes(connection)) {
      await input.onNode(node);
    }

    hasNextPage = Boolean(connection?.pageInfo?.hasNextPage);
    after = connection?.pageInfo?.endCursor ?? null;
  }
}

/** @param {unknown} value */
function stringValue(value) {
  return typeof value === "string" && value !== "" ? value : null;
}
