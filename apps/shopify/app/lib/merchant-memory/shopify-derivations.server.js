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
import { detectToolStack } from "../integrations/tool-detection.server.js";
import {
  toolStackBeliefContent,
  toolStackSignalsFromRecords,
} from "../integrations/tool-stack-belief.server.js";

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
 * @param {{ merchantId: string; shopId?: string | null; categories?: string[]; beliefKeys?: string[]; evidenceScope?: { source?: string; orderExternalIds?: string[]; productExternalIds?: string[]; variantExternalIds?: string[]; inventoryComplete?: boolean; lineItemsComplete?: boolean; ordersComplete?: boolean; activeCatalogComplete?: boolean; completeRequestedWindow?: boolean; observedFrom?: string | null; observedTo?: string | null; passCount?: number; truncated?: boolean; selectedOrderCount?: number; lineItemCount?: number; activeProductCount?: number; variantCount?: number; inventoryLevelCount?: number } }} input
 */
export async function deriveMerchantMemoryBeliefs(prisma, input) {
  const categories =
    input.categories && input.categories.length > 0
      ? new Set(input.categories)
      : new Set(ALL_CATEGORIES);
  const context = await loadDerivationContext(prisma, input);
  const beliefKeys = input.beliefKeys?.length ? new Set(input.beliefKeys) : null;
  const definitions = DETERMINISTIC_BELIEF_REGISTRY.filter(
    (definition) => categories.has(definition.category) && (!beliefKeys || beliefKeys.has(definition.key)),
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
    derivations: calculated.map((outcome) => {
      const scopedOutcome = bootstrapScopedOutcome(outcome, input.evidenceScope);
      return belief(context.merchantId, context.shopId, outcome.definition, {
        value: scopedOutcome.value,
        confidence: scopedOutcome.confidence,
        confidenceReason: scopedOutcome.confidenceReason,
        sourceCounts: context.sourceCounts,
        summary: outcome.summary,
        observedAt: outcome.observedAt,
        now: context.now,
        metadata: {
          ...(outcome.metadata ?? {}),
          ...(input.evidenceScope
              ? {
                source: input.evidenceScope.source ?? "scoped",
                sourceMode: input.evidenceScope.source ?? "scoped",
                observedWindow: {
                  from: input.evidenceScope.observedFrom ?? null,
                  to: input.evidenceScope.observedTo ?? null,
                  complete: input.evidenceScope.completeRequestedWindow === true,
                },
                evidenceScope: {
                  source: input.evidenceScope.source ?? "scoped",
                  completeRequestedWindow: input.evidenceScope.completeRequestedWindow === true,
                  observedFrom: input.evidenceScope.observedFrom ?? null,
                  observedTo: input.evidenceScope.observedTo ?? null,
                  passCount: input.evidenceScope.passCount ?? 1,
                  truncated: input.evidenceScope.truncated === true,
                  orderCount: input.evidenceScope.orderExternalIds?.length ?? 0,
                  productCount: input.evidenceScope.productExternalIds?.length ?? 0,
                  variantCount: input.evidenceScope.variantExternalIds?.length ?? 0,
                  selectedOrderCount: input.evidenceScope.selectedOrderCount ?? input.evidenceScope.orderExternalIds?.length ?? 0,
                  lineItemCount: input.evidenceScope.lineItemCount ?? 0,
                  activeProductCount: input.evidenceScope.activeProductCount ?? input.evidenceScope.productExternalIds?.length ?? 0,
                  activeVariantCount: input.evidenceScope.variantCount ?? input.evidenceScope.variantExternalIds?.length ?? 0,
                  inventoryLevelCount: input.evidenceScope.inventoryLevelCount ?? 0,
                  inventoryComplete: input.evidenceScope.inventoryComplete === true,
                  lineItemsComplete: input.evidenceScope.lineItemsComplete === true,
                  ordersComplete: input.evidenceScope.ordersComplete === true,
                  activeCatalogComplete: input.evidenceScope.activeCatalogComplete === true,
                  confidenceCap: bootstrapConfidenceCap(outcome.definition.key),
                  caveat: bootstrapEvidenceCaveat(outcome.definition.key, input.evidenceScope),
                  supportingRecords: {
                    orderExternalIds: input.evidenceScope.orderExternalIds ?? [],
                    productExternalIds: input.evidenceScope.productExternalIds ?? [],
                    variantExternalIds: input.evidenceScope.variantExternalIds ?? [],
                  },
                },
              }
            : {}),
        },
      });
    }),
    skippedOutcomes,
    derivationAttempts,
    derivationReport: buildDerivationReport(definitions, outcomes),
    registryDefinitionCount: definitions.length,
  };
}

function bootstrapScopedOutcome(outcome, scope) {
  if (scope?.source !== "bootstrap") return outcome;
  const capped = {
    ...outcome,
    confidence: Math.min(Number(outcome.confidence ?? 0.9), 0.9),
  };
  if (
    outcome.definition.key !== "inventory.low_cover_products.trailing_30d" &&
    outcome.definition.key !== "inventory.at_risk_stockout_count.trailing_30d"
  ) {
    return capped;
  }
  const value = { ...outcome.value, evidenceBasis: "conservative_upper_bound" };
  if (Array.isArray(value.items)) {
    value.items = value.items.map((item) => ({
      ...item,
      daysOfCoverUpperBound: item.daysOfCover,
    }));
    if (value.topAtRiskProduct) {
      value.topAtRiskProduct = {
        ...value.topAtRiskProduct,
        daysOfCoverUpperBound: value.topAtRiskProduct.daysOfCover,
      };
    }
  }
  return {
    ...capped,
    value,
    confidence: Math.min(Number(capped.confidence ?? 0.7), 0.7),
    confidenceReason:
      "Conservative upper bound from partial recent orders: omitted orders can only increase observed sales velocity and reduce cover.",
  };
}

function bootstrapConfidenceCap(key) {
  return key === "inventory.low_cover_products.trailing_30d" || key === "inventory.at_risk_stockout_count.trailing_30d"
    ? 0.7
    : 0.9;
}

function bootstrapEvidenceCaveat(key, scope) {
  if (key === "inventory.low_cover_products.trailing_30d" || key === "inventory.at_risk_stockout_count.trailing_30d") {
    return "Recent orders establish a conservative upper bound on days of cover; additional sales can only make the risk more urgent.";
  }
  if (String(key).startsWith("catalog.") || key === "business.catalogue_shape") {
    return scope.activeCatalogComplete
      ? "This conclusion is limited to the current active Shopify catalog Jefe read during onboarding."
      : "The active catalog read is incomplete, so this evidence cannot support a catalog-wide conclusion.";
  }
  return scope.completeRequestedWindow
    ? "This conclusion is limited to the complete recent window Jefe read during onboarding."
    : "The recent Shopify window is incomplete, so this evidence cannot support a period-wide conclusion.";
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; evidenceScope?: { orderExternalIds?: string[]; productExternalIds?: string[]; variantExternalIds?: string[] } }} input
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
  const orderExternalIds = input.evidenceScope?.orderExternalIds ?? [];
  const productExternalIds = input.evidenceScope?.productExternalIds ?? [];
  const variantExternalIds = input.evidenceScope?.variantExternalIds ?? [];
  const scopedOrderWhere = orderExternalIds.length
    ? { ...where, externalId: { in: orderExternalIds } }
    : where;
  const scopedProductWhere = productExternalIds.length
    ? { ...where, externalId: { in: productExternalIds } }
    : where;
  const scopedVariantWhere = variantExternalIds.length
    ? { ...where, externalId: { in: variantExternalIds } }
    : where;
  const scopedLineItemWhere = {
    ...where,
    ...(orderExternalIds.length ? { order: { externalId: { in: orderExternalIds } } } : {}),
    ...(productExternalIds.length
      ? { OR: [{ productId: null }, { product: { externalId: { in: productExternalIds } } }] }
      : {}),
  };
  const scopedInventoryWhere = variantExternalIds.length
    ? { ...where, variant: { externalId: { in: variantExternalIds } } }
    : where;
  const [loadedProducts, loadedVariants, loadedOrders, loadedLineItems, loadedRefunds, loadedCustomerIdentities, loadedInventoryLevels, loadedPlanRecommendations, loadedClearanceOutcomes, loadedActionDeclines] =
    await Promise.all([
      prisma.product.findMany({
        where: scopedProductWhere,
        select: {
          id: true,
          externalId: true,
          title: true,
          status: true,
          productType: true,
          vendor: true,
          sourceCreatedAt: true,
          sourceUpdatedAt: true,
        },
      }),
      prisma.variant.findMany({
        where: scopedVariantWhere,
        select: {
          id: true,
          externalId: true,
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
        where: scopedOrderWhere,
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
          discountCodes: true,
          discountApplications: true,
          attribution: true,
        },
      }),
      prisma.orderLineItem.findMany({
        where: scopedLineItemWhere,
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
      input.evidenceScope ? Promise.resolve([]) : prisma.refund.findMany({
        where: scopedOrderWhere,
        select: {
          orderId: true,
          amount: true,
          currency: true,
          processedAt: true,
          rawPayload: true,
        },
      }),
      input.evidenceScope ? Promise.resolve([]) : prisma.customerIdentity.findMany({
        where,
        select: { orderCount: true, totalSpend: true, rawPayload: true },
      }),
      prisma.inventoryLevel.findMany({
        where: scopedInventoryWhere,
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
      !input.evidenceScope && prisma.merchantPlanRecommendation?.findMany
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
      // Measured clearance outcomes — the Observe→Learn "did the action work" signal.
      // Guarded so derivation fixtures/mocks without the accessor simply see none.
      !input.evidenceScope && prisma.actionExecution?.findMany
        ? prisma.actionExecution.findMany({
            where: { merchantId: input.merchantId, shopId: shopId ?? undefined, actionType: "price_markdown", outcomeStatus: "measured" },
            select: { outcome: true, appliedAt: true },
          })
        : Promise.resolve([]),
      // Declined actions — the "what/why the merchant rejected" Observe→Learn signal.
      // reasonCategory is a PII-safe slug; the free-text note is already redacted at write.
      !input.evidenceScope && prisma.activityEvent?.findMany
        ? prisma.activityEvent.findMany({
            where: { merchantId: input.merchantId, shopId: shopId ?? undefined, type: "merchant_action_declined" },
            select: { properties: true },
          })
        : Promise.resolve([]),
    ]);

  const scopedOrderExternalIds = input.evidenceScope?.orderExternalIds?.length
    ? new Set(input.evidenceScope.orderExternalIds)
    : null;
  const scopedProductExternalIds = input.evidenceScope?.productExternalIds?.length
    ? new Set(input.evidenceScope.productExternalIds)
    : null;
  const scopedVariantExternalIds = input.evidenceScope?.variantExternalIds?.length
    ? new Set(input.evidenceScope.variantExternalIds)
    : null;
  const products = scopedProductExternalIds
    ? loadedProducts.filter((product) => scopedProductExternalIds.has(product.externalId))
    : loadedProducts;
  const productIds = new Set(products.map((product) => product.id));
  const variants = scopedVariantExternalIds
    ? loadedVariants.filter((variant) => scopedVariantExternalIds.has(variant.externalId))
    : scopedProductExternalIds
      ? loadedVariants.filter((variant) => productIds.has(variant.productId))
    : loadedVariants;
  const variantIds = new Set(variants.map((variant) => variant.id));
  const orders = scopedOrderExternalIds
    ? loadedOrders.filter((order) => scopedOrderExternalIds.has(order.externalId))
    : loadedOrders;
  const orderIds = new Set(orders.map((order) => order.id));
  const lineItems = scopedOrderExternalIds || scopedProductExternalIds
    ? loadedLineItems.filter((item) => orderIds.has(item.orderId) && (!item.productId || productIds.has(item.productId)))
    : loadedLineItems;
  const refunds = scopedOrderExternalIds
    ? loadedRefunds.filter((refund) => orderIds.has(refund.orderId))
    : loadedRefunds;
  const customerIdentities = input.evidenceScope ? [] : loadedCustomerIdentities;
  const inventoryLevels = scopedProductExternalIds
    ? loadedInventoryLevels.filter((level) => level.variantId && variantIds.has(level.variantId))
    : loadedInventoryLevels;
  const planRecommendations = input.evidenceScope ? [] : loadedPlanRecommendations;
  const clearanceOutcomes = input.evidenceScope ? [] : loadedClearanceOutcomes;
  const actionDeclines = input.evidenceScope ? [] : loadedActionDeclines;

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
    clearanceOutcomes,
    actionDeclines,
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
    // Tool-stack detection signals from already-fetched records (no new query). Order-derived
    // signals (gateways/tags/fulfilment) stay dormant until Order.rawPayload is selected above;
    // the strongest signals (metafield namespaces) arrive via the live-query feeder. Consumed by
    // the `business.tool_stack` derivation below.
    toolStackSignals: toolStackSignalsFromRecords({ orders, customerIdentities }),
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
      case "business.channel_mix.trailing_90d":
        return channelMix(context, definition);
      case "business.catalogue_shape":
        return catalogueShape(context, definition);
      case "business.purchase_cadence.all_stored_history":
        return purchaseCadence(context, definition);
      case "business.order_value_bands.trailing_90d":
        return orderValueBands(context, definition, 90);
      case "business.delivery_footprint.trailing_90d":
        return deliveryFootprint(context, definition, 90);
      case "business.purchase_consideration.trailing_90d":
        return purchaseConsideration(context, definition, 90);
      case "business.range_composition":
        return rangeComposition(context, definition);
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
      case "business.discount_depth.trailing_90d":
        return discountDepth(context, definition, 90);
      case "business.discount_code_mix.trailing_90d":
        return discountCodeMix(context, definition, 90);
      case "business.acquisition_mix.trailing_90d":
        return acquisitionMix(context, definition, 90);
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
      case "business.clearance_effectiveness.all_time":
        return clearanceEffectiveness(context, definition);
      case "business.action_decline_signal.all_time":
        return actionDeclineSignal(context, definition);
      case "business.tool_stack":
        return toolStack(context, definition);
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
      case "customers.cohort_mix.all_stored_history":
        return customerCohortMix(context, definition);
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
  // Shares `pricedCurrencySample` with `shopBaseCurrency` so this belief and the currency
  // stamped on every money belief are computed from identical input and cannot disagree.
  const distribution = currencyDistribution(pricedCurrencySample(context));
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

// ── Business shape ────────────────────────────────────────────────────────────────────
// The ontology could describe a lipstick DTC brand and a Tesla dealership identically —
// store name, currency, order counts, activity — so every recommendation came out generic
// BY CONSTRUCTION. These beliefs describe what KIND of business this is, so advice can key
// on the shape rather than the numbers.
//
// Dimensional, never a vertical enum: "gardening" is POS *and* DTC *and* wholesale, and a
// Tesla dealer shares "high price, considered, infrequent" with a medical-device seller
// under no shared label. Advice keys on the dimension.
//
// All three are `systemInference` and merchant-correctable — Jefe's read of the business,
// which the merchant outranks. Each reports the evidence behind the label, not just the
// label, so a merchant can see WHY Jefe thinks it and correct the premise.

/**
 * How the merchant reaches customers. Reuses `classifySalesChannel` (pos/online/draft/other)
 * rather than re-reading sourceName, so this and the channel revenue beliefs can't disagree.
 * Counted by ORDERS, not revenue: shape is about how the business operates, and one £40k
 * wholesale order shouldn't make a busy DTC shop look wholesale-led.
 */
function channelMix(context, definition) {
  const orders = ordersInWindow(context, 90);
  if (orders.length < 10) {
    return skipped(definition, "insufficient_data", "At least 10 orders in the last 90 days are required to read a channel mix.", { orders: orders.length });
  }
  const byChannel = new Map();
  let classified = 0;
  for (const order of orders) {
    const channel = classifySalesChannel(order.sourceName);
    if (channel == null) continue;
    classified += 1;
    byChannel.set(channel, (byChannel.get(channel) ?? 0) + 1);
  }
  const coverage = classified / orders.length;
  // Older orders predate sourceName capture; a mix read off a third of the orders would be
  // a guess wearing a label. Same coverage bar as the channel revenue beliefs.
  if (classified < 10 || coverage < 0.7) {
    return skipped(definition, "insufficient_data", "Too few orders record which channel they came from (a re-backfill fills this in).", { channelCoverage: roundNumber(coverage, 4), classifiedOrders: classified });
  }
  const share = (channel) => (byChannel.get(channel) ?? 0) / classified;
  const online = share("online");
  const pos = share("pos");
  const marketplace = share("marketplace");
  const social = share("social");
  // Shopify's own B2B channel where present, plus manually-created draft orders — how most
  // merchants without B2B invoice their trade customers. The draft half is a PROXY and the
  // value says so, so a merchant correcting it can see what to correct.
  const trade = share("draft") + share("trade");

  let shape = "mixed";
  if (trade >= 0.4) shape = "wholesale_led";
  // Same bar as wholesale: it only claims this when it genuinely describes the business.
  // Rare (4 of 207 Quiver merchants sell ≥20% through marketplaces) but a real and very
  // different shape when it fires — you don't own the storefront or the customer.
  else if (marketplace >= 0.4) shape = "marketplace_led";
  else if (online >= 0.95) shape = "online_only";
  else if (pos >= 0.6) shape = "shop_led";
  else if (online >= 0.6 && pos >= 0.1) shape = "online_led_with_shop";
  else if (online >= 0.6) shape = "online_led";

  return derived(context, definition, {
    value: {
      enum: shape,
      onlineShare: roundNumber(online, 4),
      inPersonShare: roundNumber(pos, 4),
      tradeOrderShare: roundNumber(trade, 4),
      // Reported even when they don't decide the label — a merchant with 15% on Amazon
      // isn't "marketplace_led", but Jefe should still know it rather than binning it.
      marketplaceShare: roundNumber(marketplace, 4),
      socialShare: roundNumber(social, 4),
      classifiedOrders: classified,
      channelCoverage: roundNumber(coverage, 4),
      tradeShareIsProxy: "draft_orders",
      window: "trailing_90d",
      thresholdVersion: "channel-mix-v1",
    },
    confidence: coverageConfidence(0.85, coverage),
    confidenceReason: "Share of orders per Shopify sales channel over the trailing 90 days.",
    summary: "How the merchant sells: online, in person, or to trade.",
    sampleSize: classified,
  });
}

/**
 * The shape of what they sell — a one-product brand and a 5,000-SKU marketplace need
 * completely different advice at identical revenue. Counts only, so it is currency-free and
 * comparable across every merchant.
 */
function catalogueShape(context, definition) {
  const products = context.activeProducts.length;
  if (products < 1) {
    return skipped(definition, "insufficient_data", "At least one active product is required.", context.sourceCounts);
  }
  const variants = context.activeVariants.length;
  const variantsPerProduct = products === 0 ? 0 : variants / products;

  let shape = "focused";
  if (products === 1) shape = "single_product";
  else if (products <= 20) shape = "focused";
  else if (products <= 200) shape = "broad";
  else shape = "long_tail";

  return derived(context, definition, {
    value: {
      enum: shape,
      activeProductCount: products,
      activeVariantCount: variants,
      // Separates "many products" from "few products, many sizes/colours" — a 10-product
      // apparel brand with 8 sizes each is a different operation from 80 distinct products.
      variantsPerProduct: roundNumber(variantsPerProduct, 2),
      thresholdVersion: "catalogue-shape-v1",
    },
    confidence: 0.9,
    confidenceReason: "Counted from active products and variants currently stored.",
    summary: "How wide the merchant's range is.",
    sampleSize: products,
  });
}

/**
 * How often a customer comes back. Distinguishes a coffee subscription from a mattress shop
 * at the same revenue — the difference between "win them back" and "there is no back".
 *
 * Median, not mean: one customer ordering daily would drag a mean to nonsense.
 */
function purchaseCadence(context, definition) {
  const orders = context.datedOrders.filter((order) => stringValue(order.customerExternalId));
  if (orders.length < 20) {
    return skipped(definition, "insufficient_data", "At least 20 orders with a customer attached are required to read repeat cadence.", { attributedOrders: orders.length });
  }
  /** @type {Map<string, Date[]>} */
  const byCustomer = new Map();
  for (const order of orders) {
    const key = String(order.customerExternalId);
    const times = byCustomer.get(key) ?? [];
    times.push(orderTime(order));
    byCustomer.set(key, times);
  }
  /** @type {number[]} */
  const gapDays = [];
  let repeatCustomers = 0;
  for (const times of byCustomer.values()) {
    if (times.length < 2) continue;
    repeatCustomers += 1;
    const sorted = times.sort((a, b) => a.getTime() - b.getTime());
    for (let i = 1; i < sorted.length; i += 1) {
      gapDays.push((sorted[i].getTime() - sorted[i - 1].getTime()) / 86400000);
    }
  }
  const customers = byCustomer.size;
  const repeatShare = customers === 0 ? 0 : repeatCustomers / customers;

  // No repeat gaps at all is a real, useful finding — not missing data. A business nobody
  // returns to needs different advice, and saying so is the point of this belief.
  if (gapDays.length < 5) {
    return derived(context, definition, {
      value: {
        enum: "one_off",
        medianDaysBetweenOrders: null,
        repeatCustomerShare: roundNumber(repeatShare, 4),
        repeatCustomers,
        customers,
        thresholdVersion: "purchase-cadence-v1",
      },
      confidence: coverageConfidence(0.75, Math.min(customers / 50, 1)),
      confidenceReason: "Almost no customer has ordered twice in stored history.",
      summary: "Customers rarely order more than once.",
      sampleSize: customers,
    });
  }

  // Named for the RHYTHM, and cut where merchants actually differ.
  //
  // Checked against 203 real merchants (Quiver warehouse, 2 years of repeat gaps): median
  // repeat gap runs 4–166 days, but the mass sits between p20=27 and p80=69. The first cuts
  // (21/60/120) put ~60% of merchants in one bucket and left the slowest one empty — a
  // four-way split that in practice said the same thing about almost everyone. A dimension
  // that gives nearly every merchant the same answer is worse than no dimension: it reads
  // as understanding.
  //
  // ⛔ The boundaries are ABSOLUTE human rhythms (fortnight / month / quarter), NOT quantiles
  // of this population. Quantiles would make "monthly" mean "monthly compared with other
  // London delivery clients", which is a benchmark claim Jefe has no basis for — the
  // benchmark-prior module ships with no data. These happen to land where the data varies;
  // they do not derive their meaning from it.
  //
  // ⚠️ Still tuned against a DTC/food/fashion-skewed book that repeats faster than ecommerce
  // at large. A genuinely slow business (furniture, mattresses) usually has too few repeat
  // gaps to reach the minimum at all and lands in `one_off` above — the right answer for it.
  const median = percentile(gapDays, 0.5);
  let cadence = "every_few_months";
  if (median <= 14) cadence = "fortnightly_or_faster";
  else if (median <= 35) cadence = "monthly";
  else if (median <= 75) cadence = "every_few_months";
  else cadence = "seasonal";

  return derived(context, definition, {
    value: {
      enum: cadence,
      medianDaysBetweenOrders: roundNumber(median, 1),
      repeatCustomerShare: roundNumber(repeatShare, 4),
      repeatCustomers,
      customers,
      thresholdVersion: "purchase-cadence-v1",
    },
    confidence: coverageConfidence(0.8, Math.min(gapDays.length / 30, 1)),
    confidenceReason: "Median gap between consecutive orders from the same customer.",
    summary: "How often the merchant's customers come back.",
    sampleSize: gapDays.length,
  });
}

/**
 * What this merchant's order values actually look like — the SHAPE of the spread, not a
 * "premium/budget" verdict.
 *
 * ⛔ Deliberately NOT a cross-merchant band. Calling a store "premium" needs a basis to be
 * premium *against*, and the benchmark-prior module ships with no data; picking thresholds
 * in sterling would mislabel every merchant trading in yen. Everything here describes the
 * merchant against THEMSELVES, so it needs no currency threshold and is honest for all of
 * them. A comparative band can be added the day real benchmarks land.
 */
function orderValueBands(context, definition, days) {
  const orders = pricedOrdersInWindow(context, days);
  if (orders.length < 20) {
    return skipped(definition, "insufficient_data", "At least 20 priced orders are required to describe a price spread.", { orders: orders.length });
  }
  const currency = shopBaseCurrency(context);
  if (!currency.ok) {
    return skipped(definition, "insufficient_data", "No priced orders yet to report a currency in.", { orders: orders.length });
  }
  const values = orders.map(orderValue).filter((value) => value > 0).sort((a, b) => a - b);
  if (values.length < 20) {
    return skipped(definition, "insufficient_data", "At least 20 orders with a positive value are required.", { pricedOrders: values.length });
  }
  const p25 = percentile(values, 0.25);
  const median = percentile(values, 0.5);
  const p75 = percentile(values, 0.75);
  const p90 = percentile(values, 0.9);
  // Ratios, so the shape reads the same whether the merchant trades in pounds or yen.
  const spread = p25 > 0 ? p75 / p25 : null;
  // Skew, NOT p90/median: a tail is by definition a small share of orders, and p90 sits at
  // the boundary of a 10% tail — so five £900 orders among forty-five £40 ones scored 1.0
  // and read as tight. Mean-to-median catches it (3.15), and it is the same skew measure
  // `orders.order_value_mean_to_median_ratio` already uses.
  const mean = average(values);
  const skew = median > 0 ? mean / median : null;

  let shape = "broad_band";
  if (spread != null && spread < 1.8) shape = "tight_band";
  else if (spread != null && spread > 4) shape = "wide_spread";
  // A long tail is a different business from a merely wide one: a few orders many times the
  // typical size usually means trade/bulk buyers sitting inside a retail order book.
  if (skew != null && skew >= 1.5) shape = "long_tail";

  return derived(context, definition, {
    value: {
      enum: shape,
      currency: currency.currency,
      typicalOrderValue: roundMoney(median),
      lowerQuartile: roundMoney(p25),
      upperQuartile: roundMoney(p75),
      topDecile: roundMoney(p90),
      quartileSpread: spread == null ? null : roundNumber(spread, 2),
      valueSkew: skew == null ? null : roundNumber(skew, 2),
      orderCount: values.length,
      window: `trailing_${days}d`,
      thresholdVersion: "order-value-bands-v1",
    },
    confidence: sampleConfidence(0.85, values.length, 20, 200),
    confidenceReason: "Quartiles of stored order values in the shop's base currency.",
    summary: "The spread of what customers spend per order.",
    sampleSize: values.length,
  });
}

/**
 * Where the merchant delivers. Concentration and reach, not a country list — "one market" vs
 * "shipping everywhere" changes advice; the ranked countries already live in
 * `business.revenue_by_region`.
 *
 * Counted by ORDERS so a single large export order can't make a domestic shop look global,
 * and reported as the PRIMARY market rather than "domestic": Jefe doesn't store the shop's
 * own country, so calling the top destination "home" would be an assumption, not a fact.
 */
function deliveryFootprint(context, definition, days) {
  const orders = ordersInWindow(context, days);
  if (orders.length < 10) {
    return skipped(definition, "insufficient_data", "At least 10 orders in the window are required to read a delivery footprint.", { orders: orders.length });
  }
  const byCountry = new Map();
  let known = 0;
  for (const order of orders) {
    const country = stringValue(order.shippingCountry)?.toUpperCase();
    if (!country) continue;
    known += 1;
    byCountry.set(country, (byCountry.get(country) ?? 0) + 1);
  }
  const coverage = known / orders.length;
  if (known < 10 || coverage < 0.7) {
    return skipped(definition, "insufficient_data", "Too few orders record a destination country (a re-backfill fills this in).", { countryCoverage: roundNumber(coverage, 4), classifiedOrders: known });
  }
  const ranked = Array.from(byCountry.entries()).sort((a, b) => b[1] - a[1]);
  const [primaryCountry, primaryCount] = ranked[0];
  const primaryShare = primaryCount / known;
  const countryCount = ranked.length;

  let shape = "multi_market";
  if (primaryShare >= 0.95) shape = "single_market";
  else if (primaryShare >= 0.75) shape = "one_market_plus_export";
  else if (countryCount >= 10) shape = "international";

  return derived(context, definition, {
    value: {
      enum: shape,
      primaryMarket: primaryCountry,
      primaryMarketShare: roundNumber(primaryShare, 4),
      countriesServed: countryCount,
      classifiedOrders: known,
      destinationCoverage: roundNumber(coverage, 4),
      window: `trailing_${days}d`,
      thresholdVersion: "delivery-footprint-v1",
    },
    confidence: coverageConfidence(0.85, coverage),
    confidenceReason: "Share of orders per destination country over the window.",
    summary: "How concentrated the merchant's delivery markets are.",
    sampleSize: known,
  });
}

/**
 * Is buying here a decision or a habit? A mattress shop and a coffee subscription can turn
 * the same revenue and need opposite advice — "win them back" is meaningless where there is
 * no back.
 *
 * Built only from RATIOS (basket size, order value against the merchant's own catalogue
 * prices, repeat rate), so it needs no currency threshold and no vertical label. Falls to
 * `mixed` unless the signals agree — a guess dressed as a verdict about someone's business
 * is worse than saying nothing.
 */
function purchaseConsideration(context, definition, days) {
  const orders = pricedOrdersInWindow(context, days);
  if (orders.length < 20) {
    return skipped(definition, "insufficient_data", "At least 20 priced orders are required.", { orders: orders.length });
  }
  const catalogPrices = activeVariantPrices(context);
  if (catalogPrices.length < 3) {
    return skipped(definition, "insufficient_data", "At least 3 priced active variants are required to compare order values against the range.", { pricedActiveVariants: catalogPrices.length });
  }
  const basketSizes = orders
    .map((order) => context.quantitiesByOrder.get(order.id))
    .filter((quantity) => typeof quantity === "number" && quantity > 0);
  if (basketSizes.length < 10) {
    return skipped(definition, "insufficient_data", "At least 10 orders with line items are required to read basket size.", { ordersWithLines: basketSizes.length });
  }
  const medianBasket = percentile(basketSizes, 0.5);
  const medianOrder = percentile(orders.map(orderValue).filter((v) => v > 0), 0.5);
  const medianCatalogPrice = percentile(catalogPrices, 0.5);
  // Where the typical order sits in the merchant's own price range: ~1 means people buy one
  // ordinary item; well above means they reach for the expensive end or buy several.
  const basketToCatalogue = medianCatalogPrice > 0 ? medianOrder / medianCatalogPrice : null;

  const repeatCustomers = new Map();
  for (const order of context.datedOrders) {
    const key = stringValue(order.customerExternalId);
    if (!key) continue;
    repeatCustomers.set(key, (repeatCustomers.get(key) ?? 0) + 1);
  }
  const customers = repeatCustomers.size;
  const returning = Array.from(repeatCustomers.values()).filter((count) => count > 1).length;
  const repeatShare = customers === 0 ? null : returning / customers;

  let shape = "mixed";
  const singleItemOrders = medianBasket <= 1;
  const reachesUpwards = basketToCatalogue != null && basketToCatalogue >= 1.5;
  const rarelyReturns = repeatShare != null && repeatShare <= 0.15;
  const oftenReturns = repeatShare != null && repeatShare >= 0.35;
  // Both signals must agree. One alone is just basket size or just loyalty restated.
  if (singleItemOrders && reachesUpwards && rarelyReturns) shape = "considered";
  else if (!singleItemOrders && oftenReturns) shape = "habitual";
  else if (medianBasket >= 2 && basketToCatalogue != null && basketToCatalogue < 1.5) shape = "basket";

  return derived(context, definition, {
    value: {
      enum: shape,
      medianItemsPerOrder: roundNumber(medianBasket, 2),
      orderValueVsTypicalItem: basketToCatalogue == null ? null : roundNumber(basketToCatalogue, 2),
      repeatCustomerShare: repeatShare == null ? null : roundNumber(repeatShare, 4),
      customers,
      orderCount: orders.length,
      window: `trailing_${days}d`,
      thresholdVersion: "purchase-consideration-v1",
    },
    confidence: sampleConfidence(0.75, orders.length, 20, 200),
    confidenceReason: "Basket size and order value against the merchant's own price range, with repeat rate.",
    summary: "Whether buying here is a considered decision or a habit.",
    sampleSize: orders.length,
  });
}

/**
 * What the merchant actually sells, and whose. `productType` and `vendor` were already
 * ingested but only ever used to RANK revenue (`products.revenue_by_product_type` /
 * `_by_vendor`) — nothing read them to say what kind of range this is. A one-category
 * own-brand maker and a multi-brand retailer across eight categories need opposite advice
 * about range, stock and clearance, and were indistinguishable to the ontology.
 *
 * Weighted by PRODUCT COUNT, not revenue: this describes what the business stocks, and
 * revenue-weighting would let a single bestseller define the whole range. What sells is a
 * different question, and the revenue beliefs already answer it.
 */
function rangeComposition(context, definition) {
  const products = context.activeProducts;
  if (products.length < 5) {
    return skipped(definition, "insufficient_data", "At least 5 active products are required to describe a range.", { activeProducts: products.length });
  }
  const typed = products.map((product) => stringValue(product.productType)?.trim()).filter(Boolean);
  const branded = products.map((product) => stringValue(product.vendor)?.trim()).filter(Boolean);
  const typeCoverage = typed.length / products.length;
  const vendorCoverage = branded.length / products.length;

  // Shopify leaves both optional and plenty of merchants never fill them in. A range read
  // off a third of the catalogue would be a guess about someone's business, so it declines.
  // Vendor alone is enough for the brand model; type alone is enough for the category read.
  if (typeCoverage < 0.7 && vendorCoverage < 0.7) {
    return skipped(definition, "insufficient_data", "Too few products record a type or vendor to describe the range.", {
      typeCoverage: roundNumber(typeCoverage, 4),
      vendorCoverage: roundNumber(vendorCoverage, 4),
    });
  }

  const share = (values) => {
    if (!values.length) return { top: null, topShare: null, distinct: 0 };
    const counts = new Map();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return { top: ranked[0][0], topShare: ranked[0][1] / values.length, distinct: ranked.length };
  };
  const category = typeCoverage >= 0.7 ? share(typed) : { top: null, topShare: null, distinct: 0 };
  const brand = vendorCoverage >= 0.7 ? share(branded) : { top: null, topShare: null, distinct: 0 };

  const focusedCategory = category.topShare != null ? category.topShare >= 0.5 : null;
  // One vendor across nearly everything is the signature of a maker selling their own label;
  // many vendors is a retailer stocking other people's. A PROXY — a merchant may simply put
  // their shop name on every product — so both the share and the vendor count are reported
  // for the merchant to correct against.
  const ownBrand = brand.topShare != null ? brand.topShare >= 0.8 : null;

  let shape = "mixed";
  if (ownBrand === true && focusedCategory === true) shape = "own_brand_specialist";
  else if (ownBrand === true && focusedCategory === false) shape = "own_brand_range";
  else if (ownBrand === false && focusedCategory === true) shape = "multi_brand_specialist";
  else if (ownBrand === false && focusedCategory === false) shape = "multi_brand_retailer";

  return derived(context, definition, {
    value: {
      enum: shape,
      leadingCategory: category.top,
      leadingCategoryShare: category.topShare == null ? null : roundNumber(category.topShare, 4),
      categoryCount: category.distinct,
      leadingBrandShare: brand.topShare == null ? null : roundNumber(brand.topShare, 4),
      brandCount: brand.distinct,
      brandModelIsProxy: "vendor_concentration",
      activeProductCount: products.length,
      typeCoverage: roundNumber(typeCoverage, 4),
      vendorCoverage: roundNumber(vendorCoverage, 4),
      thresholdVersion: "range-composition-v1",
    },
    confidence: coverageConfidence(0.8, Math.max(typeCoverage, vendorCoverage)),
    confidenceReason: "Concentration of active products across Shopify product types and vendors.",
    summary: "Whether the merchant sells one category or many, their own brand or other people's.",
    sampleSize: products.length,
  });
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
  if (!currency.ok) return skipped(definition, "insufficient_data", "No priced order carries a currency to report in.", { pricedOrders: context.pricedOrders.length });
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
  if (!currency.ok) return skipped(definition, "insufficient_data", "No priced order carries a currency to report in.", { pricedOrders: context.pricedOrders.length });
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
  if (!currency.ok) return skipped(definition, "insufficient_data", "No priced order carries a currency to report in.", { pricedOrders: context.pricedOrders.length });
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
  if (!currency.ok) return skipped(definition, "insufficient_data", "No priced order carries a currency to report in.", { pricedOrders: context.pricedOrders.length });
  const byDay = sumBy(orders, (order) => dayKey(orderTime(order), context.shopTimezone), orderValue);
  return shareFromValues(context, definition, Array.from(byDay.values()), `trailing_${days}d`, "Top merchant-local sales day revenue divided by window revenue.");
}

function topSalesWeekShare(context, definition, days) {
  const orders = pricedOrdersInWindow(context, days);
  const currency = shopBaseCurrency(context);
  const weekKeys = new Set(orders.map((order) => weekKey(orderTime(order), context.shopTimezone)));
  if (weekKeys.size < 8) return skipped(definition, "insufficient_data", "At least 8 observed weeks are required.", { observedWeeks: weekKeys.size, orders: orders.length });
  if (!currency.ok) return skipped(definition, "insufficient_data", "No priced order carries a currency to report in.", { pricedOrders: context.pricedOrders.length });
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
  const currency = moneyLabelCurrency(context, context.pricedActiveVariants.map((variant) => variant.currency));
  if (!currency.ok) return skipped(definition, "insufficient_data", "No priced active variant carries a currency to report in.", { pricedActiveVariants: context.pricedActiveVariants.length });
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

/**
 * The customer base split into cohorts a merchant can actually act on, rather than a
 * single "repeat rate" number. `repeat_customer_rate` says 30% came back; it cannot say
 * whether that is a handful of people buying constantly or a broad base buying twice, and
 * those want opposite things done about them.
 *
 * Two axes, both read off the hashed identities Jefe already derives from its own order
 * history — no new Shopify data and no new scopes. PII-safe by construction: this returns
 * counts, shares and aggregate money, never an identity.
 *
 * ⚠️ Recency is deliberately store-relative. A fixed "lapsed after 90 days" would mark a
 * furniture buyer lapsed at a perfectly normal gap and miss a coffee subscriber who
 * vanished a month ago — misjudging precisely the businesses the shape beliefs exist to
 * tell apart. So "lapsed" means overdue against THIS store's own observed rhythm, and when
 * there aren't enough repeat customers to establish a rhythm, the recency split is
 * withheld while the count cohorts are still reported. Partial silence beats a fixed-window
 * guess dressed as a finding.
 */
function customerCohortMix(context, definition) {
  const identities = context.customerIdentities;
  if (identities.length < 10) {
    return skipped(definition, "insufficient_data", "At least 10 known customers are required to describe a customer base.", { customerIdentities: identities.length });
  }

  const cohorts = { one_time: { customers: 0, spend: 0 }, returning: { customers: 0, spend: 0 }, loyal: { customers: 0, spend: 0 } };
  let totalSpend = 0;
  /** @type {number[]} */
  const gapsDays = [];
  for (const identity of identities) {
    const orderCount = Number(identity.orderCount ?? 0);
    const spend = Number(identity.totalSpend ?? 0);
    totalSpend += spend;
    const bucket = orderCount >= 4 ? "loyal" : orderCount >= 2 ? "returning" : "one_time";
    cohorts[bucket].customers += 1;
    cohorts[bucket].spend += spend;

    // Average gap between this customer's own orders. Only repeat buyers have one, and it
    // is what the store's rhythm is built from.
    const first = identity.firstSeenOrderAt ? new Date(identity.firstSeenOrderAt).getTime() : null;
    const last = identity.lastOrderAt ? new Date(identity.lastOrderAt).getTime() : null;
    if (orderCount >= 2 && first != null && last != null && last > first) {
      gapsDays.push((last - first) / 86400000 / (orderCount - 1));
    }
  }

  const customerCount = identities.length;
  const shareOf = (bucket) => roundNumber((cohorts[bucket].customers / customerCount) * 100, 2);
  const spendShareOf = (bucket) => (totalSpend > 0 ? roundNumber((cohorts[bucket].spend / totalSpend) * 100, 2) : null);

  const value = {
    customers: customerCount,
    oneTimeSharePercent: shareOf("one_time"),
    returningSharePercent: shareOf("returning"),
    loyalSharePercent: shareOf("loyal"),
    oneTimeRevenueSharePercent: spendShareOf("one_time"),
    returningRevenueSharePercent: spendShareOf("returning"),
    loyalRevenueSharePercent: spendShareOf("loyal"),
    loyalCustomers: cohorts.loyal.customers,
    window: "all_stored_history",
    thresholdVersion: "customer-cohort-v1",
  };

  // MIN_REPEATERS_FOR_RHYTHM: below this the median gap is one or two people's habits, not
  // the store's, and a lapsed count built on it would be noise with a number attached.
  const MIN_REPEATERS_FOR_RHYTHM = 5;
  if (gapsDays.length >= MIN_REPEATERS_FOR_RHYTHM) {
    const typicalGapDays = percentile([...gapsDays].sort((a, b) => a - b), 0.5);
    // Twice the typical gap: one missed cycle is ordinary life, two is a pattern breaking.
    const lapsedAfterDays = typicalGapDays * 2;
    const cutoff = context.now.getTime() - lapsedAfterDays * 86400000;
    let lapsed = 0;
    let lapsedSpend = 0;
    for (const identity of identities) {
      const last = identity.lastOrderAt ? new Date(identity.lastOrderAt).getTime() : null;
      if (last != null && last < cutoff) {
        lapsed += 1;
        lapsedSpend += Number(identity.totalSpend ?? 0);
      }
    }
    value.typicalRepeatGapDays = roundNumber(typicalGapDays, 1);
    value.lapsedAfterDays = roundNumber(lapsedAfterDays, 1);
    value.lapsedCustomers = lapsed;
    value.lapsedSharePercent = roundNumber((lapsed / customerCount) * 100, 2);
    value.lapsedRevenueAtStake = roundMoney(lapsedSpend);
    value.recencyBasis = "store_observed_repeat_gap";
  } else {
    // Named explicitly so a reader can tell "this store has no lapsed customers" apart from
    // "we could not work out what lapsed means here".
    value.recencyBasis = "unavailable_too_few_repeat_customers";
    value.repeatCustomersWithRhythm = gapsDays.length;
  }

  return derived(context, definition, {
    value,
    confidence: sampleConfidence(0.85, customerCount, 10, 200),
    confidenceReason: "Known hashed customer identities grouped by observed order count, with recency measured against the store's own median repeat gap where one can be established.",
    summary: "How the customer base splits between one-time, returning and loyal buyers.",
    sampleSize: customerCount,
  });
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
  const currency = moneyLabelCurrency(context, coverage.successfulTransactions.map((transaction) => transaction.currency));
  if (!currency.ok) return skipped(definition, "insufficient_data", "No successful refund transaction carries a currency to report in.", { successfulTransactions: coverage.successfulTransactions.length });
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
  const currency = moneyLabelCurrency(context, rows.map((row) => row.currency));
  if (!currency.ok) return skipped(definition, "insufficient_data", "No stocked variant carries a currency to report in.", { pricedStockedVariants: rows.length });
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
  const currency = moneyLabelCurrency(context, rows.map((row) => row.currency));
  if (!currency.ok) return skipped(definition, "insufficient_data", "No stocked variant carries a currency to report in.", { pricedStockedVariants: rows.length });
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
  if (!currency.ok) return skipped(definition, "insufficient_data", "No priced order carries a currency to report in.", { pricedOrders: context.pricedOrders.length });
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
  if (!currency.ok) return skipped(definition, "insufficient_data", "No priced order carries a currency to report in.", { pricedOrders: context.pricedOrders.length });
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

// Observe→Learn: whether Jefe's clearance actions actually worked, aggregated from the
// measured outcomes on the action_executions ledger (units moved + cash recovered after
// each applied markdown). This is the "did the action work" belief on the earned-autonomy
// ramp — a merchant whose clearances consistently move stock is one Jefe can act for with
// less friction. Dormant until clearance execution is live (no measured runs while the
// write flag is off); it lights up the moment the first real clearance is measured.
function clearanceEffectiveness(context, definition) {
  const runs = (context.clearanceOutcomes ?? []).filter(
    (run) => run?.outcome && typeof run.outcome === "object",
  );
  if (runs.length < 3) {
    return skipped(definition, "insufficient_data", "At least 3 measured clearance runs are required to summarize effectiveness.", { runs: runs.length });
  }
  let variantsCleared = 0;
  let variantsSold = 0;
  let unitsMoved = 0;
  let revenueRecovered = 0;
  let runsThatMovedStock = 0;
  for (const run of runs) {
    const outcome = run.outcome;
    variantsCleared += Number(outcome.variantsCleared) || 0;
    variantsSold += Number(outcome.variantsSold) || 0;
    unitsMoved += Number(outcome.unitsMoved) || 0;
    revenueRecovered += Number(outcome.revenueRecovered) || 0;
    if ((Number(outcome.variantsSold) || 0) > 0) runsThatMovedStock += 1;
  }
  const total = runs.length;
  return derived(context, definition, {
    value: {
      measuredRuns: total,
      runsThatMovedStock,
      variantsCleared,
      variantsSold,
      unitsMoved,
      revenueRecovered: roundNumber(revenueRecovered, 2),
      // Share of cleared variants that sold at least one unit post-clearance.
      variantSellThroughPercent: variantsCleared > 0 ? roundNumber((variantsSold / variantsCleared) * 100, 2) : 0,
      // Share of runs that moved at least one variant — the headline "clearances work here" rate.
      runEffectivenessPercent: roundNumber((runsThatMovedStock / total) * 100, 2),
      window: "all_stored_history",
    },
    confidence: sampleConfidence(0.9, total, 3, 30),
    confidenceReason: "Direct counts of measured clearance-run outcomes.",
    summary: `${runsThatMovedStock} of ${total} clearances moved stock; ${unitsMoved} units recovered.`,
    sampleSize: total,
    supportingValues: { measuredRuns: total, unitsMoved },
  });
}

// Observe→Learn: what the merchant rejects and why, aggregated from the PII-safe
// merchant_action_declined events (reasonCategory is a slug; the free-text note is
// redacted at write). The plan-rec can read this to propose better next time — e.g. a
// merchant who keeps declining clearances as "too aggressive" wants gentler markdowns.
// Dormant until execution is live (the Decline control only renders when actions are
// executable), so declines flow once the write flag is on.
function actionDeclineSignal(context, definition) {
  const declines = (context.actionDeclines ?? []).filter(
    (event) => event?.properties && typeof event.properties === "object",
  );
  if (declines.length < 3) {
    return skipped(definition, "insufficient_data", "At least 3 declined actions are required to summarize the decline signal.", { declines: declines.length });
  }
  /** @type {Record<string, number>} */
  const byReasonCategory = {};
  /** @type {Record<string, number>} */
  const byActionType = {};
  for (const event of declines) {
    const props = event.properties;
    const category = typeof props.reasonCategory === "string" && props.reasonCategory ? props.reasonCategory : "unspecified";
    byReasonCategory[category] = (byReasonCategory[category] ?? 0) + 1;
    const actionType = typeof props.actionType === "string" && props.actionType ? props.actionType : "unknown";
    byActionType[actionType] = (byActionType[actionType] ?? 0) + 1;
  }
  const total = declines.length;
  const topEntry = Object.entries(byReasonCategory).sort((a, b) => b[1] - a[1])[0];
  const topReasonCategory = topEntry ? topEntry[0] : "unspecified";
  const topReasonCount = topEntry ? topEntry[1] : 0;
  return derived(context, definition, {
    value: {
      totalDeclines: total,
      byReasonCategory,
      byActionType,
      topReasonCategory,
      topReasonSharePercent: roundNumber((topReasonCount / total) * 100, 2),
      window: "all_stored_history",
    },
    confidence: sampleConfidence(0.9, total, 3, 30),
    confidenceReason: "Direct counts of merchant action declines by reason category.",
    summary: `${total} suggestions declined; most common reason: ${topReasonCategory}.`,
    sampleSize: total,
    supportingValues: { totalDeclines: total },
  });
}

// business.tool_stack — the DB-derivation feeder for tool-stack detection. Runs the pure
// `detectToolStack` over signals extracted from already-fetched records (context.toolStackSignals)
// and shapes the shared belief content. MODEL INFERENCE: value confidence is the strongest single
// matched signal, so a weak tag-only guess never publishes as near-certain, and the standard
// `derived()` path writes it at systemInference precedence (merchant-correctable). The live-query
// feeder (detectAndRecordToolStack → recordBelief seam) writes the same belief key from signals we
// don't ingest (metafield namespaces); reconciling the two feeders is a deferred design call.
function toolStack(context, definition) {
  const signals = context.toolStackSignals ?? {};
  const detected = detectToolStack(signals);
  if (detected.length < 1) {
    return skipped(
      definition,
      "insufficient_data",
      "No third-party tool signatures matched the observed Shopify signals.",
      {
        metafieldNamespaces: (signals.metafieldNamespaces ?? []).length,
        gateways: (signals.gateways ?? []).length,
        orderTags: (signals.orderTags ?? []).length,
        customerTags: (signals.customerTags ?? []).length,
        fulfillmentServices: (signals.fulfillmentServices ?? []).length,
      },
    );
  }
  const content = toolStackBeliefContent(detected);
  return derived(context, definition, {
    value: content.value,
    confidence: content.confidence,
    confidenceReason: content.confidenceReason,
    summary: content.summary,
    sampleSize: detected.length,
    supportingValues: { toolIds: content.value.toolIds, categories: content.value.categories },
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
  // Someone else's shopfront. Checked BEFORE `online`: selling on Amazon is not selling on
  // your own site — you don't own the customer, the pricing pressure is different, and
  // clearance advice that assumes you control the storefront is wrong. Everything here used
  // to fall into "other" and vanish. Real channels seen across 207 merchants in the Quiver
  // warehouse: amazon-uk, ebay, reverb, faire.
  if (/amazon|ebay|etsy|walmart|reverb|faire|onbuy|notonthehighstreet/.test(value)) return "marketplace";
  // Social storefronts — discovery-led, and the merchant does own the customer, so they sit
  // apart from both marketplaces and the merchant's own site. Seen: tiktok, facebook.
  if (/tiktok|facebook|instagram|pinterest|snapchat/.test(value)) return "social";
  if (
    value === "web" ||
    value === "online_store" ||
    value === "shopify_online_store" ||
    value.includes("online store") ||
    // A headless/custom storefront is still the merchant's own site.
    value === "hydrogen" ||
    value === "headless" ||
    value.includes("buy_button") ||
    value.includes("buy-button")
  ) {
    return "online";
  }
  if (value.includes("draft")) return "draft";
  // Shopify's own B2B channel — a real wholesale signal, unlike the draft-order proxy.
  if (value === "b2b" || value.includes("wholesale")) return "trade";
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
    return skipped(definition, "insufficient_data", "No priced orders yet to report a currency in.", { currencies: currency.currencies.length });
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
    return skipped(definition, "insufficient_data", "No priced orders yet to report a currency in.", { currencies: currency.currencies.length });
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

// Discount depth — how much of the store's pre-discount revenue is given away in
// discounts, plus the share of orders that carried any discount. A margin-leak
// signal: heavy discounting can hide thin real margins. Shop base currency.
function discountDepth(context, definition, days) {
  const orders = pricedOrdersInWindow(context, days);
  if (orders.length < 5) {
    return skipped(definition, "insufficient_data", "At least 5 priced orders in the window are required.", { orders: orders.length });
  }
  const currency = shopBaseCurrency(context);
  if (!currency.ok) {
    return skipped(definition, "insufficient_data", "No priced orders yet to report a currency in.", { currencies: currency.currencies.length });
  }
  let totalDiscount = 0;
  let totalNet = 0;
  let discountedOrders = 0;
  for (const order of orders) {
    const discount = decimalNumber(order.totalDiscount);
    totalDiscount += discount;
    totalNet += decimalNumber(order.totalPrice);
    if (discount > 0) discountedOrders += 1;
  }
  const gross = totalNet + totalDiscount;
  if (gross <= 0) {
    return skipped(definition, "insufficient_data", "No positive revenue in the window.", { gross: roundMoney(gross) });
  }
  return derived(context, definition, {
    value: {
      percentage: roundNumber((totalDiscount / gross) * 100, 2),
      discountedOrderSharePercent: roundNumber((discountedOrders / orders.length) * 100, 2),
      totalDiscount: roundMoney(totalDiscount),
      grossRevenue: roundMoney(gross),
      netRevenue: roundMoney(totalNet),
      discountedOrderCount: discountedOrders,
      currency: currency.currency,
      window: `trailing_${days}d`,
    },
    confidence: 0.9,
    confidenceReason: "Total discounts divided by gross (pre-discount) revenue over the window, plus the share of orders carrying any discount.",
    summary: `Share of pre-discount revenue given away in discounts in the trailing ${days} days.`,
    sampleSize: orders.length,
  });
}

/**
 * How a visit is classified into an acquisition channel.
 *
 * UTM medium is checked FIRST and wins outright, because it is what the merchant declared
 * about their own campaign. Inferring "google = search" over an explicit `utm_medium=cpc`
 * would file paid traffic as organic — the single most expensive mistake available here,
 * since it makes ad spend look free.
 *
 * @param {Record<string, unknown>} visit
 */
function classifyAcquisitionSource(visit) {
  const medium = stringValue(visit?.utmMedium)?.toLowerCase() ?? "";
  if (/cpc|ppc|paid|display|retargeting/.test(medium)) return "paid";
  if (medium === "email" || medium === "newsletter") return "email";
  if (/social/.test(medium)) return "social";
  if (medium === "organic") return "search";
  if (medium === "referral") return "referral";

  const source = stringValue(visit?.source)?.toLowerCase() ?? "";
  // Shopify writes an explicit "an unknown source" string for direct arrivals; an empty
  // source means the same thing.
  if (source === "" || source.includes("unknown")) return "direct";
  if (/adwords|googleads|doubleclick|gclid/.test(source)) return "paid";
  if (/klaviyo|mailchimp|campaign-monitor|sendgrid|omnisend/.test(source)) return "email";
  if (/facebook|instagram|tiktok|pinterest|twitter|x\.com|youtube|linkedin|snapchat|reddit/.test(source)) return "social";
  if (/google|bing|duckduckgo|yahoo|ecosia|baidu/.test(source)) return "search";
  return "referral";
}

/**
 * Where the merchant's orders actually come from — paid, organic search, social, email,
 * referral or direct.
 *
 * Jefe could describe what a store sold in enormous detail and never why anyone turned up,
 * so "is the ad spend working" and "how much of this is just repeat direct traffic" were
 * not questions it could engage with at all.
 *
 * ⚠️ Reads FIRST touch, not last. Last-click flatters whatever sits closest to the
 * checkout — usually direct and email — and would tell a merchant their ads do nothing
 * while the ads are what introduced the customer. Last touch is stored too, and a
 * follow-up belief can compare them; this one answers "where do customers come from".
 *
 * ⛔ Coverage-gated hard, because the absent state here is especially misleading: the
 * journey fields are only requested when ORDER_ATTRIBUTION_INGEST_ENABLED is on, so every
 * order predating that flag carries {} — which is indistinguishable from "arrived from
 * nowhere". Ungated, this belief would report a healthy store as 100% direct.
 */
function acquisitionMix(context, definition, days) {
  const orders = ordersInWindow(context, days);
  if (orders.length < 10) {
    return skipped(definition, "insufficient_data", "At least 10 orders in the window are required to read an acquisition mix.", { orders: orders.length });
  }

  const byChannel = new Map();
  const bySource = new Map();
  let attributed = 0;
  for (const order of orders) {
    const attribution = jsonObject(order.attribution);
    const firstVisit = jsonObject(attribution.firstVisit);
    if (Object.keys(attribution).length === 0) continue;
    attributed += 1;
    const channel = classifyAcquisitionSource(firstVisit);
    byChannel.set(channel, (byChannel.get(channel) ?? 0) + 1);
    // The raw source is kept alongside the bucket so a merchant can see the evidence rather
    // than only Jefe's classification of it, and correct the premise if it is wrong.
    const raw = stringValue(firstVisit.source) ?? "(direct)";
    bySource.set(raw, (bySource.get(raw) ?? 0) + 1);
  }

  const coverage = attributed / orders.length;
  if (attributed < 10 || coverage < 0.7) {
    return skipped(definition, "blocked_by_data_quality", "Too few orders record where the customer came from (attribution ingest may be off, or these orders predate it).", {
      attributionCoverage: roundNumber(coverage, 4),
      attributedOrders: attributed,
      orders: orders.length,
    });
  }

  const shareOf = (channel) => roundNumber(((byChannel.get(channel) ?? 0) / attributed) * 100, 2);
  const topSources = Array.from(bySource.entries())
    .map(([source, count]) => ({ source, orders: count, sharePercent: roundNumber((count / attributed) * 100, 2) }))
    .sort((a, b) => b.orders - a.orders)
    .slice(0, 10);

  return derived(context, definition, {
    value: {
      paidSharePercent: shareOf("paid"),
      searchSharePercent: shareOf("search"),
      socialSharePercent: shareOf("social"),
      emailSharePercent: shareOf("email"),
      referralSharePercent: shareOf("referral"),
      directSharePercent: shareOf("direct"),
      topSources,
      attributedOrders: attributed,
      attributionCoverage: roundNumber(coverage, 4),
      touch: "first",
      window: `trailing_${days}d`,
      thresholdVersion: "acquisition-mix-v1",
    },
    confidence: coverageConfidence(0.8, coverage),
    confidenceReason: "Share of orders per first-touch acquisition channel over the window, classified from declared UTM medium where present and the referring source otherwise.",
    summary: `Where orders came from in the trailing ${days} days, by first touch.`,
    sampleSize: orders.length,
    coverageMetrics: { attributionCoverage: roundNumber(coverage, 4) },
  });
}

/**
 * WHICH offers are doing the discounting — the companion to `discountDepth`, which only
 * ever knew how much.
 *
 * The distinction that matters is typed vs automatic. A customer entering SUMMER20 chose
 * to respond to an offer; an automatic site-wide 10% is a price cut the merchant is
 * running whether anyone noticed or not. Both look identical in `total_discount` and mean
 * opposite things — the first is a campaign with a response rate, the second is margin
 * leaving quietly. A permanent "welcome" code that fires on nearly every order is the
 * clearest case: nominally a promotion, actually the price.
 *
 * ⚠️ Coverage-gated, and the gate is load-bearing here in a way it isn't elsewhere. Orders
 * ingested before the discount-identity migration carry `[]` because the field was never
 * requested, which at the column level is indistinguishable from "this order had no
 * discount". Reading a code mix across those would confidently report that a store runs no
 * campaigns. So coverage is measured against orders KNOWN to be discounted
 * (`totalDiscount > 0`), not against all orders, and thin coverage returns silence.
 */
function discountCodeMix(context, definition, days) {
  const orders = pricedOrdersInWindow(context, days);
  if (orders.length < 5) {
    return skipped(definition, "insufficient_data", "At least 5 priced orders in the window are required.", { orders: orders.length });
  }
  const currency = shopBaseCurrency(context);
  if (!currency.ok) {
    return skipped(definition, "insufficient_data", "No priced orders yet to report a currency in.", { currencies: currency.currencies.length });
  }

  const discountedOrders = orders.filter((order) => decimalNumber(order.totalDiscount) > 0);
  if (discountedOrders.length < 5) {
    return skipped(definition, "insufficient_data", "At least 5 discounted orders in the window are required to read a code mix.", { discountedOrders: discountedOrders.length });
  }

  // An order counts as "identified" if we know which offer discounted it. Anything else is
  // a pre-migration row whose identity was never requested.
  let identified = 0;
  let typedCodeOrders = 0;
  const byLabel = new Map();
  for (const order of discountedOrders) {
    const applications = jsonArray(order.discountApplications);
    const codes = jsonArray(order.discountCodes);
    if (applications.length === 0 && codes.length === 0) continue;
    identified += 1;
    const discount = decimalNumber(order.totalDiscount);
    const labels = applications.length > 0
      ? applications.map((entry) => ({
          label: stringValue(entry?.label),
          kind: stringValue(entry?.kind) ?? "automatic",
        }))
      : codes.map((code) => ({ label: stringValue(code), kind: "code" }));
    if (labels.some((entry) => entry.kind === "code")) typedCodeOrders += 1;
    // One order can carry several offers; the discount is not split between them because we
    // cannot know the split from the order total. Attributing the full amount to each would
    // double-count revenue, so `orders` is the honest denominator and money is reported as
    // the discount on orders where the offer appeared.
    for (const entry of labels) {
      if (entry.label == null) continue;
      const current = byLabel.get(entry.label) ?? { label: entry.label, kind: entry.kind, orders: 0, discountOnOrders: 0 };
      current.orders += 1;
      current.discountOnOrders += discount;
      byLabel.set(entry.label, current);
    }
  }

  const coverage = identified / discountedOrders.length;
  if (identified < 5 || coverage < 0.7) {
    return skipped(definition, "blocked_by_data_quality", "Too few discounted orders record which offer discounted them (a re-backfill fills this in).", {
      discountIdentityCoverage: roundNumber(coverage, 4),
      identifiedOrders: identified,
      discountedOrders: discountedOrders.length,
    });
  }

  const offers = Array.from(byLabel.values())
    .map((entry) => ({
      label: entry.label,
      kind: entry.kind,
      orders: entry.orders,
      orderSharePercent: roundNumber((entry.orders / identified) * 100, 2),
      discountOnOrders: roundMoney(entry.discountOnOrders),
    }))
    .sort((a, b) => b.orders - a.orders)
    .slice(0, 10);

  const typedShare = typedCodeOrders / identified;
  return derived(context, definition, {
    value: {
      offers,
      distinctOffers: byLabel.size,
      typedCodeOrderSharePercent: roundNumber(typedShare * 100, 2),
      automaticOrderSharePercent: roundNumber((1 - typedShare) * 100, 2),
      identifiedOrders: identified,
      discountedOrders: discountedOrders.length,
      discountIdentityCoverage: roundNumber(coverage, 4),
      currency: currency.currency,
      window: `trailing_${days}d`,
    },
    confidence: coverageConfidence(0.85, coverage),
    confidenceReason: "Share of discounted orders per named offer over the window, split by whether the customer typed a code or the discount applied automatically.",
    summary: `Which offers are discounting orders in the trailing ${days} days, and whether customers typed them.`,
    sampleSize: discountedOrders.length,
    coverageMetrics: { discountIdentityCoverage: roundNumber(coverage, 4) },
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
    return skipped(definition, "insufficient_data", "No priced orders yet to report a currency in.", { currencies: currency.currencies.length });
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
    return skipped(definition, "insufficient_data", "No priced orders yet to report a currency in.", { currencies: currency.currencies.length });
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

// The base currency of a set of stored money records, and the ONLY currency guard money
// beliefs should use.
//
// It never fails on currency multiplicity, because multiplicity is not a problem: every
// amount Jefe stores is Shopify `shopMoney`, already converted into the shop's base currency
// at the rate that applied when the sale happened. A merchant selling in six currencies has
// one real, correct average order value in their own currency — Shopify did the conversion
// before we ever saw the row. What varies is the CUSTOMER's presentment currency, which says
// nothing about whether the shop-currency amounts can be added up.
//
// This replaced a `singleCurrency` guard that refused whenever more than one currency label
// appeared. That refusal produced no belief at all, and a skipped belief is invisible to the
// merchant — so Jefe silently knew nothing about the money of any store that sells abroad,
// and it looked principled rather than broken. `ok` is false only when there are no priced
// records to read a currency from, which is an insufficient-data case, not a quality one.
/** @param {Array<string | null | undefined>} currencies */
function baseCurrencyOf(currencies) {
  const distribution = currencyDistribution(currencies);
  return {
    ok: distribution.entries.length >= 1,
    currency: distribution.entries[0]?.currency ?? null,
    currencies: distribution.entries.map((entry) => entry.currency),
  };
}

// Every record Jefe can read a REAL currency from. The dominant one is the working proxy for
// the shop's base currency.
//
// ⛔ This EXACT sample also feeds `business.primary_currency`, and that is not incidental —
// it is what stops Jefe contradicting itself. When `shopBaseCurrency` read one set of records
// and `primary_currency` read another, the two disagreed on any near-tie, and Jefe would tell
// a merchant their primary currency was GBP and their average order was "€100" on the same
// screen. The belief is canonical; a figure Jefe states must never contradict the belief
// describing it. One sample, one answer.
//
// ⛔ VARIANTS ARE EXCLUDED, and must stay excluded. `Variant.currency` is not observed data:
// ingestion calls `currencyCode(variant.price)`, the Shopify query fetches `price` as a bare
// Money scalar ("10.00"), and `currencyCode` falls through to a hardcoded "GBP" default
// (`normalize.server.js:26-35`). So EVERY variant of EVERY merchant reads GBP, including a
// US store's. Counting those votes let an invented value decide what currency Jefe states a
// merchant's money in — inferred data presented as observed, which is the one line we don't
// cross.
//
// ⚠️ What remains is still a PROXY: `Order.currency` is the customer's PRESENTMENT currency,
// not the shop's base currency (the amounts beside it are already base-currency shopMoney).
// The true value is fetched and stored — `Order.rawPayload.currentTotalPriceSet.shopMoney
// .currencyCode` — but the derivation's order select doesn't read `rawPayload`, and pulling a
// full JSON blob per order to get it is not free. The real fix is to persist the shop's base
// currency once, on the shop, where it belongs. Until then this is the honest best available,
// and it is at least consistent across everything Jefe says.
/** @param {any} context */
function pricedCurrencySample(context) {
  return [
    ...context.pricedOrders.map((/** @type {any} */ order) => order.currency),
    ...(context.successfulRefundCoverage?.successfulTransactions ?? []).map(
      (/** @type {any} */ transaction) => transaction.currency,
    ),
  ];
}

// The shop's base currency. See `baseCurrencyOf` for why multiplicity is not a failure.
function shopBaseCurrency(context) {
  return baseCurrencyOf(pricedCurrencySample(context));
}

// The currency to STATE a money figure in. Always the shop's base currency where Jefe has
// one, whatever records the figure was computed from — because every stored amount is
// base-currency shopMoney, so one shop has exactly one honest money label.
//
// `fallbackCurrencies` covers the store that has products but has not sold anything yet:
// there are no orders to read a base currency from, but a price belief is still worth having.
// It is a fallback only — for a trading store the shop answer always wins, which is what
// stops the hardcoded "GBP" on variant rows (see `pricedCurrencySample`) labelling a US
// merchant's stock value in sterling.
/** @param {any} context @param {Array<string | null | undefined>} fallbackCurrencies */
function moneyLabelCurrency(context, fallbackCurrencies) {
  const shop = shopBaseCurrency(context);
  return shop.ok ? shop : baseCurrencyOf(fallbackCurrencies);
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

// Prisma Json columns arrive as unknown. A non-array (null, {}, a string from a bad write)
// reads as "nothing recorded" rather than throwing mid-derivation.
function jsonArray(value) {
  return Array.isArray(value) ? value : [];
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
