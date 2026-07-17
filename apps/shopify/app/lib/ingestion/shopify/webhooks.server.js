// @ts-check

import crypto from "node:crypto";
import {
  getShopifyWebhookHeaders,
  verifyShopifyWebhookHmac,
} from "../../shopify/webhook-hmac.server.js";
import { ShopifyAdminGraphqlClient } from "../../shopify/admin-graphql.server.js";
import { INVENTORY_ITEM_COST_QUERY } from "../../shopify/queries.server.js";
import { jsonObject, parseDate } from "./normalize.server.js";
import {
  ensureShopifyTenant,
  markShopifyInstallInactive,
} from "./tenant.server.js";
import { writeLedgerEvent } from "./ledger.server.js";
import {
  upsertShopifyInventoryLevel,
  upsertShopifyOrder,
  upsertShopifyProduct,
  upsertShopifyRefund,
} from "./canonical.server.js";
import {
  recomputeCogsCoverage,
  upsertShopifyUnitCostFromInventoryItem,
} from "../../../services/cogs.server.js";
import { generateDailyBrief } from "../../../services/daily-brief.server.js";

const COMPLIANCE_TOPICS = new Set([
  "customers/data_request",
  "customers/redact",
  "shop/redact",
]);

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {Request} request
 * @param {{ expectedTopic?: string; secret?: string }} [options]
 */
export async function handleShopifyWebhookRequest(
  prisma,
  request,
  options = {},
) {
  const rawBody = await request.text();
  const headers = getShopifyWebhookHeaders(request.headers);
  const secret = options.secret ?? process.env.SHOPIFY_API_SECRET;

  if (!verifyShopifyWebhookHmac(rawBody, headers.hmac, secret)) {
    return new Response("Invalid Shopify webhook signature", { status: 401 });
  }

  if (!headers.topic || !headers.shopDomain) {
    return new Response("Missing Shopify webhook headers", { status: 400 });
  }

  if (options.expectedTopic && headers.topic !== options.expectedTopic) {
    return new Response("Unexpected Shopify webhook topic", { status: 400 });
  }

  const result = await processShopifyWebhook(prisma, {
    rawBody,
    topic: headers.topic,
    shopDomain: headers.shopDomain,
    webhookId: headers.webhookId,
    eventId: headers.eventId,
    triggeredAt: headers.triggeredAt,
    apiVersion: headers.apiVersion,
  });

  return Response.json(result);
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{
 *   rawBody: string;
 *   topic: string;
 *   shopDomain: string;
 *   webhookId?: string | null;
 *   eventId?: string | null;
 *   triggeredAt?: string | null;
 *   apiVersion?: string | null;
 * }} input
 */
export async function processShopifyWebhook(prisma, input) {
  const payload = safeJsonParse(input.rawBody);
  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain: input.shopDomain,
    rawPayload: { source: "webhook", topic: input.topic },
  });

  const dedupeKey = webhookDedupeKey(input);
  const { event, created } = await writeLedgerEvent(prisma, {
    merchantId: merchant.id,
    shopId: shop.id,
    eventType: `shopify.webhook.${input.topic}`,
    source: "shopify",
    sourceEventId: input.webhookId ?? input.eventId ?? null,
    dedupeKey,
    payload: {
      topic: input.topic,
      shopDomain: input.shopDomain,
      webhookId: input.webhookId,
      eventId: input.eventId,
      apiVersion: input.apiVersion,
    },
    rawPayload: payload,
    eventTs: parseDate(input.triggeredAt) ?? new Date(),
  });

  if (!created) {
    return { status: "duplicate", ledgerEventId: event.id };
  }

  if (input.topic === "app/uninstalled") {
    await markShopifyInstallInactive(prisma, input.shopDomain);
    return { status: "processed", ledgerEventId: event.id };
  }

  if (input.topic === "app/scopes_update") {
    const current = Array.isArray(payload.current) ? payload.current : [];
    await prisma.$transaction([
      prisma.session.updateMany({
        where: { shop: input.shopDomain },
        data: { scope: current.join(",") },
      }),
      prisma.connectorAccount.updateMany({
        where: { shopId: shop.id, connector: "shopify" },
        data: { scopes: current },
      }),
    ]);
    return { status: "processed", ledgerEventId: event.id };
  }

  if (COMPLIANCE_TOPICS.has(input.topic)) {
    return { status: "processed", ledgerEventId: event.id };
  }

  await processCanonicalWebhook(prisma, {
    merchantId: merchant.id,
    shopId: shop.id,
    shopDomain: input.shopDomain,
    topic: input.topic,
    payload,
  });

  return { status: "processed", ledgerEventId: event.id };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; shopDomain: string; topic: string; payload: unknown }} input
 */
async function processCanonicalWebhook(prisma, input) {
  switch (input.topic) {
    case "orders/create":
    case "orders/updated":
    case "orders/cancelled":
      await upsertShopifyOrder(prisma, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        order: input.payload,
      });
      break;
    case "refunds/create":
      await upsertRefundWebhook(prisma, input);
      break;
    case "products/create":
    case "products/update":
      await upsertShopifyProduct(prisma, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        product: input.payload,
      });
      break;
    case "products/delete":
      await markProductDeleted(prisma, input);
      break;
    case "inventory_levels/update":
      await upsertShopifyInventoryLevel(prisma, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        inventoryLevel: input.payload,
      });
      break;
    case "inventory_items/update":
      await handleInventoryItemUpdate(prisma, input);
      break;
    case "bulk_operations/finish":
      await handleBulkOperationFinish(prisma, input);
      break;
    default:
      break;
  }
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; shopDomain: string; payload: unknown }} input
 */
async function handleInventoryItemUpdate(prisma, input) {
  const payload = jsonObject(input.payload);
  const inventoryItemId =
    stringValue(payload.admin_graphql_api_id) ||
    stringValue(payload.id) ||
    shopifyGid("InventoryItem", payload.inventory_item_id ?? payload.id);
  if (!inventoryItemId) return;

  let inventoryItem = payload;
  if (!hasUnitCost(payload)) {
    inventoryItem =
      (await fetchInventoryItemForWebhook(prisma, {
        shopDomain: input.shopDomain,
        inventoryItemId,
      })) ?? payload;
  }

  await upsertShopifyUnitCostFromInventoryItem(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    inventoryItem,
  });
  await prisma.shop.update({
    where: { id: input.shopId },
    data: {
      lastInventoryItemCostWebhookAt: new Date(),
      lastSuccessfulCogsSyncAt: new Date(),
      lastCogsSyncError: null,
    },
  });
  await recomputeCogsCoverage(prisma, input.shopId);
  await generateDailyBrief(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    force: true,
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopDomain: string; inventoryItemId: string }} input
 */
async function fetchInventoryItemForWebhook(prisma, input) {
  const session = await prisma.session.findFirst({
    where: { shop: input.shopDomain, isOnline: false },
    orderBy: { expires: "desc" },
  });
  if (!session?.accessToken) return null;

  const client = new ShopifyAdminGraphqlClient({
    shopDomain: input.shopDomain,
    accessToken: session.accessToken,
    apiVersion: process.env.SHOPIFY_API_VERSION,
  });
  const data = /** @type {any} */ (
    await client.request(INVENTORY_ITEM_COST_QUERY, {
      id: input.inventoryItemId,
    })
  );
  return data.node ?? null;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; payload: unknown }} input
 */
async function handleBulkOperationFinish(prisma, input) {
  const payload = jsonObject(input.payload);
  const operationId =
    stringValue(payload.admin_graphql_api_id) || stringValue(payload.id);
  if (!operationId) return;

  const statuses = await prisma.shopBackfillStatus.findMany({
    where: {
      shopId: input.shopId,
      bulkOperationId: operationId,
      domain: { in: ["products", "orders"] },
    },
  });

  await Promise.all(
    statuses.map((status) =>
      prisma.$transaction([
        prisma.shopBackfillStatus.update({
          where: { id: status.id },
          data: {
            status: "bulk_completed",
            completedAt: new Date(),
            metadata: {
              ...(jsonObject(status.metadata) ?? {}),
              bulkOperationStatus:
                stringValue(payload.status) ?? "webhook_finished",
              bulkOperationErrorCode: stringValue(payload.error_code),
              bulkOperationObjectCount: numberValue(payload.object_count),
              bulkOperationFileSize: numberValue(payload.file_size),
              bulkOperationCompletedAt: stringValue(payload.completed_at),
            },
          },
        }),
        prisma.backfillJob.upsert({
          where: {
            shopId_jobType: {
              shopId: input.shopId,
              jobType:
                status.domain === "products"
                  ? "products_bulk_poll"
                  : "orders_bulk_poll",
            },
          },
          create: {
            merchantId: input.merchantId,
            shopId: input.shopId,
            jobType:
              status.domain === "products"
                ? "products_bulk_poll"
                : "orders_bulk_poll",
            status: "queued",
            priority: status.domain === "products" ? 35 : 36,
            runAfter: new Date(),
            payloadJson: {
              domain: status.domain,
              bulkOperationId: operationId,
              source: "bulk_operations_finish_webhook",
            },
          },
          update: {
            status: "queued",
            runAfter: new Date(),
            failedAt: null,
            lastError: null,
            payloadJson: {
              domain: status.domain,
              bulkOperationId: operationId,
              source: "bulk_operations_finish_webhook",
            },
          },
        }),
      ]),
    ),
  );
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopId: string; payload: unknown }} input
 */
async function markProductDeleted(prisma, input) {
  const payload = jsonObject(input.payload);
  const externalId =
    stringValue(payload.admin_graphql_api_id) ||
    stringValue(payload.id) ||
    shopifyGid("Product", payload.product_id ?? payload.id);
  if (!externalId) return;

  await prisma.product.updateMany({
    where: {
      shopId: input.shopId,
      externalId,
    },
    data: {
      status: "deleted",
      rawPayload: payload,
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; payload: unknown }} input
 */
async function upsertRefundWebhook(prisma, input) {
  const payload = jsonObject(input.payload);
  const orderExternalId =
    stringValue(payload.order?.admin_graphql_api_id) ||
    stringValue(payload.order?.id) ||
    stringValue(payload.admin_graphql_api_order_id) ||
    shopifyGid("Order", payload.order_id);

  if (!orderExternalId) return;

  const order = await prisma.order.upsert({
    where: {
      shopId_externalId: {
        shopId: input.shopId,
        externalId: orderExternalId,
      },
    },
    create: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      externalId: orderExternalId,
      rawPayload: { source: "refund_webhook_placeholder" },
    },
    update: {},
  });

  await upsertShopifyRefund(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    orderId: order.id,
    refund: input.payload,
  });
}

/**
 * @param {{ rawBody: string; topic: string; shopDomain: string; webhookId?: string | null; eventId?: string | null }} input
 */
function webhookDedupeKey(input) {
  const deliveryId =
    input.webhookId ||
    input.eventId ||
    crypto.createHash("sha256").update(input.rawBody).digest("hex");
  return `shopify:webhook:${input.shopDomain}:${input.topic}:${deliveryId}`;
}

/** @param {string} rawBody */
function safeJsonParse(rawBody) {
  try {
    return JSON.parse(rawBody);
  } catch {
    return {};
  }
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

/** @param {Record<string, any>} payload */
function hasUnitCost(payload) {
  return Boolean(payload.unitCost || payload.unit_cost || payload.cost);
}

/**
 * @param {string} resource
 * @param {unknown} value
 */
function shopifyGid(resource, value) {
  if (typeof value === "string" && value.startsWith("gid://")) return value;
  if (typeof value === "number" || typeof value === "string") {
    const id = String(value).split("/").pop();
    return id ? `gid://shopify/${resource}/${id}` : null;
  }
  return null;
}
