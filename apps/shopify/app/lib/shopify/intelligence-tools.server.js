// @ts-nocheck

import { ShopifyAdminGraphqlClient } from "./admin-graphql.server.js";
import { loadFreshOfflineToken } from "./offline-token.server.js";
import { logger as baseLogger } from "../observability/logger.server.js";
import {
  AVAILABILITY_STATE,
  SHOPIFY_INTELLIGENCE_COVERAGE_VERSION,
  getShopifyEvidenceRequirement,
  shopifyIntelligenceAvailabilityLegend,
} from "./intelligence-coverage.server.js";

export const SHOPIFY_INTELLIGENCE_TOOL_VERSION = "shopify_intelligence_tools_v1";

const MAX_TOOL_CALLS = 6;
const MAX_WINDOW_DAYS = 365;
const DEFAULT_WINDOW_DAYS = 90;
const MAX_LIMIT = 50;

const TOOL_DEFINITIONS = Object.freeze([
  tool("shopify_get_order_context", "retrieval", ["orders.core_totals", "orders.line_items", "orders.discount_identity", "orders.acquisition_journey", "orders.fulfilment_state", "returns.refund_amounts"]),
  tool("shopify_get_product_metadata", "retrieval", ["products.core_catalog", "products.variant_pricing", "products.inventory_levels", "products.collections", "products.tags", "products.metafields", "products.publication_state"]),
  tool("shopify_get_customer_commerce_summary", "retrieval", ["customers.identity_hash", "customers.order_counts", "customers.spend", "customers.product_relationships"]),
  tool("shopify_analyse_sales_mix", "analysis", ["orders.core_totals", "orders.line_items", "orders.source_name", "returns.refund_amounts"]),
  tool("shopify_analyse_product_performance", "analysis", ["orders.line_items", "products.core_catalog", "products.variant_pricing", "products.unit_cost", "products.inventory_levels", "returns.refund_line_items"]),
  tool("shopify_analyse_discount_usage", "analysis", ["orders.discount_amount", "orders.discount_identity", "customers.order_counts", "orders.acquisition_journey"]),
  tool("shopify_analyse_acquisition_quality", "analysis", ["orders.acquisition_journey", "customers.order_counts", "customers.spend", "returns.refund_amounts"]),
  tool("shopify_analyse_returns", "analysis", ["returns.refund_amounts", "returns.refund_line_items", "returns.reasons", "products.core_catalog"]),
  tool("shopify_analyse_fulfilment", "analysis", ["orders.fulfilment_state", "orders.core_totals"]),
  tool("shopify_analyse_customer_retention", "analysis", ["customers.identity_hash", "customers.order_counts", "customers.spend", "customers.product_relationships"]),
  tool("shopify_analyse_action_outcome", "analysis", ["actions.execution_ledger", "orders.core_totals", "orders.line_items", "returns.refund_amounts", "products.inventory_levels"]),
]);

const TOOL_BY_NAME = new Map(TOOL_DEFINITIONS.map((item) => [item.name, item]));

const ORDER_CONTEXT_QUERY = `#graphql
  query JefeIntelligenceOrderContext($id: ID!) {
    node(id: $id) {
      __typename
      ... on Order {
        id name createdAt processedAt displayFinancialStatus displayFulfillmentStatus sourceName
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        currentTotalDiscountsSet { shopMoney { amount currencyCode } }
        discountCodes
        customerJourneySummary {
          customerOrderIndex
          firstVisit { source referralCode landingPage occurredAt utmParameters { source medium campaign } }
          lastVisit { source referralCode landingPage occurredAt utmParameters { source medium campaign } }
        }
        lineItems(first: 50) { nodes { id title sku quantity discountedTotalSet { shopMoney { amount currencyCode } } product { id title } variant { id title sku } } }
        refunds { id createdAt totalRefundedSet { shopMoney { amount currencyCode } } }
      }
    }
  }
`;

const PRODUCT_METADATA_QUERY = `#graphql
  query JefeIntelligenceProductMetadata($id: ID!) {
    node(id: $id) {
      __typename
      ... on Product {
        id title handle status vendor productType tags createdAt updatedAt
        collections(first: 20) { nodes { id title handle } }
        metafields(first: 20) { nodes { namespace key type value } }
        variants(first: 50) { nodes { id title sku price inventoryQuantity inventoryItem { unitCost { amount currencyCode } } } }
      }
    }
  }
`;

/** @param {string} name @param {"retrieval" | "analysis"} kind @param {string[]} evidenceRequirements */
function tool(name, kind, evidenceRequirements) {
  return Object.freeze({ name, kind, evidenceRequirements });
}

export function shopifyIntelligenceToolCatalogForPrompt() {
  return {
    version: SHOPIFY_INTELLIGENCE_TOOL_VERSION,
    coverageVersion: SHOPIFY_INTELLIGENCE_COVERAGE_VERSION,
    limits: {
      maxToolCalls: MAX_TOOL_CALLS,
      maxWindowDays: MAX_WINDOW_DAYS,
      maxLimit: MAX_LIMIT,
    },
    availabilityStates: shopifyIntelligenceAvailabilityLegend(),
    toolClasses: {
      retrieval: "Use for targeted context about a specific order, product or customer aggregate.",
      analysis: "Use for bounded computation over a window. Prefer these for why/which/working questions.",
    },
    tools: TOOL_DEFINITIONS.map((definition) => ({
      name: definition.name,
      class: definition.kind,
      evidenceRequirements: definition.evidenceRequirements,
    })),
    prohibited: [
      "arbitrary GraphQL",
      "SQL or raw database access",
      "customer emails, phone numbers, addresses, names, notes or raw payloads",
      "credentials, tokens, sessions or secrets",
      "external writes or execution claims",
    ],
  };
}

export function listShopifyIntelligenceTools() {
  return [...TOOL_DEFINITIONS];
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; calls: any[]; logger?: Pick<Console, "info" | "warn" | "error">; now?: Date; client?: { request: (query: string, variables?: Record<string, unknown>) => Promise<any> } | null }} input
 */
export async function executeShopifyIntelligenceToolCalls(prisma, input) {
  const calls = Array.isArray(input.calls) ? input.calls.slice(0, MAX_TOOL_CALLS) : [];
  const results = [];
  for (const call of calls) {
    results.push(await executeShopifyIntelligenceTool(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      toolName: call?.toolName ?? call?.name ?? call?.tool,
      input: call?.input ?? call?.request ?? {},
      logger: input.logger,
      now: input.now,
      client: input.client,
    }));
  }
  return results;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; toolName: unknown; input?: any; logger?: Pick<Console, "info" | "warn" | "error">; now?: Date; client?: { request: (query: string, variables?: Record<string, unknown>) => Promise<any> } | null }} input
 */
export async function executeShopifyIntelligenceTool(prisma, input) {
  const log = input.logger ?? baseLogger.child({ component: "shopify-intelligence" });
  const started = Date.now();
  const name = safeId(input.toolName);
  const definition = TOOL_BY_NAME.get(name);
  if (!definition) return rejected(name || "unknown", "Unsupported Shopify intelligence tool.");
  if (!safeText(input.shopId, 120)) return rejected(name, "shopId is required for tenant-scoped Shopify intelligence.");
  if (containsUnsafeInput(input.input)) return rejected(name, "Unsupported Shopify intelligence request.");

  const context = {
    merchantId: input.merchantId,
    shopId: safeText(input.shopId, 120),
    now: input.now ?? new Date(),
    logger: log,
    client: input.client ?? null,
  };
  try {
    const result =
      name === "shopify_get_order_context"
        ? await getOrderContext(prisma, context, input.input)
        : name === "shopify_get_product_metadata"
          ? await getProductMetadata(prisma, context, input.input)
          : name === "shopify_get_customer_commerce_summary"
            ? await getCustomerCommerceSummary(prisma, context, input.input)
            : name === "shopify_analyse_sales_mix"
              ? await analyseSalesMix(prisma, context, input.input)
              : name === "shopify_analyse_product_performance"
                ? await analyseProductPerformance(prisma, context, input.input)
                : name === "shopify_analyse_discount_usage"
                  ? await analyseDiscountUsage(prisma, context, input.input)
                  : name === "shopify_analyse_acquisition_quality"
                    ? await analyseAcquisitionQuality(prisma, context, input.input)
                    : name === "shopify_analyse_returns"
                      ? await analyseReturns(prisma, context, input.input)
                      : name === "shopify_analyse_fulfilment"
                        ? await analyseFulfilment(prisma, context, input.input)
                        : name === "shopify_analyse_customer_retention"
                          ? await analyseCustomerRetention(prisma, context, input.input)
                          : await analyseActionOutcome(prisma, context, input.input);
    const shaped = shapeResult(name, definition, result, started);
    log.info("Shopify intelligence tool executed", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      toolName: name,
      status: shaped.status,
      availabilityState: shaped.availabilityState,
      durationMs: shaped.durationMs,
      rowCount: shaped.dataQuality?.rowCount ?? 0,
    });
    return shaped;
  } catch (error) {
    log.warn("Shopify intelligence tool unavailable", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      toolName: name,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return shapeResult(name, definition, {
      status: "unavailable",
      availabilityState: AVAILABILITY_STATE.unavailable,
      rows: [],
      totals: {},
      dataQuality: {},
      caveats: ["The Shopify intelligence tool could not complete. Jefe should not infer a negative result."],
    }, started);
  }
}

/** @param {any} name @param {string} error */
function rejected(name, error) {
  return {
    id: safeId(name) || "shopify_query",
    ok: false,
    toolKind: "shopify_query",
    status: "rejected",
    availabilityState: AVAILABILITY_STATE.unavailable,
    error,
    rows: [],
    totals: {},
    dataQuality: {},
    caveats: ["Rejected before reading Shopify or mirrored commerce data."],
    catalogVersion: SHOPIFY_INTELLIGENCE_TOOL_VERSION,
  };
}

/** @param {string} name @param {any} definition @param {any} result @param {number} started */
function shapeResult(name, definition, result, started) {
  const evidenceAvailability = definition.evidenceRequirements.map((id) => {
    const requirement = getShopifyEvidenceRequirement(id);
    return {
      id,
      state: result.evidenceAvailability?.[id] ?? requirement?.availabilityState ?? AVAILABILITY_STATE.unknown,
      accessStrategy: requirement?.accessStrategy ?? null,
      blockingReason: requirement?.blockingReason ?? null,
    };
  });
  const availabilityState = strongestAvailability(result.availabilityState, evidenceAvailability.map((item) => item.state));
  return sanitizeRecord({
    id: name,
    ok: result.status !== "rejected" && availabilityState !== AVAILABILITY_STATE.unavailable,
    toolKind: "shopify_query",
    toolClass: definition.kind,
    status: result.status ?? "ok",
    availabilityState,
    evidenceAvailability,
    rows: Array.isArray(result.rows) ? result.rows.slice(0, MAX_LIMIT).map(sanitizeRecord) : [],
    totals: sanitizeRecord(result.totals ?? {}),
    dataQuality: sanitizeRecord({
      ...(result.dataQuality ?? {}),
      rowCount: Array.isArray(result.rows) ? result.rows.length : 0,
    }),
    caveats: uniqueStrings([
      ...(Array.isArray(result.caveats) ? result.caveats : []),
      ...evidenceAvailability
        .filter((item) => item.state === AVAILABILITY_STATE.notIngested || item.state === AVAILABILITY_STATE.insufficientEvidence || item.state === AVAILABILITY_STATE.unavailable)
        .map((item) => `${item.id}: ${item.state}${item.blockingReason ? ` (${item.blockingReason})` : ""}`),
    ]),
    provenance: sanitizeRecord(result.provenance ?? { source: "jefe_shopify_intelligence", transient: true }),
    durationMs: Date.now() - started,
    catalogVersion: SHOPIFY_INTELLIGENCE_TOOL_VERSION,
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {any} context
 * @param {any} raw
 */
async function getOrderContext(prisma, context, raw) {
  const orderId = safeText(raw?.orderId ?? raw?.id, 180);
  const orderName = safeText(raw?.orderName ?? raw?.name, 80);
  if (!orderId && !orderName) {
    return { status: "rejected", availabilityState: AVAILABILITY_STATE.unavailable, rows: [], totals: {}, caveats: ["orderId or orderName is required."] };
  }
  const mirror = await prisma.order?.findFirst?.({
    where: {
      merchantId: context.merchantId,
      shopId: context.shopId,
      ...(orderId ? { externalId: orderId } : { orderName }),
    },
    include: {
      lineItems: { include: { product: true, variant: true }, take: MAX_LIMIT },
      refunds: { take: MAX_LIMIT },
    },
  });
  if (mirror) {
    return {
      status: "ok",
      availabilityState: AVAILABILITY_STATE.known,
      rows: [orderRow(mirror)],
      totals: { orderCount: 1, lineItemCount: mirror.lineItems?.length ?? 0, refundCount: mirror.refunds?.length ?? 0 },
      evidenceAvailability: attributionAvailability(mirror),
      provenance: { source: "canonical_mirror", transient: true, orderId: mirror.externalId },
    };
  }
  if (orderId && isShopifyGid(orderId)) {
    const live = await liveClient(prisma, context);
    if (live) {
      const data = await live.request(ORDER_CONTEXT_QUERY, { id: orderId });
      const node = data?.node;
      if (node?.__typename === "Order") {
        return {
          status: "ok",
          availabilityState: AVAILABILITY_STATE.known,
          rows: [liveOrderRow(node)],
          totals: { orderCount: 1 },
          evidenceAvailability: attributionAvailability(node),
          provenance: { source: "shopify_on_demand", transient: true, orderId },
        };
      }
    }
  }
  return { status: "not_found", availabilityState: AVAILABILITY_STATE.unknown, rows: [], totals: { orderCount: 0 }, caveats: ["No matching order was found. This is unknown, not proof the order never existed."] };
}

async function getProductMetadata(prisma, context, raw) {
  const productId = safeText(raw?.productId ?? raw?.id, 180);
  const handle = safeText(raw?.handle, 180);
  if (!productId && !handle) return { status: "rejected", availabilityState: AVAILABILITY_STATE.unavailable, rows: [], totals: {}, caveats: ["productId or handle is required."] };
  const mirror = await prisma.product?.findFirst?.({
    where: { merchantId: context.merchantId, shopId: context.shopId, ...(productId ? { OR: [{ id: productId }, { externalId: productId }] } : { handle }) },
    include: { variants: { include: { inventoryLevels: true }, take: MAX_LIMIT } },
  });
  if (mirror) {
    /** @type {Record<string, string>} */
    const evidenceAvailability = {
      "products.collections": AVAILABILITY_STATE.unknown,
      "products.tags": AVAILABILITY_STATE.unknown,
      "products.metafields": AVAILABILITY_STATE.unknown,
      "products.publication_state": AVAILABILITY_STATE.unknown,
    };
    return {
      status: "ok",
      availabilityState: AVAILABILITY_STATE.known,
      rows: [productRow(mirror)],
      totals: { productCount: 1, variantCount: mirror.variants?.length ?? 0 },
      evidenceAvailability,
      caveats: ["Collections, tags, metafields and publication state are live Shopify context; absence in the mirror is not absence in Shopify."],
      provenance: { source: "canonical_mirror", transient: true, productId: mirror.externalId },
    };
  }
  if (productId && isShopifyGid(productId)) {
    const live = await liveClient(prisma, context);
    if (live) {
      const data = await live.request(PRODUCT_METADATA_QUERY, { id: productId });
      if (data?.node?.__typename === "Product") {
        return {
          status: "ok",
          availabilityState: AVAILABILITY_STATE.known,
          rows: [liveProductRow(data.node)],
          totals: { productCount: 1 },
          provenance: { source: "shopify_on_demand", transient: true, productId },
        };
      }
    }
  }
  return { status: "not_found", availabilityState: AVAILABILITY_STATE.unknown, rows: [], totals: { productCount: 0 } };
}

async function getCustomerCommerceSummary(prisma, context, raw) {
  const customerExternalId = safeText(raw?.customerExternalId ?? raw?.shopifyCustomerId, 180);
  const where = { merchantId: context.merchantId, shopId: context.shopId, ...(customerExternalId ? { shopifyCustomerId: customerExternalId } : {}) };
  const rows = await prisma.customerIdentity?.findMany?.({ where, take: clampInteger(raw?.limit, 1, MAX_LIMIT, 10) }) ?? [];
  return {
    status: "ok",
    availabilityState: rows.length ? AVAILABILITY_STATE.known : AVAILABILITY_STATE.unknown,
    rows: rows.map((row) => ({
      shopifyCustomerId: row.shopifyCustomerId ?? null,
      orderCount: number(row.orderCount),
      totalSpend: number(row.totalSpend),
      averageOrderValue: number(row.averageOrderValue),
      firstSeenOrderAt: iso(row.firstSeenOrderAt),
      lastOrderAt: iso(row.lastOrderAt),
    })),
    totals: {
      customerCount: rows.length,
      totalOrders: sum(rows.map((row) => number(row.orderCount))),
      totalSpend: round(sum(rows.map((row) => number(row.totalSpend)))),
    },
    provenance: { source: "canonical_mirror", transient: true },
  };
}

async function analyseSalesMix(prisma, context, raw) {
  const window = normalizeWindow(raw?.window, context.now);
  const orders = await readOrders(prisma, context, window);
  const current = orders.filter((order) => inRange(order.processedAt, window.from, window.to));
  const previous = orders.filter((order) => inRange(order.processedAt, window.previousFrom, window.from));
  const currentRevenue = sum(current.map((order) => number(order.totalPrice)));
  const previousRevenue = sum(previous.map((order) => number(order.totalPrice)));
  return {
    status: "ok",
    availabilityState: current.length || previous.length ? AVAILABILITY_STATE.known : AVAILABILITY_STATE.insufficientEvidence,
    rows: groupBy(current, (order) => safeText(order.sourceName, 80) || "unknown").map(([label, group]) => ({
      label,
      revenue: round(sum(group.map((order) => number(order.totalPrice)))),
      orderCount: group.length,
      discountValue: round(sum(group.map((order) => number(order.totalDiscount)))),
    })),
    totals: {
      currentRevenue: round(currentRevenue),
      previousRevenue: round(previousRevenue),
      revenueChange: round(currentRevenue - previousRevenue),
      revenueChangePercent: previousRevenue > 0 ? round(((currentRevenue - previousRevenue) / previousRevenue) * 100, 1) : null,
      currentOrderCount: current.length,
      previousOrderCount: previous.length,
    },
    provenance: { source: "canonical_mirror", transient: true, window: window.label },
  };
}

async function analyseProductPerformance(prisma, context, raw) {
  const window = normalizeWindow(raw?.window, context.now);
  const limit = clampInteger(raw?.limit ?? raw?.topN, 1, MAX_LIMIT, 10);
  const rows = await prisma.orderLineItem?.findMany?.({
    where: { merchantId: context.merchantId, shopId: context.shopId, order: { processedAt: { gte: window.from, lte: window.to } } },
    include: { product: true, variant: { include: { inventoryLevels: true } }, order: true },
    take: 1000,
  }) ?? [];
  const grouped = groupBy(rows, (row) => safeText(row.productId, 120) || "unknown")
    .map(([productId, group]) => {
      const first = group[0] ?? {};
      const inventory = group.flatMap((row) => row.variant?.inventoryLevels ?? []);
      return {
        productId,
        title: safeText(first.product?.title ?? first.title, 160) || "Unknown product",
        unitsSold: sum(group.map((row) => number(row.quantity))),
        revenue: round(sum(group.map((row) => number(row.totalPrice)))),
        discount: round(sum(group.map((row) => number(row.discount)))),
        availableUnits: sum(inventory.map((level) => number(level.available))),
      };
    })
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit);
  return {
    status: "ok",
    availabilityState: grouped.length ? AVAILABILITY_STATE.known : AVAILABILITY_STATE.insufficientEvidence,
    rows: grouped.map((row) => ({ ...row, stockRisk: row.availableUnits <= 0 && row.unitsSold > 0 ? "out_of_stock_seller" : row.availableUnits > row.unitsSold * 6 ? "slow_moving_stock" : "normal" })),
    totals: { productCount: grouped.length, revenue: round(sum(grouped.map((row) => row.revenue))), unitsSold: sum(grouped.map((row) => row.unitsSold)) },
    provenance: { source: "canonical_mirror", transient: true, window: window.label },
  };
}

async function analyseDiscountUsage(prisma, context, raw) {
  const window = normalizeWindow(raw?.window, context.now);
  const orders = await readOrders(prisma, context, window);
  const discounted = orders.filter((order) => number(order.totalDiscount) > 0);
  const identified = discounted.filter(hasDiscountIdentity);
  const coverage = discounted.length ? identified.length / discounted.length : 1;
  const offers = groupBy(identified.flatMap(discountOfferRows), (row) => row.label).map(([label, group]) => ({
    label,
    kind: group[0]?.kind ?? "unknown",
    orderCount: new Set(group.map((row) => row.orderId)).size,
    discountValue: round(sum(group.map((row) => row.discountValue))),
  })).sort((a, b) => b.orderCount - a.orderCount);
  return {
    status: coverage >= 0.7 ? "ok" : "partial",
    availabilityState: coverage >= 0.7 ? AVAILABILITY_STATE.known : discounted.length ? AVAILABILITY_STATE.insufficientEvidence : AVAILABILITY_STATE.known,
    rows: offers.slice(0, clampInteger(raw?.limit, 1, MAX_LIMIT, 10)),
    totals: {
      orderCount: orders.length,
      discountedOrderCount: discounted.length,
      discountIdentityCoveragePercent: round(coverage * 100, 1),
      totalDiscount: round(sum(discounted.map((order) => number(order.totalDiscount)))),
    },
    caveats: coverage < 0.7 ? ["Discount identity coverage is thin. Do not conclude the merchant runs no campaigns."] : [],
    provenance: { source: "canonical_mirror", transient: true, window: window.label },
  };
}

async function analyseAcquisitionQuality(prisma, context, raw) {
  const window = normalizeWindow(raw?.window, context.now);
  const orders = await readOrders(prisma, context, window);
  const withJourney = orders.filter((order) => firstVisitSource(order));
  const coverage = orders.length ? withJourney.length / orders.length : 0;
  if (!withJourney.length) {
    return {
      status: "not_ingested",
      availabilityState: AVAILABILITY_STATE.notIngested,
      rows: [],
      totals: { orderCount: orders.length, attributionCoveragePercent: 0 },
      caveats: ["Acquisition journey evidence is not ingested for these orders. Do not treat this as direct traffic."],
      provenance: { source: "canonical_mirror", transient: true, window: window.label },
    };
  }
  const rows = groupBy(withJourney, firstVisitSource).map(([label, group]) => ({
    label,
    orderCount: group.length,
    revenue: round(sum(group.map((order) => number(order.totalPrice)))),
    averageOrderValue: group.length ? round(sum(group.map((order) => number(order.totalPrice))) / group.length) : 0,
  }));
  return {
    status: coverage >= 0.7 ? "ok" : "partial",
    availabilityState: coverage >= 0.7 ? AVAILABILITY_STATE.known : AVAILABILITY_STATE.insufficientEvidence,
    rows,
    totals: { orderCount: orders.length, attributedOrderCount: withJourney.length, attributionCoveragePercent: round(coverage * 100, 1) },
    caveats: coverage < 0.7 ? ["Attribution coverage is thin. Do not extrapolate this to all orders."] : [],
    provenance: { source: "canonical_mirror", transient: true, window: window.label },
  };
}

async function analyseReturns(prisma, context, raw) {
  const window = normalizeWindow(raw?.window, context.now);
  const refunds = await prisma.refund?.findMany?.({
    where: { merchantId: context.merchantId, shopId: context.shopId, processedAt: { gte: window.from, lte: window.to } },
    include: { order: { include: { lineItems: { include: { product: true } } } } },
    take: 1000,
  }) ?? [];
  const productRows = refunds.flatMap((refund) => (refund.order?.lineItems ?? []).map((line) => ({
    productId: line.productId,
    title: line.product?.title ?? line.title,
    refundAmount: number(refund.amount),
    refundCount: 1,
  })));
  const rows = groupBy(productRows, (row) => safeText(row.productId, 120) || "unknown").map(([productId, group]) => ({
    productId,
    title: safeText(group[0]?.title, 160) || "Unknown product",
    refundAmount: round(sum(group.map((row) => row.refundAmount))),
    refundCount: sum(group.map((row) => row.refundCount)),
  }));
  return {
    status: "ok",
    availabilityState: refunds.length ? AVAILABILITY_STATE.known : AVAILABILITY_STATE.unknown,
    rows,
    totals: { refundCount: refunds.length, refundAmount: round(sum(refunds.map((refund) => number(refund.amount)))) },
    evidenceAvailability: { "returns.reasons": AVAILABILITY_STATE.unknown },
    caveats: ["Refund reason detail is on-demand/contextual; missing reasons are not proof returns were unproblematic."],
    provenance: { source: "canonical_mirror", transient: true, window: window.label },
  };
}

async function analyseFulfilment(prisma, context, raw) {
  const window = normalizeWindow(raw?.window, context.now);
  const orders = await readOrders(prisma, context, window);
  const rows = groupBy(orders, (order) => safeText(order.fulfillmentStatus, 80) || "unknown").map(([label, group]) => ({
    label,
    orderCount: group.length,
    revenue: round(sum(group.map((order) => number(order.totalPrice)))),
  }));
  return {
    status: "ok",
    availabilityState: rows.length ? AVAILABILITY_STATE.known : AVAILABILITY_STATE.insufficientEvidence,
    rows,
    totals: { orderCount: orders.length },
    provenance: { source: "canonical_mirror", transient: true, window: window.label },
  };
}

async function analyseCustomerRetention(prisma, context) {
  const customers = await prisma.customerIdentity?.findMany?.({
    where: { merchantId: context.merchantId, shopId: context.shopId },
    take: 1000,
  }) ?? [];
  const oneTime = customers.filter((row) => number(row.orderCount) <= 1);
  const returning = customers.filter((row) => number(row.orderCount) > 1);
  const loyal = customers.filter((row) => number(row.orderCount) >= 4);
  return {
    status: "ok",
    availabilityState: customers.length ? AVAILABILITY_STATE.known : AVAILABILITY_STATE.insufficientEvidence,
    rows: [
      cohortRow("one_time", oneTime),
      cohortRow("returning", returning),
      cohortRow("loyal", loyal),
    ],
    totals: {
      customerCount: customers.length,
      returningCustomerCount: returning.length,
      repeatCustomerRatePercent: customers.length ? round((returning.length / customers.length) * 100, 1) : null,
      totalSpend: round(sum(customers.map((row) => number(row.totalSpend)))),
    },
    provenance: { source: "canonical_mirror", transient: true },
  };
}

async function analyseActionOutcome(prisma, context, raw) {
  const actionRunId = safeText(raw?.actionRunId ?? raw?.runId, 120);
  const where = { merchantId: context.merchantId, shopId: context.shopId, ...(actionRunId ? { runId: actionRunId } : {}) };
  const rows = await prisma.actionExecution?.findMany?.({ where, orderBy: { createdAt: "desc" }, take: clampInteger(raw?.limit, 1, MAX_LIMIT, 10) }) ?? [];
  return {
    status: "ok",
    availabilityState: rows.length ? AVAILABILITY_STATE.known : AVAILABILITY_STATE.unknown,
    rows: rows.map((row) => ({
      runId: row.runId,
      actionType: row.actionType,
      status: row.status,
      appliedAt: iso(row.appliedAt),
      outcomeStatus: row.outcomeStatus ?? null,
      outcome: sanitizeRecord(row.outcome ?? {}),
    })),
    totals: { actionRunCount: rows.length, measuredCount: rows.filter((row) => row.outcomeStatus === "measured").length },
    caveats: rows.length ? [] : ["No matching action ledger rows were found. That is unknown, not proof the recommendation failed."],
    provenance: { source: "action_execution_ledger", transient: true },
  };
}

async function readOrders(prisma, context, window) {
  return await prisma.order?.findMany?.({
    where: { merchantId: context.merchantId, shopId: context.shopId, processedAt: { gte: window.previousFrom, lte: window.to } },
    take: 2000,
  }) ?? [];
}

/** @param {import("@prisma/client").PrismaClient} prisma @param {any} context */
async function liveClient(prisma, context) {
  if (context.client) return context.client;
  const shop = await prisma.shop?.findUnique?.({ where: { id: context.shopId }, select: { shopDomain: true } });
  if (!shop?.shopDomain) return null;
  const accessToken = await loadFreshOfflineToken(shop.shopDomain);
  return new ShopifyAdminGraphqlClient({
    shopDomain: shop.shopDomain,
    accessToken,
    logger: context.logger,
    maxRetries: 1,
  });
}

/** @param {any} order */
function orderRow(order) {
  return {
    orderId: order.externalId,
    orderName: order.orderName,
    processedAt: iso(order.processedAt),
    financialStatus: order.financialStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    sourceName: order.sourceName,
    currency: order.currency,
    totalPrice: number(order.totalPrice),
    totalDiscount: number(order.totalDiscount),
    discountCodes: arrayOfStrings(order.discountCodes),
    discountApplications: arrayOfRecords(order.discountApplications).map(discountApplicationRow),
    attribution: safeAttribution(order.attribution),
    lineItems: (order.lineItems ?? []).map((line) => ({
      title: line.product?.title ?? line.title,
      sku: line.variant?.sku ?? line.sku,
      quantity: number(line.quantity),
      totalPrice: number(line.totalPrice),
      discount: number(line.discount),
    })),
    refunds: (order.refunds ?? []).map((refund) => ({ amount: number(refund.amount), processedAt: iso(refund.processedAt ?? refund.sourceCreatedAt) })),
  };
}

function liveOrderRow(order) {
  return sanitizeRecord({
    orderId: order.id,
    orderName: order.name,
    processedAt: order.processedAt,
    financialStatus: order.displayFinancialStatus,
    fulfillmentStatus: order.displayFulfillmentStatus,
    sourceName: order.sourceName,
    totalPrice: money(order.currentTotalPriceSet?.shopMoney),
    totalDiscount: money(order.currentTotalDiscountsSet?.shopMoney),
    discountCodes: arrayOfStrings(order.discountCodes),
    attribution: safeAttribution(order.customerJourneySummary),
    lineItems: (order.lineItems?.nodes ?? []).map((line) => ({
      title: line.product?.title ?? line.title,
      sku: line.variant?.sku ?? line.sku,
      quantity: number(line.quantity),
      totalPrice: money(line.discountedTotalSet?.shopMoney),
    })),
    refunds: (order.refunds ?? []).map((refund) => ({ amount: money(refund.totalRefundedSet?.shopMoney), processedAt: refund.createdAt })),
  });
}

function productRow(product) {
  return {
    productId: product.externalId,
    title: product.title,
    handle: product.handle,
    status: product.status,
    vendor: product.vendor,
    productType: product.productType,
    sourceUpdatedAt: iso(product.sourceUpdatedAt),
    variants: (product.variants ?? []).map((variant) => ({
      variantId: variant.externalId,
      sku: variant.sku,
      title: variant.title,
      price: number(variant.price),
      currency: variant.currency,
      unitCost: number(variant.unitCost),
      availableUnits: sum((variant.inventoryLevels ?? []).map((level) => number(level.available))),
    })),
  };
}

function liveProductRow(product) {
  return sanitizeRecord({
    productId: product.id,
    title: product.title,
    handle: product.handle,
    status: product.status,
    vendor: product.vendor,
    productType: product.productType,
    tags: arrayOfStrings(product.tags).slice(0, 50),
    collections: (product.collections?.nodes ?? []).map((item) => ({ id: item.id, title: item.title, handle: item.handle })),
    metafields: (product.metafields?.nodes ?? []).map((item) => ({ namespace: item.namespace, key: item.key, type: item.type, value: safeText(item.value, 300) })),
    variants: (product.variants?.nodes ?? []).map((variant) => ({ id: variant.id, title: variant.title, sku: variant.sku, price: number(variant.price), inventoryQuantity: number(variant.inventoryQuantity), unitCost: money(variant.inventoryItem?.unitCost) })),
  });
}

function discountApplicationRow(application) {
  return {
    label: safeText(application.label ?? application.code ?? application.title, 120),
    kind: safeText(application.kind ?? application.type, 80) || "unknown",
    allocationMethod: safeText(application.allocationMethod ?? application.allocation_method, 80),
    targetType: safeText(application.targetType ?? application.target_type, 80),
  };
}

function attributionAvailability(order) {
  return { "orders.acquisition_journey": firstVisitSource(order) ? AVAILABILITY_STATE.known : AVAILABILITY_STATE.notIngested };
}

function firstVisitSource(order) {
  const attr = order.attribution ?? order.customerJourneySummary ?? {};
  return safeText(attr.firstVisit?.source ?? attr.first_visit?.source, 120) ||
    safeText(attr.firstVisit?.utmSource ?? attr.first_visit?.utm_source, 120) ||
    safeText(attr.firstVisit?.utmMedium ?? attr.first_visit?.utm_medium, 120);
}

function safeAttribution(value) {
  if (!value || typeof value !== "object") return {};
  const firstVisit = sanitizeVisit(value.firstVisit ?? value.first_visit);
  const lastVisit = sanitizeVisit(value.lastVisit ?? value.last_visit);
  return {
    ...(firstVisit ? { firstVisit } : {}),
    ...(lastVisit ? { lastVisit } : {}),
    customerOrderIndex: number(value.customerOrderIndex ?? value.customer_order_index) || null,
    daysToConversion: number(value.daysToConversion ?? value.days_to_conversion) || null,
  };
}

function sanitizeVisit(value) {
  if (!value || typeof value !== "object") return null;
  return {
    source: safeText(value.source, 120),
    referralCode: safeText(value.referralCode ?? value.referral_code, 120),
    landingPath: landingPath(value.landingPath ?? value.landingPage ?? value.landing_page),
    occurredAt: safeText(value.occurredAt ?? value.occurred_at, 80),
    utmSource: safeText(value.utmSource ?? value.utmParameters?.source, 120),
    utmMedium: safeText(value.utmMedium ?? value.utmParameters?.medium, 120),
    utmCampaign: safeText(value.utmCampaign ?? value.utmParameters?.campaign, 120),
  };
}

function hasDiscountIdentity(order) {
  return arrayOfStrings(order.discountCodes).length > 0 || arrayOfRecords(order.discountApplications).length > 0;
}

function discountOfferRows(order) {
  const applications = arrayOfRecords(order.discountApplications).map(discountApplicationRow).filter((item) => item.label);
  const codeOnly = arrayOfStrings(order.discountCodes).filter((code) => !applications.some((item) => item.label === code)).map((code) => ({ label: code, kind: "code" }));
  return [...applications, ...codeOnly].map((item) => ({ ...item, orderId: order.id, discountValue: number(order.totalDiscount) }));
}

function cohortRow(label, rows) {
  return {
    label,
    customerCount: rows.length,
    orderCount: sum(rows.map((row) => number(row.orderCount))),
    totalSpend: round(sum(rows.map((row) => number(row.totalSpend)))),
  };
}

function normalizeWindow(raw, now) {
  const days = clampInteger(raw?.days, 1, MAX_WINDOW_DAYS, DEFAULT_WINDOW_DAYS);
  const to = parseDate(raw?.to) ?? now;
  const from = parseDate(raw?.from) ?? new Date(to.getTime() - days * 86400000);
  const previousFrom = new Date(from.getTime() - (to.getTime() - from.getTime()));
  return { days, from, to, previousFrom, label: safeText(raw?.label, 80) || `trailing_${days}d` };
}

function containsUnsafeInput(input) {
  const text = JSON.stringify(input ?? {}).slice(0, 5000);
  return /\b(query|mutation|rawPayload|raw_payload|session|accessToken|token|secret|email|phone|address|note|customerName|firstName|lastName)\b/i.test(text);
}

function strongestAvailability(explicit, states) {
  if (explicit) return explicit;
  if (states.includes(AVAILABILITY_STATE.unavailable)) return AVAILABILITY_STATE.unavailable;
  if (states.includes(AVAILABILITY_STATE.notIngested)) return AVAILABILITY_STATE.notIngested;
  if (states.includes(AVAILABILITY_STATE.insufficientEvidence)) return AVAILABILITY_STATE.insufficientEvidence;
  if (states.includes(AVAILABILITY_STATE.unknown)) return AVAILABILITY_STATE.unknown;
  return AVAILABILITY_STATE.known;
}

// ⛔ PII scrubbing REMOVED 2026-08-13 (founder's call, applied across every surface). This used
// to drop customer-shaped keys and rewrite email/phone-shaped strings to [redacted-*] on every
// tool result before it reached the model. Customer details in these results now pass through
// verbatim. Credential masking is kept: a leaked bearer token is account takeover, not a privacy
// question, and that was not what was asked for.
function sanitizeRecord(value) {
  if (Array.isArray(value)) return value.map(sanitizeRecord);
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? maskCredentials(value) : value;
  }
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/token|secret/i.test(key)) continue;
    output[key] = sanitizeRecord(entry);
  }
  return output;
}

function maskCredentials(value) {
  return String(value).replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted-secret]");
}

function landingPath(value) {
  const raw = safeText(value, 400);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return `${url.host}${url.pathname}`.replace(/\/$/, "");
  } catch {
    return raw.split("?")[0].slice(0, 200);
  }
}

function groupBy(rows, keyFor) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFor(row) || "unknown";
    const group = map.get(key) ?? [];
    group.push(row);
    map.set(key, group);
  }
  return [...map.entries()];
}

function inRange(value, from, to) {
  const date = parseDate(value);
  return Boolean(date && date >= from && date < to);
}

function parseDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function iso(value) {
  const date = parseDate(value);
  return date ? date.toISOString() : null;
}

function number(value) {
  if (value && typeof value === "object" && "amount" in value) return number(value.amount);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value) {
  return value ? { amount: number(value.amount), currencyCode: safeText(value.currencyCode, 12) || null } : null;
}

function sum(values) {
  return values.reduce((total, value) => total + number(value), 0);
}

function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round(number(value) * factor) / factor;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function safeText(value, max) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : "";
}

function safeId(value) {
  return safeText(value, 120).replace(/[^a-zA-Z0-9_./:-]/g, "");
}

function isShopifyGid(value) {
  return /^gid:\/\/shopify\/[A-Za-z]+\/[0-9]+$/.test(String(value ?? ""));
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function arrayOfRecords(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}
