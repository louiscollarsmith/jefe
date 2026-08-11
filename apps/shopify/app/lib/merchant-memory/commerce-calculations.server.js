// @ts-check

import { logger as baseLogger } from "../observability/logger.server.js";

export const COMMERCE_CALCULATION_CATALOG_VERSION = "commerce_calculations_v1";

const MAX_REQUESTS = 3;
const MAX_ROWS = 12;
const MAX_WINDOW_DAYS = 365;
const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_HORIZON_DAYS = 30;

/** @typedef {Record<string, any>} AnyRecord */

const REQUEST_KINDS = new Set([
  "aggregate",
  "comparison",
  "breakdown",
  "ranking",
  "timeseries",
  "ratio",
  "impact_estimate",
]);

const MEASURES = new Set([
  "revenue",
  "line_revenue",
  "units_sold",
  "order_count",
  "average_order_value",
  "refund_amount",
  "discount_value",
  "inventory_units",
  "retail_stock_value",
  "trapped_capital",
  "gross_margin",
  "stock_cover_days",
  "action_revenue_recovered",
  "action_units_moved",
  "action_sell_through",
]);

const DIMENSIONS = new Set([
  "product",
  "variant",
  "vendor",
  "product_type",
  "sku",
  "day",
  "week",
  "month",
  "action_run",
  "channel",
  "country",
]);

const MONEY_MEASURES = new Set([
  "revenue",
  "line_revenue",
  "average_order_value",
  "refund_amount",
  "discount_value",
  "retail_stock_value",
  "trapped_capital",
  "gross_margin",
  "action_revenue_recovered",
]);

const LINE_MEASURES = new Set([
  "line_revenue",
  "units_sold",
  "gross_margin",
]);

const INVENTORY_MEASURES = new Set([
  "inventory_units",
  "retail_stock_value",
  "trapped_capital",
  "stock_cover_days",
]);

const ACTION_MEASURES = new Set([
  "action_revenue_recovered",
  "action_units_moved",
  "action_sell_through",
]);

/** @type {Readonly<Record<string, string>>} */
const MEASURE_ALIASES = Object.freeze({
  aov: "average_order_value",
  refunds: "refund_amount",
  refund_value: "refund_amount",
  sales: "revenue",
  gross_sales: "revenue",
  line_sales: "line_revenue",
  units: "units_sold",
  stock_units: "inventory_units",
  stock_value: "retail_stock_value",
  margin: "gross_margin",
});

/** @type {Readonly<Record<string, string>>} */
const DIMENSION_ALIASES = Object.freeze({
  product_type: "product_type",
  type: "product_type",
  productType: "product_type",
  actionRun: "action_run",
  action_run_id: "action_run",
  sales_channel: "channel",
  shipping_country: "country",
});

/**
 * @typedef {object} CommerceCalculationRequest
 * @property {string} [id]
 * @property {string} kind
 * @property {string} measure
 * @property {string[]} [dimensions]
 * @property {Record<string, any>} [filters]
 * @property {{ days?: number; from?: string; to?: string; label?: string }} [window]
 * @property {{ windows?: Array<{ days?: number; from?: string; to?: string; label?: string }> }} [comparison]
 * @property {number} [topN]
 * @property {number} [horizonDays]
 */

/**
 * @typedef {object} CommerceCalculationResult
 * @property {string} id
 * @property {boolean} ok
 * @property {string} kind
 * @property {string} measure
 * @property {string[]} dimensions
 * @property {Record<string, any>} filters
 * @property {Record<string, any>} window
 * @property {Array<Record<string, any>>} rows
 * @property {Record<string, any>} totals
 * @property {string} formula
 * @property {string[]} sourceTables
 * @property {Record<string, any>} dataQuality
 * @property {string[]} caveats
 * @property {string | null} currency
 * @property {string} source
 * @property {string} catalogVersion
 * @property {string} [error]
 */

export function commerceCalculationCatalogForPrompt() {
  return {
    version: COMMERCE_CALCULATION_CATALOG_VERSION,
    maxRequests: MAX_REQUESTS,
    requestKinds: [...REQUEST_KINDS],
    measures: [...MEASURES],
    dimensions: [...DIMENSIONS],
    filters: [
      "scope=current_move",
      "productIds",
      "variantIds",
      "vendor",
      "productType",
      "sku",
      "channel",
      "country",
      "actionRunId",
      "statuses",
    ],
    limits: {
      maxRows: MAX_ROWS,
      maxWindowDays: MAX_WINDOW_DAYS,
      maxRequests: MAX_REQUESTS,
    },
    notes: [
      "The model may request calculations only through this catalog.",
      "The server executes tenant-scoped calculations; never request SQL or raw records.",
      "Use scope=current_move when the question is about the current recommendation/action.",
    ],
  };
}

/** @param {string} message */
export function shouldPlanCommerceCalculations(message) {
  return /\b(revenue|sales|sold|units|orders?|aov|average order|refund|discount|margin|profit|stock value|inventory value|trapped capital|cover|loss|lost|risk|impact|amount|dollars?|\$|£|€|worth|bigger|compare|breakdown|rank|top|which products?|last \d+)\b/i.test(
    message,
  );
}

/**
 * @param {{ message: string; actionContext?: any; includeDefaultScopedImpact?: boolean }} input
 * @returns {CommerceCalculationRequest[]}
 */
export function heuristicCommerceCalculationRequests(input) {
  const message = String(input.message ?? "");
  const normalized = message.toLowerCase();
  const scope = calculationScopeFromActionContext(input.actionContext);
  const scopedFilters = scope.productIds.length || scope.variantIds.length
    ? { scope: "current_move" }
    : {};
  const days = windowDaysFromText(message) ?? (/\b180\b/.test(message) ? 180 : DEFAULT_WINDOW_DAYS);
  /** @type {CommerceCalculationRequest[]} */
  const requests = [];

  if (
    input.includeDefaultScopedImpact &&
    (scope.productIds.length || scope.variantIds.length) &&
    hasLowCoverContext(input.actionContext)
  ) {
    requests.push({
      id: "current_move_revenue_impact",
      kind: "impact_estimate",
      measure: "revenue",
      filters: scopedFilters,
      window: { days, label: `trailing_${days}d` },
      horizonDays: DEFAULT_HORIZON_DAYS,
    });
  }

  if (/\b(loss|lost|risk|impact|amount|dollars?|\$|£|€|worth)\b/.test(normalized)) {
    requests.push({
      id: "revenue_impact",
      kind: scope.productIds.length || scope.variantIds.length ? "impact_estimate" : "aggregate",
      measure: "revenue",
      filters: scopedFilters,
      window: { days, label: `trailing_${days}d` },
      horizonDays: DEFAULT_HORIZON_DAYS,
    });
  } else if (/\b(revenue|sales|sold)\b/.test(normalized)) {
    requests.push({
      id: "sales_by_product",
      kind: /\b(which|top|rank|products?)\b/.test(normalized) ? "ranking" : "aggregate",
      measure: /\b(units|sold)\b/.test(normalized) ? "units_sold" : "line_revenue",
      dimensions: /\b(which|top|rank|products?)\b/.test(normalized) ? ["product"] : [],
      filters: scopedFilters,
      window: { days, label: `trailing_${days}d` },
      topN: 5,
    });
  } else if (/\b(order|aov|average order)\b/.test(normalized)) {
    requests.push({
      id: "orders",
      kind: "aggregate",
      measure: /\baov|average order\b/.test(normalized) ? "average_order_value" : "order_count",
      filters: scopedFilters,
      window: { days, label: `trailing_${days}d` },
    });
  } else if (/\b(refund)\b/.test(normalized)) {
    requests.push({
      id: "refunds",
      kind: "aggregate",
      measure: "refund_amount",
      window: { days, label: `trailing_${days}d` },
    });
  } else if (/\b(discount)\b/.test(normalized)) {
    requests.push({
      id: "discounts",
      kind: "aggregate",
      measure: "discount_value",
      filters: scopedFilters,
      window: { days, label: `trailing_${days}d` },
    });
  } else if (/\b(margin|profit)\b/.test(normalized)) {
    requests.push({
      id: "gross_margin",
      kind: "aggregate",
      measure: "gross_margin",
      filters: scopedFilters,
      window: { days, label: `trailing_${days}d` },
    });
  } else if (/\b(stock value|inventory value|trapped capital|cover)\b/.test(normalized)) {
    requests.push({
      id: "inventory",
      kind: /\b(which|top|rank|products?)\b/.test(normalized) ? "ranking" : "aggregate",
      measure: /\bcover\b/.test(normalized) ? "stock_cover_days" : /\btrapped\b/.test(normalized) ? "trapped_capital" : "retail_stock_value",
      dimensions: /\b(which|top|rank|products?)\b/.test(normalized) ? ["product"] : [],
      filters: scopedFilters,
      window: { days, label: `trailing_${days}d` },
      topN: 5,
    });
  }

  if (/\b(bigger|compare|versus|vs)\b/.test(normalized)) {
    requests.push({
      id: "comparison",
      kind: "comparison",
      measure: "line_revenue",
      filters: scopedFilters,
      comparison: {
        windows: [
          { days: 30, label: "trailing_30d" },
          { days: 180, label: "trailing_180d" },
        ],
      },
    });
  }

  return uniqueRequests(requests).slice(0, MAX_REQUESTS);
}

/**
 * Execute one batch of allowlisted commerce calculations. The LLM never executes
 * this directly; callers pass server-validated tenant scope.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; requests: CommerceCalculationRequest[]; actionContext?: any; now?: Date; source?: string; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function executeCommerceCalculations(prisma, input) {
  const log = input.logger ?? baseLogger.child({ component: "commerce-calculations" });
  const source = input.source ?? "current_system";
  const contextScope = calculationScopeFromActionContext(input.actionContext);
  const requests = Array.isArray(input.requests) ? input.requests.slice(0, MAX_REQUESTS) : [];
  if (!safeText(input.shopId, 120)) {
    const results = requests.map((request) =>
      invalidResult(request, "shopId is required for tenant-scoped commerce calculations.", source),
    );
    log.warn("commerce calculations rejected without shop scope", {
      merchantId: input.merchantId,
      source,
      requestCount: requests.length,
    });
    return {
      generatedAt: (input.now ?? new Date()).toISOString(),
      source,
      catalogVersion: COMMERCE_CALCULATION_CATALOG_VERSION,
      results,
    };
  }
  /** @type {CommerceCalculationResult[]} */
  const results = [];
  for (const rawRequest of requests) {
    results.push(await executeOneCalculation(prisma, {
      merchantId: input.merchantId,
      shopId: safeText(input.shopId, 120),
      rawRequest,
      contextScope,
      now: input.now ?? new Date(),
      source,
    }));
  }
  log.info("commerce calculations executed", {
    merchantId: input.merchantId,
    shopId: input.shopId ?? null,
    source,
    requestCount: requests.length,
    resultCount: results.length,
    okCount: results.filter((result) => result.ok).length,
    kinds: uniqueStrings(results.map((result) => result.kind)),
    measures: uniqueStrings(results.map((result) => result.measure)),
  });
  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    source,
    catalogVersion: COMMERCE_CALCULATION_CATALOG_VERSION,
    results,
  };
}

/**
 * @param {any} actionContext
 * @returns {{ productIds: string[]; variantIds: string[]; actionRunId: string | null; products: Array<{ productId: string; title: string }> }}
 */
export function calculationScopeFromActionContext(actionContext) {
  const productMap = new Map();
  /** @type {string[]} */
  const variantIds = [];
  for (const block of allContextBlocks(actionContext)) {
    if (block?.kind === "structured_evidence" && Array.isArray(block?.data?.items)) {
      for (const item of block.data.items) {
        const productId = text(item?.productId);
        if (productId && !productMap.has(productId)) {
          productMap.set(productId, {
            productId,
            title: safeText(item?.title, 160),
          });
        }
        const variantId = text(item?.variantId);
        if (variantId) variantIds.push(variantId);
      }
    }
    if (block?.kind === "action_preview" && Array.isArray(block?.data?.topItems)) {
      for (const item of block.data.topItems) {
        const productId = text(item?.productId);
        if (productId && !productMap.has(productId)) {
          productMap.set(productId, {
            productId,
            title: safeText(item?.title, 160),
          });
        }
        const variantId = text(item?.variantId);
        if (variantId) variantIds.push(variantId);
      }
    }
  }
  return {
    productIds: [...productMap.keys()].slice(0, MAX_ROWS),
    variantIds: uniqueStrings(variantIds).slice(0, MAX_ROWS),
    actionRunId: text(actionContext?.actionRunId),
    products: [...productMap.values()].slice(0, MAX_ROWS),
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; rawRequest: CommerceCalculationRequest; contextScope: ReturnType<typeof calculationScopeFromActionContext>; now: Date; source: string }} input
 */
async function executeOneCalculation(prisma, input) {
  const normalized = normalizeRequest(input.rawRequest, input.contextScope, input.now);
  if (!normalized.ok) {
    return invalidResult(input.rawRequest, normalized.error ?? "Unsupported calculation request.", input.source);
  }
  const request = normalized.request;
  if (!request) return invalidResult(input.rawRequest, "Calculation request could not be normalized.", input.source);
  if (request.kind === "comparison") {
    return executeComparison(prisma, { ...input, request });
  }
  if (ACTION_MEASURES.has(request.measure)) {
    const actionRows = await safeFindMany(prisma.actionExecution, {
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId ?? undefined,
        runId: request.filters.actionRunId ?? undefined,
      },
      select: {
        runId: true,
        actionType: true,
        actionKind: true,
        status: true,
        outcomeStatus: true,
        outcome: true,
        updatedAt: true,
      },
    });
    return actionMetricResult(request, actionRows, input.source);
  }
  const dataset = await loadCommerceDataset(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    window: request.window,
  });
  if (request.kind === "impact_estimate") {
    return impactEstimateResult(request, dataset, input.source);
  }
  if (INVENTORY_MEASURES.has(request.measure)) {
    return inventoryResult(request, dataset, input.source);
  }
  if (request.measure === "refund_amount") {
    return refundResult(request, dataset, input.source);
  }
  if (usesLineData(request)) {
    return lineMetricResult(request, dataset, input.source);
  }
  return orderMetricResult(request, dataset, input.source);
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; window: any }} input
 */
async function loadCommerceDataset(prisma, input) {
  const tenantWhere = { merchantId: input.merchantId, shopId: input.shopId };
  const processedAt = dateFilter(input.window);
  const orderWhere = processedAt ? { ...tenantWhere, processedAt } : tenantWhere;
  const lineWhere = processedAt ? { ...tenantWhere, order: { processedAt } } : tenantWhere;
  const refundWhere = processedAt ? { ...tenantWhere, processedAt } : tenantWhere;
  const [products, variants, orders, lineItems, inventoryLevels, refunds] = await Promise.all([
    safeFindMany(prisma.product, {
      where: tenantWhere,
      select: { id: true, title: true, status: true, vendor: true, productType: true },
    }),
    safeFindMany(prisma.variant, {
      where: tenantWhere,
      select: { id: true, productId: true, sku: true, title: true, price: true, currency: true, unitCost: true },
    }),
    safeFindMany(prisma.order, {
      where: orderWhere,
      select: {
        id: true,
        currency: true,
        totalPrice: true,
        totalDiscount: true,
        processedAt: true,
        financialStatus: true,
        sourceName: true,
        shippingCountry: true,
      },
    }),
    safeFindMany(prisma.orderLineItem, {
      where: lineWhere,
      select: {
        orderId: true,
        productId: true,
        variantId: true,
        sku: true,
        title: true,
        quantity: true,
        unitPrice: true,
        totalPrice: true,
        discount: true,
        order: {
          select: {
            id: true,
            currency: true,
            processedAt: true,
            financialStatus: true,
            sourceName: true,
            shippingCountry: true,
          },
        },
      },
    }),
    safeFindMany(prisma.inventoryLevel, {
      where: tenantWhere,
      select: { variantId: true, available: true },
    }),
    safeFindMany(prisma.refund, {
      where: refundWhere,
      select: {
        amount: true,
        currency: true,
        processedAt: true,
        reason: true,
        order: { select: { sourceName: true, shippingCountry: true } },
      },
    }),
  ]);
  const productById = new Map(products.map((/** @type {AnyRecord} */ product) => [String(product.id), product]));
  const variantById = new Map(variants.map((/** @type {AnyRecord} */ variant) => [String(variant.id), variant]));
  const orderById = new Map(orders.map((/** @type {AnyRecord} */ order) => [String(order.id), order]));
  return {
    products,
    variants,
    orders,
    lineItems,
    inventoryLevels,
    refunds,
    productById,
    variantById,
    orderById,
  };
}

/**
 * @param {any} request
 * @param {ReturnType<typeof calculationScopeFromActionContext>} scope
 * @param {Date} now
 */
function normalizeRequest(request, scope, now) {
  const rawKind = safeText(request?.kind, 80);
  const kind = rawKind ? rawKind : "aggregate";
  const measure = normalizeMeasure(request?.measure);
  const dimensions = uniqueStrings(Array.isArray(request?.dimensions) ? request.dimensions.map(normalizeDimension) : [])
    .filter((dimension) => DIMENSIONS.has(dimension))
    .slice(0, 2);
  if (!REQUEST_KINDS.has(kind)) return { ok: false, error: `Unsupported calculation kind: ${request?.kind}` };
  if (!MEASURES.has(measure)) return { ok: false, error: `Unsupported calculation measure: ${request?.measure}` };
  if (Array.isArray(request?.dimensions) && request.dimensions.length && !dimensions.length) {
    return { ok: false, error: "No supported dimensions were requested." };
  }
  const filters = normalizeFilters(request?.filters, scope);
  return {
    ok: true,
    request: {
      id: safeId(request?.id) || `${kind}_${measure}`,
      kind,
      measure,
      dimensions: kind === "timeseries" && !dimensions.length ? ["day"] : dimensions,
      filters,
      window: normalizeWindow(request?.window, now),
      comparison: normalizeComparison(request?.comparison, now),
      topN: clampInteger(request?.topN, 1, MAX_ROWS, 5),
      horizonDays: clampInteger(request?.horizonDays, 1, 90, DEFAULT_HORIZON_DAYS),
    },
  };
}

/**
 * @param {any} raw
 * @param {ReturnType<typeof calculationScopeFromActionContext>} scope
 */
function normalizeFilters(raw, scope) {
  const record = asRecord(raw) ?? {};
  const useScope = record.scope === "current_move" || record.useActionScope === true;
  return {
    scope: useScope ? "current_move" : null,
    productIds: uniqueStrings([
      ...(Array.isArray(record.productIds) ? record.productIds : []),
      ...(useScope ? scope.productIds : []),
    ]).slice(0, MAX_ROWS),
    variantIds: uniqueStrings([
      ...(Array.isArray(record.variantIds) ? record.variantIds : []),
      ...(useScope ? scope.variantIds : []),
    ]).slice(0, MAX_ROWS),
    vendor: safeText(record.vendor, 120),
    productType: safeText(record.productType ?? record.product_type, 120),
    sku: safeText(record.sku, 120),
    channel: safeText(record.channel ?? record.sourceName, 120),
    country: safeText(record.country ?? record.shippingCountry, 120),
    actionRunId: safeText(record.actionRunId ?? (useScope ? scope.actionRunId : ""), 120),
    statuses: uniqueStrings(Array.isArray(record.statuses) ? record.statuses : []).slice(0, 8),
  };
}

/**
 * @param {any} request
 * @param {any[]} actionRows
 * @param {string} source
 * @returns {CommerceCalculationResult}
 */
function actionMetricResult(request, actionRows, source) {
  /** @type {AnyRecord[]} */
  const rows = [];
  let total = 0;
  for (const action of actionRows.filter((/** @type {AnyRecord} */ row) => matchesStatuses(row, request.filters))) {
    const outcome = asRecord(action.outcome) ?? {};
    const value =
      request.measure === "action_revenue_recovered"
        ? number(outcome.revenueRecovered)
        : request.measure === "action_units_moved"
          ? number(outcome.unitsMoved ?? outcome.unitsSold)
          : number(outcome.sellThroughRate ?? outcome.sellThrough);
    rows.push({
      dimensions: { action_run: action.runId },
      value,
      actionRunId: action.runId,
      status: action.status,
      outcomeStatus: action.outcomeStatus,
    });
    total += value;
  }
  return finalizeResult(request, {
    rows,
    totals: { value: round(request.measure === "action_sell_through" && rows.length ? total / rows.length : total) },
    formula: actionFormula(request.measure),
    sourceTables: ["action_executions"],
    source,
  });
}

/**
 * @param {any} request
 * @param {any} dataset
 * @param {string} source
 * @returns {CommerceCalculationResult}
 */
function orderMetricResult(request, dataset, source) {
  const orders = dataset.orders.filter((/** @type {AnyRecord} */ order) => matchesOrder(order, request.filters));
  const grouped = new Map();
  for (const order of orders) {
    const group = groupForOrder(order, request.dimensions);
    const key = JSON.stringify(group.dimensions);
    const bucket = grouped.get(key) ?? { dimensions: group.dimensions, label: group.label, revenue: 0, discount: 0, orderIds: new Set(), currencies: new Set() };
    bucket.revenue += money(order.totalPrice);
    bucket.discount += money(order.totalDiscount);
    bucket.orderIds.add(order.id);
    if (order.currency) bucket.currencies.add(String(order.currency));
    grouped.set(key, bucket);
  }
  const rows = [...grouped.values()].map((bucket) => rowFromBucket(request, bucket));
  return finalizeResult(request, {
    rows: shapeRows(request, rows),
    totals: totalsFromRows(request, rows),
    formula: formulaFor(request),
    sourceTables: ["orders"],
    currency: singleCurrency([...grouped.values()].flatMap((bucket) => [...bucket.currencies])),
    source,
  });
}

/**
 * @param {any} request
 * @param {any} dataset
 * @param {string} source
 * @returns {CommerceCalculationResult}
 */
function lineMetricResult(request, dataset, source) {
  const lines = dataset.lineItems.filter((/** @type {AnyRecord} */ line) => matchesLine(line, request.filters, dataset));
  const grouped = new Map();
  for (const line of lines) {
    const group = groupForLine(line, request.dimensions, dataset);
    const key = JSON.stringify(group.dimensions);
    const bucket = grouped.get(key) ?? {
      dimensions: group.dimensions,
      label: group.label,
      revenue: 0,
      discount: 0,
      units: 0,
      cogs: 0,
      costCoveredRevenue: 0,
      orderIds: new Set(),
      currencies: new Set(),
      rows: 0,
      costCoveredRows: 0,
    };
    const revenue = lineRevenue(line);
    const quantity = number(line.quantity);
    const variant = dataset.variantById.get(String(line.variantId ?? ""));
    const unitCost = nullableNumber(variant?.unitCost);
    bucket.revenue += revenue;
    bucket.discount += money(line.discount);
    bucket.units += quantity;
    bucket.orderIds.add(line.orderId);
    bucket.rows += 1;
    if (unitCost !== null) {
      bucket.cogs += unitCost * quantity;
      bucket.costCoveredRevenue += revenue;
      bucket.costCoveredRows += 1;
    }
    const currency = line.order?.currency ?? variant?.currency ?? null;
    if (currency) bucket.currencies.add(String(currency));
    grouped.set(key, bucket);
  }
  const rows = [...grouped.values()].map((bucket) => rowFromBucket(request, bucket));
  const dataQuality = request.measure === "gross_margin"
    ? { costCoverage: costCoverage(rows), rowCount: lines.length }
    : { rowCount: lines.length };
  return finalizeResult(request, {
    rows: shapeRows(request, rows),
    totals: totalsFromRows(request, rows),
    formula: formulaFor(request),
    sourceTables: ["order_line_items", "orders", ...(request.measure === "gross_margin" ? ["variants"] : [])],
    currency: singleCurrency([...grouped.values()].flatMap((bucket) => [...bucket.currencies])),
    dataQuality,
    source,
  });
}

/**
 * @param {any} request
 * @param {any} dataset
 * @param {string} source
 * @returns {CommerceCalculationResult}
 */
function refundResult(request, dataset, source) {
  const refunds = dataset.refunds.filter((/** @type {AnyRecord} */ refund) => matchesRefund(refund, request.filters));
  const grouped = new Map();
  for (const refund of refunds) {
    const group = groupForRefund(refund, request.dimensions);
    const key = JSON.stringify(group.dimensions);
    const bucket = grouped.get(key) ?? { dimensions: group.dimensions, label: group.label, value: 0, currencies: new Set(), count: 0 };
    bucket.value += money(refund.amount);
    bucket.count += 1;
    if (refund.currency) bucket.currencies.add(String(refund.currency));
    grouped.set(key, bucket);
  }
  const rows = [...grouped.values()].map((bucket) => ({
    dimensions: bucket.dimensions,
    label: bucket.label,
    value: round(bucket.value),
    refundCount: bucket.count,
  }));
  return finalizeResult(request, {
    rows: shapeRows(request, rows),
    totals: { value: round(sum(rows.map((row) => row.value))), refundCount: refunds.length },
    formula: "sum(refund.amount) for stored refund records in the requested window",
    sourceTables: ["refunds"],
    currency: singleCurrency([...grouped.values()].flatMap((bucket) => [...bucket.currencies])),
    source,
  });
}

/**
 * @param {any} request
 * @param {any} dataset
 * @param {string} source
 * @returns {CommerceCalculationResult}
 */
function inventoryResult(request, dataset, source) {
  const grouped = new Map();
  for (const level of dataset.inventoryLevels) {
    const variant = dataset.variantById.get(String(level.variantId ?? ""));
    if (!variant || !matchesVariant(variant, request.filters, dataset)) continue;
    const product = dataset.productById.get(String(variant.productId ?? ""));
    const group = groupForInventory(level, variant, product, request.dimensions);
    const key = JSON.stringify(group.dimensions);
    const bucket = grouped.get(key) ?? {
      dimensions: group.dimensions,
      label: group.label,
      available: 0,
      retailValue: 0,
      trappedCapital: 0,
      costCoveredUnits: 0,
      unitsSold: 0,
      currencies: new Set(),
    };
    const available = number(level.available);
    bucket.available += available;
    const price = nullableNumber(variant.price);
    if (price !== null) bucket.retailValue += available * price;
    const unitCost = nullableNumber(variant.unitCost);
    if (unitCost !== null) {
      bucket.trappedCapital += available * unitCost;
      bucket.costCoveredUnits += available;
    }
    if (variant.currency) bucket.currencies.add(String(variant.currency));
    grouped.set(key, bucket);
  }
  const unitsByProduct = unitsSoldByProduct(dataset.lineItems, dataset);
  const rows = [...grouped.values()].map((bucket) => {
    const productId = bucket.dimensions.productId ?? bucket.dimensions.product;
    const unitsSold = productId ? number(unitsByProduct.get(String(productId))) : 0;
    const dailyUnits = unitsSold / Math.max(number(request.window.days), 1);
    const stockCoverDays = dailyUnits > 0 ? bucket.available / dailyUnits : null;
    return {
      dimensions: bucket.dimensions,
      label: bucket.label,
      value:
        request.measure === "inventory_units"
          ? round(bucket.available)
          : request.measure === "retail_stock_value"
            ? round(bucket.retailValue)
            : request.measure === "trapped_capital"
              ? round(bucket.trappedCapital)
              : stockCoverDays === null
                ? null
                : round(stockCoverDays, 1),
      availableUnits: round(bucket.available),
      retailStockValue: round(bucket.retailValue),
      trappedCapital: round(bucket.trappedCapital),
      unitsSold,
      dailyUnits: round(dailyUnits, 4),
      stockCoverDays: stockCoverDays === null ? null : round(stockCoverDays, 1),
      currency: singleCurrency([...bucket.currencies]),
    };
  });
  return finalizeResult(request, {
    rows: shapeRows(request, rows, request.measure === "stock_cover_days" ? "asc" : "desc"),
    totals: inventoryTotals(request, rows),
    formula: formulaFor(request),
    sourceTables: ["inventory_levels", "variants", ...(request.measure === "stock_cover_days" ? ["order_line_items", "orders"] : [])],
    currency: singleCurrency([...grouped.values()].flatMap((bucket) => [...bucket.currencies])),
    dataQuality: { inventoryRows: dataset.inventoryLevels.length },
    source,
  });
}

/**
 * @param {any} request
 * @param {any} dataset
 * @param {string} source
 * @returns {CommerceCalculationResult}
 */
function impactEstimateResult(request, dataset, source) {
  const filteredLineItems = dataset.lineItems.filter((/** @type {AnyRecord} */ line) =>
    matchesLine(line, request.filters, dataset),
  );
  const filteredInventoryLevels = dataset.inventoryLevels.filter((/** @type {AnyRecord} */ level) => {
    const variant = dataset.variantById.get(String(level.variantId ?? ""));
    return Boolean(variant && matchesVariant(variant, request.filters, dataset));
  });
  const scopedProductIds = impactScopeProductIds(request, dataset, filteredLineItems, filteredInventoryLevels);
  const unitsByProduct = unitsSoldByProduct(filteredLineItems, dataset);
  const revenueByProduct = revenueByProductMap(filteredLineItems, dataset);
  const inventoryByProduct = inventoryUnitsByProduct(filteredInventoryLevels, dataset);
  const currency = singleCurrency(filteredLineItems.map((/** @type {AnyRecord} */ line) => line.order?.currency).filter(Boolean));
  /** @type {AnyRecord[]} */
  const rows = [];
  for (const productId of scopedProductIds.slice(0, MAX_ROWS)) {
    const product = dataset.productById.get(String(productId));
    const unitsSold = number(unitsByProduct.get(String(productId)));
    const revenue = number(revenueByProduct.get(String(productId)));
    const availableUnits = number(inventoryByProduct.get(String(productId)));
    const dailyUnits = unitsSold / Math.max(number(request.window.days), 1);
    const dailyRevenue = revenue / Math.max(number(request.window.days), 1);
    const stockCoverDays = dailyUnits > 0 ? availableUnits / dailyUnits : null;
    const expectedOutOfStockDays = stockCoverDays === null
      ? null
      : Math.max(0, number(request.horizonDays) - stockCoverDays);
    rows.push({
      dimensions: { product: productId },
      productId,
      title: safeText(product?.title, 180) || productId,
      value: expectedOutOfStockDays === null ? null : round(dailyRevenue * expectedOutOfStockDays),
      revenueInWindow: round(revenue),
      unitsSold,
      dailyRevenue: round(dailyRevenue),
      dailyUnits: round(dailyUnits, 4),
      availableUnits,
      stockCoverDays: stockCoverDays === null ? null : round(stockCoverDays, 1),
      expectedOutOfStockDays: expectedOutOfStockDays === null ? null : round(expectedOutOfStockDays, 1),
      horizonDays: request.horizonDays,
    });
  }
  return finalizeResult(request, {
    rows: shapeRows(request, rows),
    totals: {
      value: round(sum(rows.map((row) => number(row.value)))),
      atRiskRevenue: round(sum(rows.map((row) => number(row.value)))),
      revenueInWindow: round(sum(rows.map((row) => number(row.revenueInWindow)))),
      unitsSold: round(sum(rows.map((row) => number(row.unitsSold)))),
      horizonDays: request.horizonDays,
    },
    formula: "sum(product trailing-window revenue / window days * max(0, horizon days - stock cover days))",
    sourceTables: ["order_line_items", "orders", "inventory_levels", "variants", "products"],
    currency,
    dataQuality: {
      scopedProductCount: scopedProductIds.length,
      filteredLineItemCount: filteredLineItems.length,
      filteredInventoryRowCount: filteredInventoryLevels.length,
      windowDays: request.window.days,
    },
    caveats: ["Run-rate estimate, not guaranteed lost revenue."],
    source,
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; request: any; rawRequest: any; contextScope: any; now: Date; source: string }} input
 * @returns {Promise<CommerceCalculationResult>}
 */
async function executeComparison(prisma, input) {
  const windows = input.request.comparison.windows.length
    ? input.request.comparison.windows
    : [
        normalizeWindow({ days: 30, label: "trailing_30d" }, input.now),
        normalizeWindow({ days: 180, label: "trailing_180d" }, input.now),
      ];
  const childResults = [];
  for (const window of windows.slice(0, 3)) {
    childResults.push(await executeOneCalculation(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      rawRequest: {
        ...input.request,
        id: `${input.request.id}_${window.label}`,
        kind: "aggregate",
        window,
      },
      contextScope: input.contextScope,
      now: input.now,
      source: input.source,
    }));
  }
  const rows = childResults.map((result) => ({
    dimensions: { window: result.window.label },
    label: result.window.label,
    value: number(result.totals.value),
    ok: result.ok,
    caveats: result.caveats,
  }));
  return finalizeResult(input.request, {
    rows,
    totals: { value: rows.length ? rows[0].value : 0, comparisonCount: rows.length },
    formula: `comparison of ${input.request.measure} across requested windows`,
    sourceTables: uniqueStrings(childResults.flatMap((result) => result.sourceTables)),
    currency: singleCurrency(childResults.map((result) => result.currency).filter(Boolean)),
    dataQuality: { childStatuses: childResults.map((result) => ({ id: result.id, ok: result.ok })) },
    source: input.source,
  });
}

/** @param {any} request */
function usesLineData(request) {
  return (
    LINE_MEASURES.has(request.measure) ||
    request.filters.productIds.length > 0 ||
    request.filters.variantIds.length > 0 ||
    ["product", "variant", "vendor", "product_type", "sku"].some((dimension) => request.dimensions.includes(dimension))
  );
}

/**
 * @param {AnyRecord} request
 * @param {AnyRecord} bucket
 */
function rowFromBucket(request, bucket) {
  const revenue = round(bucket.revenue);
  const orderCount = bucket.orderIds?.size ?? bucket.orderCount ?? 0;
  const grossMargin = round(number(bucket.costCoveredRevenue) - number(bucket.cogs));
  return {
    dimensions: bucket.dimensions,
    label: bucket.label,
    value:
      request.measure === "revenue" || request.measure === "line_revenue"
        ? revenue
        : request.measure === "units_sold"
          ? round(bucket.units)
          : request.measure === "order_count"
            ? orderCount
            : request.measure === "average_order_value"
              ? orderCount > 0 ? round(revenue / orderCount) : 0
              : request.measure === "discount_value"
                ? round(bucket.discount)
                : request.measure === "gross_margin"
                  ? grossMargin
                  : revenue,
    revenue,
    unitsSold: round(bucket.units),
    orderCount,
    discountValue: round(bucket.discount),
    grossMargin,
    marginPercent: bucket.costCoveredRevenue > 0 ? round((grossMargin / bucket.costCoveredRevenue) * 100, 2) : null,
    costCoverage: bucket.rows ? round(bucket.costCoveredRows / bucket.rows, 4) : null,
  };
}

/**
 * @param {AnyRecord} request
 * @param {AnyRecord[]} rows
 */
function totalsFromRows(request, rows) {
  if (request.measure === "average_order_value") {
    const revenue = sum(rows.map((row) => number(row.revenue)));
    const orderCount = sum(rows.map((row) => number(row.orderCount)));
    return { value: orderCount > 0 ? round(revenue / orderCount) : 0, revenue: round(revenue), orderCount };
  }
  if (request.measure === "gross_margin") {
    const grossMargin = sum(rows.map((row) => number(row.grossMargin)));
    const revenue = sum(rows.map((row) => number(row.revenue)));
    return { value: round(grossMargin), grossMargin: round(grossMargin), revenue: round(revenue), marginPercent: revenue > 0 ? round((grossMargin / revenue) * 100, 2) : null };
  }
  return { value: round(sum(rows.map((row) => number(row.value)))) };
}

/**
 * @param {AnyRecord} request
 * @param {AnyRecord[]} rows
 */
function inventoryTotals(request, rows) {
  if (request.measure === "stock_cover_days") {
    const values = rows.map((row) => nullableNumber(row.stockCoverDays)).filter((value) => value !== null);
    return { value: values.length ? round(Math.min(...values), 1) : null, productCount: rows.length };
  }
  return {
    value: round(sum(rows.map((row) => number(row.value)))),
    availableUnits: round(sum(rows.map((row) => number(row.availableUnits)))),
    retailStockValue: round(sum(rows.map((row) => number(row.retailStockValue)))),
    trappedCapital: round(sum(rows.map((row) => number(row.trappedCapital)))),
  };
}

/**
 * @param {AnyRecord} request
 * @param {AnyRecord[]} rows
 * @param {"asc" | "desc"} [direction]
 */
function shapeRows(request, rows, direction = "desc") {
  /** @type {AnyRecord[]} */
  const shaped = request.kind === "ratio"
    ? withShares(rows)
    : rows;
  const sorted = request.kind === "ranking"
    ? [...shaped].sort((a, b) => direction === "asc" ? number(a.value) - number(b.value) : number(b.value) - number(a.value))
    : shaped;
  return sorted.slice(0, request.kind === "aggregate" ? Math.max(1, request.topN) : request.topN || MAX_ROWS);
}

/**
 * @param {AnyRecord[]} rows
 * @returns {AnyRecord[]}
 */
function withShares(rows) {
  const total = sum(rows.map((row) => number(row.value)));
  return rows.map((row) => ({
    ...row,
    sharePercent: total > 0 ? round((number(row.value) / total) * 100, 2) : null,
  }));
}

/**
 * @param {AnyRecord} request
 * @param {{ rows: AnyRecord[]; totals?: AnyRecord; formula: string; sourceTables: string[]; currency?: string | null; dataQuality?: AnyRecord; caveats?: string[]; source: string }} input
 * @returns {CommerceCalculationResult}
 */
function finalizeResult(request, input) {
  const currency = input.currency ?? currencyFromRows(input.rows);
  const caveats = [...(input.caveats ?? [])];
  if (MONEY_MEASURES.has(request.measure) && currency === null) {
    caveats.push("No single currency was available, so money values may be unavailable or caveated.");
  }
  return {
    id: request.id,
    ok: true,
    kind: request.kind,
    measure: request.measure,
    dimensions: request.dimensions,
    filters: publicFilters(request.filters),
    window: publicWindow(request.window),
    rows: sanitizeRows(input.rows),
    totals: sanitizeRecord(input.totals ?? totalsFromRows(request, input.rows)),
    formula: input.formula,
    sourceTables: input.sourceTables,
    dataQuality: sanitizeRecord({
      rowCount: input.rows.length,
      ...(input.dataQuality ?? {}),
    }),
    caveats,
    currency,
    source: input.source,
    catalogVersion: COMMERCE_CALCULATION_CATALOG_VERSION,
  };
}

/**
 * @param {any} request
 * @param {string} error
 * @param {string} source
 * @returns {CommerceCalculationResult}
 */
function invalidResult(request, error, source) {
  const kind = normalizeKind(request?.kind);
  const measure = normalizeMeasure(request?.measure);
  return {
    id: safeId(request?.id) || "invalid_request",
    ok: false,
    kind,
    measure,
    dimensions: [],
    filters: {},
    window: {},
    rows: [],
    totals: {},
    formula: "",
    sourceTables: [],
    dataQuality: {},
    caveats: [],
    currency: null,
    source,
    catalogVersion: COMMERCE_CALCULATION_CATALOG_VERSION,
    error,
  };
}

/** @param {AnyRecord} filters */
function publicFilters(filters) {
  /** @type {AnyRecord} */
  const output = {};
  for (const key of ["scope", "productIds", "variantIds", "vendor", "productType", "sku", "channel", "country", "actionRunId", "statuses"]) {
    const value = filters[key];
    if (Array.isArray(value) ? value.length : value) output[key] = value;
  }
  return output;
}

/** @param {AnyRecord} window */
function publicWindow(window) {
  return {
    from: window.from?.toISOString?.() ?? null,
    to: window.to?.toISOString?.() ?? null,
    days: window.days,
    label: window.label,
  };
}

/** @param {AnyRecord} request */
function formulaFor(request) {
  switch (request.measure) {
    case "revenue":
      return usesLineData(request) ? "sum(order_line_items.total_price else unit_price * quantity)" : "sum(orders.total_price)";
    case "line_revenue":
      return "sum(order_line_items.total_price else unit_price * quantity)";
    case "units_sold":
      return "sum(order_line_items.quantity)";
    case "order_count":
      return "count(distinct orders)";
    case "average_order_value":
      return "revenue / count(distinct orders)";
    case "discount_value":
      return usesLineData(request) ? "sum(order_line_items.discount)" : "sum(orders.total_discount)";
    case "gross_margin":
      return "sum(line revenue where cost-covered) - sum(variant.unit_cost * quantity)";
    case "inventory_units":
      return "sum(inventory_levels.available)";
    case "retail_stock_value":
      return "sum(inventory_levels.available * variant.price)";
    case "trapped_capital":
      return "sum(inventory_levels.available * variant.unit_cost)";
    case "stock_cover_days":
      return "available inventory units / trailing-window daily units sold";
    default:
      return `allowlisted ${request.measure} calculation`;
  }
}

/** @param {string} measure */
function actionFormula(measure) {
  if (measure === "action_revenue_recovered") return "sum(action_executions.outcome.revenueRecovered)";
  if (measure === "action_units_moved") return "sum(action_executions.outcome.unitsMoved)";
  return "average(action_executions.outcome.sellThroughRate)";
}

/**
 * @param {AnyRecord} order
 * @param {string[]} dimensions
 */
function groupForOrder(order, dimensions) {
  /** @type {AnyRecord} */
  const dimensionsOut = {};
  for (const dimension of dimensions) {
    dimensionsOut[dimension] = dimensionValueForOrder(order, dimension);
  }
  return { dimensions: dimensionsOut, label: labelFromDimensions(dimensionsOut) };
}

/**
 * @param {AnyRecord} refund
 * @param {string[]} dimensions
 */
function groupForRefund(refund, dimensions) {
  /** @type {AnyRecord} */
  const dimensionsOut = {};
  for (const dimension of dimensions) {
    dimensionsOut[dimension] = dimensionValueForOrder(refund.order ?? refund, dimension);
  }
  return { dimensions: dimensionsOut, label: labelFromDimensions(dimensionsOut) };
}

/**
 * @param {AnyRecord} line
 * @param {string[]} dimensions
 * @param {AnyRecord} dataset
 */
function groupForLine(line, dimensions, dataset) {
  /** @type {AnyRecord} */
  const dimensionsOut = {};
  for (const dimension of dimensions) {
    dimensionsOut[dimension] = dimensionValueForLine(line, dimension, dataset);
  }
  return { dimensions: dimensionsOut, label: labelFromDimensions(dimensionsOut) };
}

/**
 * @param {AnyRecord} level
 * @param {AnyRecord} variant
 * @param {AnyRecord | undefined} product
 * @param {string[]} dimensions
 */
function groupForInventory(level, variant, product, dimensions) {
  /** @type {AnyRecord} */
  const dimensionsOut = {};
  for (const dimension of dimensions) {
    dimensionsOut[dimension] = dimensionValueForInventory(level, variant, product, dimension);
  }
  return { dimensions: dimensionsOut, label: labelFromDimensions(dimensionsOut) };
}

/**
 * @param {AnyRecord} order
 * @param {string} dimension
 */
function dimensionValueForOrder(order, dimension) {
  if (dimension === "day") return dayKey(order.processedAt);
  if (dimension === "week") return weekKey(order.processedAt);
  if (dimension === "month") return monthKey(order.processedAt);
  if (dimension === "channel") return safeText(order.sourceName, 120) || "unknown_channel";
  if (dimension === "country") return safeText(order.shippingCountry, 120) || "unknown_country";
  return "all";
}

/**
 * @param {AnyRecord} line
 * @param {string} dimension
 * @param {AnyRecord} dataset
 */
function dimensionValueForLine(line, dimension, dataset) {
  const variant = dataset.variantById.get(String(line.variantId ?? ""));
  const productId = productIdForLine(line, dataset);
  const product = dataset.productById.get(String(productId ?? ""));
  if (dimension === "product") return safeText(product?.title, 180) || productId || "unknown_product";
  if (dimension === "variant") return safeText(variant?.title ?? line.title, 180) || line.variantId || "unknown_variant";
  if (dimension === "vendor") return safeText(product?.vendor, 120) || "unknown_vendor";
  if (dimension === "product_type") return safeText(product?.productType, 120) || "unknown_product_type";
  if (dimension === "sku") return safeText(line.sku ?? variant?.sku, 120) || "unknown_sku";
  return dimensionValueForOrder(line.order ?? {}, dimension);
}

/**
 * @param {AnyRecord} _level
 * @param {AnyRecord} variant
 * @param {AnyRecord | undefined} product
 * @param {string} dimension
 */
function dimensionValueForInventory(_level, variant, product, dimension) {
  if (dimension === "product") return safeText(product?.title, 180) || variant.productId || "unknown_product";
  if (dimension === "variant") return safeText(variant.title, 180) || variant.id || "unknown_variant";
  if (dimension === "vendor") return safeText(product?.vendor, 120) || "unknown_vendor";
  if (dimension === "product_type") return safeText(product?.productType, 120) || "unknown_product_type";
  if (dimension === "sku") return safeText(variant.sku, 120) || "unknown_sku";
  return "current";
}

/**
 * @param {AnyRecord} line
 * @param {AnyRecord} filters
 * @param {AnyRecord} dataset
 */
function matchesLine(line, filters, dataset) {
  const variant = dataset.variantById.get(String(line.variantId ?? ""));
  const productId = productIdForLine(line, dataset);
  const product = dataset.productById.get(String(productId ?? ""));
  if (filters.productIds.length && !filters.productIds.includes(String(productId))) return false;
  if (filters.variantIds.length && !filters.variantIds.includes(String(line.variantId))) return false;
  if (filters.vendor && safeText(product?.vendor, 120) !== filters.vendor) return false;
  if (filters.productType && safeText(product?.productType, 120) !== filters.productType) return false;
  if (filters.sku && safeText(line.sku ?? variant?.sku, 120) !== filters.sku) return false;
  return matchesOrder(line.order ?? {}, filters);
}

/**
 * @param {AnyRecord} variant
 * @param {AnyRecord} filters
 * @param {AnyRecord} dataset
 */
function matchesVariant(variant, filters, dataset) {
  const product = dataset.productById.get(String(variant.productId ?? ""));
  if (filters.productIds.length && !filters.productIds.includes(String(variant.productId))) return false;
  if (filters.variantIds.length && !filters.variantIds.includes(String(variant.id))) return false;
  if (filters.vendor && safeText(product?.vendor, 120) !== filters.vendor) return false;
  if (filters.productType && safeText(product?.productType, 120) !== filters.productType) return false;
  if (filters.sku && safeText(variant.sku, 120) !== filters.sku) return false;
  return true;
}

/**
 * @param {AnyRecord} order
 * @param {AnyRecord} filters
 */
function matchesOrder(order, filters) {
  if (filters.channel && safeText(order.sourceName, 120) !== filters.channel) return false;
  if (filters.country && safeText(order.shippingCountry, 120) !== filters.country) return false;
  if (filters.statuses.length && !filters.statuses.includes(String(order.financialStatus ?? ""))) return false;
  return true;
}

/**
 * @param {AnyRecord} refund
 * @param {AnyRecord} filters
 */
function matchesRefund(refund, filters) {
  if (filters.channel && safeText(refund.order?.sourceName, 120) !== filters.channel) return false;
  if (filters.country && safeText(refund.order?.shippingCountry, 120) !== filters.country) return false;
  return true;
}

/**
 * @param {AnyRecord} row
 * @param {AnyRecord} filters
 */
function matchesStatuses(row, filters) {
  return !filters.statuses.length || filters.statuses.includes(String(row.status ?? ""));
}

/**
 * @param {AnyRecord} line
 * @param {AnyRecord} dataset
 */
function productIdForLine(line, dataset) {
  if (line.productId) return String(line.productId);
  const variant = dataset.variantById.get(String(line.variantId ?? ""));
  return variant?.productId ? String(variant.productId) : "";
}

/**
 * @param {AnyRecord[]} lineItems
 * @param {AnyRecord} dataset
 */
function unitsSoldByProduct(lineItems, dataset) {
  const map = new Map();
  for (const line of lineItems) {
    const productId = productIdForLine(line, dataset);
    if (!productId) continue;
    map.set(productId, number(map.get(productId)) + number(line.quantity));
  }
  return map;
}

/**
 * @param {AnyRecord[]} lineItems
 * @param {AnyRecord} dataset
 */
function revenueByProductMap(lineItems, dataset) {
  const map = new Map();
  for (const line of lineItems) {
    const productId = productIdForLine(line, dataset);
    if (!productId) continue;
    map.set(productId, number(map.get(productId)) + lineRevenue(line));
  }
  return map;
}

/**
 * @param {AnyRecord[]} inventoryLevels
 * @param {AnyRecord} dataset
 */
function inventoryUnitsByProduct(inventoryLevels, dataset) {
  const map = new Map();
  for (const level of inventoryLevels) {
    const variant = dataset.variantById.get(String(level.variantId ?? ""));
    if (!variant?.productId) continue;
    map.set(String(variant.productId), number(map.get(String(variant.productId))) + number(level.available));
  }
  return map;
}

/**
 * @param {AnyRecord} request
 * @param {AnyRecord} dataset
 * @param {AnyRecord[]} lineItems
 * @param {AnyRecord[]} inventoryLevels
 */
function impactScopeProductIds(request, dataset, lineItems, inventoryLevels) {
  if (request.filters.productIds.length) {
    return uniqueStrings(request.filters.productIds).slice(0, MAX_ROWS);
  }
  if (request.filters.variantIds.length) {
    return uniqueStrings(
      request.filters.variantIds
        .map((/** @type {string} */ variantId) => dataset.variantById.get(String(variantId))?.productId)
        .filter(Boolean),
    ).slice(0, MAX_ROWS);
  }
  const fromLines = lineItems.map((line) => productIdForLine(line, dataset));
  const fromInventory = inventoryLevels
    .map((level) => dataset.variantById.get(String(level.variantId ?? ""))?.productId)
    .filter(Boolean);
  return uniqueStrings([...fromLines, ...fromInventory]).slice(0, MAX_ROWS);
}

/** @param {any} actionContext */
function hasLowCoverContext(actionContext) {
  return allContextBlocks(actionContext).some(
    (block) => block?.kind === "structured_evidence" && block?.data?.key === "inventory.low_cover_products.trailing_30d",
  );
}

/** @param {any} actionContext */
function allContextBlocks(actionContext) {
  return [
    ...(Array.isArray(actionContext?.planEvidenceAtRecommendationTime?.blocks)
      ? actionContext.planEvidenceAtRecommendationTime.blocks
      : []),
    ...(Array.isArray(actionContext?.currentSystemContext?.blocks)
      ? actionContext.currentSystemContext.blocks
      : []),
  ];
}

/** @param {unknown} kind */
function normalizeKind(kind) {
  const value = safeText(kind, 80);
  return REQUEST_KINDS.has(value) ? value : value || "aggregate";
}

/** @param {unknown} measure */
function normalizeMeasure(measure) {
  const value = safeText(measure, 80);
  return MEASURE_ALIASES[value] ?? value;
}

/** @param {unknown} dimension */
function normalizeDimension(dimension) {
  const value = safeText(dimension, 80);
  return DIMENSION_ALIASES[value] ?? value;
}

/**
 * @param {unknown} window
 * @param {Date} now
 */
function normalizeWindow(window, now) {
  const record = asRecord(window) ?? {};
  const days = clampInteger(record.days, 1, MAX_WINDOW_DAYS, DEFAULT_WINDOW_DAYS);
  const from = parseDate(record.from) ?? new Date(now.getTime() - days * 86400000);
  const to = parseDate(record.to) ?? now;
  return {
    from,
    to,
    days: Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86400000)),
    label: safeText(record.label, 80) || `trailing_${days}d`,
  };
}

/**
 * @param {unknown} comparison
 * @param {Date} now
 */
function normalizeComparison(comparison, now) {
  const record = asRecord(comparison) ?? {};
  const windows = Array.isArray(record.windows)
    ? record.windows.slice(0, 3).map((window) => normalizeWindow(window, now))
    : [];
  return { windows };
}

/** @param {AnyRecord | null | undefined} window */
function dateFilter(window) {
  /** @type {AnyRecord} */
  const filter = {};
  if (window?.from) filter.gte = window.from;
  if (window?.to) filter.lte = window.to;
  return Object.keys(filter).length ? filter : null;
}

/**
 * @param {any} model
 * @param {AnyRecord} args
 * @returns {Promise<AnyRecord[]>}
 */
async function safeFindMany(model, args) {
  if (!model?.findMany) return [];
  return model.findMany(args);
}

/** @param {AnyRecord} line */
function lineRevenue(line) {
  const total = nullableNumber(line.totalPrice);
  if (total !== null) return total;
  const unit = nullableNumber(line.unitPrice);
  return unit === null ? 0 : unit * number(line.quantity);
}

/** @param {unknown} value */
function money(value) {
  return number(value);
}

/** @param {unknown} value */
function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** @param {unknown} value */
function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @param {unknown} value
 * @param {number} [digits]
 */
function round(value, digits = 2) {
  const parsed = number(value);
  const factor = 10 ** digits;
  return Math.round(parsed * factor) / factor;
}

/**
 * @param {unknown[]} values
 * @returns {number}
 */
function sum(values) {
  let total = 0;
  for (const value of values) total += number(value);
  return total;
}

/** @param {AnyRecord[]} rows */
function costCoverage(rows) {
  const coverages = rows.map((row) => nullableNumber(row.costCoverage)).filter((value) => value !== null);
  return coverages.length ? round(sum(coverages) / coverages.length, 4) : null;
}

/** @param {unknown[]} currencies */
function singleCurrency(currencies) {
  const unique = uniqueStrings(currencies).filter(Boolean);
  return unique.length === 1 ? unique[0] : null;
}

/** @param {AnyRecord[]} rows */
function currencyFromRows(rows) {
  return singleCurrency(rows.map((row) => row.currency).filter(Boolean));
}

/** @param {AnyRecord} dimensions */
function labelFromDimensions(dimensions) {
  const entries = Object.entries(dimensions);
  return entries.length ? entries.map((entry) => String(entry[1])).join(" / ") : "All";
}

/** @param {AnyRecord[]} rows */
function sanitizeRows(rows) {
  return rows.map((row) => sanitizeRecord(row)).slice(0, MAX_ROWS);
}

/** @param {unknown} record */
function sanitizeRecord(record) {
  /** @type {AnyRecord} */
  const output = {};
  for (const [key, value] of Object.entries(asRecord(record) ?? {})) {
    if (/raw|payload|customer|email|phone|address|credential|token|secret/i.test(key)) continue;
    if (Array.isArray(value)) output[key] = value.slice(0, MAX_ROWS).map((item) => sanitizeRecord(item));
    else if (value && typeof value === "object" && !(value instanceof Date)) output[key] = sanitizeRecord(value);
    else output[key] = typeof value === "string" ? safeText(value, 240) : value;
  }
  return output;
}

/** @param {unknown} value */
function safeId(value) {
  return safeText(value, 80).replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 80);
}

/**
 * @param {unknown} value
 * @param {number} max
 */
function safeText(value, max) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted]")
    .slice(0, max);
}

/** @param {unknown} value */
function text(value) {
  return safeText(value, 240);
}

/** @param {unknown} value */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : null;
}

/** @param {unknown[]} values */
function uniqueStrings(values) {
  return [...new Set((values ?? []).map((value) => safeText(value, 240)).filter(Boolean))];
}

/** @param {CommerceCalculationRequest[]} requests */
function uniqueRequests(requests) {
  const seen = new Set();
  /** @type {CommerceCalculationRequest[]} */
  const output = [];
  for (const request of requests) {
    const key = JSON.stringify({
      kind: request.kind,
      measure: request.measure,
      dimensions: request.dimensions ?? [],
      filters: request.filters ?? {},
      window: request.window ?? {},
    });
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(request);
  }
  return output;
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

/** @param {unknown} value */
function parseDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : null;
}

/** @param {string} message */
function windowDaysFromText(message) {
  const match = String(message).match(/\b(?:last|trailing)\s+(\d{1,3})\s*(?:days?|d)\b/i);
  if (!match) return null;
  return clampInteger(match[1], 1, MAX_WINDOW_DAYS, DEFAULT_WINDOW_DAYS);
}

/** @param {unknown} value */
function dayKey(value) {
  const date = parseDate(value);
  return date ? date.toISOString().slice(0, 10) : "unknown_day";
}

/** @param {unknown} value */
function monthKey(value) {
  const date = parseDate(value);
  return date ? date.toISOString().slice(0, 7) : "unknown_month";
}

/** @param {unknown} value */
function weekKey(value) {
  const date = parseDate(value);
  if (!date) return "unknown_week";
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const day = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - start.getTime()) / 86400000);
  const week = Math.floor(day / 7) + 1;
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
