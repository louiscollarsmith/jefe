// @ts-check

export const WATCHDOG_ACTION_TYPE = "watchdog_alert";
export const WATCHDOG_FORMULA_VERSION = "watchdog_v0";

const CURRENT_PERIOD_DAYS = 7;
const COMPARISON_PERIOD_DAYS = 30;
const REVENUE_DROP_MIN_BASELINE = 500;
const IMPORTANT_SELLER_REVENUE_THRESHOLD = 100;

/**
 * @typedef {"refund_spike" | "sku_sales_collapse" | "product_unavailable" | "revenue_drop" | "unusual_stock_movement" | "missing_cogs_important_seller" | "high_return_product"} WatchdogAlertType
 * @typedef {"critical" | "warning" | "watch"} WatchdogSeverity
 * @typedef {"low" | "medium" | "high"} WatchdogConfidence
 */

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; now?: Date }} input
 */
export async function generateWatchdog(prisma, input) {
  const payload = await buildWatchdogPayload(prisma, input);
  const actions = await persistWatchdogAlerts(prisma, payload);

  return { ...payload, persistedActionCount: actions.length };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; now?: Date }} input
 */
export async function buildWatchdogPayload(prisma, input) {
  const now = input.now ?? new Date();
  const currentStart = subtractDays(now, CURRENT_PERIOD_DAYS);
  const comparisonStart = subtractDays(
    currentStart,
    COMPARISON_PERIOD_DAYS,
  );
  const [merchant, orders, lineItems, refunds, variants, cogsInputs, ledgerEvents] =
    await Promise.all([
      prisma.merchant.findUnique({
        where: { id: input.merchantId },
        select: { primaryCurrency: true },
      }),
      prisma.order.findMany({
        where: {
          merchantId: input.merchantId,
          shopId: input.shopId,
          processedAt: { gte: comparisonStart, lt: now },
        },
        include: { lineItems: true, refunds: true },
      }),
      prisma.orderLineItem.findMany({
        where: {
          merchantId: input.merchantId,
          shopId: input.shopId,
          order: { processedAt: { gte: comparisonStart, lt: now } },
        },
        include: { order: true, product: true, variant: true },
      }),
      prisma.refund.findMany({
        where: {
          merchantId: input.merchantId,
          shopId: input.shopId,
          OR: [
            { processedAt: { gte: comparisonStart, lt: now } },
            { sourceCreatedAt: { gte: comparisonStart, lt: now } },
          ],
        },
        include: {
          order: {
            include: {
              lineItems: {
                include: { product: true, variant: true },
              },
            },
          },
        },
      }),
      prisma.variant.findMany({
        where: { merchantId: input.merchantId, shopId: input.shopId },
        include: { product: true, inventoryLevels: true },
      }),
      prisma.cogsInput.findMany({
        where: {
          merchantId: input.merchantId,
          shopId: input.shopId,
          effectiveFrom: { lte: now },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
        },
        orderBy: [{ updatedAt: "desc" }, { effectiveFrom: "desc" }],
      }),
      prisma.ledgerEvent.findMany({
        where: {
          merchantId: input.merchantId,
          shopId: input.shopId,
          eventType: "shopify.webhook.inventory_levels/update",
          eventTs: { gte: currentStart, lt: now },
        },
        orderBy: [{ eventTs: "asc" }],
      }),
    ]);

  return buildWatchdogView({
    merchantId: input.merchantId,
    shopId: input.shopId,
    now,
    currentStart,
    comparisonStart,
    orders,
    lineItems,
    refunds,
    variants,
    cogsInputs,
    ledgerEvents,
    currency: firstCurrency(lineItems, refunds) ?? merchant?.primaryCurrency ?? "GBP",
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {ReturnType<typeof buildWatchdogView>} payload
 */
export async function persistWatchdogAlerts(prisma, payload) {
  const proposedAt = new Date(payload.generatedAt);
  const actionDate = dateOnly(proposedAt);

  return Promise.all(
    payload.alerts.map((alert) =>
      prisma.action.upsert({
        where: {
          merchantId_idempotencyKey: {
            merchantId: payload.merchantId,
            idempotencyKey: `watchdog:${payload.shopId}:${actionDate}:${alert.type}:${alert.affectedVariantId ?? alert.affectedProductId ?? "store"}`,
          },
        },
        create: {
          merchantId: payload.merchantId,
          shopId: payload.shopId,
          actionType: WATCHDOG_ACTION_TYPE,
          status: "proposed",
          expectedValue: actionExpectedValue(alert, payload.currency),
          confidence: confidenceScore(alert.confidence).toFixed(4),
          riskLevel: alert.severity,
          evidence: actionEvidence(alert),
          rulesConsulted: [],
          ruleConstraintsApplied: [],
          preview: actionPreview(alert),
          verificationClass: "ESTIMATED",
          idempotencyKey: `watchdog:${payload.shopId}:${actionDate}:${alert.type}:${alert.affectedVariantId ?? alert.affectedProductId ?? "store"}`,
          proposedAt,
        },
        update: {
          status: "proposed",
          expectedValue: actionExpectedValue(alert, payload.currency),
          confidence: confidenceScore(alert.confidence).toFixed(4),
          riskLevel: alert.severity,
          evidence: actionEvidence(alert),
          preview: actionPreview(alert),
          verificationClass: "ESTIMATED",
          proposedAt,
        },
      }),
    ),
  );
}

/**
 * @param {{
 *   merchantId: string;
 *   shopId: string;
 *   now: Date;
 *   currentStart: Date;
 *   comparisonStart: Date;
 *   orders: any[];
 *   lineItems: any[];
 *   refunds: any[];
 *   variants: any[];
 *   cogsInputs: any[];
 *   ledgerEvents: any[];
 *   currency: string;
 * }} input
 */
export function buildWatchdogView(input) {
  const currentEnd = input.now;
  const comparisonEnd = input.currentStart;
  const currentOrders = input.orders.filter((order) =>
    inWindow(order.processedAt, input.currentStart, currentEnd),
  );
  const comparisonOrders = input.orders.filter((order) =>
    inWindow(order.processedAt, input.comparisonStart, comparisonEnd),
  );
  const currentLineItems = input.lineItems.filter((lineItem) =>
    inWindow(lineItem.order?.processedAt, input.currentStart, currentEnd),
  );
  const comparisonLineItems = input.lineItems.filter((lineItem) =>
    inWindow(lineItem.order?.processedAt, input.comparisonStart, comparisonEnd),
  );
  const currentRefunds = input.refunds.filter((refund) =>
    refundInWindow(refund, input.currentStart, currentEnd),
  );
  const comparisonRefunds = input.refunds.filter((refund) =>
    refundInWindow(refund, input.comparisonStart, comparisonEnd),
  );
  const cogsByVariantId = firstBy(input.cogsInputs, "variantId");
  const alerts = [
    detectRefundSpike({
      merchantId: input.merchantId,
      shopId: input.shopId,
      currency: input.currency,
      currentStart: input.currentStart,
      currentEnd,
      comparisonStart: input.comparisonStart,
      comparisonEnd,
      currentOrders,
      comparisonOrders,
      currentLineItems,
      comparisonLineItems,
      currentRefunds,
      comparisonRefunds,
    }),
    ...detectSkuSalesCollapse({
      merchantId: input.merchantId,
      shopId: input.shopId,
      currency: input.currency,
      currentStart: input.currentStart,
      currentEnd,
      comparisonStart: input.comparisonStart,
      comparisonEnd,
      currentLineItems,
      comparisonLineItems,
    }),
    ...detectProductUnavailable({
      merchantId: input.merchantId,
      shopId: input.shopId,
      currency: input.currency,
      currentStart: input.currentStart,
      currentEnd,
      comparisonStart: input.comparisonStart,
      comparisonEnd,
      variants: input.variants,
      comparisonLineItems,
    }),
    detectRevenueDrop({
      merchantId: input.merchantId,
      shopId: input.shopId,
      currency: input.currency,
      currentStart: input.currentStart,
      currentEnd,
      comparisonStart: input.comparisonStart,
      comparisonEnd,
      currentOrders,
      comparisonOrders,
      currentLineItems,
      comparisonLineItems,
    }),
    ...detectUnusualStockMovement({
      merchantId: input.merchantId,
      shopId: input.shopId,
      currency: input.currency,
      currentStart: input.currentStart,
      currentEnd,
      variants: input.variants,
      ledgerEvents: input.ledgerEvents,
      currentLineItems,
    }),
    ...detectMissingCogsImportantSellers({
      merchantId: input.merchantId,
      shopId: input.shopId,
      currency: input.currency,
      currentStart: input.currentStart,
      currentEnd,
      currentLineItems,
      cogsByVariantId,
    }),
    ...detectHighReturnProducts({
      merchantId: input.merchantId,
      shopId: input.shopId,
      currency: input.currency,
      currentStart: subtractDays(input.now, COMPARISON_PERIOD_DAYS),
      currentEnd,
      lineItems: input.lineItems.filter((lineItem) =>
        inWindow(lineItem.order?.processedAt, subtractDays(input.now, COMPARISON_PERIOD_DAYS), currentEnd),
      ),
      refunds: input.refunds.filter((refund) =>
        refundInWindow(refund, subtractDays(input.now, COMPARISON_PERIOD_DAYS), currentEnd),
      ),
    }),
  ].filter(isWatchdogAlert);
  const sortedAlerts = alerts.sort(compareAlerts);
  const estimatedValueAtRisk = roundMoney(
    sortedAlerts.reduce(
      (sum, alert) => sum + Number(alert.estimatedValueAtRisk ?? 0),
      0,
    ),
  );
  const metrics = {
    critical: countSeverity(sortedAlerts, "critical"),
    warning: countSeverity(sortedAlerts, "warning"),
    watch: countSeverity(sortedAlerts, "watch"),
    estimatedValueAtRisk,
    currency: input.currency,
  };

  return {
    merchantId: input.merchantId,
    shopId: input.shopId,
    currency: input.currency,
    generatedAt: input.now.toISOString(),
    statusStrip: {
      currentPeriod: "Last 7 days",
      comparisonPeriod: "Compared against previous 30 days",
    },
    hero: {
      alertCount: sortedAlerts.length,
      highestSeverity: highestSeverity(sortedAlerts),
      estimatedValueAtRisk,
      message: heroMessage(sortedAlerts, estimatedValueAtRisk, input.currency),
    },
    metrics,
    alerts: sortedAlerts,
    emptyState: watchdogEmptyState({
      alertCount: sortedAlerts.length,
      comparisonOrderCount: comparisonOrders.length,
      comparisonLineItemCount: comparisonLineItems.length,
    }),
    limitations: {
      refundData:
        input.refunds.length === 0
          ? "Refund checks are limited because refund data is incomplete or no refunds have synced yet."
          : null,
      inventoryMovement:
        input.ledgerEvents.length === 0
          ? "Unusual stock movement checks need inventory webhook history before Jefe can compare changes."
          : null,
    },
    verificationClass: "estimated",
  };
}

/**
 * @param {any} input
 */
function detectRefundSpike(input) {
  const currentRevenue = lineItemsRevenue(input.currentLineItems);
  const comparisonRevenue = lineItemsRevenue(input.comparisonLineItems);
  const currentRefundAmount = refundAmount(input.currentRefunds);
  const comparisonRefundAmount = refundAmount(input.comparisonRefunds);
  const currentRefundRate =
    currentRevenue > 0 ? (currentRefundAmount / currentRevenue) * 100 : currentRefundAmount > 0 ? 100 : 0;
  const comparisonRefundRate =
    comparisonRevenue > 0 ? (comparisonRefundAmount / comparisonRevenue) * 100 : 0;
  const spikeDetected =
    input.currentRefunds.length >= 2 &&
    comparisonRefundRate > 0 &&
    currentRefundRate >= comparisonRefundRate * 2;
  const fallbackDetected =
    input.currentRefunds.length >= 3 && currentRefundRate >= 15;

  if (!spikeDetected && !fallbackDetected) return null;

  const affected = affectedProductsFromRefunds(input.currentRefunds);
  const multiplier =
    comparisonRefundRate > 0
      ? roundNumber(currentRefundRate / comparisonRefundRate, 1)
      : null;

  return alertRecord({
    merchantId: input.merchantId,
    shopId: input.shopId,
    type: "refund_spike",
    title:
      multiplier === null
        ? "Refunds are unusually high this week"
        : `Refunds are ${multiplier}x higher than baseline`,
    summary:
      multiplier === null
        ? `Jefe found ${input.currentRefunds.length} refunds in the last 7 days, equal to ${roundPercent(currentRefundRate)}% of revenue.`
        : `Jefe found ${input.currentRefunds.length} refunds this week, equal to ${roundPercent(currentRefundRate)}% of revenue versus ${roundPercent(comparisonRefundRate)}% in the previous 30 days.`,
    severity:
      currentRefundAmount >= 250 || currentRefundRate >= 30
        ? "critical"
        : "warning",
    confidence:
      comparisonRevenue > 0 && affected.length > 0 ? "high" : "medium",
    estimatedValueAtRisk: currentRefundAmount,
    affectedProductId: affected[0]?.productId ?? null,
    affectedVariantId: affected[0]?.variantId ?? null,
    affectedSku: affected[0]?.sku ?? null,
    suggestedCheck:
      "Review the refunded orders and look for repeated issues with sizing, product quality, delivery, or customer expectations.",
    evidence: {
      formulaVersion: WATCHDOG_FORMULA_VERSION,
      rule: "current_7d_refund_rate >= 2x previous_30d_refund_rate and current_7d_refund_count >= 2, or current_7d_refunds >= 3 and refund_rate >= 15%",
      currentRefundCount: input.currentRefunds.length,
      currentRefundAmount,
      currentRefundRatePercent: roundPercent(currentRefundRate),
      comparisonRefundCount: input.comparisonRefunds.length,
      comparisonRefundAmount,
      comparisonRefundRatePercent: roundPercent(comparisonRefundRate),
      affectedProducts: affected,
      refundIds: input.currentRefunds
        .map(
          /** @param {any} refund */
          (refund) => refund.id,
        )
        .filter(Boolean),
      sourceOrderRefs: input.currentRefunds
        .map(
          /** @param {any} refund */
          (refund) => refund.order?.orderName ?? refund.order?.externalId,
        )
        .filter(Boolean),
      limitation:
        "Refunds are stored at order level in v0, so product attribution is inferred from refunded orders.",
    },
    periodStart: input.currentStart,
    periodEnd: input.currentEnd,
    comparisonStart: input.comparisonStart,
    comparisonEnd: input.comparisonEnd,
  });
}

/**
 * @param {any} input
 */
function detectSkuSalesCollapse(input) {
  const previous = aggregateByVariant(input.comparisonLineItems);
  const current = aggregateByVariant(input.currentLineItems);
  const alerts = [];

  for (const [variantId, baseline] of previous) {
    if (!variantId || baseline.units < 10) continue;

    const currentAggregate = current.get(variantId);
    const currentUnits = currentAggregate?.units ?? 0;
    const currentRevenue = currentAggregate?.revenue ?? 0;
    const expectedUnits = (baseline.units / COMPARISON_PERIOD_DAYS) * CURRENT_PERIOD_DAYS;
    const expectedRevenue = roundMoney(
      (baseline.revenue / COMPARISON_PERIOD_DAYS) * CURRENT_PERIOD_DAYS,
    );
    const collapsed =
      currentUnits === 0 || currentUnits <= Math.max(1, expectedUnits * 0.25);
    if (!collapsed) continue;

    const valueAtRisk = roundMoney(
      Math.max(0, expectedRevenue - currentRevenue),
    );

    alerts.push(
      alertRecord({
        merchantId: input.merchantId,
        shopId: input.shopId,
        type: "sku_sales_collapse",
        title: `${productVariantLabel(baseline)} sales collapsed`,
        summary: `${productVariantLabel(baseline)} sold ${baseline.units} units in the previous 30 days but sold ${currentUnits} in the last 7 days.`,
        severity: valueAtRisk >= 500 && currentUnits === 0 ? "critical" : "warning",
        confidence: baseline.units >= 20 ? "high" : "medium",
        estimatedValueAtRisk: valueAtRisk,
        affectedProductId: baseline.productId,
        affectedVariantId: baseline.variantId,
        affectedSku: baseline.sku,
        whyThisMatters:
          "This product had recent demand, so a sudden drop to zero could mean availability, visibility, pricing or tracking has changed.",
        suggestedCheck:
          "Check whether the product is still visible, in stock, correctly priced, and included in normal collections.",
        suggestedChecks: [
          "Check product is visible on Online Store",
          "Check it is in stock",
          "Check price has not changed unexpectedly",
          "Check it is still included in normal collections",
          "Check recent product/theme edits",
        ],
        evidence: {
          formulaVersion: WATCHDOG_FORMULA_VERSION,
          rule: "previous_30d_units >= 10 and last_7d_units = 0, or last_7d_units <= 25% of expected 7-day run rate",
          previous30dUnits: baseline.units,
          previous30dRevenue: baseline.revenue,
          expected7dUnits: roundNumber(expectedUnits, 2),
          expected7dRevenue: expectedRevenue,
          last7dUnits: currentUnits,
          last7dRevenue: currentRevenue,
          averageUnitPrice: baseline.averageUnitPrice,
          sourceOrderRefs: baseline.sourceOrderRefs,
          orderLineItemIds: baseline.lineItemIds,
        },
        periodStart: input.currentStart,
        periodEnd: input.currentEnd,
        comparisonStart: input.comparisonStart,
        comparisonEnd: input.comparisonEnd,
      }),
    );
  }

  return alerts;
}

/**
 * @param {any} input
 */
function detectProductUnavailable(input) {
  const previous = aggregateByVariant(input.comparisonLineItems);
  const alerts = [];

  for (const variant of input.variants) {
    const baseline = previous.get(variant.id);
    if (!baseline || baseline.units < 3) continue;

    const inventory = currentInventory(variant.inventoryLevels ?? []);
    const unavailableReason = unavailableReasonForVariant(variant, inventory);
    if (!unavailableReason) continue;

    const expectedRevenue = roundMoney(
      (baseline.revenue / COMPARISON_PERIOD_DAYS) * CURRENT_PERIOD_DAYS,
    );

    alerts.push(
      alertRecord({
        merchantId: input.merchantId,
        shopId: input.shopId,
        type: "product_unavailable",
        title: `${variant.product?.title ?? baseline.productTitle} appears unavailable`,
        summary: `${productVariantLabel(baseline)} had recent sales but now appears unavailable: ${unavailableReason}.`,
        severity: baseline.revenue >= 250 || unavailableReason !== "inventory is 0" ? "critical" : "warning",
        confidence: unavailableReason === "inventory is 0" ? "medium" : "high",
        estimatedValueAtRisk: expectedRevenue,
        affectedProductId: variant.productId,
        affectedVariantId: variant.id,
        affectedSku: variant.sku ?? baseline.sku,
        suggestedCheck:
          "Check product status, inventory, sales channel availability, and recent theme/product edits.",
        evidence: {
          formulaVersion: WATCHDOG_FORMULA_VERSION,
          rule: "variant had sales in previous 30 days and is now inactive, unavailable or out of stock",
          previous30dUnits: baseline.units,
          previous30dRevenue: baseline.revenue,
          productStatus: variant.product?.status ?? null,
          currentInventory: inventory,
          unavailableReason,
          sourceOrderRefs: baseline.sourceOrderRefs,
        },
        periodStart: input.currentStart,
        periodEnd: input.currentEnd,
        comparisonStart: input.comparisonStart,
        comparisonEnd: input.comparisonEnd,
      }),
    );
  }

  return alerts;
}

/**
 * @param {any} input
 */
function detectRevenueDrop(input) {
  const currentRevenue = lineItemsRevenue(input.currentLineItems);
  const comparisonRevenue = lineItemsRevenue(input.comparisonLineItems);
  const expectedRevenue =
    (comparisonRevenue / COMPARISON_PERIOD_DAYS) * CURRENT_PERIOD_DAYS;

  if (
    comparisonRevenue < REVENUE_DROP_MIN_BASELINE ||
    expectedRevenue <= 0 ||
    currentRevenue >= expectedRevenue * 0.5
  ) {
    return null;
  }

  const dropPercent = roundPercent(
    ((expectedRevenue - currentRevenue) / expectedRevenue) * 100,
  );
  const valueAtRisk = roundMoney(expectedRevenue - currentRevenue);

  return alertRecord({
    merchantId: input.merchantId,
    shopId: input.shopId,
    type: "revenue_drop",
    title: `Revenue is ${dropPercent}% below baseline`,
    summary: `Last 7 days: ${formatMoney(currentRevenue, input.currency)}. Expected from the previous 30-day run rate: ${formatMoney(expectedRevenue, input.currency)}.`,
    severity: valueAtRisk >= 500 || currentRevenue < expectedRevenue * 0.35 ? "critical" : "warning",
    confidence: input.comparisonOrders.length >= 10 ? "high" : "medium",
    estimatedValueAtRisk: valueAtRisk,
    suggestedCheck:
      "Check traffic, conversion, discount changes, payment errors, and recent theme edits.",
    evidence: {
      formulaVersion: WATCHDOG_FORMULA_VERSION,
      rule: "current_7d_revenue < 50% of previous_30d_daily_average * 7 and previous_30d_revenue >= 500",
      current7dRevenue: currentRevenue,
      previous30dRevenue: comparisonRevenue,
      expected7dRevenue: roundMoney(expectedRevenue),
      dropPercent,
      currentOrderCount: input.currentOrders.length,
      comparisonOrderCount: input.comparisonOrders.length,
    },
    periodStart: input.currentStart,
    periodEnd: input.currentEnd,
    comparisonStart: input.comparisonStart,
    comparisonEnd: input.comparisonEnd,
  });
}

/**
 * @param {any} input
 */
function detectUnusualStockMovement(input) {
  const variantsByInventoryItemId = new Map(
    input.variants
      .filter(
        /** @param {any} variant */
        (variant) => variant.inventoryItemExternalId,
      )
      .map(
        /** @param {any} variant */
        (variant) => [variant.inventoryItemExternalId, variant],
      ),
  );
  const salesByVariant = aggregateByVariant(input.currentLineItems);
  const eventsByInventoryItem = groupInventoryEvents(input.ledgerEvents);
  const alerts = [];

  for (const [inventoryItemExternalId, events] of eventsByInventoryItem) {
    if (events.length < 2) continue;

    const first = events[0];
    const last = events[events.length - 1];
    const drop = Number(first.available) - Number(last.available);
    if (drop <= 50) continue;

    const variant = variantsByInventoryItemId.get(inventoryItemExternalId);
    const sales = variant ? salesByVariant.get(variant.id) : null;
    const soldUnits = sales?.units ?? 0;
    if (soldUnits >= drop * 0.5) continue;

    const averageUnitPrice =
      sales?.averageUnitPrice ?? moneyOrNull(variant?.price) ?? 0;
    const unexplainedUnits = Math.max(0, drop - soldUnits);
    const valueAtRisk = roundMoney(unexplainedUnits * averageUnitPrice);

    alerts.push(
      alertRecord({
        merchantId: input.merchantId,
        shopId: input.shopId,
        type: "unusual_stock_movement",
        title: `${variant?.product?.title ?? "Inventory"} changed unusually`,
        summary: `${variant?.product?.title ?? "An inventory item"} fell from ${first.available} to ${last.available}, but recent orders explain only ${soldUnits} units.`,
        severity: valueAtRisk >= 500 ? "warning" : "watch",
        confidence: variant ? "medium" : "low",
        estimatedValueAtRisk: valueAtRisk,
        affectedProductId: variant?.productId ?? null,
        affectedVariantId: variant?.id ?? null,
        affectedSku: variant?.sku ?? null,
        suggestedCheck:
          "Check stock adjustment history, transfers, returns, manual edits, and fulfilment activity.",
        evidence: {
          formulaVersion: WATCHDOG_FORMULA_VERSION,
          rule: "inventory drops by more than 50 units and recent orders do not explain the change",
          inventoryItemExternalId,
          startAvailable: first.available,
          endAvailable: last.available,
          drop,
          soldUnits,
          unexplainedUnits,
          inventoryEventIds: events.map(
            /** @param {any} event */
            (event) => event.ledgerEventId,
          ),
          limitation:
            "This v0 check uses inventory webhook history. It may miss adjustments from before webhook capture started.",
        },
        periodStart: input.currentStart,
        periodEnd: input.currentEnd,
        comparisonStart: null,
        comparisonEnd: null,
      }),
    );
  }

  return alerts;
}

/**
 * @param {any} input
 */
function detectMissingCogsImportantSellers(input) {
  const currentByVariant = aggregateByVariant(input.currentLineItems);
  const alerts = [];

  for (const [variantId, aggregate] of currentByVariant) {
    if (!variantId || aggregate.revenue < IMPORTANT_SELLER_REVENUE_THRESHOLD) {
      continue;
    }
    if (input.cogsByVariantId.has(variantId)) continue;

    alerts.push(
      alertRecord({
        merchantId: input.merchantId,
        shopId: input.shopId,
        type: "missing_cogs_important_seller",
        title: `${aggregate.productTitle} is selling without product costs`,
        summary: `${aggregate.productTitle} generated ${formatMoney(aggregate.revenue, input.currency)} this week, but COGS is missing. Jefe cannot confidently judge its margin.`,
        severity: "warning",
        confidence: "high",
        estimatedValueAtRisk: null,
        affectedProductId: aggregate.productId,
        affectedVariantId: aggregate.variantId,
        affectedSku: aggregate.sku,
        suggestedCheck:
          "Add product costs so Jefe can monitor margin properly.",
        evidence: {
          formulaVersion: WATCHDOG_FORMULA_VERSION,
          rule: "variant has revenue in last 7 days and COGS is missing and revenue >= 100",
          last7dRevenue: aggregate.revenue,
          last7dUnits: aggregate.units,
          cogsInputId: null,
          orderLineItemIds: aggregate.lineItemIds,
        },
        periodStart: input.currentStart,
        periodEnd: input.currentEnd,
        comparisonStart: null,
        comparisonEnd: null,
      }),
    );
  }

  return alerts;
}

/**
 * @param {any} input
 */
function detectHighReturnProducts(input) {
  const products = aggregateByProduct(input.lineItems);
  const refundedOrderIds = new Set(
    input.refunds
      .map(
        /** @param {any} refund */
        (refund) => refund.orderId,
      )
      .filter(Boolean),
  );
  const refundAmountByOrderId = new Map();
  for (const refund of input.refunds) {
    refundAmountByOrderId.set(
      refund.orderId,
      (refundAmountByOrderId.get(refund.orderId) ?? 0) + money(refund.amount),
    );
  }
  const alerts = [];

  for (const [, product] of products) {
    if (product.orderIds.size < 4) continue;

    const refundedProductOrders = [...product.orderIds].filter((orderId) =>
      refundedOrderIds.has(orderId),
    );
    const refundRate = (refundedProductOrders.length / product.orderIds.size) * 100;
    if (refundRate < 25) continue;

    const refundedAmount = roundMoney(
      refundedProductOrders.reduce(
        (sum, orderId) => sum + (refundAmountByOrderId.get(orderId) ?? 0),
        0,
      ),
    );

    alerts.push(
      alertRecord({
        merchantId: input.merchantId,
        shopId: input.shopId,
        type: "high_return_product",
        title: `${product.productTitle} may be a fake winner`,
        summary: `${product.productTitle} sold in ${product.orderIds.size} orders, but ${roundPercent(refundRate)}% of those orders were refunded.`,
        severity: refundedAmount >= 250 || refundRate >= 40 ? "warning" : "watch",
        confidence: "medium",
        estimatedValueAtRisk: refundedAmount,
        affectedProductId: product.productId,
        affectedVariantId: null,
        affectedSku: product.skus[0] ?? null,
        suggestedCheck:
          "Check sizing, product quality, delivery issues, and whether the product description sets the right expectations.",
        evidence: {
          formulaVersion: WATCHDOG_FORMULA_VERSION,
          rule: "product refund rate >= 25% and product had at least 4 orders in period",
          productOrderCount: product.orderIds.size,
          refundedProductOrderCount: refundedProductOrders.length,
          productRefundRatePercent: roundPercent(refundRate),
          refundedAmount,
          sourceOrderRefs: product.sourceOrderRefs,
          limitation:
            "Refunds are stored at order level in v0, so product return rate is inferred from orders containing this product.",
        },
        periodStart: input.currentStart,
        periodEnd: input.currentEnd,
        comparisonStart: null,
        comparisonEnd: null,
      }),
    );
  }

  return alerts;
}

/**
 * @param {{
 *   merchantId: string;
 *   shopId: string;
 *   type: WatchdogAlertType;
 *   title: string;
 *   summary: string;
 *   severity: WatchdogSeverity;
 *   confidence: WatchdogConfidence;
 *   estimatedValueAtRisk?: number | null;
 *   affectedProductId?: string | null;
 *   affectedVariantId?: string | null;
 *   affectedSku?: string | null;
 *   whyThisMatters?: string | null;
 *   suggestedCheck: string;
 *   suggestedChecks?: string[];
 *   evidence: Record<string, any>;
 *   periodStart: Date;
 *   periodEnd: Date;
 *   comparisonStart?: Date | null;
 *   comparisonEnd?: Date | null;
 * }} input
 */
function alertRecord(input) {
  return {
    merchantId: input.merchantId,
    shopId: input.shopId,
    type: input.type,
    title: input.title,
    summary: input.summary,
    severity: input.severity,
    confidence: input.confidence,
    estimatedValueAtRisk:
      input.estimatedValueAtRisk === null ||
      input.estimatedValueAtRisk === undefined
        ? null
        : roundMoney(input.estimatedValueAtRisk),
    verificationClass: "estimated",
    affectedProductId: input.affectedProductId ?? null,
    affectedVariantId: input.affectedVariantId ?? null,
    affectedSku: input.affectedSku ?? null,
    whyThisMatters: input.whyThisMatters ?? null,
    suggestedCheck: input.suggestedCheck,
    suggestedChecks: input.suggestedChecks ?? [],
    evidence: {
      ...input.evidence,
      currentPeriod: {
        start: input.periodStart.toISOString(),
        end: input.periodEnd.toISOString(),
      },
      comparisonPeriod:
        input.comparisonStart && input.comparisonEnd
          ? {
              start: input.comparisonStart.toISOString(),
              end: input.comparisonEnd.toISOString(),
            }
          : null,
    },
    periodStart: input.periodStart.toISOString(),
    periodEnd: input.periodEnd.toISOString(),
    createdAt: input.periodEnd.toISOString(),
  };
}

/** @param {any[]} lineItems */
function aggregateByVariant(lineItems) {
  const map = new Map();
  for (const lineItem of lineItems) {
    const variantId = lineItem.variantId ?? lineItem.variant?.id ?? null;
    if (!variantId) continue;

    const aggregate = ensureAggregate(map, variantId, {
      productId: lineItem.productId ?? lineItem.product?.id ?? null,
      variantId,
      productTitle: lineItem.product?.title ?? lineItem.title ?? "Unknown product",
      variantTitle: lineItem.variant?.title ?? "Default",
      sku: lineItem.sku ?? lineItem.variant?.sku ?? null,
      units: 0,
      revenue: 0,
      averageUnitPrice: 0,
      lineItemIds: [],
      sourceOrderRefs: [],
    });
    const quantity = Number(lineItem.quantity ?? 0);
    aggregate.units += quantity;
    aggregate.revenue = roundMoney(aggregate.revenue + lineRevenue(lineItem));
    aggregate.averageUnitPrice =
      aggregate.units > 0 ? roundMoney(aggregate.revenue / aggregate.units) : 0;
    if (lineItem.id) aggregate.lineItemIds.push(lineItem.id);
    const orderRef = lineItem.order?.orderName ?? lineItem.order?.externalId;
    if (orderRef) aggregate.sourceOrderRefs.push(orderRef);
  }

  return map;
}

/** @param {any[]} lineItems */
function aggregateByProduct(lineItems) {
  const map = new Map();
  for (const lineItem of lineItems) {
    const productId = lineItem.productId ?? lineItem.product?.id ?? null;
    if (!productId || !lineItem.orderId) continue;

    const aggregate = ensureAggregate(map, productId, {
      productId,
      productTitle: lineItem.product?.title ?? lineItem.title ?? "Unknown product",
      orderIds: new Set(),
      skus: [],
      sourceOrderRefs: [],
    });
    aggregate.orderIds.add(lineItem.orderId);
    if (lineItem.sku && !aggregate.skus.includes(lineItem.sku)) {
      aggregate.skus.push(lineItem.sku);
    }
    const orderRef = lineItem.order?.orderName ?? lineItem.order?.externalId;
    if (orderRef && !aggregate.sourceOrderRefs.includes(orderRef)) {
      aggregate.sourceOrderRefs.push(orderRef);
    }
  }

  return map;
}

/** @param {any[]} refunds */
function affectedProductsFromRefunds(refunds) {
  const map = new Map();
  for (const refund of refunds) {
    for (const lineItem of refund.order?.lineItems ?? []) {
      const key = lineItem.variantId ?? lineItem.productId ?? lineItem.sku;
      if (!key) continue;
      const aggregate = ensureAggregate(map, key, {
        productId: lineItem.productId ?? lineItem.product?.id ?? null,
        variantId: lineItem.variantId ?? lineItem.variant?.id ?? null,
        title: lineItem.product?.title ?? lineItem.title ?? "Unknown product",
        variantTitle: lineItem.variant?.title ?? "Default",
        sku: lineItem.sku ?? lineItem.variant?.sku ?? null,
        orderCount: 0,
      });
      aggregate.orderCount += 1;
    }
  }

  return [...map.values()].sort((a, b) => b.orderCount - a.orderCount);
}

/** @param {any[]} ledgerEvents */
function groupInventoryEvents(ledgerEvents) {
  const grouped = new Map();
  for (const ledgerEvent of ledgerEvents) {
    const rawPayload = objectValue(ledgerEvent.rawPayload);
    const inventoryItemExternalId =
      stringValue(rawPayload.inventory_item_id) ??
      stringValue(rawPayload.inventoryItemId) ??
      stringValue(rawPayload.inventory_item_admin_graphql_api_id);
    const available = numberOrNull(rawPayload.available);
    if (!inventoryItemExternalId || available === null) continue;

    const events = ensureAggregate(grouped, inventoryItemExternalId, []);
    events.push({
      ledgerEventId: ledgerEvent.id,
      eventTs: dateString(ledgerEvent.eventTs),
      available,
    });
  }

  return grouped;
}

/**
 * @param {any} variant
 * @param {number | null} inventory
 */
function unavailableReasonForVariant(variant, inventory) {
  const productStatus = String(variant.product?.status ?? "").toLowerCase();
  if (productStatus && !["active", "published"].includes(productStatus)) {
    return `product status is ${productStatus}`;
  }
  const rawPayload = objectValue(variant.rawPayload);
  if (rawPayload.availableForSale === false || rawPayload.available === false) {
    return "variant is unavailable for sale";
  }
  if (inventory === 0) return "inventory is 0";
  return null;
}

/** @param {any[]} inventoryLevels */
function currentInventory(inventoryLevels) {
  const values = inventoryLevels
    .map((level) => numberOrNull(level.available))
    .filter((value) => value !== null);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + Number(value), 0);
}

/** @param {any[]} lineItems */
function lineItemsRevenue(lineItems) {
  return roundMoney(
    lineItems.reduce((sum, lineItem) => sum + lineRevenue(lineItem), 0),
  );
}

/** @param {any} lineItem */
function lineRevenue(lineItem) {
  const totalPrice = moneyOrNull(lineItem.totalPrice);
  if (totalPrice !== null) return totalPrice;
  return roundMoney(money(lineItem.unitPrice) * Number(lineItem.quantity ?? 0));
}

/** @param {any[]} refunds */
function refundAmount(refunds) {
  return roundMoney(refunds.reduce((sum, refund) => sum + money(refund.amount), 0));
}

/**
 * @param {any} refund
 * @param {Date} start
 * @param {Date} end
 */
function refundInWindow(refund, start, end) {
  return inWindow(refund.processedAt ?? refund.sourceCreatedAt, start, end);
}

/**
 * @param {Date | string | null | undefined} value
 * @param {Date} start
 * @param {Date} end
 */
function inWindow(value, start, end) {
  if (!value) return false;
  const date = new Date(value);
  return date >= start && date < end;
}

/**
 * @param {Map<any, any>} map
 * @param {any} key
 * @param {any} initial
 */
function ensureAggregate(map, key, initial) {
  if (!map.has(key)) map.set(key, initial);
  return map.get(key);
}

/**
 * @param {any[]} records
 * @param {string} key
 */
function firstBy(records, key) {
  const map = new Map();
  for (const record of records) {
    if (record[key] && !map.has(record[key])) map.set(record[key], record);
  }
  return map;
}

/** @param {any[]} alerts */
function highestSeverity(alerts) {
  if (alerts.some((alert) => alert.severity === "critical")) return "critical";
  if (alerts.some((alert) => alert.severity === "warning")) return "warning";
  if (alerts.some((alert) => alert.severity === "watch")) return "watch";
  return null;
}

/**
 * @param {any[]} alerts
 * @param {WatchdogSeverity} severity
 */
function countSeverity(alerts, severity) {
  return alerts.filter((alert) => alert.severity === severity).length;
}

/**
 * @param {any[]} alerts
 * @param {number} estimatedValueAtRisk
 * @param {string} currency
 */
function heroMessage(alerts, estimatedValueAtRisk, currency) {
  if (alerts.length === 0) {
    return "No urgent issues found. Jefe did not find refund spikes, sales collapses, revenue drops or unusual stock movements in this period.";
  }

  const valueText =
    estimatedValueAtRisk > 0
      ? ` Estimated value at risk is ${formatMoney(estimatedValueAtRisk, currency)}.`
      : "";

  if (alerts.length === 1 && alerts[0].type === "sku_sales_collapse") {
    return `Jefe found 1 sales collapse worth checking.${valueText}`;
  }

  return `Jefe found ${alerts.length} issue${alerts.length === 1 ? "" : "s"} that may need attention.${valueText} These are estimated prevention alerts, not verified lift.`;
}

/** @param {{ alertCount: number; comparisonOrderCount: number; comparisonLineItemCount: number }} input */
function watchdogEmptyState(input) {
  if (input.alertCount > 0) return null;
  if (input.comparisonOrderCount < 3 || input.comparisonLineItemCount < 3) {
    return "not_enough_history";
  }
  return "no_alerts";
}

/**
 * @param {unknown} value
 * @returns {value is ReturnType<typeof alertRecord>}
 */
function isWatchdogAlert(value) {
  return Boolean(value && typeof value === "object" && "type" in value);
}

/**
 * @param {ReturnType<typeof alertRecord>} a
 * @param {ReturnType<typeof alertRecord>} b
 */
function compareAlerts(a, b) {
  /** @type {Record<WatchdogSeverity, number>} */
  const severityOrder = { critical: 0, warning: 1, watch: 2 };
  return (
    severityOrder[a.severity] - severityOrder[b.severity] ||
    Number(b.estimatedValueAtRisk ?? 0) - Number(a.estimatedValueAtRisk ?? 0) ||
    a.title.localeCompare(b.title)
  );
}

/** @param {WatchdogConfidence} confidence */
function confidenceScore(confidence) {
  if (confidence === "high") return 0.9;
  if (confidence === "medium") return 0.6;
  return 0.3;
}

/**
 * @param {any} alert
 * @param {string} currency
 */
function actionExpectedValue(alert, currency) {
  return {
    type: "estimated_prevention",
    estimatedValueAtRisk: alert.estimatedValueAtRisk,
    currency,
    verificationClass: "estimated",
    source: "watchdog",
  };
}

/** @param {any} alert */
function actionEvidence(alert) {
  return {
    ...alert,
    verificationClass: "estimated",
  };
}

/** @param {any} alert */
function actionPreview(alert) {
  return {
    title: alert.title,
    message: alert.summary,
    suggestedCheck: alert.suggestedCheck,
    suggestedChecks: alert.suggestedChecks,
    noWriteAction: true,
  };
}

/** @param {any} value */
function money(value) {
  return moneyOrNull(value) ?? 0;
}

/** @param {any} value */
function moneyOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** @param {any} value */
function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** @param {any} value */
function objectValue(value) {
  return value && typeof value === "object" ? value : {};
}

/** @param {any} value */
function stringValue(value) {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number") return String(value);
  return null;
}

/**
 * @param {any} aggregate
 */
function productVariantLabel(aggregate) {
  return `${aggregate.productTitle} / ${aggregate.variantTitle}`;
}

/**
 * @param {any[]} lineItems
 * @param {any[]} refunds
 */
function firstCurrency(lineItems, refunds) {
  const value =
    lineItems.find((lineItem) => isCurrencyCode(lineItem.order?.currency))?.order
      ?.currency ?? refunds.find((refund) => isCurrencyCode(refund.currency))?.currency;
  return isCurrencyCode(value) ? value : null;
}

/** @param {string | null | undefined} value */
function isCurrencyCode(value) {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}

/**
 * @param {number} value
 * @param {string} currency
 */
function formatMoney(value, currency) {
  const safeCurrency = isCurrencyCode(currency) ? currency : "GBP";
  const symbol = safeCurrency === "GBP" ? "£" : `${safeCurrency} `;
  return `${symbol}${Number(value).toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** @param {number} value */
function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/** @param {number} value */
function roundPercent(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * @param {number} value
 * @param {number} places
 */
function roundNumber(value, places) {
  const multiplier = 10 ** places;
  return Math.round((Number(value) + Number.EPSILON) * multiplier) / multiplier;
}

/**
 * @param {Date} date
 * @param {number} days
 */
function subtractDays(date, days) {
  return new Date(date.getTime() - days * 24 * 60 * 60 * 1000);
}

/** @param {Date} date */
function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

/** @param {Date | string | null | undefined} value */
function dateString(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
