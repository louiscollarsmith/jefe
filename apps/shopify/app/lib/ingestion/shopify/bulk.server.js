// @ts-check

import { ShopifyAdminGraphqlClient } from "../../shopify/admin-graphql.server.js";
import {
  BULK_OPERATION_NODE_QUERY,
  BULK_OPERATION_RUN_QUERY,
  buildOrdersBulkQuery,
  PRODUCTS_BULK_QUERY,
} from "../../shopify/queries.server.js";
import { jsonObject, parseDate } from "./normalize.server.js";
import { ensureShopifyTenant } from "./tenant.server.js";
import { writeLedgerEvent } from "./ledger.server.js";
import {
  upsertShopifyOrder,
  upsertShopifyOrderLineItem,
  upsertShopifyProduct,
  upsertShopifyRefund,
  upsertShopifyVariant,
} from "./canonical.server.js";
import { upsertShopifyUnitCostFromVariant } from "../../../services/cogs.server.js";

const DEFAULT_BACKFILL_DAYS = 365;

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopDomain: string; accessToken: string; domain: "products" | "orders"; sessionId?: string | null; apiVersion?: string; orderBackfillDays?: number; logger?: Pick<Console, "info" | "warn" | "error">; fetchImpl?: typeof fetch }} input
 */
export async function startShopifyBulkBackfill(prisma, input) {
  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain: input.shopDomain,
    accessTokenSessionId: input.sessionId,
  });
  const client = createClient(input);
  const query =
    input.domain === "products"
      ? PRODUCTS_BULK_QUERY
      : buildOrdersBulkQuery(input.orderBackfillDays ?? DEFAULT_BACKFILL_DAYS);
  const data = /** @type {any} */ (
    await client.request(BULK_OPERATION_RUN_QUERY, { query })
  );
  const result = jsonObject(data.bulkOperationRunQuery);
  const userErrors = Array.isArray(result.userErrors) ? result.userErrors : [];

  if (userErrors.length > 0) {
    const message = userErrors
      .map((error) => error?.message)
      .filter(Boolean)
      .join("; ");
    throw new Error(message || "Shopify bulk operation could not start.");
  }

  const bulkOperation = normalizeBulkOperation(result.bulkOperation);
  if (!bulkOperation.id) {
    throw new Error("Shopify bulk operation did not return an operation ID.");
  }

  await prisma.shopBackfillStatus.update({
    where: {
      shopId_domain: { shopId: shop.id, domain: input.domain },
    },
    data: {
      status: "bulk_running",
      startedAt: new Date(),
      completedAt: null,
      lastError: null,
      bulkOperationId: bulkOperation.id,
      metadata: bulkStatusMetadata({
        bulkOperation,
        fallbackUsed: false,
      }),
    },
  });

  return { merchant, shop, bulkOperation };
}

/**
 * @param {{ shopDomain: string; accessToken: string; apiVersion?: string; logger?: Pick<Console, "info" | "warn" | "error">; fetchImpl?: typeof fetch }} input
 * @param {string} operationId
 */
export async function getShopifyBulkOperation(input, operationId) {
  const client = createClient(input);
  const data = /** @type {any} */ (
    await client.request(BULK_OPERATION_NODE_QUERY, { id: operationId })
  );
  return normalizeBulkOperation(data.node);
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopDomain: string; accessToken: string; domain: "products" | "orders"; operation: BulkOperationState; sessionId?: string | null; logger?: Pick<Console, "info" | "warn" | "error">; fetchImpl?: typeof fetch }} input
 */
export async function importShopifyBulkResult(prisma, input) {
  if (!input.operation.url) {
    throw new Error("Shopify bulk operation completed without a result URL.");
  }

  const logger = input.logger ?? console;
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(input.operation.url);
  if (!response.ok) {
    throw new Error(`Shopify bulk result download failed: ${response.status}`);
  }

  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain: input.shopDomain,
    accessTokenSessionId: input.sessionId,
  });
  const importer =
    input.domain === "products"
      ? new ProductBulkImporter(prisma, merchant.id, shop.id, shop.shopDomain)
      : new OrderBulkImporter(prisma, merchant.id, shop.id, shop.shopDomain);
  let processed = 0;

  for await (const record of parseJsonlStream(response.body)) {
    await importer.importRecord(record);
    processed += 1;
  }

  const totals =
    input.domain === "orders"
      ? {
          ...importer.totals,
          refunds: await prisma.refund.count({ where: { shopId: shop.id } }),
        }
      : importer.totals;

  logger.info("Shopify bulk JSONL imported", {
    shopDomain: shop.shopDomain,
    domain: input.domain,
    processed,
    bulkOperationId: input.operation.id,
  });

  return {
    recordsProcessed: processed,
    ...totals,
  };
}

class ProductBulkImporter {
  /**
   * @param {import("@prisma/client").PrismaClient} prisma
   * @param {string} merchantId
   * @param {string} shopId
   * @param {string} shopDomain
   */
  constructor(prisma, merchantId, shopId, shopDomain) {
    this.prisma = prisma;
    this.merchantId = merchantId;
    this.shopId = shopId;
    this.shopDomain = shopDomain;
    /** @type {Map<string, string>} */
    this.productsByExternalId = new Map();
    this.totals = { products: 0, variants: 0 };
  }

  /** @param {Record<string, any>} record */
  async importRecord(record) {
    const type = record.__typename;
    if (type === "Product" || (!record.__parentId && productId(record))) {
      const product = stripBulkFields(record);
      const externalId = productId(product);
      if (!externalId) return;

      const ledger = await writeLedgerEvent(this.prisma, {
        merchantId: this.merchantId,
        shopId: this.shopId,
        eventType: "shopify.bulk.product",
        source: "shopify",
        sourceEventId: externalId,
        dedupeKey: `shopify:bulk:product:${this.shopDomain}:${externalId}`,
        payload: { shopDomain: this.shopDomain, productId: externalId },
        rawPayload: product,
        eventTs: parseDate(product.updatedAt) ?? new Date(),
      });
      const saved = await upsertShopifyProduct(this.prisma, {
        merchantId: this.merchantId,
        shopId: this.shopId,
        product,
      });
      if (saved) this.productsByExternalId.set(externalId, saved.id);
      if (ledger.created) this.totals.products += 1;
      return;
    }

    if (type === "ProductVariant" || variantId(record)) {
      const parentExternalId = stringValue(record.__parentId);
      if (!parentExternalId) {
        throw new Error("Product variant bulk row is missing __parentId.");
      }
      const productDbId =
        this.productsByExternalId.get(parentExternalId) ??
        (
          await this.prisma.product.findUnique({
            where: {
              shopId_externalId: {
                shopId: this.shopId,
                externalId: parentExternalId,
              },
            },
          })
        )?.id;
      if (!productDbId) {
        throw new Error("Product variant bulk row arrived before its product.");
      }
      const variant = stripBulkFields(record);
      const externalId = variantId(variant);
      if (!externalId) return;
      const ledger = await writeLedgerEvent(this.prisma, {
        merchantId: this.merchantId,
        shopId: this.shopId,
        eventType: "shopify.bulk.variant",
        source: "shopify",
        sourceEventId: externalId,
        dedupeKey: `shopify:bulk:variant:${this.shopDomain}:${externalId}`,
        payload: { shopDomain: this.shopDomain, variantId: externalId },
        rawPayload: variant,
        eventTs: parseDate(variant.updatedAt) ?? new Date(),
      });
      await upsertShopifyVariant(this.prisma, {
        merchantId: this.merchantId,
        shopId: this.shopId,
        productId: productDbId,
        variant,
      });
      await upsertShopifyUnitCostFromVariant(this.prisma, {
        merchantId: this.merchantId,
        shopId: this.shopId,
        productId: productDbId,
        variant,
      });
      if (ledger.created) this.totals.variants += 1;
    }
  }
}

class OrderBulkImporter {
  /**
   * @param {import("@prisma/client").PrismaClient} prisma
   * @param {string} merchantId
   * @param {string} shopId
   * @param {string} shopDomain
   */
  constructor(prisma, merchantId, shopId, shopDomain) {
    this.prisma = prisma;
    this.merchantId = merchantId;
    this.shopId = shopId;
    this.shopDomain = shopDomain;
    /** @type {Map<string, string>} */
    this.ordersByExternalId = new Map();
    this.totals = { orders: 0, lineItems: 0, refunds: 0 };
  }

  /** @param {Record<string, any>} record */
  async importRecord(record) {
    const type = record.__typename;
    if (type === "Order" || (!record.__parentId && orderId(record))) {
      const order = stripBulkFields(record);
      const externalId = orderId(order);
      if (!externalId) return;
      const ledger = await writeLedgerEvent(this.prisma, {
        merchantId: this.merchantId,
        shopId: this.shopId,
        eventType: "shopify.bulk.order",
        source: "shopify",
        sourceEventId: externalId,
        dedupeKey: `shopify:bulk:order:${this.shopDomain}:${externalId}`,
        payload: { shopDomain: this.shopDomain, orderId: externalId },
        rawPayload: order,
        eventTs: parseDate(order.updatedAt) ?? new Date(),
      });
      const saved = await upsertShopifyOrder(this.prisma, {
        merchantId: this.merchantId,
        shopId: this.shopId,
        order,
      });
      if (saved) this.ordersByExternalId.set(externalId, saved.id);
      if (ledger.created) this.totals.orders += 1;
      return;
    }

    const parentExternalId = stringValue(record.__parentId);
    if (!parentExternalId) {
      throw new Error("Order child bulk row is missing __parentId.");
    }
    const orderDbId =
      this.ordersByExternalId.get(parentExternalId) ??
      (
        await this.prisma.order.findUnique({
          where: {
            shopId_externalId: {
              shopId: this.shopId,
              externalId: parentExternalId,
            },
          },
        })
      )?.id;
    if (!orderDbId) {
      throw new Error("Order child bulk row arrived before its order.");
    }

    if (type === "LineItem" || type === "OrderLineItem" || lineItemId(record)) {
      const lineItem = stripBulkFields(record);
      const externalId = lineItemId(lineItem);
      if (!externalId) return;
      const ledger = await writeLedgerEvent(this.prisma, {
        merchantId: this.merchantId,
        shopId: this.shopId,
        eventType: "shopify.bulk.order_line_item",
        source: "shopify",
        sourceEventId: externalId,
        dedupeKey: `shopify:bulk:order_line_item:${this.shopDomain}:${externalId}`,
        payload: { shopDomain: this.shopDomain, lineItemId: externalId },
        rawPayload: lineItem,
        eventTs: new Date(),
      });
      await upsertShopifyOrderLineItem(this.prisma, {
        merchantId: this.merchantId,
        shopId: this.shopId,
        orderId: orderDbId,
        lineItem,
      });
      if (ledger.created) this.totals.lineItems += 1;
      return;
    }

    if (type === "Refund" || refundId(record)) {
      const refund = stripBulkFields(record);
      const externalId = refundId(refund);
      if (!externalId) return;
      const ledger = await writeLedgerEvent(this.prisma, {
        merchantId: this.merchantId,
        shopId: this.shopId,
        eventType: "shopify.bulk.refund",
        source: "shopify",
        sourceEventId: externalId,
        dedupeKey: `shopify:bulk:refund:${this.shopDomain}:${externalId}`,
        payload: { shopDomain: this.shopDomain, refundId: externalId },
        rawPayload: refund,
        eventTs: parseDate(refund.createdAt) ?? new Date(),
      });
      await upsertShopifyRefund(this.prisma, {
        merchantId: this.merchantId,
        shopId: this.shopId,
        orderId: orderDbId,
        refund,
      });
      if (ledger.created) this.totals.refunds += 1;
    }
  }
}

/**
 * @param {ReadableStream<Uint8Array> | NodeJS.ReadableStream | null} body
 */
export async function* parseJsonlStream(body) {
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of streamChunks(body)) {
    buffer += decoder.decode(chunk, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) yield parseJsonLine(line);
      newlineIndex = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  const finalLine = buffer.trim();
  if (finalLine) yield parseJsonLine(finalLine);
}

/** @param {ReadableStream<Uint8Array> | NodeJS.ReadableStream} body */
async function* streamChunks(body) {
  if ("getReader" in body && typeof body.getReader === "function") {
    const reader = body.getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        yield result.value;
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }

  const iterable = /** @type {AsyncIterable<Uint8Array | string | Buffer>} */ (
    body
  );
  for await (const chunk of iterable) {
    yield typeof chunk === "string" ? Buffer.from(chunk) : chunk;
  }
}

/** @param {string} line */
function parseJsonLine(line) {
  try {
    return jsonObject(JSON.parse(line));
  } catch (error) {
    throw new Error(
      `Shopify bulk JSONL parse failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * @param {{ shopDomain: string; accessToken: string; apiVersion?: string; logger?: Pick<Console, "info" | "warn" | "error">; fetchImpl?: typeof fetch }} input
 */
function createClient(input) {
  return new ShopifyAdminGraphqlClient({
    shopDomain: input.shopDomain,
    accessToken: input.accessToken,
    apiVersion: input.apiVersion,
    logger: input.logger ?? console,
    fetchImpl: input.fetchImpl,
  });
}

/** @param {unknown} value */
export function normalizeBulkOperation(value) {
  const payload = jsonObject(value);
  return {
    id: stringValue(payload.id),
    status: stringValue(payload.status),
    errorCode: stringValue(payload.errorCode),
    createdAt: stringValue(payload.createdAt),
    completedAt: stringValue(payload.completedAt),
    objectCount: numberValue(payload.objectCount),
    fileSize: numberValue(payload.fileSize),
    url: stringValue(payload.url),
    partialDataUrl: stringValue(payload.partialDataUrl),
  };
}

/**
 * @param {{ bulkOperation: BulkOperationState; fallbackUsed?: boolean; importedAt?: string | null }} input
 */
export function bulkStatusMetadata(input) {
  return {
    bulkOperationStatus: input.bulkOperation.status,
    bulkOperationErrorCode: input.bulkOperation.errorCode,
    bulkOperationCreatedAt: input.bulkOperation.createdAt,
    bulkOperationCompletedAt: input.bulkOperation.completedAt,
    bulkOperationObjectCount: input.bulkOperation.objectCount,
    bulkOperationFileSize: input.bulkOperation.fileSize,
    bulkOperationUrl: input.bulkOperation.url,
    partialDataUrl: input.bulkOperation.partialDataUrl,
    fallbackUsed: input.fallbackUsed ?? false,
    resultImportedAt: input.importedAt ?? null,
  };
}

/** @param {Record<string, any>} record */
function stripBulkFields(record) {
  const payload = { ...record };
  delete payload.__typename;
  delete payload.__parentId;
  return payload;
}

/** @param {unknown} value */
function stringValue(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

/** @param {unknown} value */
function numberValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** @param {Record<string, any>} value */
function productId(value) {
  return gidOfType(value.id, "Product");
}

/** @param {Record<string, any>} value */
function variantId(value) {
  return gidOfType(value.id, "ProductVariant");
}

/** @param {Record<string, any>} value */
function orderId(value) {
  return gidOfType(value.id, "Order");
}

/** @param {Record<string, any>} value */
function lineItemId(value) {
  return gidOfType(value.id, "LineItem");
}

/** @param {Record<string, any>} value */
function refundId(value) {
  return gidOfType(value.id, "Refund");
}

/**
 * @param {unknown} value
 * @param {string} resource
 */
function gidOfType(value, resource) {
  const gid = stringValue(value);
  return gid?.includes(`/${resource}/`) ? gid : null;
}

/**
 * @typedef {{
 *   id: string | null;
 *   status: string | null;
 *   errorCode: string | null;
 *   createdAt: string | null;
 *   completedAt: string | null;
 *   objectCount: number | null;
 *   fileSize: number | null;
 *   url: string | null;
 *   partialDataUrl: string | null;
 * }} BulkOperationState
 */
