// @ts-check

import crypto from "node:crypto";
import {
  currencyCode,
  edgesToNodes,
  gidToId,
  jsonObject,
  moneyAmount,
  parseDate,
} from "./normalize.server.js";

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; product: unknown }} input
 */
export async function upsertShopifyProduct(prisma, input) {
  const product = jsonObject(input.product);
  const externalId = productExternalId(product);
  if (!externalId) return null;

  const savedProduct = await prisma.product.upsert({
    where: { shopId_externalId: { shopId: input.shopId, externalId } },
    create: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      externalId,
      title: stringValue(product.title) ?? "Untitled product",
      handle: stringValue(product.handle),
      status: stringValue(product.status),
      vendor: stringValue(product.vendor),
      productType: stringValue(product.productType ?? product.product_type),
      sourceCreatedAt: parseDate(product.createdAt ?? product.created_at),
      sourceUpdatedAt: parseDate(product.updatedAt ?? product.updated_at),
      rawPayload: product,
    },
    update: {
      title: stringValue(product.title) ?? "Untitled product",
      handle: stringValue(product.handle),
      status: stringValue(product.status),
      vendor: stringValue(product.vendor),
      productType: stringValue(product.productType ?? product.product_type),
      sourceCreatedAt: parseDate(product.createdAt ?? product.created_at),
      sourceUpdatedAt: parseDate(product.updatedAt ?? product.updated_at),
      rawPayload: product,
    },
  });

  for (const variant of extractVariants(product)) {
    await upsertShopifyVariant(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      productId: savedProduct.id,
      variant,
    });
  }

  return savedProduct;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; productId: string; variant: unknown }} input
 */
export async function upsertShopifyVariant(prisma, input) {
  const variant = jsonObject(input.variant);
  const externalId = variantExternalId(variant);
  if (!externalId) return null;

  return prisma.variant.upsert({
    where: { shopId_externalId: { shopId: input.shopId, externalId } },
    create: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      productId: input.productId,
      externalId,
      sku: stringValue(variant.sku),
      title: stringValue(variant.title),
      price: moneyAmount(variant.price),
      currency: currencyCode(variant.price),
      inventoryItemExternalId: inventoryItemExternalId(variant),
      sourceCreatedAt: parseDate(variant.createdAt ?? variant.created_at),
      sourceUpdatedAt: parseDate(variant.updatedAt ?? variant.updated_at),
      rawPayload: variant,
    },
    update: {
      productId: input.productId,
      sku: stringValue(variant.sku),
      title: stringValue(variant.title),
      price: moneyAmount(variant.price),
      currency: currencyCode(variant.price),
      inventoryItemExternalId: inventoryItemExternalId(variant),
      sourceCreatedAt: parseDate(variant.createdAt ?? variant.created_at),
      sourceUpdatedAt: parseDate(variant.updatedAt ?? variant.updated_at),
      rawPayload: variant,
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopId: string; payload: unknown }} input
 */
export async function markShopifyProductDeleted(prisma, input) {
  const payload = jsonObject(input.payload);
  const externalId = productExternalId(payload);
  if (!externalId) return { matched: 0 };

  const result = await prisma.product.updateMany({
    where: {
      shopId: input.shopId,
      externalId,
    },
    data: {
      status: "deleted",
      rawPayload: payload,
    },
  });

  return { matched: result.count };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; order: unknown }} input
 */
export async function upsertShopifyOrder(prisma, input) {
  const order = jsonObject(input.order);
  const externalId = orderExternalId(order);
  if (!externalId) return null;

  const totalShipping =
    order.totalShippingPriceSet?.shopMoney ??
    order.total_shipping_price_set?.shop_money;
  const customer = jsonObject(order.customer);

  const savedOrder = await prisma.order.upsert({
    where: { shopId_externalId: { shopId: input.shopId, externalId } },
    create: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      externalId,
      orderName: stringValue(order.name ?? order.order_name),
      customerExternalId: customerExternalId(customer),
      financialStatus: stringValue(
        order.displayFinancialStatus ?? order.financial_status,
      ),
      fulfillmentStatus: stringValue(
        order.displayFulfillmentStatus ?? order.fulfillment_status,
      ),
      currency: stringValue(order.currencyCode ?? order.currency) ?? "GBP",
      subtotalPrice: moneyAmount(
        order.currentSubtotalPriceSet?.shopMoney ?? order.subtotal_price,
      ),
      totalPrice: moneyAmount(
        order.currentTotalPriceSet?.shopMoney ?? order.total_price,
      ),
      totalDiscount: moneyAmount(
        order.currentTotalDiscountsSet?.shopMoney ?? order.total_discounts,
      ),
      totalTax: moneyAmount(
        order.currentTotalTaxSet?.shopMoney ?? order.total_tax,
      ),
      totalShipping: moneyAmount(totalShipping),
      sourceCreatedAt: parseDate(order.createdAt ?? order.created_at),
      sourceUpdatedAt: parseDate(order.updatedAt ?? order.updated_at),
      processedAt: parseDate(order.processedAt ?? order.processed_at),
      rawPayload: order,
    },
    update: {
      orderName: stringValue(order.name ?? order.order_name),
      customerExternalId: customerExternalId(customer),
      financialStatus: stringValue(
        order.displayFinancialStatus ?? order.financial_status,
      ),
      fulfillmentStatus: stringValue(
        order.displayFulfillmentStatus ?? order.fulfillment_status,
      ),
      currency: stringValue(order.currencyCode ?? order.currency) ?? "GBP",
      subtotalPrice: moneyAmount(
        order.currentSubtotalPriceSet?.shopMoney ?? order.subtotal_price,
      ),
      totalPrice: moneyAmount(
        order.currentTotalPriceSet?.shopMoney ?? order.total_price,
      ),
      totalDiscount: moneyAmount(
        order.currentTotalDiscountsSet?.shopMoney ?? order.total_discounts,
      ),
      totalTax: moneyAmount(
        order.currentTotalTaxSet?.shopMoney ?? order.total_tax,
      ),
      totalShipping: moneyAmount(totalShipping),
      sourceCreatedAt: parseDate(order.createdAt ?? order.created_at),
      sourceUpdatedAt: parseDate(order.updatedAt ?? order.updated_at),
      processedAt: parseDate(order.processedAt ?? order.processed_at),
      rawPayload: order,
    },
  });

  for (const lineItem of extractLineItems(order)) {
    await upsertShopifyOrderLineItem(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      orderId: savedOrder.id,
      lineItem,
    });
  }

  for (const refund of extractRefunds(order)) {
    await upsertShopifyRefund(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      orderId: savedOrder.id,
      refund,
    });
  }

  await upsertCustomerIdentityFromOrder(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    order,
  });

  return savedOrder;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; orderId: string; lineItem: unknown }} input
 */
export async function upsertShopifyOrderLineItem(prisma, input) {
  const lineItem = jsonObject(input.lineItem);
  const externalId = lineItemExternalId(lineItem);
  if (!externalId) return null;

  const lineProductExternalId = productExternalId(jsonObject(lineItem.product));
  const lineVariantExternalId = variantExternalId(jsonObject(lineItem.variant));

  const [product, variant] = await Promise.all([
    lineProductExternalId
      ? prisma.product.findUnique({
          where: {
            shopId_externalId: {
              shopId: input.shopId,
              externalId: lineProductExternalId,
            },
          },
        })
      : null,
    lineVariantExternalId
      ? prisma.variant.findUnique({
          where: {
            shopId_externalId: {
              shopId: input.shopId,
              externalId: lineVariantExternalId,
            },
          },
        })
      : null,
  ]);

  const discountAllocations =
    Array.isArray(lineItem.discountAllocations) ||
    Array.isArray(lineItem.discount_allocations)
      ? (lineItem.discountAllocations ?? lineItem.discount_allocations)
      : [];

  return prisma.orderLineItem.upsert({
    where: { orderId_externalId: { orderId: input.orderId, externalId } },
    create: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      orderId: input.orderId,
      productId: product?.id ?? null,
      variantId: variant?.id ?? null,
      externalId,
      sku: stringValue(lineItem.sku),
      title: stringValue(lineItem.title),
      quantity: numberValue(lineItem.quantity) ?? 0,
      unitPrice: moneyAmount(
        lineItem.originalUnitPriceSet?.shopMoney ?? lineItem.price,
      ),
      totalPrice: moneyAmount(
        lineItem.discountedTotalSet?.shopMoney ?? lineItem.total_discount,
      ),
      discount: sumDiscountAllocations(discountAllocations),
      discountAllocations,
      rawPayload: lineItem,
    },
    update: {
      productId: product?.id ?? null,
      variantId: variant?.id ?? null,
      sku: stringValue(lineItem.sku),
      title: stringValue(lineItem.title),
      quantity: numberValue(lineItem.quantity) ?? 0,
      unitPrice: moneyAmount(
        lineItem.originalUnitPriceSet?.shopMoney ?? lineItem.price,
      ),
      totalPrice: moneyAmount(
        lineItem.discountedTotalSet?.shopMoney ?? lineItem.total_discount,
      ),
      discount: sumDiscountAllocations(discountAllocations),
      discountAllocations,
      rawPayload: lineItem,
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; orderId: string; refund: unknown }} input
 */
export async function upsertShopifyRefund(prisma, input) {
  const refund = jsonObject(input.refund);
  const externalId = refundExternalId(refund);
  if (!externalId) return null;

  return prisma.refund.upsert({
    where: { shopId_externalId: { shopId: input.shopId, externalId } },
    create: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      orderId: input.orderId,
      externalId,
      amount: moneyAmount(
        refund.totalRefundedSet?.shopMoney ??
          refund.total_refunded_set?.shop_money,
      ),
      currency: currencyCode(
        refund.totalRefundedSet?.shopMoney ??
          refund.total_refunded_set?.shop_money,
      ),
      reason: stringValue(refund.note ?? refund.reason),
      sourceCreatedAt: parseDate(refund.createdAt ?? refund.created_at),
      processedAt: parseDate(refund.processedAt ?? refund.processed_at),
      rawPayload: refund,
    },
    update: {
      amount: moneyAmount(
        refund.totalRefundedSet?.shopMoney ??
          refund.total_refunded_set?.shop_money,
      ),
      currency: currencyCode(
        refund.totalRefundedSet?.shopMoney ??
          refund.total_refunded_set?.shop_money,
      ),
      reason: stringValue(refund.note ?? refund.reason),
      sourceCreatedAt: parseDate(refund.createdAt ?? refund.created_at),
      processedAt: parseDate(refund.processedAt ?? refund.processed_at),
      rawPayload: refund,
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; inventoryLevel: unknown; inventoryItemId?: string | null; variantExternalId?: string | null }} input
 */
export async function upsertShopifyInventoryLevel(prisma, input) {
  const inventoryLevel = jsonObject(input.inventoryLevel);
  const inventoryItemExternalId =
    input.inventoryItemId ||
    shopifyGid("InventoryItem", inventoryLevel.inventory_item_id) ||
    stringValue(inventoryLevel.inventoryItemId);
  const locationExternalId =
    locationExternalIdFromPayload(inventoryLevel) ||
    shopifyGid("Location", inventoryLevel.location_id);

  if (!inventoryItemExternalId || !locationExternalId) return null;

  const variantExternalId =
    input.variantExternalId || stringValue(inventoryLevel.variant_id);
  const variant = variantExternalId
    ? await prisma.variant.findUnique({
        where: {
          shopId_externalId: {
            shopId: input.shopId,
            externalId: variantExternalId,
          },
        },
      })
    : await prisma.variant.findFirst({
        where: {
          shopId: input.shopId,
          inventoryItemExternalId,
        },
      });

  return prisma.inventoryLevel.upsert({
    where: {
      shopId_inventoryItemExternalId_locationExternalId: {
        shopId: input.shopId,
        inventoryItemExternalId,
        locationExternalId,
      },
    },
    create: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      variantId: variant?.id ?? null,
      inventoryItemExternalId,
      locationExternalId,
      available: inventoryQuantity(inventoryLevel, "available"),
      committed: inventoryQuantity(inventoryLevel, "committed"),
      incoming: inventoryQuantity(inventoryLevel, "incoming"),
      sourceUpdatedAt: parseDate(
        inventoryLevel.updatedAt ?? inventoryLevel.updated_at,
      ),
      observedAt:
        parseDate(inventoryLevel.updatedAt ?? inventoryLevel.updated_at) ??
        new Date(),
      rawPayload: inventoryLevel,
    },
    update: {
      variantId: variant?.id ?? null,
      available: inventoryQuantity(inventoryLevel, "available"),
      committed: inventoryQuantity(inventoryLevel, "committed"),
      incoming: inventoryQuantity(inventoryLevel, "incoming"),
      sourceUpdatedAt: parseDate(
        inventoryLevel.updatedAt ?? inventoryLevel.updated_at,
      ),
      observedAt:
        parseDate(inventoryLevel.updatedAt ?? inventoryLevel.updated_at) ??
        new Date(),
      rawPayload: inventoryLevel,
    },
  });
}

/** @param {unknown} product */
function extractVariants(product) {
  const payload = jsonObject(product);
  if (Array.isArray(payload.variants)) return payload.variants;
  return edgesToNodes(payload.variants);
}

/** @param {unknown} order */
function extractLineItems(order) {
  const payload = jsonObject(order);
  if (Array.isArray(payload.line_items)) return payload.line_items;
  return edgesToNodes(payload.lineItems);
}

/** @param {unknown} order */
function extractRefunds(order) {
  const payload = jsonObject(order);
  if (Array.isArray(payload.refunds)) return payload.refunds;
  return [];
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

/** @param {unknown} product */
function productExternalId(product) {
  const payload = jsonObject(product);
  return (
    stringValue(payload.admin_graphql_api_id) ||
    stringValue(payload.id) ||
    shopifyGid("Product", payload.product_id ?? payload.id)
  );
}

/** @param {unknown} variant */
function variantExternalId(variant) {
  const payload = jsonObject(variant);
  return (
    stringValue(payload.admin_graphql_api_id) ||
    stringValue(payload.id) ||
    shopifyGid("ProductVariant", payload.variant_id ?? payload.id)
  );
}

/** @param {unknown} order */
function orderExternalId(order) {
  const payload = jsonObject(order);
  return (
    stringValue(payload.admin_graphql_api_id) ||
    stringValue(payload.id) ||
    shopifyGid("Order", payload.order_id ?? payload.id)
  );
}

/** @param {unknown} lineItem */
function lineItemExternalId(lineItem) {
  const payload = jsonObject(lineItem);
  return (
    stringValue(payload.admin_graphql_api_id) ||
    stringValue(payload.id) ||
    shopifyGid("LineItem", payload.line_item_id ?? payload.id)
  );
}

/** @param {unknown} refund */
function refundExternalId(refund) {
  const payload = jsonObject(refund);
  return (
    stringValue(payload.admin_graphql_api_id) ||
    stringValue(payload.id) ||
    shopifyGid("Refund", payload.refund_id ?? payload.id)
  );
}

/** @param {unknown} variant */
function inventoryItemExternalId(variant) {
  const payload = jsonObject(variant);
  return (
    stringValue(payload.inventoryItem?.id) ||
    stringValue(payload.inventory_item?.admin_graphql_api_id) ||
    shopifyGid("InventoryItem", payload.inventory_item_id)
  );
}

/** @param {unknown} customer */
function customerExternalId(customer) {
  const payload = jsonObject(customer);
  return (
    stringValue(payload.admin_graphql_api_id) ||
    stringValue(payload.id) ||
    shopifyGid("Customer", payload.customer_id)
  );
}

/**
 * @param {string} resource
 * @param {unknown} value
 */
function shopifyGid(resource, value) {
  if (typeof value === "string" && value.startsWith("gid://")) return value;
  const id =
    typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : gidToId(value);
  return id ? `gid://shopify/${resource}/${id}` : null;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; order: unknown }} input
 */
async function upsertCustomerIdentityFromOrder(prisma, input) {
  const order = jsonObject(input.order);
  const identity = extractOrderEmailIdentity(order);
  if (!identity) return null;

  const processedAt =
    parseDate(order.processedAt ?? order.processed_at) ??
    parseDate(order.createdAt ?? order.created_at);
  const totalSpend = moneyAmount(
    order.currentTotalPriceSet?.shopMoney ??
      order.current_total_price_set?.shop_money ??
      order.total_price,
  );
  const customer = jsonObject(order.customer);
  const shopifyCustomerId = customerExternalId(customer);
  const emailHash = hashEmail(identity.normalizedEmail);
  const orderId = orderExternalId(order);
  const existing = await prisma.customerIdentity.findUnique({
    where: { shopId_emailHash: { shopId: input.shopId, emailHash } },
  });
  const existingRawPayload = jsonObject(existing?.rawPayload);
  const existingOrderIds = Array.isArray(existingRawPayload.orderIds)
    ? existingRawPayload.orderIds
    : [];
  const alreadySeen = orderId ? existingOrderIds.includes(orderId) : false;
  const nextOrderCount = alreadySeen
    ? (existing?.orderCount ?? 0)
    : (existing?.orderCount ?? 0) + 1;
  const nextTotalSpend =
    Number(existing?.totalSpend ?? 0) +
    (alreadySeen ? 0 : Number(totalSpend ?? 0));
  const nextOrderIds =
    orderId && !alreadySeen ? [...existingOrderIds, orderId] : existingOrderIds;

  return prisma.customerIdentity.upsert({
    where: { shopId_emailHash: { shopId: input.shopId, emailHash } },
    create: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      normalizedEmail: identity.normalizedEmail,
      emailHash,
      maskedEmail: maskEmail(identity.normalizedEmail),
      firstSeenOrderAt: processedAt,
      lastOrderAt: processedAt,
      orderCount: 1,
      totalSpend: totalSpend ?? "0",
      averageOrderValue: totalSpend ?? "0",
      source: identity.source,
      shopifyCustomerId,
      rawPayload: {
        source: identity.source,
        orderIds: orderId ? [orderId] : [],
        hasShopifyCustomerId: Boolean(shopifyCustomerId),
      },
    },
    update: {
      normalizedEmail: identity.normalizedEmail,
      maskedEmail: maskEmail(identity.normalizedEmail),
      firstSeenOrderAt:
        existing?.firstSeenOrderAt && processedAt
          ? minDate(existing.firstSeenOrderAt, processedAt)
          : (existing?.firstSeenOrderAt ?? processedAt),
      lastOrderAt:
        existing?.lastOrderAt && processedAt
          ? maxDate(existing.lastOrderAt, processedAt)
          : (existing?.lastOrderAt ?? processedAt),
      orderCount: nextOrderCount,
      totalSpend: String(nextTotalSpend.toFixed(2)),
      averageOrderValue: String((nextTotalSpend / nextOrderCount).toFixed(2)),
      source: existing?.source ?? identity.source,
      shopifyCustomerId: shopifyCustomerId ?? existing?.shopifyCustomerId,
      rawPayload: {
        source: existing?.source ?? identity.source,
        orderIds: nextOrderIds,
        lastOrderId: orderId,
        hasShopifyCustomerId: Boolean(
          shopifyCustomerId ?? existing?.shopifyCustomerId,
        ),
      },
    },
  });
}

/** @param {Record<string, any>} order */
function extractOrderEmailIdentity(order) {
  const noteAttributeEmail = noteAttributeValue(order, "jefe_customer_email");
  const candidates = [
    ["shopify_customer", order.customer?.email],
    ["order_email", order.email],
    ["contact_email", order.contact_email ?? order.contactEmail],
    ["note_attribute", noteAttributeEmail],
    [
      "billing_email",
      order.billing_address?.email ?? order.billingAddress?.email,
    ],
    [
      "shipping_email",
      order.shipping_address?.email ?? order.shippingAddress?.email,
    ],
  ];

  for (const [source, value] of candidates) {
    const normalizedEmail = normalizeEmail(value);
    if (normalizedEmail) return { source, normalizedEmail };
  }

  return null;
}

/**
 * @param {Record<string, any>} order
 * @param {string} name
 */
function noteAttributeValue(order, name) {
  const attributes = order.note_attributes ?? order.noteAttributes;
  if (!Array.isArray(attributes)) return null;
  const match = attributes.find(
    (attribute) =>
      attribute?.name === name ||
      attribute?.key === name ||
      attribute?.Name === name,
  );
  return match?.value ?? match?.Value ?? null;
}

/** @param {unknown} value */
function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null;
}

/** @param {string} email */
function hashEmail(email) {
  return crypto.createHash("sha256").update(email).digest("hex");
}

/** @param {string} email */
function maskEmail(email) {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "masked";
  const first = local.slice(0, 1);
  return `${first}${"*".repeat(Math.max(local.length - 1, 2))}@${domain}`;
}

/**
 * @param {Date} a
 * @param {Date} b
 */
function minDate(a, b) {
  return a.getTime() <= b.getTime() ? a : b;
}

/**
 * @param {Date} a
 * @param {Date} b
 */
function maxDate(a, b) {
  return a.getTime() >= b.getTime() ? a : b;
}

/** @param {unknown} inventoryLevel */
function locationExternalIdFromPayload(inventoryLevel) {
  const payload = jsonObject(inventoryLevel);
  return (
    stringValue(payload.location?.id) ||
    stringValue(payload.location?.admin_graphql_api_id) ||
    stringValue(payload.location_id)
  );
}

/**
 * @param {unknown} inventoryLevel
 * @param {string} name
 */
function inventoryQuantity(inventoryLevel, name) {
  const payload = jsonObject(inventoryLevel);
  if (name in payload) return numberValue(payload[name]);
  if (Array.isArray(payload.quantities)) {
    const quantity = payload.quantities.find((item) => item?.name === name);
    return numberValue(quantity?.quantity);
  }
  return null;
}

/** @param {unknown} allocations */
function sumDiscountAllocations(allocations) {
  if (!Array.isArray(allocations)) return null;
  const total = allocations.reduce((sum, allocation) => {
    const payload = jsonObject(allocation);
    const amount = moneyAmount(
      payload.allocatedAmountSet?.shopMoney ?? payload.amount,
    );
    return sum + (amount ? Number(amount) : 0);
  }, 0);
  return total > 0 ? String(total) : null;
}
