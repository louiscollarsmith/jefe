// @ts-check

import crypto from "node:crypto";
import {
  getShopifyWebhookHeaders,
  verifyShopifyWebhookHmac,
} from "../../shopify/webhook-hmac.server.js";
import { jsonObject, parseDate } from "./normalize.server.js";
import {
  ensureShopifyTenant,
  markShopifyInstallInactive,
} from "./tenant.server.js";
import { writeLedgerEvent } from "./ledger.server.js";
import {
  markShopifyProductDeleted,
  upsertShopifyInventoryLevel,
  upsertShopifyOrder,
  upsertShopifyProduct,
  upsertShopifyRefund,
} from "./canonical.server.js";
import { enqueueMerchantMemoryRefreshForWebhook } from "../../merchant-memory/jobs.server.js";

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
    topic: input.topic,
    payload,
  });
  await enqueueMerchantMemoryRefreshForWebhook(prisma, {
    merchantId: merchant.id,
    shopId: shop.id,
    shopDomain: shop.shopDomain,
    topic: input.topic,
  });

  return { status: "processed", ledgerEventId: event.id };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; topic: string; payload: unknown }} input
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
      await markShopifyProductDeleted(prisma, {
        shopId: input.shopId,
        payload: input.payload,
      });
      break;
    case "inventory_levels/update":
      await upsertShopifyInventoryLevel(prisma, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        inventoryLevel: input.payload,
      });
      break;
    default:
      break;
  }
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
