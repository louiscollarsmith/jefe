// @ts-check

import {
  BELIEF_PRECEDENCE,
  MEMORY_DERIVATION_VERSION,
} from "./constants.server.js";

const ALL_CATEGORIES = [
  "business",
  "catalog",
  "orders",
  "customers",
  "refunds",
  "inventory",
];

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; categories?: string[] }} input
 */
export async function deriveMerchantMemoryBeliefs(prisma, input) {
  const categories =
    input.categories && input.categories.length > 0
      ? new Set(input.categories)
      : new Set(ALL_CATEGORIES);
  const merchant = await prisma.merchant.findUniqueOrThrow({
    where: { id: input.merchantId },
    include: {
      shops: {
        where: input.shopId ? { id: input.shopId } : undefined,
      },
    },
  });
  const shop = merchant.shops[0] ?? null;
  const shopId = input.shopId ?? shop?.id ?? null;

  const [
    products,
    variants,
    orders,
    lineItems,
    refunds,
    customerIdentities,
    inventoryLevels,
  ] = await Promise.all([
    prisma.product.findMany({
      where: { merchantId: input.merchantId, shopId: shopId ?? undefined },
      select: { id: true, status: true, sourceCreatedAt: true },
    }),
    prisma.variant.findMany({
      where: { merchantId: input.merchantId, shopId: shopId ?? undefined },
      select: { id: true, productId: true, price: true, currency: true },
    }),
    prisma.order.findMany({
      where: { merchantId: input.merchantId, shopId: shopId ?? undefined },
      select: {
        id: true,
        currency: true,
        totalPrice: true,
        processedAt: true,
        sourceCreatedAt: true,
      },
    }),
    prisma.orderLineItem.findMany({
      where: { merchantId: input.merchantId, shopId: shopId ?? undefined },
      select: { orderId: true, quantity: true },
    }),
    prisma.refund.findMany({
      where: { merchantId: input.merchantId, shopId: shopId ?? undefined },
      select: { orderId: true, amount: true, currency: true, processedAt: true },
    }),
    prisma.customerIdentity.findMany({
      where: { merchantId: input.merchantId, shopId: shopId ?? undefined },
      select: { orderCount: true },
    }),
    prisma.inventoryLevel.findMany({
      where: { merchantId: input.merchantId, shopId: shopId ?? undefined },
      select: {
        variantId: true,
        available: true,
        inventoryItemExternalId: true,
        locationExternalId: true,
        observedAt: true,
      },
    }),
  ]);

  const now = new Date();
  const derivations = [];
  const sourceCounts = {
    products: products.length,
    variants: variants.length,
    orders: orders.length,
    lineItems: lineItems.length,
    refunds: refunds.length,
    customerIdentities: customerIdentities.length,
    inventoryLevels: inventoryLevels.length,
  };

  if (categories.has("business")) {
    const storeName = storeNameFrom(shop?.rawPayload, merchant.name, shop);
    if (storeName) {
      derivations.push(
        belief(input.merchantId, shopId, {
          category: "business",
          key: "business.store_name",
          value: { text: storeName },
          valueType: "string",
          confidence: storeName === merchant.name ? 0.7 : 0.95,
          confidenceReason:
            storeName === merchant.name
              ? "Derived from the merchant tenant name because no richer Shopify shop name is stored."
              : "Observed directly from stored Shopify shop metadata.",
          sourceCounts,
          formula: "shop.raw_payload.name, shop.raw_payload.shop.name, or merchant.name fallback",
          summary: "Store name derived from installed Shopify tenant metadata.",
          now,
        }),
      );
    }

    const primaryCurrency = mostCommonCurrency([
      ...orders.map((order) => order.currency),
      ...variants.map((variant) => variant.currency),
      ...refunds.map((refund) => refund.currency),
    ]);
    if (primaryCurrency) {
      derivations.push(
        belief(input.merchantId, shopId, {
          category: "business",
          key: "business.primary_currency",
          value: {
            currency: primaryCurrency.currency,
            observedCurrencies: primaryCurrency.observedCurrencies,
          },
          valueType: "currency_code",
          confidence: primaryCurrency.observedCurrencies.length === 1 ? 0.95 : 0.75,
          confidenceReason:
            primaryCurrency.observedCurrencies.length === 1
              ? "All priced commerce records use the same currency."
              : "Multiple currencies are present; selected the most common observed currency.",
          sourceCounts,
          formula: "mode(order.currency, variant.currency, refund.currency)",
          summary: "Primary currency derived from stored priced commerce records.",
          now,
        }),
      );
    }
  }

  if (categories.has("catalog")) {
    const retainedProducts = products.filter((product) => !isDeleted(product));
    const activeProducts = retainedProducts.filter((product) =>
      isActiveProduct(product),
    );
    const pricedVariants = variants.filter((variant) => variant.price !== null);
    const variantCurrency = mostCommonCurrency(
      pricedVariants.map((variant) => variant.currency),
    );
    derivations.push(
      belief(input.merchantId, shopId, {
        category: "catalog",
        key: "catalog.total_product_count",
        value: { count: retainedProducts.length },
        valueType: "number",
        confidence: 0.95,
        confidenceReason: "Direct count of retained non-deleted Shopify product records.",
        sourceCounts,
        formula: "count(products where status is not deleted)",
        summary: "Total catalogue product count calculated from stored product records.",
        now,
      }),
      belief(input.merchantId, shopId, {
        category: "catalog",
        key: "catalog.active_product_count",
        value: { count: activeProducts.length },
        valueType: "number",
        confidence: 0.95,
        confidenceReason: "Direct count of products whose stored status is active.",
        sourceCounts,
        formula: "count(products where upper(status) = ACTIVE)",
        summary: "Active product count calculated from stored Shopify product statuses.",
        now,
      }),
      belief(input.merchantId, shopId, {
        category: "catalog",
        key: "catalog.total_variant_count",
        value: { count: variants.length },
        valueType: "number",
        confidence: 0.95,
        confidenceReason: "Direct count of stored Shopify variant records.",
        sourceCounts,
        formula: "count(variants)",
        summary: "Variant count calculated from stored variant records.",
        now,
      }),
      belief(input.merchantId, shopId, {
        category: "catalog",
        key: "catalog.has_product_variants",
        value: { boolean: variants.length > retainedProducts.length },
        valueType: "boolean",
        confidence: 0.9,
        confidenceReason: "Derived by comparing variant and product counts.",
        sourceCounts,
        formula: "total_variant_count > total_product_count",
        summary: "Variant usage inferred from product and variant counts.",
        now,
      }),
    );

    if (pricedVariants.length > 0) {
      derivations.push(
        belief(input.merchantId, shopId, {
          category: "catalog",
          key: "catalog.average_product_price",
          value: {
            amount: roundMoney(
              sum(pricedVariants.map((variant) => decimalNumber(variant.price))) /
                pricedVariants.length,
            ),
            currency: variantCurrency?.currency ?? null,
            pricedVariantCount: pricedVariants.length,
          },
          valueType: "currency_amount",
          confidence:
            variantCurrency?.observedCurrencies.length === 1 ? 0.9 : 0.7,
          confidenceReason:
            variantCurrency?.observedCurrencies.length === 1
              ? "Calculated from priced variants in a single observed currency."
              : "Calculated from priced variants, but multiple or missing currencies are present.",
          sourceCounts,
          formula: "sum(variant.price where present) / priced_variant_count",
          summary: "Average product price calculated from stored variant prices.",
          now,
        }),
      );
    }

    derivations.push(
      belief(input.merchantId, shopId, {
        category: "catalog",
        key: "catalog.out_of_stock_product_count",
        value: {
          count: outOfStockProductCount(activeProducts, variants, inventoryLevels),
        },
        valueType: "number",
        confidence: inventoryLevels.length > 0 ? 0.85 : 0.55,
        confidenceReason:
          inventoryLevels.length > 0
            ? "Calculated from active products, variants and current stored inventory levels."
            : "No inventory levels are stored yet, so the count may be incomplete.",
        sourceCounts,
        formula:
          "count(active products where every known variant has summed available inventory <= 0)",
        summary: "Out-of-stock product count derived from active products and inventory levels.",
        now,
      }),
    );
  }

  if (categories.has("orders")) {
    const commerceOrders = orders.filter(isCommerceOrder);
    const pricedOrders = commerceOrders.filter((order) => order.totalPrice !== null);
    const orderCurrency = mostCommonCurrency(pricedOrders.map((order) => order.currency));
    const itemsByOrder = quantityByOrder(lineItems);
    derivations.push(
      belief(input.merchantId, shopId, {
        category: "orders",
        key: "orders.total_order_count",
        value: { count: commerceOrders.length },
        valueType: "number",
        confidence: 0.9,
        confidenceReason: "Direct count of stored Shopify orders with a processed timestamp or total price.",
        sourceCounts,
        formula: "count(orders where processed_at is present or total_price is present)",
        summary: "Order count calculated from stored order records.",
        now,
      }),
    );

    if (pricedOrders.length > 0) {
      derivations.push(
        belief(input.merchantId, shopId, {
          category: "orders",
          key: "orders.average_order_value.all_time",
          value: {
            amount: roundMoney(
              sum(pricedOrders.map((order) => decimalNumber(order.totalPrice))) /
                pricedOrders.length,
            ),
            currency: orderCurrency?.currency ?? null,
            orderCount: pricedOrders.length,
            window: "all_stored_history",
            refundHandling: "uses Shopify current total_price; refunds are reported separately",
          },
          valueType: "currency_amount",
          confidence:
            orderCurrency?.observedCurrencies.length === 1 ? 0.9 : 0.7,
          confidenceReason:
            orderCurrency?.observedCurrencies.length === 1
              ? "Calculated from stored priced orders in one observed currency."
              : "Calculated from stored priced orders, but multiple or missing currencies are present.",
          sourceCounts,
          formula: "sum(order.total_price where present) / priced_order_count",
          summary: "Average order value calculated from stored Shopify order totals.",
          now,
        }),
      );
    }

    if (commerceOrders.length > 0) {
      const datedOrders = commerceOrders
        .map((order) => order.processedAt ?? order.sourceCreatedAt)
        .filter(isDate)
        .sort((a, b) => a.getTime() - b.getTime());
      derivations.push(
        belief(input.merchantId, shopId, {
          category: "orders",
          key: "orders.average_items_per_order.all_time",
          value: {
            number: roundNumber(
              sum(commerceOrders.map((order) => itemsByOrder.get(order.id) ?? 0)) /
                commerceOrders.length,
              2,
            ),
            orderCount: commerceOrders.length,
            window: "all_stored_history",
          },
          valueType: "number",
          confidence: lineItems.length > 0 ? 0.85 : 0.6,
          confidenceReason:
            lineItems.length > 0
              ? "Calculated from stored order line-item quantities."
              : "No order line items are stored yet, so the value may be incomplete.",
          sourceCounts,
          formula: "sum(order_line_items.quantity) / commerce_order_count",
          summary: "Average items per order calculated from stored line items.",
          now,
        }),
      );

      if (datedOrders.length > 0) {
        const firstOrderAt = datedOrders[0];
        const latestOrderAt = datedOrders[datedOrders.length - 1];
        if (firstOrderAt && latestOrderAt) {
          derivations.push(
            belief(input.merchantId, shopId, {
              category: "orders",
              key: "orders.first_order_at",
              value: { timestamp: firstOrderAt.toISOString() },
              valueType: "timestamp",
              confidence: 0.9,
              confidenceReason: "Earliest stored Shopify order timestamp.",
              sourceCounts,
              formula:
                "min(order.processed_at fallback order.source_created_at)",
              summary: "First order timestamp derived from stored order records.",
              observedAt: firstOrderAt,
              now,
            }),
            belief(input.merchantId, shopId, {
              category: "orders",
              key: "orders.latest_order_at",
              value: { timestamp: latestOrderAt.toISOString() },
              valueType: "timestamp",
              confidence: 0.9,
              confidenceReason: "Latest stored Shopify order timestamp.",
              sourceCounts,
              formula:
                "max(order.processed_at fallback order.source_created_at)",
              summary:
                "Latest order timestamp derived from stored order records.",
              observedAt: latestOrderAt,
              now,
            }),
          );
        }
      }
    }
  }

  if (categories.has("customers")) {
    const repeatCustomers = customerIdentities.filter(
      (identity) => identity.orderCount > 1,
    ).length;
    derivations.push(
      belief(input.merchantId, shopId, {
        category: "customers",
        key: "customers.known_customer_count",
        value: { count: customerIdentities.length },
        valueType: "number",
        confidence: 0.9,
        confidenceReason: "Direct count of stored hashed customer identities.",
        sourceCounts,
        formula: "count(customer_identities)",
        summary: "Known customer count calculated without copying customer PII into memory.",
        now,
      }),
      belief(input.merchantId, shopId, {
        category: "customers",
        key: "customers.repeat_customer_rate.all_time",
        value: {
          ratio:
            customerIdentities.length === 0
              ? 0
              : roundNumber(repeatCustomers / customerIdentities.length, 4),
          percentage:
            customerIdentities.length === 0
              ? 0
              : roundNumber((repeatCustomers / customerIdentities.length) * 100, 2),
          knownCustomerCount: customerIdentities.length,
          repeatCustomerCount: repeatCustomers,
          window: "all_stored_history",
        },
        valueType: "percentage",
        confidence: customerIdentities.length > 0 ? 0.85 : 0.55,
        confidenceReason:
          customerIdentities.length > 0
            ? "Calculated from aggregate order counts on hashed customer identities."
            : "No customer identities are stored yet.",
        sourceCounts,
        formula: "count(customer_identities where order_count > 1) / count(customer_identities)",
        summary: "Repeat customer rate calculated from aggregate identity counts only.",
        now,
      }),
    );
  }

  if (categories.has("refunds")) {
    const pricedRefunds = refunds.filter((refund) => refund.amount !== null);
    const refundCurrency = mostCommonCurrency(pricedRefunds.map((refund) => refund.currency));
    const commerceOrderCount = orders.filter(isCommerceOrder).length;
    const refundedOrderCount = new Set(refunds.map((refund) => refund.orderId)).size;

    derivations.push(
      belief(input.merchantId, shopId, {
        category: "refunds",
        key: "refunds.total_refunded_amount.all_time",
        value: {
          amount: roundMoney(
            sum(pricedRefunds.map((refund) => decimalNumber(refund.amount))),
          ),
          currency: refundCurrency?.currency ?? null,
          refundCount: pricedRefunds.length,
          window: "all_stored_history",
        },
        valueType: "currency_amount",
        confidence:
          pricedRefunds.length === refunds.length &&
          (refundCurrency === null || refundCurrency.observedCurrencies.length === 1)
            ? 0.9
            : 0.65,
        confidenceReason:
          pricedRefunds.length === refunds.length
            ? "Calculated from stored refund amounts."
            : "Some refund records do not have an amount, so the total may be incomplete.",
        sourceCounts,
        formula: "sum(refund.amount where present)",
        summary: "Total refunded amount calculated from stored refund records.",
        now,
      }),
      belief(input.merchantId, shopId, {
        category: "refunds",
        key: "refunds.refunded_order_rate.all_time",
        value: {
          ratio:
            commerceOrderCount === 0
              ? 0
              : roundNumber(refundedOrderCount / commerceOrderCount, 4),
          percentage:
            commerceOrderCount === 0
              ? 0
              : roundNumber((refundedOrderCount / commerceOrderCount) * 100, 2),
          refundedOrderCount,
          orderCount: commerceOrderCount,
          window: "all_stored_history",
        },
        valueType: "percentage",
        confidence: commerceOrderCount > 0 ? 0.85 : 0.55,
        confidenceReason:
          commerceOrderCount > 0
            ? "Calculated from distinct refunded orders divided by stored commerce orders."
            : "No commerce orders are stored yet.",
        sourceCounts,
        formula: "count(distinct refund.order_id) / commerce_order_count",
        summary: "Refunded order rate calculated from stored orders and refunds.",
        now,
      }),
    );
  }

  if (categories.has("inventory")) {
    const knownAvailableLevels = inventoryLevels.filter(
      (level) => level.available !== null,
    );
    const availableByVariant = inventoryByVariant(inventoryLevels);
    const outOfStockVariants = Array.from(availableByVariant.values()).filter(
      (available) => available <= 0,
    ).length;
    const observedAts = inventoryLevels
      .map((level) => level.observedAt)
      .filter(Boolean)
      .sort((a, b) => a.getTime() - b.getTime());
    const lastObservedAt = observedAts[observedAts.length - 1] ?? now;

    derivations.push(
      belief(input.merchantId, shopId, {
        category: "inventory",
        key: "inventory.total_tracked_units",
        value: {
          count: sum(knownAvailableLevels.map((level) => level.available ?? 0)),
          inventoryLevelCount: knownAvailableLevels.length,
        },
        valueType: "number",
        confidence: knownAvailableLevels.length > 0 ? 0.85 : 0.55,
        confidenceReason:
          knownAvailableLevels.length > 0
            ? "Calculated from stored Shopify inventory levels with available quantities."
            : "No available inventory quantities are stored yet.",
        sourceCounts,
        formula: "sum(inventory_levels.available where present)",
        summary: "Tracked units calculated from stored inventory availability.",
        observedAt: lastObservedAt,
        now,
      }),
      belief(input.merchantId, shopId, {
        category: "inventory",
        key: "inventory.out_of_stock_variant_count",
        value: { count: outOfStockVariants },
        valueType: "number",
        confidence: availableByVariant.size > 0 ? 0.85 : 0.55,
        confidenceReason:
          availableByVariant.size > 0
            ? "Calculated by summing available inventory across locations per variant."
            : "No variant-linked inventory availability is stored yet.",
        sourceCounts,
        formula: "count(variants where sum(inventory_levels.available by variant) <= 0)",
        summary: "Out-of-stock variant count calculated from stored inventory levels.",
        observedAt: lastObservedAt,
        now,
      }),
    );
  }

  return derivations;
}

/**
 * @param {string} merchantId
 * @param {string | null} shopId
 * @param {BeliefSeed} seed
 */
function belief(merchantId, shopId, seed) {
  return {
    merchantId,
    shopId,
    category: seed.category,
    key: seed.key,
    value: seed.value,
    valueType: seed.valueType,
    confidence: seed.confidence,
    confidenceReason: seed.confidenceReason,
    precedence: BELIEF_PRECEDENCE.systemInference,
    derivationVersion: MEMORY_DERIVATION_VERSION,
    observedAt: seed.observedAt ?? seed.now,
    evaluatedAt: seed.now,
    evidence: {
      sourceType: "system_derivation",
      sourceReference: MEMORY_DERIVATION_VERSION,
      evidenceType: "deterministic_calculation",
      summary: seed.summary,
      observedAt: seed.observedAt ?? seed.now,
      metadata: {
        formula: seed.formula,
        analysisWindow: seed.value?.window ?? "current_stored_state",
        sourceRecordCounts: seed.sourceCounts,
        calculatedAt: seed.now.toISOString(),
      },
    },
  };
}

/**
 * @param {unknown} rawPayload
 * @param {string} merchantName
 * @param {{ shopDomain: string } | null} shop
 */
function storeNameFrom(rawPayload, merchantName, shop) {
  const payload = jsonObject(rawPayload);
  const candidates = [
    payload.name,
    payload.shop?.name,
    payload.shopName,
    shop?.shopDomain,
    merchantName,
  ];
  return candidates.find((value) => typeof value === "string" && value.trim())
    ?.trim();
}

/** @param {{ status: string | null }} product */
function isDeleted(product) {
  return String(product.status ?? "").toLowerCase() === "deleted";
}

/** @param {{ status: string | null }} product */
function isActiveProduct(product) {
  return String(product.status ?? "").toUpperCase() === "ACTIVE";
}

/** @param {{ processedAt: Date | null; totalPrice: unknown }} order */
function isCommerceOrder(order) {
  return Boolean(order.processedAt || order.totalPrice !== null);
}

/** @param {unknown} value */
function isDate(value) {
  return value instanceof Date;
}

/** @param {Array<string | null | undefined>} currencies */
function mostCommonCurrency(currencies) {
  const counts = new Map();
  for (const currency of currencies) {
    if (typeof currency !== "string" || currency.trim() === "") continue;
    const key = currency.trim().toUpperCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  return {
    currency: sorted[0][0],
    observedCurrencies: sorted.map(([currency]) => currency),
  };
}

/** @param {unknown} value */
function decimalNumber(value) {
  if (value === null || value === undefined) return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** @param {number[]} values */
function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

/** @param {number} value */
function roundMoney(value) {
  return roundNumber(value, 2);
}

/**
 * @param {number} value
 * @param {number} places
 */
function roundNumber(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** @param {Array<{ orderId: string; quantity: number }>} lineItems */
function quantityByOrder(lineItems) {
  const quantities = new Map();
  for (const lineItem of lineItems) {
    quantities.set(
      lineItem.orderId,
      (quantities.get(lineItem.orderId) ?? 0) + lineItem.quantity,
    );
  }
  return quantities;
}

/** @param {Array<{ variantId: string | null; available: number | null }>} inventoryLevels */
function inventoryByVariant(inventoryLevels) {
  const availableByVariant = new Map();
  for (const level of inventoryLevels) {
    if (!level.variantId || level.available === null) continue;
    availableByVariant.set(
      level.variantId,
      (availableByVariant.get(level.variantId) ?? 0) + level.available,
    );
  }
  return availableByVariant;
}

/**
 * @param {Array<{ id: string }>} products
 * @param {Array<{ id: string; productId: string }>} variants
 * @param {Array<{ variantId: string | null; available: number | null }>} inventoryLevels
 */
function outOfStockProductCount(products, variants, inventoryLevels) {
  const availableByVariant = inventoryByVariant(inventoryLevels);
  /** @type {Map<string, Array<{ id: string; productId: string }>>} */
  const variantsByProduct = new Map();
  for (const variant of variants) {
    const productVariants = variantsByProduct.get(variant.productId) ?? [];
    productVariants.push(variant);
    variantsByProduct.set(variant.productId, productVariants);
  }

  let outOfStock = 0;
  for (const product of products) {
    const productVariants = variantsByProduct.get(product.id) ?? [];
    const variantsWithInventory = productVariants.filter((variant) =>
      availableByVariant.has(variant.id),
    );
    if (
      variantsWithInventory.length > 0 &&
      variantsWithInventory.every(
        (variant) => (availableByVariant.get(variant.id) ?? 0) <= 0,
      )
    ) {
      outOfStock += 1;
    }
  }
  return outOfStock;
}

/**
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/**
 * @typedef {{
 *   category: string;
 *   key: string;
 *   value: any;
 *   valueType: string;
 *   confidence: number;
 *   confidenceReason: string;
 *   sourceCounts: Record<string, number>;
 *   formula: string;
 *   summary: string;
 *   observedAt?: Date;
 *   now: Date;
 * }} BeliefSeed
 */
