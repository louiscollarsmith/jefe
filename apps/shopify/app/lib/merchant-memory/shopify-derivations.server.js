// @ts-nocheck

import {
  BELIEF_PRECEDENCE,
} from "./constants.server.js";
import {
  average as primitiveAverage,
  clamp as primitiveClamp,
  decimalNumber as primitiveDecimalNumber,
  hoursBetween as primitiveHoursBetween,
  percentile as primitivePercentile,
  percentileFor as primitivePercentileFor,
  roundMoney as primitiveRoundMoney,
  roundNumber as primitiveRoundNumber,
  stddev as primitiveStddev,
  sum as primitiveSum,
  sumBy as primitiveSumBy,
} from "./calculation-primitives.server.js";
import {
  calibratePublishedConfidence,
  evaluateConfidenceTemplate,
} from "./confidence-templates.server.js";
import { getConfidenceConfig } from "./deterministic-confidence-registry.server.js";
import { DETERMINISTIC_BELIEF_REGISTRY } from "./deterministic-belief-registry.server.js";
import { currentDefinitionVersion } from "./derivation-versioning.server.js";
import { buildDeterministicEvidence } from "./evidence-builders.server.js";

const STALE_INVENTORY_HOURS = 72;
const LARGE_BASKET_ITEM_THRESHOLD = 4;
const DERIVATION_OUTCOME = {
  calculated: "CALCULATED",
  insufficientData: "INSUFFICIENT_DATA",
  notApplicable: "NOT_APPLICABLE",
  blockedByMissingSource: "BLOCKED_BY_MISSING_SOURCE",
};

const ALL_CATEGORIES = Array.from(
  new Set(DETERMINISTIC_BELIEF_REGISTRY.map((definition) => definition.category)),
);

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; categories?: string[] }} input
 */
export async function deriveMerchantMemoryBeliefs(prisma, input) {
  const categories =
    input.categories && input.categories.length > 0
      ? new Set(input.categories)
      : new Set(ALL_CATEGORIES);
  const context = await loadDerivationContext(prisma, input);
  const definitions = DETERMINISTIC_BELIEF_REGISTRY.filter((definition) =>
    categories.has(definition.category),
  );
  const outcomes = definitions.map((definition) => deriveDefinition(context, definition));
  const calculated = outcomes.filter(
    (outcome) => outcome.status === DERIVATION_OUTCOME.calculated,
  );
  const skippedOutcomes = outcomes
    .filter((outcome) => outcome.status !== DERIVATION_OUTCOME.calculated)
    .map(derivationAttemptSummary);
  const derivationAttempts = outcomes.map(derivationAttemptSummary);

  return {
    derivations: calculated.map((outcome) =>
      belief(context.merchantId, context.shopId, outcome.definition, {
        value: outcome.value,
        confidence: outcome.confidence,
        confidenceReason: outcome.confidenceReason,
        sourceCounts: context.sourceCounts,
        summary: outcome.summary,
        observedAt: outcome.observedAt,
        now: context.now,
        metadata: outcome.metadata ?? {},
      }),
    ),
    skippedOutcomes,
    derivationAttempts,
    derivationReport: buildDerivationReport(definitions, outcomes),
    registryDefinitionCount: definitions.length,
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null }} input
 */
async function loadDerivationContext(prisma, input) {
  const merchant = await prisma.merchant.findUniqueOrThrow({
    where: { id: input.merchantId },
    include: {
      shops: {
        where: input.shopId ? { id: input.shopId } : undefined,
        include: { connectorAccounts: true, backfillStatuses: true },
      },
    },
  });
  const shop = merchant.shops[0] ?? null;
  const shopId = input.shopId ?? shop?.id ?? null;
  const where = { merchantId: input.merchantId, shopId: shopId ?? undefined };
  const [products, variants, orders, lineItems, refunds, customerIdentities, inventoryLevels, planRecommendations] =
    await Promise.all([
      prisma.product.findMany({
        where,
        select: {
          id: true,
          title: true,
          status: true,
          productType: true,
          vendor: true,
          sourceCreatedAt: true,
          sourceUpdatedAt: true,
        },
      }),
      prisma.variant.findMany({
        where,
        select: {
          id: true,
          productId: true,
          sku: true,
          title: true,
          price: true,
          currency: true,
          unitCost: true,
          inventoryItemExternalId: true,
          sourceUpdatedAt: true,
        },
      }),
      prisma.order.findMany({
        where,
        select: {
          id: true,
          externalId: true,
          currency: true,
          totalPrice: true,
          totalDiscount: true,
          totalTax: true,
          totalShipping: true,
          processedAt: true,
          sourceCreatedAt: true,
          sourceUpdatedAt: true,
          customerExternalId: true,
          financialStatus: true,
          sourceName: true,
          shippingCountry: true,
        },
      }),
      prisma.orderLineItem.findMany({
        where,
        select: {
          orderId: true,
          externalId: true,
          productId: true,
          variantId: true,
          quantity: true,
          unitPrice: true,
          totalPrice: true,
        },
      }),
      prisma.refund.findMany({
        where,
        select: {
          orderId: true,
          amount: true,
          currency: true,
          processedAt: true,
          rawPayload: true,
        },
      }),
      prisma.customerIdentity.findMany({
        where,
        select: { orderCount: true, totalSpend: true, rawPayload: true },
      }),
      prisma.inventoryLevel.findMany({
        where,
        select: {
          variantId: true,
          available: true,
          inventoryItemExternalId: true,
          locationExternalId: true,
          sourceUpdatedAt: true,
          observedAt: true,
        },
      }),
      // Recommendation outcomes are the Observe→Learn signal. Guarded so
      // derivation fixtures/mocks without this accessor simply see none.
      prisma.merchantPlanRecommendation?.findMany
        ? prisma.merchantPlanRecommendation.findMany({
            where,
            select: {
              reviewStatus: true,
              acceptedAt: true,
              rejectedAt: true,
              completedAt: true,
            },
          })
        : Promise.resolve([]),
    ]);

  const now = new Date();
  const shopTimezone = shopTimezoneFrom(shop?.rawPayload);
  const retainedProducts = products.filter((product) => !isDeleted(product));
  const activeProducts = retainedProducts.filter(isActiveProduct);
  const retainedProductIds = new Set(retainedProducts.map((product) => product.id));
  const activeProductIds = new Set(activeProducts.map((product) => product.id));
  const retainedVariants = variants.filter((variant) => retainedProductIds.has(variant.productId));
  const activeVariants = variants.filter((variant) => activeProductIds.has(variant.productId));
  const commerceOrders = orders.filter(isCommerceOrder);
  const datedOrders = commerceOrders
    .map((order) => ({ ...order, orderTime: orderTime(order) }))
    .filter((order) => order.orderTime instanceof Date);
  const pricedOrders = commerceOrders.filter((order) => order.totalPrice !== null);
  const pricedActiveVariants = activeVariants.filter((variant) => variant.price !== null);
  const availableByVariant = inventoryByVariant(inventoryLevels);
  const variantsByProduct = groupBy(activeVariants, (variant) => variant.productId);
  const quantitiesByOrder = quantityByOrder(lineItems);
  const uniqueProductsByOrder = linkedCountByOrder(lineItems, "productId");
  const uniqueVariantsByOrder = linkedCountByOrder(lineItems, "variantId");
  const lineItemOrderIds = new Set(lineItems.map((lineItem) => lineItem.orderId));
  const successfulRefundCoverage = refundTransactionCoverage(refunds);

  return {
    merchantId: input.merchantId,
    shopId,
    merchant,
    shop,
    now,
    shopTimezone,
    products,
    variants,
    orders,
    lineItems,
    refunds,
    customerIdentities,
    inventoryLevels,
    planRecommendations,
    retainedProducts,
    activeProducts,
    retainedVariants,
    activeVariants,
    commerceOrders,
    datedOrders,
    pricedOrders,
    pricedActiveVariants,
    availableByVariant,
    variantsByProduct,
    quantitiesByOrder,
    uniqueProductsByOrder,
    uniqueVariantsByOrder,
    lineItemOrderIds,
    successfulRefundCoverage,
    sourceCounts: {
      products: products.length,
      variants: variants.length,
      orders: orders.length,
      lineItems: lineItems.length,
      refunds: refunds.length,
      customerIdentities: customerIdentities.length,
      inventoryLevels: inventoryLevels.length,
    },
  };
}

/**
 * @param {any} context
 * @param {any} definition
 */
function deriveDefinition(context, definition) {
  try {
    switch (definition.key) {
      case "business.store_name":
        return storeName(context, definition);
      case "business.primary_currency":
        return primaryCurrency(context, definition);
      case "business.commerce_history_days":
        return commerceHistoryDays(context, definition);
      case "business.days_since_last_order":
        return daysSinceLastOrder(context, definition);
      case "business.currency_count.all_stored_history":
        return currencyCount(context, definition);
      case "business.activity_profile":
        return activityProfile(context, definition);
      case "business.active_selling_days.trailing_30d":
      case "business.active_selling_days.trailing_90d":
        return activeSellingDays(context, definition, trailingDays(definition.key));
      case "business.orders_per_active_day.trailing_30d":
        return ordersPerActiveDay(context, definition, 30);
      case "business.revenue_per_active_day.trailing_30d":
        return revenuePerActiveDay(context, definition, 30);
      case "business.multi_currency_order_share.trailing_90d":
        return multiCurrencyOrderShare(context, definition, 90);
      case "business.order_value_dispersion.trailing_90d":
        return orderValueDispersion(context, definition, 90);
      case "business.order_value_mean_to_median_ratio.trailing_90d":
        return orderValueMeanMedianRatio(context, definition, 90);
      case "business.top_sales_day_revenue_share.trailing_90d":
        return topSalesDayShare(context, definition, 90);
      case "business.top_sales_week_revenue_share.trailing_180d":
        return topSalesWeekShare(context, definition, 180);
      case "business.zero_sales_day_share.trailing_90d":
        return zeroSalesDayShare(context, definition, 90);

      case "products.selling_product_count.trailing_90d":
        return sellingProductCount(context, definition, 90);
      case "products.no_sale_active_product_count.trailing_90d":
        return noSaleActiveProductCount(context, definition, 90);
      case "products.dead_stock.trailing_90d":
        return deadStock(context, definition, 90);
      case "products.top_product_revenue_share.trailing_90d":
        return topProductRevenueShare(context, definition, 90, 1);
      case "products.top_5_product_revenue_share.trailing_90d":
        return topProductRevenueShare(context, definition, 90, 5);
      case "products.bestseller_by_revenue.trailing_90d":
        return bestsellerByRevenue(context, definition, 90);
      case "products.bestseller_by_units.trailing_90d":
        return bestsellerByUnits(context, definition, 90);
      case "products.cost_coverage":
        return costCoverage(context, definition);
      case "products.gross_margin.trailing_90d":
        return grossMargin(context, definition, 90);
      case "business.online_revenue_share.trailing_90d":
        return onlineRevenueShare(context, definition, 90);
      case "business.revenue_by_region.trailing_90d":
        return revenueByRegion(context, definition, 90);
      case "business.margin_by_region.trailing_90d":
        return marginByRegion(context, definition, 90);
      case "products.top_returned_products.trailing_180d":
        return topReturnedProducts(context, definition, 180);
      case "products.product_momentum.trailing_60d":
        return productMomentum(context, definition);
      case "business.yoy_revenue_growth.trailing_90d":
        return yoyRevenueGrowth(context, definition, 90);
      case "business.revenue_trend.trailing_180d":
        return revenueTrend(context, definition, 90);
      case "business.peak_sales_month.all_time":
        return peakSalesMonth(context, definition);
      case "business.recommendation_engagement.all_time":
        return recommendationEngagement(context, definition);
      case "products.revenue_by_product_type.trailing_90d":
        return revenueByProductType(context, definition, 90);
      case "products.revenue_by_vendor.trailing_90d":
        return revenueByVendor(context, definition, 90);

      case "catalog.total_product_count":
        return countOutcome(context, definition, context.retainedProducts.length, "Retained non-deleted Shopify products.");
      case "catalog.active_product_count":
        return countOutcome(context, definition, context.activeProducts.length, "Active Shopify products.");
      case "catalog.archived_product_count":
        return countOutcome(context, definition, productStatusCount(context, "ARCHIVED"), "Archived Shopify products.");
      case "catalog.draft_product_count":
        return countOutcome(context, definition, productStatusCount(context, "DRAFT"), "Draft Shopify products.");
      case "catalog.total_variant_count":
        return countOutcome(context, definition, context.retainedVariants.length, "Variants linked to retained products.");
      case "catalog.has_product_variants":
        return hasProductVariants(context, definition);
      case "catalog.average_product_price":
        return variantPriceAggregate(context, definition, "mean", 1);
      case "catalog.minimum_variant_price":
        return variantPriceAggregate(context, definition, "min", 1);
      case "catalog.maximum_variant_price":
        return variantPriceAggregate(context, definition, "max", 1);
      case "catalog.median_variant_price":
        return variantPriceAggregate(context, definition, "median", 5);
      case "catalog.variant_price_p25":
        return variantPriceAggregate(context, definition, "p25", 10);
      case "catalog.variant_price_p75":
        return variantPriceAggregate(context, definition, "p75", 10);
      case "catalog.variant_price_range_ratio":
        return variantPriceRangeRatio(context, definition);
      case "catalog.out_of_stock_product_count":
        return outOfStockProducts(context, definition);
      case "catalog.active_product_share":
        return shareOutcome(context, definition, context.activeProducts.length, context.retainedProducts.length, "Active products divided by retained products.");
      case "catalog.max_variants_per_product":
        return variantsPerProduct(context, definition, "max");
      case "catalog.multi_variant_product_count":
        return multiVariantProductCount(context, definition);
      case "catalog.multi_variant_product_share":
        return multiVariantProductShare(context, definition);
      case "catalog.single_variant_product_share":
        return singleVariantProductShare(context, definition);
      case "catalog.variants_per_product_average":
        return variantsPerProduct(context, definition, "mean");
      case "catalog.variants_per_product_median":
        return variantsPerProduct(context, definition, "median");
      case "catalog.zero_price_variant_count":
        return countOutcome(context, definition, activeVariantPrices(context).filter((price) => price === 0).length, "Active variants with a zero current price.");
      case "catalog.zero_price_variant_share":
        return shareOutcome(context, definition, activeVariantPrices(context).filter((price) => price === 0).length, activeVariantPrices(context).length, "Zero-price active variants divided by priced active variants.");

      case "customers.known_customer_count":
        return countOutcome(context, definition, context.customerIdentities.length, "Stored hashed customer identities.");
      case "customers.repeat_customer_rate.all_time":
        return repeatCustomerRate(context, definition);
      case "customers.repeat_revenue_share.all_time":
        return repeatRevenueShare(context, definition);
      case "customers.average_lifetime_spend.all_time":
        return averageLifetimeSpend(context, definition);
      case "customers.top_customer_revenue_share.all_time":
        return topCustomerRevenueShare(context, definition);

      case "refunds.refunded_order_rate.all_time":
        return refundedOrderRate(context, definition);
      case "refunds.total_refunded_amount.all_time":
        return totalRefundedAmount(context, definition);

      case "inventory.positive_available_units":
        return positiveAvailableUnits(context, definition);
      case "inventory.total_tracked_units":
        return skipped(
          definition,
          "not_applicable",
          "Suppressed because inventory.positive_available_units publishes the same positive available unit total and negative inventory is tracked separately.",
          { knownTrackedVariants: knownTrackedAvailability(context).length },
        );
      case "inventory.out_of_stock_variant_count":
        return inventoryVariantCount(context, definition, (available) => available <= 0, "Inventory-tracked active variants with summed available units at or below zero.");
      case "inventory.in_stock_variant_count":
        return inventoryVariantCount(context, definition, (available) => available > 0, "Inventory-tracked active variants with positive summed available units.");
      case "inventory.in_stock_variant_share":
        return inventoryVariantShare(context, definition, (available) => available > 0, "In-stock active tracked variants divided by known tracked variants.");
      case "inventory.negative_inventory_variant_count":
        return inventoryVariantCount(context, definition, (available) => available < 0, "Inventory-tracked active variants with negative summed available units.");
      case "inventory.negative_inventory_variant_share":
        return inventoryVariantShare(context, definition, (available) => available < 0, "Negative-stock active tracked variants divided by known tracked variants.");
      case "inventory.negative_inventory_unit_magnitude":
        return negativeInventoryMagnitude(context, definition);
      case "inventory.median_available_units_per_variant":
        return inventoryAvailabilityAggregate(context, definition, "median", 5);
      case "inventory.available_units_p90_per_variant":
        return inventoryAvailabilityAggregate(context, definition, "p90", 10);
      case "inventory.retail_value_of_available_stock":
        return retailValueOfAvailableStock(context, definition);
      case "inventory.top_5_variant_retail_value_share":
        return topVariantRetailValueShare(context, definition);
      case "inventory.stale_inventory_level_share":
        return staleInventoryLevelShare(context, definition);
      case "inventory.units_per_active_product":
        return unitsPerActiveProduct(context, definition);
      case "inventory.at_risk_stockout_count.trailing_30d":
        return atRiskStockoutCount(context, definition);
      case "inventory.low_cover_products.trailing_30d":
        return lowCoverProducts(context, definition);

      case "data.currency_consistency":
        return currencyConsistency(context, definition);
      case "data.customer_identity_order_coverage":
        return customerIdentityOrderCoverage(context, definition);
      case "data.duplicate_sku_count":
        return duplicateSkuCount(context, definition);
      case "data.inventory_freshness_hours_p90":
        return inventoryFreshnessP90(context, definition);
      case "data.inventory_variant_coverage":
        return inventoryVariantCoverage(context, definition);
      case "data.line_item_product_link_coverage":
        return shareOutcome(context, definition, context.lineItems.filter((item) => item.productId).length, context.lineItems.length, "Line items linked to stored products divided by all line items.", { confidence: 0.99 });
      case "data.line_item_variant_link_coverage":
        return shareOutcome(context, definition, context.lineItems.filter((item) => item.variantId).length, context.lineItems.length, "Line items linked to stored variants divided by all line items.", { confidence: 0.99 });
      case "data.missing_sku_variant_share":
        return missingSkuVariantShare(context, definition);
      case "data.nonpositive_order_value_count":
        return countOutcome(context, definition, context.pricedOrders.filter((order) => decimalNumber(order.totalPrice) <= 0).length, "Stored priced orders with non-positive total price.", { confidence: 0.99 });
      case "data.nonpositive_variant_price_count":
        return countOutcome(context, definition, activeVariantPrices(context).filter((price) => price <= 0).length, "Active priced variants with non-positive current prices.", { confidence: 0.99 });
      case "data.order_history_completeness":
        return orderHistoryCompleteness(context, definition);
      case "data.order_history_span_days":
        return orderHistorySpanDays(context, definition);
      case "data.order_timestamp_coverage":
        return shareOutcome(context, definition, context.commerceOrders.filter((order) => orderTime(order)).length, context.commerceOrders.length, "Stored commerce orders with processed or created timestamps divided by stored commerce orders.", { confidence: 0.99 });
      case "data.orphan_inventory_level_count":
        return countOutcome(context, definition, context.inventoryLevels.filter((level) => !level.variantId).length, "Inventory levels without a linked stored variant.", { confidence: 0.99 });
      case "data.orphan_line_item_count":
        return orphanLineItemCount(context, definition);
      case "data.priced_order_coverage":
        return shareOutcome(context, definition, context.pricedOrders.length, context.commerceOrders.length, "Stored commerce orders with a total price divided by stored commerce orders.", { confidence: 0.99 });
      case "data.priced_variant_coverage":
        return shareOutcome(context, definition, context.pricedActiveVariants.length, context.activeVariants.length, "Active variants with a current price divided by active variants.", { confidence: 0.99 });
      case "data.refund_line_item_coverage":
        return refundLineItemCoverage(context, definition);
      case "data.refund_transaction_amount_coverage":
        return refundTransactionAmountCoverage(context, definition);

      case "orders.total_order_count":
        return countOutcome(context, definition, context.commerceOrders.length, "Stored valid commerce orders.");
      case "orders.average_order_value.all_time":
        return orderValueAggregate(context, definition, context.pricedOrders, "mean", 1);
      case "orders.average_items_per_order.all_time":
        return averageItemsPerOrder(context, definition, context.commerceOrders, 1);
      case "orders.first_order_at":
        return firstOrderAt(context, definition);
      case "orders.latest_order_at":
        return latestOrderAt(context, definition);
      case "orders.zero_value_order_share.all_stored_history":
        return shareOutcome(context, definition, context.pricedOrders.filter((order) => decimalNumber(order.totalPrice) === 0).length, context.commerceOrders.length, "Zero-value stored commerce orders divided by stored commerce orders.", { confidence: 0.99 });
      case "orders.order_count.trailing_7d":
      case "orders.order_count.trailing_30d":
      case "orders.order_count.trailing_90d":
        return orderCountWindow(context, definition, trailingDays(definition.key));
      case "orders.gross_order_value.trailing_7d":
      case "orders.gross_order_value.trailing_30d":
      case "orders.gross_order_value.trailing_90d":
        return grossOrderValueWindow(context, definition, trailingDays(definition.key));
      case "orders.average_order_value.trailing_30d":
      case "orders.average_order_value.trailing_90d":
        return orderValueAggregate(context, definition, pricedOrdersInWindow(context, trailingDays(definition.key)), "mean", 5);
      case "orders.median_order_value.trailing_30d":
      case "orders.median_order_value.trailing_90d":
        return orderValueAggregate(context, definition, pricedOrdersInWindow(context, trailingDays(definition.key)), "median", 5);
      case "orders.order_value_p25.trailing_90d":
        return orderValueAggregate(context, definition, pricedOrdersInWindow(context, 90), "p25", 20);
      case "orders.order_value_p75.trailing_90d":
        return orderValueAggregate(context, definition, pricedOrdersInWindow(context, 90), "p75", 20);
      case "orders.order_value_p90.trailing_90d":
        return orderValueAggregate(context, definition, pricedOrdersInWindow(context, 90), "p90", 20);
      case "orders.average_items_per_order.trailing_30d":
      case "orders.average_items_per_order.trailing_90d":
        return averageItemsPerOrder(context, definition, ordersInWindow(context, trailingDays(definition.key)), 5);
      case "orders.median_items_per_order.trailing_90d":
        return medianItemsPerOrder(context, definition, ordersInWindow(context, 90));
      case "orders.multi_item_order_share.trailing_90d":
        return itemQuantityShare(context, definition, ordersInWindow(context, 90), (quantity) => quantity >= 2, 10, "Orders with at least two items divided by stored orders in the trailing 90 days.");
      case "orders.single_item_order_share.trailing_90d":
        return itemQuantityShare(context, definition, ordersInWindow(context, 90), (quantity) => quantity === 1, 10, "Orders with exactly one item divided by stored orders in the trailing 90 days.");
      case "orders.large_basket_order_share.trailing_90d":
        return itemQuantityShare(context, definition, ordersInWindow(context, 90), (quantity) => quantity >= LARGE_BASKET_ITEM_THRESHOLD, 20, "Orders with at least four items divided by stored orders in the trailing 90 days.");
      case "orders.average_unique_products_per_order.trailing_90d":
        return averageLinkedEntitiesPerOrder(context, definition, ordersInWindow(context, 90), context.uniqueProductsByOrder, 10, "Mean distinct linked products per order in the trailing 90 days.");
      case "orders.average_unique_variants_per_order.trailing_90d":
        return averageLinkedEntitiesPerOrder(context, definition, ordersInWindow(context, 90), context.uniqueVariantsByOrder, 10, "Mean distinct linked variants per order in the trailing 90 days.");
      case "orders.longest_gap_between_orders.trailing_180d":
        return longestGapBetweenOrders(context, definition, 180);
      default:
        return skipped(definition, "insufficient_data", "No deterministic calculation is implemented for this registry key.", context.sourceCounts);
    }
  } catch (error) {
    return skipped(
      definition,
      "blocked_by_data_quality",
      error instanceof Error ? error.message : "Deterministic calculation failed.",
      context.sourceCounts,
    );
  }
}

function storeName(context, definition) {
  const payload = jsonObject(context.shop?.rawPayload);
  const shopName = stringValue(payload.name) ?? stringValue(payload.shop?.name) ?? stringValue(payload.shopName);
  const fallback = shopName ?? context.merchant.name;
  if (!fallback) return skipped(definition, "insufficient_data", "Installed Shopify shop metadata is missing.", context.sourceCounts);
  return derived(context, definition, {
    value: { text: fallback },
    confidence: shopName ? 0.95 : 0.7,
    confidenceReason: shopName ? "Observed directly from stored Shopify shop metadata." : "Derived from the merchant tenant name because no Shopify shop name is stored.",
    summary: "Store name derived from installed Shopify tenant metadata.",
    sampleSize: shopName ? 1 : 0,
    supportingValues: { source: shopName ? "shopify_shop_metadata" : "merchant_name_fallback" },
  });
}

function primaryCurrency(context, definition) {
  const pricedCurrencies = [
    ...context.pricedOrders.map((order) => order.currency),
    ...context.pricedActiveVariants.map((variant) => variant.currency),
    ...context.successfulRefundCoverage.successfulTransactions.map((transaction) => transaction.currency),
  ];
  const distribution = currencyDistribution(pricedCurrencies);
  if (distribution.total === 0) return skipped(definition, "insufficient_data", "No priced commerce records are stored.", context.sourceCounts);
  const dominant = distribution.entries[0];
  return derived(context, definition, {
    value: {
      currency: dominant.currency,
      observedCurrencies: distribution.entries.map((entry) => entry.currency),
      dominantShare: roundNumber(dominant.count / distribution.total, 4),
      pricedRecordCount: distribution.total,
    },
    confidence: coverageConfidence(0.95, dominant.count / distribution.total),
    confidenceReason: dominant.count / distribution.total >= 0.95 ? "At least 95% of priced commerce records use the dominant currency." : "Multiple currencies are present; selected the most common observed currency.",
    summary: "Primary currency derived from stored priced commerce records.",
    sampleSize: distribution.total,
    coverageMetrics: { dominantCurrencyShare: roundNumber(dominant.count / distribution.total, 4) },
  });
}

function commerceHistoryDays(context, definition) {
  const dated = sortedOrderTimes(context.datedOrders);
  if (dated.length < 1) return skipped(definition, "insufficient_data", "No dated stored orders are available.", context.sourceCounts);
  return derived(context, definition, {
    value: { count: inclusiveDaySpan(dated[0], dated[dated.length - 1], context.shopTimezone), window: "all_stored_history" },
    confidence: 0.9,
    confidenceReason: "Calculated from earliest and latest stored order timestamps.",
    summary: "Stored commerce history span calculated from stored order timestamps.",
    observedAt: dated[dated.length - 1],
    sampleSize: dated.length,
  });
}

function daysSinceLastOrder(context, definition) {
  const dated = sortedOrderTimes(context.datedOrders);
  if (dated.length < 1) return skipped(definition, "insufficient_data", "No dated stored orders are available.", context.sourceCounts);
  const latest = dated[dated.length - 1];
  return derived(context, definition, {
    value: { count: Math.max(0, Math.floor((context.now.getTime() - latest.getTime()) / 86400000)) },
    confidence: 0.95,
    confidenceReason: "Calculated from the latest stored order timestamp.",
    summary: "Days since latest stored order.",
    observedAt: latest,
    sampleSize: dated.length,
  });
}

function currencyCount(context, definition) {
  const distribution = currencyDistribution(context.pricedOrders.map((order) => order.currency));
  if (distribution.total === 0) return skipped(definition, "insufficient_data", "No priced stored orders are available.", context.sourceCounts);
  return countOutcome(context, definition, distribution.entries.length, "Distinct currencies on stored priced orders.", { confidence: 0.99, sampleSize: distribution.total });
}

function activityProfile(context, definition) {
  const orders = ordersInWindow(context, 90);
  if (orders.length < 10) return skipped(definition, "insufficient_data", "At least 10 orders are required for activity profile.", { orders: orders.length });
  const activeDays = activeDaySet(context, orders).size;
  const activeSellingDayShare = activeDays / 90;
  const perActiveDay = activeDays === 0 ? 0 : orders.length / activeDays;
  const orderTimes = sortedOrderTimes(orders);
  const longestInactivityGapDays = longestInactivityGap(orderTimes, context.now);
  const weeklyConsistency = weeklyOrderConsistency(orderTimes, context.now, 90);
  const daysSinceLastOrderValue =
    orderTimes.length === 0
      ? null
      : Math.max(0, Math.floor((context.now.getTime() - orderTimes[orderTimes.length - 1].getTime()) / 86400000));
  let profile = "quiet";
  if (
    activeSellingDayShare >= 0.5 &&
    perActiveDay >= 4 &&
    weeklyConsistency >= 0.75 &&
    longestInactivityGapDays <= 7
  ) {
    profile = "high_velocity";
  } else if (
    weeklyConsistency >= 0.65 &&
    activeSellingDayShare >= 0.25 &&
    longestInactivityGapDays <= 14
  ) {
    profile = "steady";
  } else if (
    activeSellingDayShare >= 0.08 ||
    weeklyConsistency >= 0.3 ||
    orders.length >= 20
  ) {
    profile = "intermittent";
  }
  if (daysSinceLastOrderValue !== null && daysSinceLastOrderValue > 30) {
    profile = "quiet_recently";
  }
  return derived(context, definition, {
    value: {
      enum: profile,
      activeSellingDayShare: roundNumber(activeSellingDayShare, 4),
      ordersPerActiveDay: roundNumber(perActiveDay, 2),
      longestInactivityGapDays,
      weeklyConsistency: roundNumber(weeklyConsistency, 4),
      daysSinceLastOrder: daysSinceLastOrderValue,
      thresholdVersion: "activity-profile-v2",
      window: "trailing_90d",
    },
    confidence: sampleConfidence(0.8, orders.length, 10, 100),
    confidenceReason: "Bucketed deterministically from active selling days, order cadence, weekly consistency and recent inactivity.",
    summary: "Operational activity profile derived from trailing 90-day order cadence.",
    sampleSize: orders.length,
  });
}

function activeSellingDays(context, definition, days) {
  const orders = ordersInWindow(context, days);
  return derived(context, definition, {
    value: { count: activeDaySet(context, orders).size, window: `trailing_${days}d` },
    confidence: 0.95,
    confidenceReason: "Direct count of merchant-local calendar days with at least one stored order in the window.",
    summary: `Active selling days counted over the trailing ${days} days.`,
    sampleSize: orders.length,
  });
}

function ordersPerActiveDay(context, definition, days) {
  const orders = ordersInWindow(context, days);
  const activeDays = activeDaySet(context, orders).size;
  if (activeDays < 1) return skipped(definition, "insufficient_data", "At least one active selling day is required.", { orders: orders.length, activeDays });
  return derived(context, definition, {
    value: { number: roundNumber(orders.length / activeDays, 2), orderCount: orders.length, activeSellingDays: activeDays, window: `trailing_${days}d` },
    confidence: sampleConfidence(0.9, orders.length, 1, 50),
    confidenceReason: "Stored order count divided by active selling days in the window.",
    summary: `Orders per active selling day over the trailing ${days} days.`,
    sampleSize: orders.length,
  });
}

function revenuePerActiveDay(context, definition, days) {
  const orders = pricedOrdersInWindow(context, days);
  const activeDays = activeDaySet(context, orders).size;
  const currency = shopBaseCurrency(context);
  if (orders.length < 1 || activeDays < 1) return skipped(definition, "insufficient_data", "At least one priced order on an active selling day is required.", { orders: orders.length, activeDays });
  if (!currency.ok) return skipped(definition, "blocked_by_data_quality", "Multiple currencies are present without conversion support.", { currencies: currency.currencies.length });
  return derived(context, definition, {
    value: { amount: roundMoney(sum(orders.map(orderValue)) / activeDays), currency: currency.currency, activeSellingDays: activeDays, orderCount: orders.length, window: `trailing_${days}d`, orderValuePolicy: orderValuePolicy() },
    confidence: sampleConfidence(0.9, orders.length, 1, 50),
    confidenceReason: "Canonical stored order value divided by active selling days in a single currency.",
    summary: `Revenue per active selling day over the trailing ${days} days.`,
    sampleSize: orders.length,
    currencyHandling: "single_shop_currency_required",
  });
}

function multiCurrencyOrderShare(context, definition, days) {
  const orders = pricedOrdersInWindow(context, days);
  const distribution = currencyDistribution(orders.map((order) => order.currency));
  if (distribution.total < 1) return skipped(definition, "insufficient_data", "At least one priced order is required.", { orders: orders.length });
  const dominant = distribution.entries[0];
  return shareOutcome(context, definition, distribution.total - dominant.count, distribution.total, "Priced orders not in the dominant currency divided by priced orders in the window.", { confidence: 0.99, supportingValues: { dominantCurrency: dominant.currency } });
}

function orderValueDispersion(context, definition, days) {
  const orders = pricedOrdersInWindow(context, days);
  const currency = shopBaseCurrency(context);
  if (orders.length < 10) return skipped(definition, "insufficient_data", "At least 10 priced orders are required for dispersion.", { orders: orders.length });
  if (!currency.ok) return skipped(definition, "blocked_by_data_quality", "Multiple currencies are present without conversion support.", { currencies: currency.currencies.length });
  const values = orders.map(orderValue);
  const mean = average(values);
  return derived(context, definition, {
    value: { number: mean === 0 ? 0 : roundNumber(stddev(values) / mean, 4), orderCount: orders.length, window: `trailing_${days}d` },
    confidence: sampleConfidence(0.85, orders.length, 10, 100),
    confidenceReason: "Coefficient of variation calculated from canonical order values in one currency.",
    summary: "Trailing order value dispersion calculated from stored order values.",
    sampleSize: orders.length,
  });
}

function orderValueMeanMedianRatio(context, definition, days) {
  const orders = pricedOrdersInWindow(context, days);
  const currency = shopBaseCurrency(context);
  if (orders.length < 10) return skipped(definition, "insufficient_data", "At least 10 priced orders are required for mean-to-median ratio.", { orders: orders.length });
  if (!currency.ok) return skipped(definition, "blocked_by_data_quality", "Multiple currencies are present without conversion support.", { currencies: currency.currencies.length });
  const values = orders.map(orderValue);
  const med = percentile(values, 0.5);
  return derived(context, definition, {
    value: { number: med === 0 ? null : roundNumber(average(values) / med, 4), mean: roundMoney(average(values)), median: roundMoney(med), orderCount: orders.length, window: `trailing_${days}d` },
    confidence: sampleConfidence(0.85, orders.length, 10, 100),
    confidenceReason: "Mean canonical order value divided by median canonical order value in one currency.",
    summary: "Trailing order value skew proxy calculated from stored order values.",
    sampleSize: orders.length,
  });
}

function topSalesDayShare(context, definition, days) {
  const orders = pricedOrdersInWindow(context, days);
  const currency = shopBaseCurrency(context);
  if (orders.length < 5) return skipped(definition, "insufficient_data", "At least 5 priced orders are required.", { orders: orders.length });
  if (!currency.ok) return skipped(definition, "blocked_by_data_quality", "Multiple currencies are present without conversion support.", { currencies: currency.currencies.length });
  const byDay = sumBy(orders, (order) => dayKey(orderTime(order), context.shopTimezone), orderValue);
  return shareFromValues(context, definition, Array.from(byDay.values()), `trailing_${days}d`, "Top merchant-local sales day revenue divided by window revenue.");
}

function topSalesWeekShare(context, definition, days) {
  const orders = pricedOrdersInWindow(context, days);
  const currency = shopBaseCurrency(context);
  const weekKeys = new Set(orders.map((order) => weekKey(orderTime(order), context.shopTimezone)));
  if (weekKeys.size < 8) return skipped(definition, "insufficient_data", "At least 8 observed weeks are required.", { observedWeeks: weekKeys.size, orders: orders.length });
  if (!currency.ok) return skipped(definition, "blocked_by_data_quality", "Multiple currencies are present without conversion support.", { currencies: currency.currencies.length });
  const byWeek = sumBy(orders, (order) => weekKey(orderTime(order), context.shopTimezone), orderValue);
  return shareFromValues(context, definition, Array.from(byWeek.values()), `trailing_${days}d`, "Top merchant-local sales week revenue divided by window revenue.");
}

function zeroSalesDayShare(context, definition, days) {
  const activeDays = activeDaySet(context, ordersInWindow(context, days)).size;
  return shareOutcome(context, definition, days - activeDays, days, "Merchant-local calendar days without a stored order divided by days in the trailing window.", { confidence: 0.95 });
}

function hasProductVariants(context, definition) {
  const counts = variantCountsPerActiveProduct(context);
  if (counts.length < 1) return skipped(definition, "insufficient_data", "Products and variants must be linked before variant usage can be derived.", context.sourceCounts);
  return derived(context, definition, {
    value: { boolean: counts.some((count) => count > 1) },
    confidence: 0.95,
    confidenceReason: "Direct product-level test for an active product with more than one active variant.",
    summary: "Product variant usage derived from active variants grouped by product.",
    sampleSize: counts.length,
    supportingValues: { maxVariantsPerProduct: Math.max(...counts) },
  });
}

function variantPriceAggregate(context, definition, method, minimum) {
  const prices = activeVariantPrices(context);
  if (prices.length < minimum) return skipped(definition, "insufficient_data", `At least ${minimum} priced active variant(s) are required.`, { pricedActiveVariants: prices.length });
  const currency = singleCurrency(context.pricedActiveVariants.map((variant) => variant.currency));
  if (!currency.ok) return skipped(definition, "blocked_by_data_quality", "Multiple variant currencies are present without conversion support.", { currencies: currency.currencies.length });
  const amount = method === "mean" ? average(prices) : method === "min" ? Math.min(...prices) : method === "max" ? Math.max(...prices) : percentile(prices, percentileFor(method));
  return derived(context, definition, {
    value: { amount: roundMoney(amount), currency: currency.currency, pricedVariantCount: prices.length },
    confidence: coverageConfidence(0.9, prices.length / Math.max(context.activeVariants.length, 1)),
    confidenceReason: "Calculated from priced active variants in one current variant currency.",
    summary: "Current variant price aggregate calculated from stored active variant prices.",
    sampleSize: prices.length,
    coverageMetrics: { pricedActiveVariantCoverage: roundNumber(prices.length / Math.max(context.activeVariants.length, 1), 4) },
    currencyHandling: "single_variant_currency_required",
  });
}

function variantPriceRangeRatio(context, definition) {
  const prices = activeVariantPrices(context).filter((price) => price > 0);
  if (prices.length < 2) return skipped(definition, "insufficient_data", "At least two positive priced active variants are required.", { pricedActiveVariants: prices.length });
  return derived(context, definition, {
    value: { number: roundNumber(Math.max(...prices) / Math.min(...prices), 4), pricedVariantCount: prices.length },
    confidence: 0.9,
    confidenceReason: "Maximum active variant price divided by minimum positive active variant price.",
    summary: "Variant price range ratio calculated from current active variant prices.",
    sampleSize: prices.length,
  });
}

function outOfStockProducts(context, definition) {
  const counts = knownAvailabilityByActiveProduct(context);
  if (counts.length < 1) return skipped(definition, "insufficient_data", "At least one active product with linked inventory is required.", context.sourceCounts);
  return countOutcome(context, definition, counts.filter((product) => product.knownVariantCount > 0 && product.available.every((available) => available <= 0)).length, "Active products where every inventory-known variant has summed available units at or below zero.", { confidence: coverageConfidence(0.85, counts.length / Math.max(context.activeProducts.length, 1)), sampleSize: counts.length });
}

function variantsPerProduct(context, definition, method) {
  const counts = variantCountsPerActiveProduct(context);
  if (counts.length < 1) return skipped(definition, "insufficient_data", "At least one active product is required.", { activeProducts: context.activeProducts.length });
  const number = method === "max" ? Math.max(...counts) : method === "mean" ? average(counts) : percentile(counts, 0.5);
  return derived(context, definition, {
    value: { number: roundNumber(number, method === "max" ? 0 : 2), activeProductCount: counts.length },
    confidence: 0.95,
    confidenceReason: "Calculated from active variants grouped by active product.",
    summary: "Variants-per-product aggregate calculated from current active catalogue records.",
    sampleSize: counts.length,
  });
}

function multiVariantProductCount(context, definition) {
  const counts = variantCountsPerActiveProduct(context);
  if (counts.length < 1) return skipped(definition, "insufficient_data", "At least one active product is required.", { activeProducts: context.activeProducts.length });
  return countOutcome(context, definition, counts.filter((count) => count > 1).length, "Active products with more than one active variant.", { confidence: 0.95, sampleSize: counts.length });
}

function multiVariantProductShare(context, definition) {
  const counts = variantCountsPerActiveProduct(context);
  return shareOutcome(context, definition, counts.filter((count) => count > 1).length, counts.length, "Active products with more than one active variant divided by active products.", { confidence: 0.95 });
}

function singleVariantProductShare(context, definition) {
  const counts = variantCountsPerActiveProduct(context);
  return shareOutcome(context, definition, counts.filter((count) => count === 1).length, counts.length, "Active products with exactly one active variant divided by active products.", { confidence: 0.95 });
}

function repeatCustomerRate(context, definition) {
  if (context.customerIdentities.length < 10) return skipped(definition, "insufficient_data", "At least 10 known customers are required for repeat customer rate.", { customerIdentities: context.customerIdentities.length });
  const repeatCustomers = context.customerIdentities.filter((identity) => identity.orderCount >= 2).length;
  return shareOutcome(context, definition, repeatCustomers, context.customerIdentities.length, "Known hashed customer identities with at least two observed orders divided by known identities.", { confidence: sampleConfidence(0.85, context.customerIdentities.length, 10, 100), supportingValues: { window: "all_stored_history" } });
}

const MIN_CUSTOMERS_FOR_SPEND_BELIEFS = 10;
const TOP_CUSTOMER_SAMPLE = 10;

// Aggregate per-customer lifetime spend from the hashed identities. totalSpend
// is stored in shop base currency (currentTotalPriceSet.shopMoney at ingest,
// deduped by order id), so these are summable/comparable across customers
// regardless of the buyer's presentment currency. PII-safe: counts, shares and
// aggregate money only — never an identity.
function customerSpendStats(context) {
  let totalSpend = 0;
  let repeatCount = 0;
  let repeatSpend = 0;
  const spendsDesc = [];
  for (const identity of context.customerIdentities) {
    const spend = Number(identity.totalSpend ?? 0);
    totalSpend += spend;
    spendsDesc.push(spend);
    if (Number(identity.orderCount ?? 0) >= 2) {
      repeatCount += 1;
      repeatSpend += spend;
    }
  }
  spendsDesc.sort((a, b) => b - a);
  const customerCount = context.customerIdentities.length;
  return {
    customerCount,
    totalSpend,
    repeatCount,
    repeatSpend,
    oneTimeCount: customerCount - repeatCount,
    oneTimeSpend: totalSpend - repeatSpend,
    spendsDesc,
  };
}

// Share of total customer spend that comes from repeat customers (>=2 orders):
// distinct from repeat_customer_rate (share of customers), this is the "returning
// customers drive X% of revenue" signal — a store can have few repeaters who
// account for most revenue, or many who don't.
function repeatRevenueShare(context, definition) {
  const stats = customerSpendStats(context);
  if (stats.customerCount < MIN_CUSTOMERS_FOR_SPEND_BELIEFS) return skipped(definition, "insufficient_data", "At least 10 known customers are required for repeat revenue share.", { customerIdentities: stats.customerCount });
  if (stats.totalSpend <= 0) return skipped(definition, "insufficient_data", "Recorded customer spend is required for repeat revenue share.", { totalSpend: roundMoney(stats.totalSpend) });
  return shareOutcome(context, definition, roundMoney(stats.repeatSpend), roundMoney(stats.totalSpend), "Lifetime spend from customers with at least two observed orders divided by total known customer spend (shop base currency).", { confidence: sampleConfidence(0.85, stats.customerCount, 10, 100), supportingValues: { repeatCustomerCount: stats.repeatCount, currency: shopBaseCurrency(context).currency, window: "all_stored_history" } });
}

// Average customer lifetime spend (LTV proxy), split by repeat vs one-time so the
// value of retention is visible. Shop base currency.
function averageLifetimeSpend(context, definition) {
  const stats = customerSpendStats(context);
  if (stats.customerCount < MIN_CUSTOMERS_FOR_SPEND_BELIEFS) return skipped(definition, "insufficient_data", "At least 10 known customers are required for average lifetime spend.", { customerIdentities: stats.customerCount });
  if (stats.totalSpend <= 0) return skipped(definition, "insufficient_data", "Recorded customer spend is required for average lifetime spend.", { totalSpend: roundMoney(stats.totalSpend) });
  return derived(context, definition, {
    value: {
      averageLifetimeSpend: roundMoney(stats.totalSpend / stats.customerCount),
      repeatCustomerAverageSpend: stats.repeatCount > 0 ? roundMoney(stats.repeatSpend / stats.repeatCount) : 0,
      oneTimeCustomerAverageSpend: stats.oneTimeCount > 0 ? roundMoney(stats.oneTimeSpend / stats.oneTimeCount) : 0,
      customerCount: stats.customerCount,
      currency: shopBaseCurrency(context).currency,
      window: "all_stored_history",
    },
    confidence: sampleConfidence(0.85, stats.customerCount, 10, 100),
    confidenceReason: "Mean lifetime spend across known hashed customer identities (shop base currency).",
    summary: `Average lifetime spend across ${stats.customerCount} known customers.`,
    sampleSize: stats.customerCount,
    supportingValues: { customerCount: stats.customerCount },
  });
}

// Revenue concentration: share of total customer spend from the top customers.
// A high value = revenue depends on a handful of buyers (concentration risk).
function topCustomerRevenueShare(context, definition) {
  const stats = customerSpendStats(context);
  if (stats.customerCount < MIN_CUSTOMERS_FOR_SPEND_BELIEFS) return skipped(definition, "insufficient_data", "At least 10 known customers are required for customer concentration.", { customerIdentities: stats.customerCount });
  if (stats.totalSpend <= 0) return skipped(definition, "insufficient_data", "Recorded customer spend is required for customer concentration.", { totalSpend: roundMoney(stats.totalSpend) });
  const topCustomerCount = Math.min(TOP_CUSTOMER_SAMPLE, stats.customerCount);
  const topSpend = sum(stats.spendsDesc.slice(0, topCustomerCount));
  return shareOutcome(context, definition, roundMoney(topSpend), roundMoney(stats.totalSpend), `Lifetime spend from the top ${topCustomerCount} customers divided by total known customer spend (shop base currency).`, { confidence: sampleConfidence(0.85, stats.customerCount, 10, 100), supportingValues: { topCustomerCount, currency: shopBaseCurrency(context).currency, window: "all_stored_history" } });
}

function refundedOrderRate(context, definition) {
  if (context.commerceOrders.length < 20) return skipped(definition, "insufficient_data", "At least 20 stored orders are required for refunded order incidence.", { orders: context.commerceOrders.length });
  const refundedOrderCount = new Set(context.refunds.map((refund) => refund.orderId)).size;
  return shareOutcome(context, definition, refundedOrderCount, context.commerceOrders.length, "Stored orders with at least one refund record divided by stored commerce orders.", { confidence: 0.85, supportingValues: { window: "all_stored_history" } });
}

function totalRefundedAmount(context, definition) {
  if (context.refunds.length < 1) return skipped(definition, "insufficient_data", "Refund transaction amounts are not stored.", context.sourceCounts);
  const coverage = context.successfulRefundCoverage;
  if (coverage.refundsWithSuccessfulTransactionAmount < context.refunds.length) {
    return skipped(definition, "insufficient_data", "Successful refund transaction amounts are not available for every refund record.", { refunds: context.refunds.length, refundsWithSuccessfulTransactionAmount: coverage.refundsWithSuccessfulTransactionAmount });
  }
  const currency = singleCurrency(coverage.successfulTransactions.map((transaction) => transaction.currency));
  if (!currency.ok) return skipped(definition, "blocked_by_data_quality", "Multiple refund transaction currencies are present without conversion support.", { currencies: currency.currencies.length });
  return derived(context, definition, {
    value: { amount: roundMoney(sum(coverage.successfulTransactions.map((transaction) => transaction.amount))), currency: currency.currency, refundCount: context.refunds.length, window: "all_stored_history" },
    confidence: 0.9,
    confidenceReason: "Calculated only from successful refund transaction amounts with complete refund coverage.",
    summary: "Total refunded amount calculated from successful refund transactions in shop currency.",
    sampleSize: coverage.successfulTransactions.length,
    coverageMetrics: { refundTransactionAmountCoverage: 1 },
    currencyHandling: "single_shop_currency_required",
  });
}

function positiveAvailableUnits(context, definition) {
  const values = knownTrackedAvailability(context);
  if (values.length < 1) return skipped(definition, "insufficient_data", "At least one active tracked variant with known inventory is required.", context.sourceCounts);
  return countOutcome(context, definition, sum(values.map((available) => Math.max(available, 0))), "Positive available units summed by active tracked variant; negative units are reported separately.", { confidence: 0.95, sampleSize: values.length });
}

function inventoryVariantCount(context, definition, predicate, summary) {
  const values = knownTrackedAvailability(context);
  if (values.length < 1) return skipped(definition, "insufficient_data", "At least one active tracked variant with known inventory is required.", context.sourceCounts);
  return countOutcome(context, definition, values.filter(predicate).length, summary, { confidence: 0.9, sampleSize: values.length });
}

function inventoryVariantShare(context, definition, predicate, summary) {
  const values = knownTrackedAvailability(context);
  return shareOutcome(context, definition, values.filter(predicate).length, values.length, summary, { confidence: 0.9 });
}

function negativeInventoryMagnitude(context, definition) {
  const values = knownTrackedAvailability(context);
  if (values.length < 1) return skipped(definition, "insufficient_data", "At least one active tracked variant with known inventory is required.", context.sourceCounts);
  return countOutcome(context, definition, sum(values.map((available) => Math.abs(Math.min(available, 0)))), "Absolute magnitude of negative active tracked variant inventory; not netted against positive stock.", { confidence: 0.95, sampleSize: values.length });
}

function inventoryAvailabilityAggregate(context, definition, method, minimum) {
  const values = knownTrackedAvailability(context).map((available) => Math.max(available, 0));
  if (values.length < minimum) return skipped(definition, "insufficient_data", `At least ${minimum} active tracked variants with known inventory are required.`, { knownTrackedVariants: values.length });
  return derived(context, definition, {
    value: { number: roundNumber(percentile(values, percentileFor(method)), 2), knownTrackedVariantCount: values.length },
    confidence: 0.9,
    confidenceReason: "Calculated from non-negative summed available units per active tracked variant.",
    summary: "Current inventory availability distribution calculated from linked inventory levels.",
    sampleSize: values.length,
  });
}

function retailValueOfAvailableStock(context, definition) {
  const rows = stockRetailValues(context);
  if (rows.length < 1) return skipped(definition, "insufficient_data", "At least one priced active tracked variant with positive known inventory is required.", context.sourceCounts);
  const currency = singleCurrency(rows.map((row) => row.currency));
  if (!currency.ok) return skipped(definition, "blocked_by_data_quality", "Multiple variant currencies are present without conversion support.", { currencies: currency.currencies.length });
  return derived(context, definition, {
    value: { amount: roundMoney(sum(rows.map((row) => row.value))), currency: currency.currency, pricedStockedVariantCount: rows.length },
    confidence: 0.85,
    confidenceReason: "Current retail value calculated from positive available stock multiplied by current variant list price in one currency.",
    summary: "Retail value of available stock calculated from current inventory and variant prices.",
    sampleSize: rows.length,
    currencyHandling: "single_variant_currency_required",
  });
}

function topVariantRetailValueShare(context, definition) {
  const rows = stockRetailValues(context);
  if (rows.length < 5) return skipped(definition, "insufficient_data", "At least five priced stocked variants are required.", { pricedStockedVariants: rows.length });
  const currency = singleCurrency(rows.map((row) => row.currency));
  if (!currency.ok) return skipped(definition, "blocked_by_data_quality", "Multiple variant currencies are present without conversion support.", { currencies: currency.currencies.length });
  const values = rows.map((row) => row.value).sort((a, b) => b - a);
  return shareOutcome(context, definition, sum(values.slice(0, 5)), sum(values), "Top five stocked variant retail values divided by total available stock retail value.", { confidence: 0.85 });
}

function staleInventoryLevelShare(context, definition) {
  const levels = context.inventoryLevels.filter((level) => level.sourceUpdatedAt || level.observedAt);
  return shareOutcome(context, definition, levels.filter((level) => hoursBetween(level.sourceUpdatedAt ?? level.observedAt, context.now) > STALE_INVENTORY_HOURS).length, levels.length, "Inventory levels older than the freshness threshold divided by inventory levels with timestamps.", { confidence: 0.85, supportingValues: { staleThresholdHours: STALE_INVENTORY_HOURS } });
}

function unitsPerActiveProduct(context, definition) {
  if (context.activeProducts.length < 1) return skipped(definition, "insufficient_data", "At least one active product is required.", { activeProducts: 0 });
  const positiveUnits = sum(knownTrackedAvailability(context).map((available) => Math.max(available, 0)));
  return derived(context, definition, {
    value: { number: roundNumber(positiveUnits / context.activeProducts.length, 2), positiveAvailableUnits: positiveUnits, activeProductCount: context.activeProducts.length },
    confidence: 0.85,
    confidenceReason: "Positive available units divided by active product count.",
    summary: "Available units per active product calculated from current inventory and catalogue records.",
    sampleSize: context.activeProducts.length,
  });
}

function currencyConsistency(context, definition) {
  const distribution = currencyDistribution([
    ...context.pricedOrders.map((order) => order.currency),
    ...context.pricedActiveVariants.map((variant) => variant.currency),
    ...context.successfulRefundCoverage.successfulTransactions.map((transaction) => transaction.currency),
  ]);
  if (distribution.total === 0) return skipped(definition, "insufficient_data", "No priced commerce records are stored.", context.sourceCounts);
  const dominant = distribution.entries[0];
  return derived(context, definition, {
    value: { dominantCurrency: dominant.currency, dominantShare: roundNumber(dominant.count / distribution.total, 4), currencyCount: distribution.entries.length, distribution: distribution.entries },
    confidence: 0.99,
    confidenceReason: "Direct currency distribution across stored priced commerce records.",
    summary: "Currency consistency guardrail calculated from priced records.",
    sampleSize: distribution.total,
  });
}

function customerIdentityOrderCoverage(context, definition) {
  if (context.commerceOrders.length < 1) return skipped(definition, "insufficient_data", "At least one stored order is required.", context.sourceCounts);
  const orderIds = new Set(context.orders.map((order) => order.externalId));
  const linkedExternalIds = new Set();
  for (const identity of context.customerIdentities) {
    const raw = jsonObject(identity.rawPayload);
    if (Array.isArray(raw.orderIds)) {
      for (const id of raw.orderIds) if (orderIds.has(id)) linkedExternalIds.add(id);
    }
  }
  const fallbackLinked = Math.min(sum(context.customerIdentities.map((identity) => identity.orderCount)), context.commerceOrders.length);
  const linkedCount = linkedExternalIds.size > 0 ? linkedExternalIds.size : fallbackLinked;
  return shareOutcome(context, definition, linkedCount, context.commerceOrders.length, "Stored orders linked to hashed customer identity evidence divided by stored commerce orders.", { confidence: 0.99, supportingValues: { linkageMethod: linkedExternalIds.size > 0 ? "identity_raw_payload_order_ids" : "capped_identity_order_count_fallback" } });
}

function duplicateSkuCount(context, definition) {
  const counts = new Map();
  for (const variant of context.activeVariants) {
    const sku = stringValue(variant.sku)?.trim();
    if (!sku) continue;
    counts.set(sku, (counts.get(sku) ?? 0) + 1);
  }
  const duplicateSkuCount = Array.from(counts.values()).filter((count) => count > 1).length;
  return countOutcome(context, definition, duplicateSkuCount, "Distinct nonblank SKUs assigned to more than one active variant.", { confidence: 0.99, sampleSize: counts.size });
}

function inventoryFreshnessP90(context, definition) {
  const ages = context.inventoryLevels
    .map((level) => level.sourceUpdatedAt ?? level.observedAt)
    .filter(Boolean)
    .map((timestamp) => hoursBetween(timestamp, context.now));
  if (ages.length < 5) return skipped(definition, "insufficient_data", "At least five inventory levels with timestamps are required.", { inventoryLevelsWithTimestamps: ages.length });
  return derived(context, definition, {
    value: { number: roundNumber(percentile(ages, 0.9), 2) },
    confidence: 0.95,
    confidenceReason: "Direct p90 age of stored inventory timestamps.",
    summary: "Inventory freshness p90 calculated from inventory level timestamps.",
    sampleSize: ages.length,
  });
}

function inventoryVariantCoverage(context, definition) {
  const tracked = context.activeVariants.filter((variant) => variant.inventoryItemExternalId);
  const withLevels = tracked.filter((variant) => context.availableByVariant.has(variant.id));
  return shareOutcome(context, definition, withLevels.length, tracked.length, "Active inventory-tracked variants with at least one linked inventory level divided by active tracked variants.", { confidence: 0.99 });
}

function inventoryCoverage(context, definition) {
  if (definition.category !== "inventory") return null;
  const tracked = context.activeVariants.filter((variant) => variant.inventoryItemExternalId);
  if (tracked.length < 1) return null;
  const withLevels = tracked.filter((variant) => context.availableByVariant.has(variant.id));
  return roundNumber(withLevels.length / tracked.length, 4);
}

function inventoryFreshnessAgeHours(context, definition) {
  if (definition.category !== "inventory") return null;
  const ages = context.inventoryLevels
    .map((level) => level.sourceUpdatedAt ?? level.observedAt)
    .filter(Boolean)
    .map((timestamp) => hoursBetween(timestamp, context.now));
  if (ages.length < 1) return null;
  return roundNumber(percentile(ages, 0.9), 2);
}

function missingSkuVariantShare(context, definition) {
  return shareOutcome(context, definition, context.activeVariants.filter((variant) => !stringValue(variant.sku)?.trim()).length, context.activeVariants.length, "Active variants with blank or missing SKU divided by active variants.", { confidence: 0.99 });
}

function orderHistoryCompleteness(context, definition) {
  const scopes = new Set((context.shop?.connectorAccounts ?? []).flatMap((account) => account.scopes ?? []));
  const ordersStatus = (context.shop?.backfillStatuses ?? []).find((status) => status.domain === "orders");
  const hasAllOrdersScope = scopes.has("read_all_orders") || context.shop?.historicalOrderAccess === "all_orders";
  const backfillComplete = ordersStatus?.status === "complete" || Boolean(context.shop?.backfillCompletedAt);
  const reconciliationPassed = false;
  const completeLifetimeHistory = hasAllOrdersScope && backfillComplete && reconciliationPassed;
  return derived(context, definition, {
    value: { historyKind: completeLifetimeHistory ? "complete_lifetime_history" : "all_stored_history", completeLifetimeHistory, hasAllOrdersScope, backfillComplete, reconciliationSupported: false, earliestStoredOrderAt: firstIso(sortedOrderTimes(context.datedOrders)), latestStoredOrderAt: lastIso(sortedOrderTimes(context.datedOrders)), storedOrderCount: context.commerceOrders.length },
    confidence: completeLifetimeHistory ? 0.99 : 0.8,
    confidenceReason: completeLifetimeHistory ? "All-order access, completed backfill and reconciliation are all present." : "Stored history is explicit, but complete lifetime history is not established by scope, backfill and reconciliation.",
    summary: "Order history completeness guardrail derived from shop access, backfill state and stored orders.",
    sampleSize: context.commerceOrders.length,
  });
}

function orderHistorySpanDays(context, definition) {
  const distinct = Array.from(new Set(context.datedOrders.map((order) => dayKey(order.orderTime, context.shopTimezone)))).sort();
  if (distinct.length < 2) return skipped(definition, "insufficient_data", "At least two distinct stored order dates are required.", { distinctOrderDates: distinct.length });
  const first = new Date(`${distinct[0]}T00:00:00Z`);
  const last = new Date(`${distinct[distinct.length - 1]}T00:00:00Z`);
  return countOutcome(context, definition, inclusiveDaySpan(first, last, "UTC"), "Calendar-day span between earliest and latest stored order dates.", { confidence: 0.99, sampleSize: context.datedOrders.length });
}

function orphanLineItemCount(context, definition) {
  const orderIds = new Set(context.orders.map((order) => order.id));
  return countOutcome(context, definition, context.lineItems.filter((item) => !orderIds.has(item.orderId)).length, "Line items whose order id is absent from stored orders.", { confidence: 0.99, sampleSize: context.lineItems.length });
}

function refundLineItemCoverage(context, definition) {
  if (context.refunds.length < 1) return skipped(definition, "insufficient_data", "At least one refund record is required.", context.sourceCounts);
  const withLineItems = context.refunds.filter((refund) => refundHasLineItems(refund)).length;
  return shareOutcome(context, definition, withLineItems, context.refunds.length, "Refund records with refund-line-item payloads divided by refund records.", { confidence: 0.99 });
}

function refundTransactionAmountCoverage(context, definition) {
  if (context.refunds.length < 1) return skipped(definition, "insufficient_data", "At least one refund record is required.", context.sourceCounts);
  return shareOutcome(context, definition, context.successfulRefundCoverage.refundsWithSuccessfulTransactionAmount, context.refunds.length, "Refund records with at least one successful refund transaction amount divided by refund records.", { confidence: 0.99 });
}

function orderCountWindow(context, definition, days) {
  const orders = ordersInWindow(context, days);
  return countOutcome(context, definition, orders.length, `Stored commerce orders in the trailing ${days} days.`, { confidence: 0.95, sampleSize: orders.length, supportingValues: { window: `trailing_${days}d` } });
}

function grossOrderValueWindow(context, definition, days) {
  const orders = pricedOrdersInWindow(context, days);
  if (orders.length < 1) return skipped(definition, "insufficient_data", "At least one priced order is required.", { pricedOrders: 0 });
  const currency = shopBaseCurrency(context);
  if (!currency.ok) return skipped(definition, "blocked_by_data_quality", "Multiple currencies are present without conversion support.", { currencies: currency.currencies.length });
  return derived(context, definition, {
    value: { amount: roundMoney(sum(orders.map(orderValue))), currency: currency.currency, orderCount: orders.length, window: `trailing_${days}d`, orderValuePolicy: orderValuePolicy() },
    confidence: sampleConfidence(0.9, orders.length, 1, 100),
    confidenceReason: "Sum of canonical stored order values for priced orders in one currency.",
    summary: `Gross stored order value over the trailing ${days} days.`,
    sampleSize: orders.length,
    currencyHandling: "single_shop_currency_required",
  });
}

function orderValueAggregate(context, definition, orders, method, minimum) {
  if (orders.length < minimum) return skipped(definition, "insufficient_data", `At least ${minimum} priced order(s) are required.`, { pricedOrders: orders.length });
  const currency = shopBaseCurrency(context);
  if (!currency.ok) return skipped(definition, "blocked_by_data_quality", "Multiple currencies are present without conversion support.", { currencies: currency.currencies.length });
  const values = orders.map(orderValue);
  const amount = method === "mean" ? average(values) : percentile(values, percentileFor(method));
  return derived(context, definition, {
    value: { amount: roundMoney(amount), currency: currency.currency, orderCount: orders.length, window: definition.window, orderValuePolicy: orderValuePolicy() },
    confidence: sampleConfidence(0.9, orders.length, minimum, 100),
    confidenceReason: "Calculated from canonical stored order values in one currency using the documented order-value policy.",
    summary: "Order value aggregate calculated from stored Shopify order totals.",
    sampleSize: orders.length,
    currencyHandling: "single_shop_currency_required",
  });
}

function averageItemsPerOrder(context, definition, orders, minimum) {
  if (orders.length < minimum) return skipped(definition, "insufficient_data", `At least ${minimum} stored order(s) are required.`, { orders: orders.length });
  const withLineItems = orders.filter((order) => context.lineItemOrderIds.has(order.id));
  if (withLineItems.length < minimum) return skipped(definition, "insufficient_data", `At least ${minimum} stored order(s) with line items are required.`, { ordersWithLineItems: withLineItems.length });
  return derived(context, definition, {
    value: { number: roundNumber(average(withLineItems.map((order) => context.quantitiesByOrder.get(order.id) ?? 0)), 2), orderCount: withLineItems.length, window: definition.window },
    confidence: coverageConfidence(0.85, withLineItems.length / orders.length),
    confidenceReason: "Line-item quantities divided by stored orders with line-item coverage.",
    summary: "Average items per order calculated from stored line-item quantities.",
    sampleSize: withLineItems.length,
    coverageMetrics: { lineItemOrderCoverage: roundNumber(withLineItems.length / orders.length, 4) },
  });
}

function medianItemsPerOrder(context, definition, orders) {
  const withLineItems = orders.filter((order) => context.lineItemOrderIds.has(order.id));
  if (withLineItems.length < 10) return skipped(definition, "insufficient_data", "At least 10 orders with line items are required.", { ordersWithLineItems: withLineItems.length });
  return derived(context, definition, {
    value: { number: roundNumber(percentile(withLineItems.map((order) => context.quantitiesByOrder.get(order.id) ?? 0), 0.5), 2), orderCount: withLineItems.length, window: definition.window },
    confidence: 0.9,
    confidenceReason: "Median total item quantity among stored orders with line items.",
    summary: "Median items per order calculated from stored line-item quantities.",
    sampleSize: withLineItems.length,
  });
}

function itemQuantityShare(context, definition, orders, predicate, minimum, summary) {
  const withLineItems = orders.filter((order) => context.lineItemOrderIds.has(order.id));
  if (withLineItems.length < minimum) return skipped(definition, "insufficient_data", `At least ${minimum} orders with line items are required.`, { ordersWithLineItems: withLineItems.length });
  return shareOutcome(context, definition, withLineItems.filter((order) => predicate(context.quantitiesByOrder.get(order.id) ?? 0)).length, withLineItems.length, summary, { confidence: sampleConfidence(0.9, withLineItems.length, minimum, 100) });
}

function averageLinkedEntitiesPerOrder(context, definition, orders, countMap, minimum, summary) {
  if (orders.length < minimum) return skipped(definition, "insufficient_data", `At least ${minimum} orders are required.`, { orders: orders.length });
  return derived(context, definition, {
    value: { number: roundNumber(average(orders.map((order) => countMap.get(order.id) ?? 0)), 2), orderCount: orders.length, window: definition.window },
    confidence: 0.9,
    confidenceReason: "Mean distinct linked entity count per stored order.",
    summary,
    sampleSize: orders.length,
  });
}

function firstOrderAt(context, definition) {
  const dates = sortedOrderTimes(context.datedOrders);
  if (dates.length < 1) return skipped(definition, "insufficient_data", "At least one dated stored order is required.", context.sourceCounts);
  return derived(context, definition, {
    value: { timestamp: dates[0].toISOString(), historyKind: "all_stored_history" },
    confidence: 0.9,
    confidenceReason: "Earliest stored order timestamp; not labelled complete lifetime history.",
    summary: "First stored order timestamp derived from stored order records.",
    observedAt: dates[0],
    sampleSize: dates.length,
  });
}

function latestOrderAt(context, definition) {
  const dates = sortedOrderTimes(context.datedOrders);
  if (dates.length < 1) return skipped(definition, "insufficient_data", "At least one dated stored order is required.", context.sourceCounts);
  return derived(context, definition, {
    value: { timestamp: dates[dates.length - 1].toISOString() },
    confidence: 0.95,
    confidenceReason: "Latest stored order timestamp.",
    summary: "Latest stored order timestamp derived from stored order records.",
    observedAt: dates[dates.length - 1],
    sampleSize: dates.length,
  });
}

function longestGapBetweenOrders(context, definition, days) {
  const times = sortedOrderTimes(ordersInWindow(context, days));
  if (times.length < 5) return skipped(definition, "insufficient_data", "At least five dated orders are required.", { orders: times.length });
  let maxGap = 0;
  for (let index = 1; index < times.length; index += 1) {
    maxGap = Math.max(maxGap, Math.floor((times[index].getTime() - times[index - 1].getTime()) / 86400000));
  }
  return countOutcome(context, definition, maxGap, `Longest day gap between consecutive stored orders in the trailing ${days} days.`, { confidence: 0.9, sampleSize: times.length });
}

// Year-over-year revenue — revenue in the trailing window vs the same window one
// calendar year earlier. Unlocked by the extended history window; the honest
// growth signal (is the business bigger than a year ago?).
function ordersRevenueInRange(context, startDaysAgo, endDaysAgo) {
  const startMs = context.now.getTime() - endDaysAgo * 86400000;
  const endMs = context.now.getTime() - startDaysAgo * 86400000;
  const orders = context.datedOrders.filter(
    (order) =>
      order.totalPrice !== null &&
      order.orderTime.getTime() >= startMs &&
      order.orderTime.getTime() < endMs,
  );
  return { orders, revenue: sum(orders.map((order) => orderValue(order))) };
}

function yoyRevenueGrowth(context, definition, days) {
  const current = ordersRevenueInRange(context, 0, days);
  const priorYear = ordersRevenueInRange(context, 365, 365 + days);
  if (current.orders.length < 5 || priorYear.orders.length < 5) {
    return skipped(definition, "insufficient_data", "At least 5 priced orders in both the current window and the same window one year ago are required.", { currentOrders: current.orders.length, priorYearOrders: priorYear.orders.length });
  }
  if (priorYear.revenue <= 0) {
    return skipped(definition, "insufficient_data", "No prior-year revenue in the comparison window.", { priorYearRevenue: priorYear.revenue });
  }
  const change = (current.revenue - priorYear.revenue) / priorYear.revenue;
  return derived(context, definition, {
    value: {
      percentage: roundNumber(change * 100, 2),
      currentRevenue: roundMoney(current.revenue),
      priorYearRevenue: roundMoney(priorYear.revenue),
      currency: shopBaseCurrency(context).currency,
      window: `trailing_${days}d_vs_prior_year`,
    },
    confidence: 0.85,
    confidenceReason: "Revenue in the trailing window vs the same window one calendar year earlier.",
    summary: `Year-over-year revenue change: trailing ${days} days vs the same period a year ago.`,
    sampleSize: current.orders.length + priorYear.orders.length,
  });
}

// Recent revenue trend — revenue in the recent window vs the immediately prior
// window of the same length (sequential, not year-over-year): is the store
// growing, flat, or declining right now?
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function monthOfYear(date, timeZone) {
  return Number(
    new Intl.DateTimeFormat("en-CA", { timeZone, month: "2-digit" }).format(date),
  );
}

// Which calendar month is the sales peak, aggregating revenue by month-of-year
// across all stored history (shop timezone, shop base currency). Needs roughly a
// full year of history before it will claim a season.
function peakSalesMonth(context, definition) {
  const orders = context.datedOrders.filter((order) => order.totalPrice !== null);
  if (orders.length < 20) return skipped(definition, "insufficient_data", "At least 20 priced, dated orders are required for seasonality.", { orders: orders.length });
  const times = orders.map((order) => order.orderTime.getTime());
  const spanDays = (Math.max(...times) - Math.min(...times)) / 86400000;
  if (spanDays < 300) return skipped(definition, "insufficient_data", "About 12 months of order history are required to judge seasonality.", { spanDays: Math.round(spanDays) });
  const revenueByMonth = new Map();
  let total = 0;
  for (const order of orders) {
    const month = monthOfYear(order.orderTime, context.shopTimezone);
    const revenue = orderValue(order);
    total += revenue;
    revenueByMonth.set(month, (revenueByMonth.get(month) ?? 0) + revenue);
  }
  if (total <= 0) return skipped(definition, "insufficient_data", "Positive revenue is required for seasonality.", { total: roundMoney(total) });
  let peakMonth = 1;
  let peakRevenue = -1;
  for (const [month, revenue] of revenueByMonth) {
    if (revenue > peakRevenue) {
      peakRevenue = revenue;
      peakMonth = month;
    }
  }
  const monthlyBreakdown = [];
  for (let month = 1; month <= 12; month += 1) {
    const revenue = revenueByMonth.get(month) ?? 0;
    monthlyBreakdown.push({
      month: MONTH_NAMES[month - 1],
      monthNumber: month,
      revenue: roundMoney(revenue),
      sharePercent: roundNumber((revenue / total) * 100, 2),
    });
  }
  const monthsOfHistory = Math.round(spanDays / 30);
  return derived(context, definition, {
    value: {
      peakMonth: MONTH_NAMES[peakMonth - 1],
      peakMonthNumber: peakMonth,
      peakMonthRevenue: roundMoney(peakRevenue),
      peakMonthSharePercent: roundNumber((peakRevenue / total) * 100, 2),
      monthlyBreakdown,
      monthsOfHistory,
      currency: shopBaseCurrency(context).currency,
      window: "all_stored_history",
    },
    confidence: sampleConfidence(0.8, monthsOfHistory, 12, 24),
    confidenceReason: "Revenue aggregated by calendar month across stored history (shop timezone, shop base currency).",
    summary: `Peak sales month: ${MONTH_NAMES[peakMonth - 1]} (${roundNumber((peakRevenue / total) * 100, 2)}% of stored revenue).`,
    sampleSize: orders.length,
    supportingValues: { monthsOfHistory },
  });
}

// Observe→Learn: how the merchant engages with Jefe's recommendations, from the
// plan recommendation review outcomes. The first memory signal on the earned-
// autonomy ramp — a merchant who accepts and completes recommendations is one
// Jefe can eventually act for with less friction.
function recommendationEngagement(context, definition) {
  const recs = context.planRecommendations ?? [];
  if (recs.length < 3) return skipped(definition, "insufficient_data", "At least 3 recommendations are required to summarize engagement.", { recommendations: recs.length });
  let accepted = 0;
  let rejected = 0;
  let completed = 0;
  for (const rec of recs) {
    const status = String(rec.reviewStatus ?? "proposed");
    if (rec.completedAt || status === "completed") completed += 1;
    if (rec.acceptedAt || status === "accepted" || status === "completed") accepted += 1;
    if (rec.rejectedAt || status === "rejected") rejected += 1;
  }
  const total = recs.length;
  return derived(context, definition, {
    value: {
      totalRecommendations: total,
      acceptedCount: accepted,
      rejectedCount: rejected,
      completedCount: completed,
      acceptanceRatePercent: roundNumber((accepted / total) * 100, 2),
      completionRatePercent: roundNumber((completed / total) * 100, 2),
      window: "all_stored_history",
    },
    confidence: sampleConfidence(0.9, total, 3, 30),
    confidenceReason: "Direct counts of plan recommendation review outcomes.",
    summary: `${accepted} of ${total} recommendations accepted; ${completed} completed.`,
    sampleSize: total,
    supportingValues: { totalRecommendations: total },
  });
}

function revenueTrend(context, definition, days) {
  const recent = ordersRevenueInRange(context, 0, days);
  const prior = ordersRevenueInRange(context, days, days * 2);
  if (recent.orders.length < 5 || prior.orders.length < 5) {
    return skipped(definition, "insufficient_data", `At least 5 priced orders in each of the recent and prior ${days}-day windows are required.`, { recentOrders: recent.orders.length, priorOrders: prior.orders.length });
  }
  if (prior.revenue <= 0) {
    return skipped(definition, "insufficient_data", "No prior-window revenue to compare against.", { priorRevenue: prior.revenue });
  }
  const change = (recent.revenue - prior.revenue) / prior.revenue;
  const trend = change >= 0.1 ? "growing" : change <= -0.1 ? "declining" : "flat";
  return derived(context, definition, {
    value: {
      trend,
      changePercent: roundNumber(change * 100, 2),
      recentRevenue: roundMoney(recent.revenue),
      priorRevenue: roundMoney(prior.revenue),
      currency: shopBaseCurrency(context).currency,
      window: `trailing_${days}d_vs_prior_${days}d`,
    },
    confidence: 0.85,
    confidenceReason: `Revenue in the recent ${days} days versus the immediately prior ${days} days.`,
    summary: `Recent revenue trend: last ${days} days versus the prior ${days} days.`,
    sampleSize: recent.orders.length + prior.orders.length,
  });
}

// Product momentum — products rising or declining by revenue, current 30 days vs
// the prior 30 days. Only judges products with prior-period revenue (a brand-new
// product isn't "momentum"), so it reads as growth/decline, not new arrivals.
function productRevenueInRange(context, startDaysAgo, endDaysAgo) {
  const startMs = context.now.getTime() - endDaysAgo * 86400000;
  const endMs = context.now.getTime() - startDaysAgo * 86400000;
  const orders = context.datedOrders.filter(
    (order) =>
      order.totalPrice !== null &&
      order.orderTime.getTime() >= startMs &&
      order.orderTime.getTime() < endMs,
  );
  const orderIds = new Set(orders.map((order) => order.id));
  const revenueByProduct = sumBy(
    context.lineItems.filter((item) => item.productId && orderIds.has(item.orderId)),
    (item) => item.productId,
    (item) => decimalNumber(item.totalPrice),
  );
  return { orders, revenueByProduct };
}

function productMomentum(context, definition) {
  const current = productRevenueInRange(context, 0, 30);
  const prior = productRevenueInRange(context, 30, 60);
  if (current.orders.length < 5 || prior.orders.length < 5) {
    return skipped(definition, "insufficient_data", "At least 5 priced orders in each of the current and prior 30-day windows are required.", { currentOrders: current.orders.length, priorOrders: prior.orders.length });
  }
  let risingProductCount = 0;
  let decliningProductCount = 0;
  let topRiser = null;
  let topRiserChange = 0;
  let topFaller = null;
  let topFallerChange = 0;
  for (const [productId, priorRevenue] of prior.revenueByProduct) {
    if (priorRevenue <= 0) continue;
    const currentRevenue = current.revenueByProduct.get(productId) ?? 0;
    const change = (currentRevenue - priorRevenue) / priorRevenue;
    const entry = {
      productId,
      title: productTitle(context, productId),
      changePercent: roundNumber(change * 100, 2),
      currentRevenue: roundMoney(currentRevenue),
      priorRevenue: roundMoney(priorRevenue),
    };
    if (change >= 0.2) {
      risingProductCount += 1;
      if (!topRiser || change > topRiserChange) {
        topRiser = entry;
        topRiserChange = change;
      }
    } else if (change <= -0.2) {
      decliningProductCount += 1;
      if (!topFaller || change < topFallerChange) {
        topFaller = entry;
        topFallerChange = change;
      }
    }
  }
  return derived(context, definition, {
    value: {
      risingProductCount,
      decliningProductCount,
      topRiser,
      topFaller,
      currency: shopBaseCurrency(context).currency,
      window: "current_30d_vs_prior_30d",
    },
    confidence: 0.8,
    confidenceReason: "Products with at least a 20% revenue change, current 30 days vs prior 30 days.",
    summary: "Products rising or declining in the last 30 days versus the prior 30 days.",
    sampleSize: current.orders.length + prior.orders.length,
  });
}

// Returns by product — units and refund value returned per product, from refund
// line items in each order's Refund.rawPayload (backfilled GraphQL shape), mapped
// to products via the order line item's external id. Real-time webhook refunds
// (REST shape) and a normalized refund-line-item table are follow-ups.
function returnsByProductInWindow(context, days) {
  const productByLineItemExternalId = new Map();
  for (const item of context.lineItems) {
    if (item.externalId && item.productId) {
      productByLineItemExternalId.set(item.externalId, item.productId);
    }
  }
  const windowStartMs = context.now.getTime() - days * 86400000;
  const returnedUnitsByProduct = new Map();
  const refundValueByProduct = new Map();
  let refundsWithLineItems = 0;
  for (const refund of context.refunds) {
    const processedAt = refund.processedAt;
    if (processedAt instanceof Date && processedAt.getTime() < windowStartMs) continue;
    let mappedAny = false;
    for (const line of refundLineNodes(jsonObject(refund.rawPayload))) {
      const productId = line.lineItemExternalId
        ? productByLineItemExternalId.get(line.lineItemExternalId)
        : null;
      if (!productId) continue;
      mappedAny = true;
      returnedUnitsByProduct.set(productId, (returnedUnitsByProduct.get(productId) ?? 0) + line.quantity);
      refundValueByProduct.set(productId, (refundValueByProduct.get(productId) ?? 0) + line.value);
    }
    if (mappedAny) refundsWithLineItems += 1;
  }
  return { returnedUnitsByProduct, refundValueByProduct, refundsWithLineItems };
}

// Refund line items arrive in two shapes: the GraphQL backfill shape
// (refundLineItems.edges[].node, line-item id as a gid, subtotalSet.shopMoney)
// and the REST webhook shape (refund_line_items[], numeric line_item_id,
// subtotal_set.shop_money). Normalize both to { lineItemExternalId (gid),
// quantity, value } so a real-time refund counts the same as a backfilled one.
function refundLineNodes(payload) {
  const out = [];
  const edges = payload.refundLineItems?.edges;
  if (Array.isArray(edges)) {
    for (const edge of edges) {
      const node = jsonObject(jsonObject(edge).node);
      const shopMoney = jsonObject(jsonObject(node.subtotalSet).shopMoney);
      out.push({
        lineItemExternalId: normalizeLineItemGid(jsonObject(node.lineItem).id),
        quantity: Number(node.quantity) || 0,
        value: decimalNumber(shopMoney.amount),
      });
    }
    return out;
  }
  const restLines = payload.refund_line_items;
  if (Array.isArray(restLines)) {
    for (const raw of restLines) {
      const line = jsonObject(raw);
      const shopMoney = jsonObject(jsonObject(line.subtotal_set).shop_money);
      const value =
        shopMoney.amount != null
          ? decimalNumber(shopMoney.amount)
          : decimalNumber(line.subtotal);
      out.push({
        lineItemExternalId: normalizeLineItemGid(
          line.line_item_id ?? jsonObject(line.line_item).id,
        ),
        quantity: Number(line.quantity) || 0,
        value,
      });
    }
    return out;
  }
  return out;
}

// Match the ingestion's line-item id normalization: OrderLineItem.externalId is
// always stored as a gid, so a numeric REST id must be lifted to a gid to join.
function normalizeLineItemGid(value) {
  if (value == null || value === "") return null;
  const text = String(value);
  if (text.startsWith("gid://")) return text;
  // REST payloads carry a bare numeric line-item id; lift it to the gid form the
  // ingestion stores so the join succeeds. Any already-formed id is left as-is.
  return /^\d+$/.test(text) ? `gid://shopify/LineItem/${text}` : text;
}

function topReturnedProducts(context, definition, days) {
  const { returnedUnitsByProduct, refundValueByProduct, refundsWithLineItems } =
    returnsByProductInWindow(context, days);
  if (refundsWithLineItems < 1 || returnedUnitsByProduct.size < 1) {
    return skipped(definition, "insufficient_data", "No refund line items mapped to products in the window (a backfill populates them).", { refundsWithLineItems });
  }
  const { unitsByProduct: soldUnitsByProduct } = productSalesInWindow(context, days);
  const items = Array.from(returnedUnitsByProduct.entries())
    .map(([productId, returnedUnits]) => {
      const soldUnits = soldUnitsByProduct.get(productId) ?? 0;
      return {
        productId,
        title: productTitle(context, productId),
        returnedUnits,
        refundValue: roundMoney(refundValueByProduct.get(productId) ?? 0),
        soldUnits,
        returnRatePercent: soldUnits > 0 ? roundNumber((returnedUnits / soldUnits) * 100, 2) : null,
      };
    })
    .sort((a, b) => b.returnedUnits - a.returnedUnits)
    .slice(0, 5);
  return derived(context, definition, {
    value: {
      items,
      // Headline returned product surfaced at the top level so it survives the
      // generator's compactValue serialization (which drops objects nested in an
      // array); items[] stays for the memory view.
      topReturnedProduct: items[0] ?? null,
      returnedProductCount: returnedUnitsByProduct.size,
      currency: shopBaseCurrency(context).currency,
      window: `trailing_${days}d`,
    },
    confidence: 0.85,
    confidenceReason: "Products ranked by returned units from mapped refund line items over the window.",
    summary: `Most-returned products by units in the trailing ${days} days.`,
    sampleSize: refundsWithLineItems,
  });
}

// Sales channel — online-store vs in-store (POS) vs other revenue split, from
// each order's Shopify sourceName. Amounts are shopMoney (base currency). Gated
// on channel coverage (older orders lack sourceName until re-backfilled), so it
// never reports a split on data it doesn't have.
function classifySalesChannel(sourceName) {
  const value = stringValue(sourceName)?.toLowerCase() ?? "";
  if (!value) return null;
  if (value === "pos" || value.includes("point_of_sale") || value.includes("point of sale")) return "pos";
  if (value === "web" || value === "online_store" || value === "shopify_online_store" || value.includes("online store")) return "online";
  if (value.includes("draft")) return "draft";
  return "other";
}

function onlineRevenueShare(context, definition, days) {
  const orders = pricedOrdersInWindow(context, days);
  if (orders.length < 5) {
    return skipped(definition, "insufficient_data", "At least 5 priced orders in the window are required.", { orders: orders.length });
  }
  const currency = shopBaseCurrency(context);
  let totalRevenue = 0;
  let knownRevenue = 0;
  const byChannel = new Map();
  for (const order of orders) {
    const revenue = orderValue(order);
    totalRevenue += revenue;
    const channel = classifySalesChannel(order.sourceName);
    if (channel == null) continue;
    knownRevenue += revenue;
    byChannel.set(channel, (byChannel.get(channel) ?? 0) + revenue);
  }
  const coverage = totalRevenue > 0 ? knownRevenue / totalRevenue : 0;
  if (knownRevenue <= 0 || coverage < 0.7) {
    return skipped(definition, "blocked_by_data_quality", "Sales-channel is set on too little of window revenue (a re-backfill populates it).", { channelCoverage: roundNumber(coverage, 4) });
  }
  const online = byChannel.get("online") ?? 0;
  return derived(context, definition, {
    value: {
      percentage: roundNumber((online / knownRevenue) * 100, 2),
      onlineRevenue: roundMoney(online),
      knownRevenue: roundMoney(knownRevenue),
      channels: Object.fromEntries(
        Array.from(byChannel.entries()).map(([channel, revenue]) => [channel, roundMoney(revenue)]),
      ),
      channelCoverage: roundNumber(coverage, 4),
      currency: currency.currency,
      window: `trailing_${days}d`,
    },
    confidence: 0.9,
    confidenceReason: "Online-store revenue divided by revenue with a known sales channel over the window.",
    summary: `Share of revenue from the online store vs in-store/other channels in the trailing ${days} days.`,
    sampleSize: orders.length,
    coverageMetrics: { channelCoverage: roundNumber(coverage, 4) },
  });
}

// Revenue split by destination country — the geo signal behind "should I split my
// store / open a US presence": which markets actually drive revenue. Coverage-gated
// on the share of window revenue that carries a known destination country (older
// orders lack it until re-backfilled). Shop base currency, so summable across a
// multi-currency store.
function revenueByRegion(context, definition, days) {
  const orders = pricedOrdersInWindow(context, days);
  if (orders.length < 5) {
    return skipped(definition, "insufficient_data", "At least 5 priced orders in the window are required.", { orders: orders.length });
  }
  const currency = shopBaseCurrency(context);
  let totalRevenue = 0;
  let knownRevenue = 0;
  const byCountry = new Map();
  for (const order of orders) {
    const revenue = orderValue(order);
    totalRevenue += revenue;
    const country = stringValue(order.shippingCountry)?.toUpperCase() ?? null;
    if (!country) continue;
    knownRevenue += revenue;
    byCountry.set(country, (byCountry.get(country) ?? 0) + revenue);
  }
  const coverage = totalRevenue > 0 ? knownRevenue / totalRevenue : 0;
  if (knownRevenue <= 0 || coverage < 0.7) {
    return skipped(definition, "blocked_by_data_quality", "Destination country is set on too little of window revenue (a re-backfill populates it).", { countryCoverage: roundNumber(coverage, 4) });
  }
  const items = Array.from(byCountry.entries())
    .map(([country, revenue]) => ({
      country,
      revenue: roundMoney(revenue),
      sharePercent: roundNumber((revenue / knownRevenue) * 100, 2),
    }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 8);
  return derived(context, definition, {
    value: {
      items,
      topCountry: items[0] ?? null,
      countryCount: byCountry.size,
      knownRevenue: roundMoney(knownRevenue),
      countryCoverage: roundNumber(coverage, 4),
      currency: currency.currency,
      window: `trailing_${days}d`,
    },
    confidence: 0.9,
    confidenceReason: "Revenue grouped by destination country over the share of window revenue with a known country.",
    summary: `Revenue split by destination country in the trailing ${days} days.`,
    sampleSize: orders.length,
    coverageMetrics: { countryCoverage: roundNumber(coverage, 4) },
  });
}

// Product margin — gross margin over the cost-covered share of window revenue,
// plus a cost-coverage readiness signal. Cost-per-item is optional in Shopify,
// so margin is gated on coverage and never guessed where cost is absent.
function variantUnitCostMap(context) {
  const map = new Map();
  for (const variant of context.variants) {
    if (variant.unitCost != null) {
      map.set(variant.id, decimalNumber(variant.unitCost));
    }
  }
  return map;
}

function costCoverage(context, definition) {
  const active = context.activeVariants;
  if (active.length < 1) {
    return skipped(definition, "insufficient_data", "At least one active variant is required.", { activeVariants: active.length });
  }
  const withCost = active.filter((variant) => variant.unitCost != null).length;
  return shareOutcome(context, definition, withCost, active.length, "Active variants with a cost-per-item set, divided by active variants.", { confidence: 0.95, supportingValues: { variantsWithCost: withCost, activeVariants: active.length } });
}

function grossMargin(context, definition, days) {
  const orders = pricedOrdersInWindow(context, days);
  if (orders.length < 5) {
    return skipped(definition, "insufficient_data", "At least 5 priced orders in the window are required.", { orders: orders.length });
  }
  const currency = shopBaseCurrency(context);
  if (!currency.ok) {
    return skipped(definition, "blocked_by_data_quality", "No priced orders in a determinable currency.", { currencies: currency.currencies.length });
  }
  const orderIds = new Set(orders.map((order) => order.id));
  const costByVariant = variantUnitCostMap(context);
  let totalRevenue = 0;
  let coveredRevenue = 0;
  let coveredCogs = 0;
  for (const item of context.lineItems) {
    if (!orderIds.has(item.orderId)) continue;
    const revenue = decimalNumber(item.totalPrice);
    totalRevenue += revenue;
    const unitCost = item.variantId != null ? costByVariant.get(item.variantId) : undefined;
    if (unitCost != null) {
      coveredRevenue += revenue;
      coveredCogs += unitCost * (Number(item.quantity) || 0);
    }
  }
  if (totalRevenue <= 0) {
    return skipped(definition, "insufficient_data", "No priced line-item revenue in the window.", { totalRevenue });
  }
  const revenueCoverage = coveredRevenue / totalRevenue;
  if (coveredRevenue <= 0 || revenueCoverage < 0.7) {
    return skipped(definition, "blocked_by_data_quality", "Cost-per-item covers too little of window revenue for a reliable margin.", { revenueCoverage: roundNumber(revenueCoverage, 4), coveredRevenue: roundMoney(coveredRevenue) });
  }
  return derived(context, definition, {
    value: {
      percentage: roundNumber(((coveredRevenue - coveredCogs) / coveredRevenue) * 100, 2),
      coveredRevenue: roundMoney(coveredRevenue),
      coveredCogs: roundMoney(coveredCogs),
      revenueCoverage: roundNumber(revenueCoverage, 4),
      currency: currency.currency,
      window: `trailing_${days}d`,
    },
    confidence: 0.85,
    confidenceReason: "Gross margin over the cost-covered share of window revenue: (covered revenue − covered COGS) / covered revenue.",
    summary: `Gross margin on cost-covered products in the trailing ${days} days.`,
    sampleSize: orders.length,
    coverageMetrics: { revenueCoverage: roundNumber(revenueCoverage, 4) },
  });
}

// Gross margin per destination country — the missing half of the store-split /
// international-expansion decision: revenue_by_region says WHERE the revenue is;
// this says whether it's PROFITABLE there (a market can be big on revenue but thin
// on margin after regional cost mix). Doubly coverage-gated: on known destination
// country (>=70% of window revenue) and, per region, on cost coverage (a region's
// margin is only stated when >=70% of its revenue has a known cost — never guessed).
function marginByRegion(context, definition, days) {
  const orders = pricedOrdersInWindow(context, days);
  if (orders.length < 5) {
    return skipped(definition, "insufficient_data", "At least 5 priced orders in the window are required.", { orders: orders.length });
  }
  const currency = shopBaseCurrency(context);
  if (!currency.ok) {
    return skipped(definition, "blocked_by_data_quality", "No priced orders in a determinable currency.", { currencies: currency.currencies.length });
  }
  const countryByOrder = new Map();
  for (const order of orders) {
    countryByOrder.set(order.id, stringValue(order.shippingCountry)?.toUpperCase() ?? null);
  }
  const costByVariant = variantUnitCostMap(context);
  const byRegion = new Map();
  let totalRevenue = 0;
  let knownCountryRevenue = 0;
  for (const item of context.lineItems) {
    if (!countryByOrder.has(item.orderId)) continue;
    const revenue = decimalNumber(item.totalPrice);
    totalRevenue += revenue;
    const country = countryByOrder.get(item.orderId);
    if (!country) continue;
    knownCountryRevenue += revenue;
    const bucket = byRegion.get(country) ?? { revenue: 0, coveredRevenue: 0, coveredCogs: 0 };
    bucket.revenue += revenue;
    const unitCost = item.variantId != null ? costByVariant.get(item.variantId) : undefined;
    if (unitCost != null) {
      bucket.coveredRevenue += revenue;
      bucket.coveredCogs += unitCost * (Number(item.quantity) || 0);
    }
    byRegion.set(country, bucket);
  }
  const countryCoverage = totalRevenue > 0 ? knownCountryRevenue / totalRevenue : 0;
  if (knownCountryRevenue <= 0 || countryCoverage < 0.7) {
    return skipped(definition, "blocked_by_data_quality", "Destination country is set on too little of window revenue.", { countryCoverage: roundNumber(countryCoverage, 4) });
  }
  const items = Array.from(byRegion.entries())
    .map(([country, bucket]) => {
      const costCov = bucket.revenue > 0 ? bucket.coveredRevenue / bucket.revenue : 0;
      const stated = costCov >= 0.7 && bucket.coveredRevenue > 0;
      return {
        country,
        revenue: roundMoney(bucket.revenue),
        marginPercent: stated ? roundNumber(((bucket.coveredRevenue - bucket.coveredCogs) / bucket.coveredRevenue) * 100, 2) : null,
        costCoverage: roundNumber(costCov, 4),
      };
    })
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 8);
  if (!items.some((item) => item.marginPercent !== null)) {
    return skipped(definition, "blocked_by_data_quality", "Cost-per-item covers too little of any region's revenue for a reliable per-region margin.", { countryCoverage: roundNumber(countryCoverage, 4) });
  }
  return derived(context, definition, {
    value: {
      items,
      topRegion: items[0] ?? null,
      regionCount: byRegion.size,
      countryCoverage: roundNumber(countryCoverage, 4),
      currency: currency.currency,
      window: `trailing_${days}d`,
    },
    confidence: 0.85,
    confidenceReason: "Per-destination-country gross margin over the cost-covered share of each region's revenue; coverage-gated on known country and known cost.",
    summary: `Gross margin by destination country in the trailing ${days} days.`,
    sampleSize: orders.length,
    coverageMetrics: { countryCoverage: roundNumber(countryCoverage, 4) },
  });
}

// Product performance — trailing-window sales derived from line items joined to
// priced orders. Bounded aggregates (concentration, bestsellers, dead stock),
// never one belief per SKU, so belief counts and generator inputs stay bounded.
// Revenue grouped by a catalogue attribute (product type, vendor) over a window.
// Products with no value for the attribute are pooled as "unattributed" revenue
// rather than dropped, so the shares stay honest about coverage.
function revenueByAttribute(context, revenueByProduct, attributeOf) {
  const productById = new Map(
    context.products.map((product) => [product.id, product]),
  );
  const revenueByGroup = new Map();
  let total = 0;
  let unattributed = 0;
  for (const [productId, revenue] of revenueByProduct) {
    total += revenue;
    const group = attributeOf(productById.get(productId));
    if (!group) {
      unattributed += revenue;
      continue;
    }
    revenueByGroup.set(group, (revenueByGroup.get(group) ?? 0) + revenue);
  }
  const items = [...revenueByGroup.entries()]
    .map(([name, revenue]) => ({
      name,
      revenue: roundMoney(revenue),
      sharePercent: total > 0 ? roundNumber((revenue / total) * 100, 2) : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 8);
  return { items, total, unattributed, groupCount: revenueByGroup.size };
}

function cleanAttribute(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : null;
}

// Which product TYPES drive revenue — the "analyse by category" view merchants
// merchandise by.
function revenueByProductType(context, definition, days) {
  const sales = productSalesInWindow(context, days);
  if (sales.orders.length < 5) return skipped(definition, "insufficient_data", "At least 5 priced orders in the window are required for revenue by product type.", { orders: sales.orders.length });
  const agg = revenueByAttribute(context, sales.revenueByProduct, (product) => cleanAttribute(product?.productType));
  if (agg.items.length < 1) return skipped(definition, "insufficient_data", "No sold products have a product type set.", { typeCount: agg.groupCount });
  return derived(context, definition, {
    value: {
      items: agg.items,
      topType: agg.items[0] ?? null,
      typeCount: agg.groupCount,
      unattributedRevenue: roundMoney(agg.unattributed),
      currency: shopBaseCurrency(context).currency,
      window: `trailing_${days}d`,
    },
    confidence: sampleConfidence(0.85, sales.orders.length, 5, 100),
    confidenceReason: "Revenue grouped by product type over the trailing window (shop base currency).",
    summary: `Top product type by revenue: ${agg.items[0]?.name ?? "unknown"} (${agg.groupCount} types with sales).`,
    sampleSize: sales.orders.length,
    supportingValues: { typeCount: agg.groupCount },
  });
}

// Which VENDORS / brands drive revenue.
function revenueByVendor(context, definition, days) {
  const sales = productSalesInWindow(context, days);
  if (sales.orders.length < 5) return skipped(definition, "insufficient_data", "At least 5 priced orders in the window are required for revenue by vendor.", { orders: sales.orders.length });
  const agg = revenueByAttribute(context, sales.revenueByProduct, (product) => cleanAttribute(product?.vendor));
  if (agg.items.length < 1) return skipped(definition, "insufficient_data", "No sold products have a vendor set.", { vendorCount: agg.groupCount });
  return derived(context, definition, {
    value: {
      items: agg.items,
      topVendor: agg.items[0] ?? null,
      vendorCount: agg.groupCount,
      unattributedRevenue: roundMoney(agg.unattributed),
      currency: shopBaseCurrency(context).currency,
      window: `trailing_${days}d`,
    },
    confidence: sampleConfidence(0.85, sales.orders.length, 5, 100),
    confidenceReason: "Revenue grouped by vendor over the trailing window (shop base currency).",
    summary: `Top vendor by revenue: ${agg.items[0]?.name ?? "unknown"} (${agg.groupCount} vendors with sales).`,
    sampleSize: sales.orders.length,
    supportingValues: { vendorCount: agg.groupCount },
  });
}

function productSalesInWindow(context, days) {
  const orders = pricedOrdersInWindow(context, days);
  const orderIds = new Set(orders.map((order) => order.id));
  const items = context.lineItems.filter(
    (item) => item.productId && orderIds.has(item.orderId),
  );
  const soldProductIds = new Set(items.map((item) => item.productId));
  const revenueByProduct = sumBy(
    items,
    (item) => item.productId,
    (item) => decimalNumber(item.totalPrice),
  );
  const unitsByProduct = sumBy(
    items,
    (item) => item.productId,
    (item) => Number(item.quantity) || 0,
  );
  return { orders, items, soldProductIds, revenueByProduct, unitsByProduct };
}

function productTitle(context, productId) {
  return (
    context.products.find((product) => product.id === productId)?.title ?? null
  );
}

const INVENTORY_VELOCITY_WINDOW_DAYS = 30;
const STOCKOUT_RISK_DAYS = 21;
const MIN_UNITS_FOR_VELOCITY = 3;

// Join recent sell-rate to current stock, per product, to get days of cover.
// Only products that BOTH sold enough in the window (a meaningful velocity) and
// have at least one tracked variant (known available units — missing inventory
// is unknown, never treated as zero) are evaluated. Returns rows sorted by days
// of cover ascending (most urgent first).
function productInventoryCover(context, days) {
  const { unitsByProduct, orders } = productSalesInWindow(context, days);
  const rows = [];
  for (const [productId, unitsSold] of unitsByProduct) {
    if (unitsSold < MIN_UNITS_FOR_VELOCITY) continue;
    const variants = context.variantsByProduct.get(productId) ?? [];
    let available = 0;
    let tracked = false;
    for (const variant of variants) {
      if (context.availableByVariant.has(variant.id)) {
        tracked = true;
        available += Number(context.availableByVariant.get(variant.id)) || 0;
      }
    }
    if (!tracked) continue;
    const dailyVelocity = unitsSold / days;
    if (dailyVelocity <= 0) continue;
    rows.push({
      productId,
      title: productTitle(context, productId),
      unitsSold,
      available,
      dailyVelocity: roundNumber(dailyVelocity, 2),
      daysOfCover: roundNumber(available / dailyVelocity, 1),
    });
  }
  rows.sort((a, b) => a.daysOfCover - b.daysOfCover);
  return { rows, orders };
}

// How many selling products will run out of stock soon at the current sell-rate
// — the reorder-urgency headline. Never counts untracked products (unknown
// stock) or slow sellers (noisy velocity).
function atRiskStockoutCount(context, definition) {
  const days = INVENTORY_VELOCITY_WINDOW_DAYS;
  const { rows, orders } = productInventoryCover(context, days);
  if (orders.length < 5) return skipped(definition, "insufficient_data", "At least 5 priced orders in the window are required for stockout risk.", { orders: orders.length });
  if (rows.length < 1) return skipped(definition, "insufficient_data", "No products have both a recent sell-rate and tracked inventory.", { evaluatedProducts: rows.length });
  const atRisk = rows.filter((row) => row.daysOfCover < STOCKOUT_RISK_DAYS);
  return countOutcome(context, definition, atRisk.length, `Selling products with fewer than ${STOCKOUT_RISK_DAYS} days of stock cover at the current ${days}-day sell-rate.`, { sampleSize: rows.length, confidence: sampleConfidence(0.85, rows.length, 3, 50), supportingValues: { evaluatedProductCount: rows.length, thresholdDays: STOCKOUT_RISK_DAYS, window: `trailing_${days}d` } });
}

// The actionable "reorder these" list: the selling products closest to running
// out, each with its days of cover, current stock and daily sell-rate. The most
// urgent product is also surfaced at the top level so it survives the generators'
// depth-capped serialization.
function lowCoverProducts(context, definition) {
  const days = INVENTORY_VELOCITY_WINDOW_DAYS;
  const { rows, orders } = productInventoryCover(context, days);
  if (orders.length < 5) return skipped(definition, "insufficient_data", "At least 5 priced orders in the window are required for reorder cover.", { orders: orders.length });
  const atRisk = rows.filter((row) => row.daysOfCover < STOCKOUT_RISK_DAYS).slice(0, 5);
  if (atRisk.length < 1) return skipped(definition, "insufficient_data", "No selling product is below the stockout-risk cover threshold.", { evaluatedProducts: rows.length });
  return derived(context, definition, {
    value: {
      items: atRisk,
      topAtRiskProduct: atRisk[0] ?? null,
      atRiskProductCount: atRisk.length,
      thresholdDays: STOCKOUT_RISK_DAYS,
      window: `trailing_${days}d`,
    },
    confidence: sampleConfidence(0.85, rows.length, 3, 50),
    confidenceReason: "Products ranked by days of stock cover (available units divided by recent daily sell-rate).",
    summary: `${atRisk.length} selling product(s) below ${STOCKOUT_RISK_DAYS} days of stock cover.`,
    sampleSize: rows.length,
    supportingValues: { evaluatedProductCount: rows.length },
  });
}

function sellingProductCount(context, definition, days) {
  const { orders, soldProductIds } = productSalesInWindow(context, days);
  if (orders.length < 5) {
    return skipped(definition, "insufficient_data", "At least 5 priced orders in the window are required.", { orders: orders.length });
  }
  return countOutcome(context, definition, soldProductIds.size, `Distinct products with recorded sales in the trailing ${days} days.`, { sampleSize: orders.length });
}

function noSaleActiveProductCount(context, definition, days) {
  const { orders, soldProductIds } = productSalesInWindow(context, days);
  if (orders.length < 5) {
    return skipped(definition, "insufficient_data", "At least 5 priced orders in the window are required.", { orders: orders.length });
  }
  if (context.activeProducts.length < 1) {
    return skipped(definition, "insufficient_data", "At least 1 active product is required.", { activeProducts: context.activeProducts.length });
  }
  const noSale = context.activeProducts.filter((product) => !soldProductIds.has(product.id)).length;
  return countOutcome(context, definition, noSale, `Active products with no recorded sales in the trailing ${days} days.`, { sampleSize: context.activeProducts.length });
}

// Dead stock = active products with inventory on hand but no sales in the window:
// the cash trapped in what isn't moving. Trapped capital = units on hand × unit
// cost (where cost is known), so it's the true capital tied up, not retail value.
// Complements the count belief with the value + the named products, and feeds the
// clearance action.
function deadStock(context, definition, days) {
  const { orders, soldProductIds } = productSalesInWindow(context, days);
  if (orders.length < 5) {
    return skipped(definition, "insufficient_data", "At least 5 priced orders in the window are required.", { orders: orders.length });
  }
  const costByVariant = variantUnitCostMap(context);
  const items = [];
  let deadStockProductCount = 0;
  let totalTrappedCapital = 0;
  for (const product of context.activeProducts) {
    if (soldProductIds.has(product.id)) continue;
    const variants = context.variantsByProduct.get(product.id) ?? [];
    let units = 0;
    let trapped = 0;
    let hasStock = false;
    let hasCost = false;
    for (const variant of variants) {
      const available = context.availableByVariant.get(variant.id) ?? 0;
      if (available > 0) {
        hasStock = true;
        units += available;
        const cost = costByVariant.get(variant.id);
        if (cost != null) {
          hasCost = true;
          trapped += cost * available;
        }
      }
    }
    if (!hasStock) continue;
    deadStockProductCount += 1;
    if (hasCost) {
      totalTrappedCapital += trapped;
      items.push({ productId: product.id, title: productTitle(context, product.id), unitsOnHand: units, trappedCapital: roundMoney(trapped) });
    }
  }
  if (deadStockProductCount < 1) {
    return skipped(definition, "insufficient_data", "No active product is both in stock and out of sales in the window.", { deadStockProductCount });
  }
  items.sort((a, b) => b.trappedCapital - a.trappedCapital);
  return derived(context, definition, {
    value: {
      items: items.slice(0, 8),
      topDeadProduct: items[0] ?? null,
      deadStockProductCount,
      costCoveredProductCount: items.length,
      totalTrappedCapital: roundMoney(totalTrappedCapital),
      currency: shopBaseCurrency(context).currency,
      window: `trailing_${days}d`,
    },
    confidence: 0.9,
    confidenceReason: "Active products in stock with no sales in the window; trapped capital = units on hand × unit cost where cost is known.",
    summary: `${deadStockProductCount} active products have stock but no sales in the trailing ${days} days.`,
    sampleSize: orders.length,
  });
}

function topProductRevenueShare(context, definition, days, topN) {
  const { orders, revenueByProduct } = productSalesInWindow(context, days);
  if (orders.length < 5) {
    return skipped(definition, "insufficient_data", "At least 5 priced orders in the window are required.", { orders: orders.length });
  }
  const currency = shopBaseCurrency(context);
  if (!currency.ok) {
    return skipped(definition, "blocked_by_data_quality", "No priced orders in a determinable currency.", { currencies: currency.currencies.length });
  }
  const revenues = Array.from(revenueByProduct.values())
    .filter((revenue) => revenue > 0)
    .sort((a, b) => b - a);
  if (revenues.length < 2) {
    return skipped(definition, "insufficient_data", "At least 2 products with sales are required for a concentration share.", { sellingProducts: revenues.length });
  }
  const total = sum(revenues);
  const topSum = sum(revenues.slice(0, topN));
  return shareOutcome(context, definition, topSum, total, `Revenue from the top ${topN} product${topN === 1 ? "" : "s"} divided by total product revenue in the trailing ${days} days.`, { supportingValues: { sellingProductCount: revenues.length, topN, currency: currency.currency } });
}

function bestsellerByRevenue(context, definition, days) {
  const { orders, revenueByProduct } = productSalesInWindow(context, days);
  if (orders.length < 5) {
    return skipped(definition, "insufficient_data", "At least 5 priced orders in the window are required.", { orders: orders.length });
  }
  const currency = shopBaseCurrency(context);
  if (!currency.ok) {
    return skipped(definition, "blocked_by_data_quality", "No priced orders in a determinable currency.", { currencies: currency.currencies.length });
  }
  const ranked = Array.from(revenueByProduct.entries())
    .filter((entry) => entry[1] > 0)
    .sort((a, b) => b[1] - a[1]);
  if (ranked.length < 1) {
    return skipped(definition, "insufficient_data", "At least 1 product with sales is required.", { sellingProducts: ranked.length });
  }
  const total = sum(ranked.map((entry) => entry[1]));
  const [productId, revenue] = ranked[0];
  return derived(context, definition, {
    value: {
      productId,
      title: productTitle(context, productId),
      revenue: roundMoney(revenue),
      revenueSharePercent: roundNumber((revenue / total) * 100, 2),
      currency: currency.currency,
      sellingProductCount: ranked.length,
      window: `trailing_${days}d`,
    },
    confidence: 0.9,
    confidenceReason: "Highest-revenue product from stored line items in one currency over the window.",
    summary: `Best-selling product by revenue in the trailing ${days} days.`,
    sampleSize: ranked.length,
  });
}

function bestsellerByUnits(context, definition, days) {
  const { orders, unitsByProduct } = productSalesInWindow(context, days);
  if (orders.length < 5) {
    return skipped(definition, "insufficient_data", "At least 5 priced orders in the window are required.", { orders: orders.length });
  }
  const ranked = Array.from(unitsByProduct.entries())
    .filter((entry) => entry[1] > 0)
    .sort((a, b) => b[1] - a[1]);
  if (ranked.length < 1) {
    return skipped(definition, "insufficient_data", "At least 1 product with sales is required.", { sellingProducts: ranked.length });
  }
  const totalUnits = sum(ranked.map((entry) => entry[1]));
  const [productId, units] = ranked[0];
  return derived(context, definition, {
    value: {
      productId,
      title: productTitle(context, productId),
      units,
      unitsSharePercent: roundNumber((units / totalUnits) * 100, 2),
      sellingProductCount: ranked.length,
      window: `trailing_${days}d`,
    },
    confidence: 0.9,
    confidenceReason: "Highest-unit-volume product from stored line items over the window.",
    summary: `Best-selling product by units in the trailing ${days} days.`,
    sampleSize: ranked.length,
  });
}

function countOutcome(context, definition, count, summary, options = {}) {
  return derived(context, definition, {
    value: { count, ...(options.supportingValues ?? {}) },
    confidence: options.confidence ?? sampleConfidence(0.95, options.sampleSize ?? count, 1, 100),
    confidenceReason: options.confidenceReason ?? "Direct deterministic count from stored Shopify records.",
    summary,
    sampleSize: options.sampleSize ?? count,
    supportingValues: options.supportingValues,
  });
}

function shareOutcome(context, definition, numerator, denominator, summary, options = {}) {
  if (denominator < 1) return skipped(definition, "insufficient_data", "At least one denominator record is required.", { numerator, denominator });
  return derived(context, definition, {
    value: { ratio: roundNumber(numerator / denominator, 4), percentage: roundNumber((numerator / denominator) * 100, 2), numerator, denominator, ...(options.supportingValues ?? {}) },
    confidence: options.confidence ?? coverageConfidence(0.9, denominator === 0 ? 0 : numerator / denominator),
    confidenceReason: options.confidenceReason ?? "Direct deterministic ratio from stored Shopify records.",
    summary,
    sampleSize: denominator,
    supportingValues: options.supportingValues,
  });
}

function shareFromValues(context, definition, values, window, summary) {
  const total = sum(values);
  if (values.length < 1 || total <= 0) return skipped(definition, "insufficient_data", "Positive revenue values are required for concentration share.", { groups: values.length });
  const top = Math.max(...values);
  return derived(context, definition, {
    value: { ratio: roundNumber(top / total, 4), percentage: roundNumber((top / total) * 100, 2), numerator: roundMoney(top), denominator: roundMoney(total), window },
    confidence: 0.85,
    confidenceReason: "Largest grouped revenue total divided by total revenue in the window.",
    summary,
    sampleSize: values.length,
  });
}

function derived(context, definition, result) {
  const confidence = buildConfidence(context, definition, result);
  const derivationVersion = currentDefinitionVersion(definition);
  return {
    status: DERIVATION_OUTCOME.calculated,
    publish: true,
    definition,
    value: result.value,
    confidence: confidence.score,
    confidenceReason: result.confidenceReason,
    summary: result.summary,
    observedAt: result.observedAt,
    metadata: {
      sourceRecordCounts: context.sourceCounts,
      analysisWindow: definition.window,
      exactWindow: exactWindow(context, definition.window),
      shopTimezone: context.shopTimezone,
      formulaIdentifier: formulaIdentifier(definition),
      derivationVersion,
      calculation: definition.calculation,
      minimumDataRule: definition.minimumData,
      confidenceRule: definition.confidenceRule,
      confidenceProvenance: confidence,
      confidencePublishPolicy: confidence.publishPolicy,
      dataQualityFlags: getConfidenceConfig(definition).dataQualityFlags,
      dependencies: definition.dependencies,
      includedExcludedRules: includedExcludedRules(),
      coverageMetrics: result.coverageMetrics ?? {},
      sampleSize: result.sampleSize ?? null,
      currencyHandling: result.currencyHandling ?? defaultCurrencyHandling(definition),
      supportingValues: result.supportingValues ?? {},
      caveat: definition.caveat ?? "",
      llmExposure: exposureSlug(definition.llmExposure),
      registryTranche: definition.tranche,
      sourceUrl: definition.sourceUrl,
      calculatedAt: context.now.toISOString(),
    },
  };
}

function skipped(definition, status, reason, observedCounts) {
  const normalizedStatus = normalizeOutcomeStatus(status);
  const confidenceConfig = getConfidenceConfig(definition);
  return {
    status: normalizedStatus,
    publish: false,
    definition,
    reason,
    observedCounts,
    requiredSources: requiredSourcesFor(definition, normalizedStatus),
    confidencePublishPolicy: confidenceConfig.publishPolicy,
    qualityFlags: confidenceConfig.dataQualityFlags,
  };
}

function normalizeOutcomeStatus(status) {
  switch (status) {
    case DERIVATION_OUTCOME.calculated:
    case DERIVATION_OUTCOME.insufficientData:
    case DERIVATION_OUTCOME.notApplicable:
    case DERIVATION_OUTCOME.blockedByMissingSource:
      return status;
    case "derived":
      return DERIVATION_OUTCOME.calculated;
    case "insufficient_data":
      return DERIVATION_OUTCOME.insufficientData;
    case "not_applicable":
      return DERIVATION_OUTCOME.notApplicable;
    case "blocked_by_data_quality":
    case "blocked_by_missing_source":
      return DERIVATION_OUTCOME.blockedByMissingSource;
    default:
      return DERIVATION_OUTCOME.insufficientData;
  }
}

function derivationAttemptSummary(outcome) {
  const definition = outcome.definition;
  const confidenceConfig = getConfidenceConfig(definition);
  return {
    key: definition.key,
    category: definition.category,
    status: outcome.status,
    publish: outcome.publish === true,
    reason:
      outcome.status === DERIVATION_OUTCOME.calculated
        ? "Calculated and published."
        : outcome.reason,
    observedCounts: outcome.observedCounts ?? {},
    requiredSources:
      outcome.requiredSources ?? requiredSourcesFor(definition, outcome.status),
    confidencePublishPolicy:
      outcome.confidencePublishPolicy ?? confidenceConfig.publishPolicy,
    qualityFlags: outcome.qualityFlags ?? confidenceConfig.dataQualityFlags,
    llmExposure: exposureSlug(definition.llmExposure),
    tranche: definition.tranche,
    derivationVersion: currentDefinitionVersion(definition),
  };
}

function buildDerivationReport(definitions, outcomes) {
  const report = {
    attempted: definitions.length,
    published: 0,
    suppressed: 0,
    statusCounts: {},
    suppressedReasonCounts: {},
  };
  for (const outcome of outcomes) {
    report.statusCounts[outcome.status] = (report.statusCounts[outcome.status] ?? 0) + 1;
    if (outcome.status === DERIVATION_OUTCOME.calculated) {
      report.published += 1;
    } else {
      report.suppressed += 1;
      report.suppressedReasonCounts[outcome.status] =
        (report.suppressedReasonCounts[outcome.status] ?? 0) + 1;
    }
  }
  return report;
}

function requiredSourcesFor(definition, status) {
  if (status === DERIVATION_OUTCOME.calculated) return [];
  return definition.dependencies?.length ? definition.dependencies : ["stored Shopify records"];
}

function belief(merchantId, shopId, definition, seed) {
  const metadata = { ...seed.metadata, sourceRecordCounts: seed.sourceCounts };
  const derivationVersion = currentDefinitionVersion(definition);
  return {
    merchantId,
    shopId,
    category: definition.category,
    key: definition.key,
    value: seed.value,
    valueType: definition.valueType,
    confidence: seed.confidence,
    confidenceReason: seed.confidenceReason,
    precedence: BELIEF_PRECEDENCE.systemInference,
    derivationVersion,
    observedAt: seed.observedAt ?? seed.now,
    evaluatedAt: seed.now,
    evidence: buildDeterministicEvidence({
      definition: { ...definition, derivationVersion },
      summary: seed.summary,
      observedAt: seed.observedAt ?? seed.now,
      metadata,
      now: seed.now,
    }),
  };
}

function buildConfidence(context, definition, result) {
  const config = getConfidenceConfig(definition);
  const coverageValues = Object.values(result.coverageMetrics ?? {}).filter(
    (value) => typeof value === "number",
  );
  const inventoryCoverageValue = inventoryCoverage(context, definition);
  const inventoryAgeHours = inventoryFreshnessAgeHours(context, definition);
  const params = {
    ...config.params,
    calibratedScore: result.confidence,
    components: config.components,
    publishPolicy: config.publishPolicy,
    sampleSize: result.sampleSize ?? result.value?.denominator ?? null,
    denominator: result.value?.denominator ?? null,
    recordCount: result.sampleSize ?? null,
    coverage: inventoryCoverageValue ?? coverageValues[0] ?? undefined,
    completeness: inventoryCoverageValue ?? coverageValues[0] ?? undefined,
    ageHours:
      inventoryAgeHours ??
      result.coverageMetrics?.ageHours ??
      (definition.category === "inventory" ? 999999 : undefined),
    dominantCoverage:
      result.value?.dominantShare ??
      result.coverageMetrics?.dominantCurrencyShare ??
      coverageValues[0] ??
      undefined,
    pricedRecordCount:
      result.value?.pricedRecordCount ??
      result.value?.orderCount ??
      result.value?.pricedVariantCount ??
      result.sampleSize ??
      null,
    completeLifetimeHistory: Boolean(result.value?.completeLifetimeHistory),
    historyKind: result.value?.historyKind ?? null,
    source: definition.dependencies?.join(", ") ?? "stored Shopify records",
    selectedSource: result.supportingValues?.source ?? null,
  };
  let evaluated = evaluateConfidenceTemplate(config.template, params);
  if (definition.category === "inventory") {
    const freshnessCap = evaluateConfidenceTemplate("freshness_coverage_v1", {
      ...params,
      calibratedScore: undefined,
      score: undefined,
    });
    const cappedRawScore = Math.min(
      Number(evaluated.rawScore ?? evaluated.score),
      Number(freshnessCap.rawScore ?? freshnessCap.score),
    );
    evaluated = {
      ...evaluated,
      score: calibratePublishedConfidence(cappedRawScore),
      rawScore: cappedRawScore,
      inventoryFreshnessCap: freshnessCap,
    };
  }
  return {
    ...evaluated,
    configuredTemplateVersion: config.templateVersion,
    publishPolicy: config.publishPolicy,
    legacyConfidenceRule: definition.legacyConfidenceRule,
  };
}

function formulaIdentifier(definition) {
  const version = currentDefinitionVersion(definition);
  const formulaSlug = String(definition.calculation ?? definition.key)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return `${formulaSlug}@${version}`;
}

function orderValuePolicy() {
  return {
    formula: "orders.total_price",
    includesTax: true,
    includesShipping: true,
    discounts: "net of discounts reflected in Shopify current total_price",
    refunds: "excluded; refund amounts are reported separately when successful transaction coverage is available",
    cancellations: "not independently adjusted unless reflected in stored Shopify current total_price",
    orderEdits: "not independently adjusted unless reflected in stored Shopify current total_price",
    duties: "not separately modelled in the current schema",
    tips: "not separately modelled in the current schema",
  };
}

function includedExcludedRules() {
  return {
    orderInclusion: "stored Shopify orders with processed_at or total_price",
    orderValue: orderValuePolicy(),
    inventory: "active tracked variants use summed inventory_levels.available by variant; negative and positive units are separated",
    pii: "belief evidence includes counts, identifiers and aggregate values only; no customer names, emails, phones or addresses",
  };
}

function defaultCurrencyHandling(definition) {
  return definition.valueType === "currency_amount" ? "single_currency_required_or_skipped" : "not_monetary";
}

function exactWindow(context, registryWindow) {
  if (registryWindow === "current_state" || registryWindow === "current_stored_state") {
    return { type: "current_state", start: null, end: context.now.toISOString() };
  }
  if (registryWindow === "all_stored_history") {
    const dates = sortedOrderTimes(context.datedOrders);
    return { type: "all_stored_history", start: firstIso(dates), end: context.now.toISOString() };
  }
  const days = windowDays(registryWindow);
  if (days) {
    const start = new Date(context.now.getTime() - days * 86400000);
    return { type: "trailing_days", days, start: start.toISOString(), end: context.now.toISOString() };
  }
  return { type: registryWindow, start: null, end: context.now.toISOString() };
}

function ordersInWindow(context, days) {
  const start = new Date(context.now.getTime() - days * 86400000);
  return context.datedOrders.filter((order) => order.orderTime >= start && order.orderTime < context.now);
}

function pricedOrdersInWindow(context, days) {
  return ordersInWindow(context, days).filter((order) => order.totalPrice !== null);
}

function trailingDays(key) {
  const match = key.match(/trailing_(\d+)d/);
  return match ? Number(match[1]) : 0;
}

function windowDays(value) {
  const match = String(value).match(/trailing_(\d+)d/);
  return match ? Number(match[1]) : null;
}

function productStatusCount(context, status) {
  return context.retainedProducts.filter((product) => String(product.status ?? "").toUpperCase() === status).length;
}

function activeVariantPrices(context) {
  return context.pricedActiveVariants.map((variant) => decimalNumber(variant.price));
}

function variantCountsPerActiveProduct(context) {
  return context.activeProducts.map((product) => (context.variantsByProduct.get(product.id) ?? []).length);
}

function knownAvailabilityByActiveProduct(context) {
  return context.activeProducts.map((product) => {
    const variants = context.variantsByProduct.get(product.id) ?? [];
    const available = variants.filter((variant) => context.availableByVariant.has(variant.id)).map((variant) => context.availableByVariant.get(variant.id) ?? 0);
    return { productId: product.id, knownVariantCount: available.length, available };
  }).filter((product) => product.knownVariantCount > 0);
}

function knownTrackedAvailability(context) {
  return context.activeVariants
    .filter((variant) => variant.inventoryItemExternalId && context.availableByVariant.has(variant.id))
    .map((variant) => context.availableByVariant.get(variant.id) ?? 0);
}

function stockRetailValues(context) {
  return context.activeVariants
    .filter((variant) => variant.price !== null && context.availableByVariant.has(variant.id))
    .map((variant) => ({ available: Math.max(context.availableByVariant.get(variant.id) ?? 0, 0), price: decimalNumber(variant.price), currency: variant.currency }))
    .filter((row) => row.available > 0 && row.price >= 0)
    .map((row) => ({ value: row.available * row.price, currency: row.currency }));
}

function activeDaySet(context, orders) {
  return new Set(orders.map((order) => dayKey(orderTime(order), context.shopTimezone)));
}

function sortedOrderTimes(orders) {
  return orders.map((order) => order.orderTime ?? orderTime(order) ?? order).filter((value) => value instanceof Date).sort((a, b) => a.getTime() - b.getTime());
}

function longestInactivityGap(orderTimes, now) {
  if (orderTimes.length < 1) return 90;
  let longest = Math.max(0, Math.floor((now.getTime() - orderTimes[orderTimes.length - 1].getTime()) / 86400000));
  for (let index = 1; index < orderTimes.length; index += 1) {
    const gap = Math.max(0, Math.floor((orderTimes[index].getTime() - orderTimes[index - 1].getTime()) / 86400000));
    if (gap > longest) longest = gap;
  }
  return longest;
}

function weeklyOrderConsistency(orderTimes, now, days) {
  const weeks = Math.max(1, Math.ceil(days / 7));
  const start = new Date(now.getTime() - days * 86400000);
  const activeWeeks = new Set(
    orderTimes.map((time) =>
      Math.min(weeks - 1, Math.max(0, Math.floor((time.getTime() - start.getTime()) / 604800000))),
    ),
  );
  return activeWeeks.size / weeks;
}

function orderTime(order) {
  return order?.processedAt ?? order?.sourceCreatedAt ?? null;
}

function orderValue(order) {
  return decimalNumber(order.totalPrice);
}

function isCommerceOrder(order) {
  return Boolean(order.processedAt || order.totalPrice !== null);
}

function isDeleted(product) {
  return String(product.status ?? "").toLowerCase() === "deleted";
}

function isActiveProduct(product) {
  return String(product.status ?? "").toUpperCase() === "ACTIVE";
}

function inventoryByVariant(inventoryLevels) {
  const availableByVariant = new Map();
  for (const level of inventoryLevels) {
    if (!level.variantId || level.available === null) continue;
    availableByVariant.set(level.variantId, (availableByVariant.get(level.variantId) ?? 0) + level.available);
  }
  return availableByVariant;
}

function quantityByOrder(lineItems) {
  const quantities = new Map();
  for (const lineItem of lineItems) quantities.set(lineItem.orderId, (quantities.get(lineItem.orderId) ?? 0) + lineItem.quantity);
  return quantities;
}

function linkedCountByOrder(lineItems, field) {
  const sets = new Map();
  for (const lineItem of lineItems) {
    const value = lineItem[field];
    if (!value) continue;
    const set = sets.get(lineItem.orderId) ?? new Set();
    set.add(value);
    sets.set(lineItem.orderId, set);
  }
  return new Map(Array.from(sets.entries()).map(([orderId, set]) => [orderId, set.size]));
}

function refundTransactionCoverage(refunds) {
  const successfulTransactions = [];
  let refundsWithSuccessfulTransactionAmount = 0;
  for (const refund of refunds) {
    const transactions = refundTransactions(refund);
    const successful = transactions.filter((transaction) => transaction.status === "success" && transaction.amount > 0);
    if (successful.length > 0) refundsWithSuccessfulTransactionAmount += 1;
    successfulTransactions.push(...successful);
  }
  return { refundsWithSuccessfulTransactionAmount, successfulTransactions };
}

function refundTransactions(refund) {
  const raw = jsonObject(refund.rawPayload);
  const candidates = [raw.transactions, raw.refundTransactions, raw.refund_transactions];
  const rows = candidates.find((candidate) => Array.isArray(candidate)) ?? edgesToNodes(raw.transactions ?? raw.refundTransactions);
  return rows.map((row) => {
    const payload = jsonObject(row);
    const money = jsonObject(payload.amountSet?.shopMoney ?? payload.amount_set?.shop_money);
    return {
      status: String(payload.status ?? payload.kind ?? "").toLowerCase(),
      amount: decimalNumber(money.amount ?? payload.amount),
      currency: stringValue(money.currencyCode ?? money.currency_code ?? payload.currency) ?? refund.currency,
    };
  });
}

function refundHasLineItems(refund) {
  const raw = jsonObject(refund.rawPayload);
  const candidates = [raw.refundLineItems, raw.refund_line_items, raw.refund_line_items?.nodes];
  return candidates.some((candidate) => Array.isArray(candidate) && candidate.length > 0) || edgesToNodes(raw.refundLineItems).length > 0;
}

function currencyDistribution(currencies) {
  const counts = new Map();
  for (const currency of currencies) {
    const key = stringValue(currency)?.trim().toUpperCase();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const entries = Array.from(counts.entries())
    .map(([currency, count]) => ({ currency, count }))
    .sort((a, b) => b.count - a.count || a.currency.localeCompare(b.currency));
  return { total: entries.reduce((total, entry) => total + entry.count, 0), entries };
}

function singleCurrency(currencies) {
  const distribution = currencyDistribution(currencies);
  return { ok: distribution.entries.length <= 1, currency: distribution.entries[0]?.currency ?? null, currencies: distribution.entries.map((entry) => entry.currency) };
}

// The shop's base currency. Every stored money amount is Shopify shopMoney,
// denominated in the shop's base currency (constant per shop) — so order/line
// revenue and margin are summable across orders regardless of the customer's
// *presentment* currency. A single store selling internationally is the common
// case, not a data-quality problem, so revenue beliefs must not skip on it. We
// only need the base-currency label; the dominant priced currency is the proxy
// (exact capture from shopMoney.currencyCode is a documented follow-up). `ok` is
// false only when there are no priced records at all. Returns the singleCurrency
// shape so it is a drop-in at order-revenue call sites.
function shopBaseCurrency(context) {
  const distribution = currencyDistribution([
    ...context.pricedOrders.map((order) => order.currency),
    ...(context.successfulRefundCoverage?.successfulTransactions ?? []).map(
      (transaction) => transaction.currency,
    ),
  ]);
  return {
    ok: distribution.entries.length >= 1,
    currency: distribution.entries[0]?.currency ?? null,
    currencies: distribution.entries.map((entry) => entry.currency),
  };
}

function shopTimezoneFrom(rawPayload) {
  const payload = jsonObject(rawPayload);
  const candidate = stringValue(payload.iana_timezone) ?? stringValue(payload.ianaTimezone) ?? stringValue(payload.timezone);
  try {
    if (candidate) new Intl.DateTimeFormat("en-GB", { timeZone: candidate }).format(new Date());
    return candidate || "UTC";
  } catch {
    return "UTC";
  }
}

function dayKey(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function weekKey(date, timeZone) {
  const local = new Date(`${dayKey(date, timeZone)}T00:00:00Z`);
  const day = local.getUTCDay() || 7;
  local.setUTCDate(local.getUTCDate() - day + 1);
  return dayKey(local, "UTC");
}

function inclusiveDaySpan(start, end, timeZone) {
  const startDay = new Date(`${dayKey(start, timeZone)}T00:00:00Z`);
  const endDay = new Date(`${dayKey(end, timeZone)}T00:00:00Z`);
  return Math.max(1, Math.floor((endDay.getTime() - startDay.getTime()) / 86400000) + 1);
}

function hoursBetween(start, end) {
  return primitiveHoursBetween(start, end);
}

function firstIso(dates) {
  return dates[0]?.toISOString() ?? null;
}

function lastIso(dates) {
  return dates[dates.length - 1]?.toISOString() ?? null;
}

function decimalNumber(value) {
  return primitiveDecimalNumber(value);
}

function average(values) {
  return primitiveAverage(values);
}

function sum(values) {
  return primitiveSum(values);
}

function stddev(values) {
  return primitiveStddev(values);
}

function percentile(values, p) {
  return primitivePercentile(values, p);
}

function percentileFor(method) {
  return primitivePercentileFor(method);
}

function sumBy(rows, keyFn, valueFn) {
  return primitiveSumBy(rows, keyFn, valueFn);
}

function roundMoney(value) {
  return primitiveRoundMoney(value);
}

function roundNumber(value, places) {
  return primitiveRoundNumber(value, places);
}

function sampleConfidence(base, sampleSize, minimum, full) {
  if (sampleSize <= minimum) return clampConfidence(base * 0.9);
  if (sampleSize >= full) return clampConfidence(Math.max(base, 0.95));
  return clampConfidence(base + (Math.min(sampleSize, full) - minimum) / (full - minimum) * (0.95 - base));
}

function coverageConfidence(base, coverage) {
  return clampConfidence(base * Math.max(0.55, Math.min(1, coverage)));
}

function clampConfidence(value) {
  return primitiveClamp(Number.isFinite(value) ? value : 0.5, 0, 1);
}

function exposureSlug(value) {
  const text = String(value ?? "").toLowerCase();
  if (text.includes("internal")) return "internal_guardrail";
  if (text.includes("on-demand") || text.includes("on_demand")) return "on_demand";
  return "core";
}

function stringValue(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const values = map.get(key) ?? [];
    values.push(row);
    map.set(key, values);
  }
  return map;
}

function edgesToNodes(value) {
  const payload = jsonObject(value);
  if (Array.isArray(payload.nodes)) return payload.nodes;
  if (Array.isArray(payload.edges)) return payload.edges.map((edge) => jsonObject(edge).node).filter(Boolean);
  return [];
}
