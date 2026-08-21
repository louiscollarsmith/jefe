// @ts-nocheck

import { ShopifyAdminGraphqlClient } from "../shopify/admin-graphql.server.js";
import {
  BOOTSTRAP_ACTIVE_PRODUCTS_QUERY,
  BOOTSTRAP_INVENTORY_LEVELS_QUERY,
  BOOTSTRAP_ORDER_LINE_ITEMS_QUERY,
  BOOTSTRAP_PRODUCT_VARIANTS_QUERY,
  BOOTSTRAP_RECENT_ORDERS_QUERY,
} from "../shopify/queries.server.js";
import { edgesToNodes, jsonObject, parseDate } from "../ingestion/shopify/normalize.server.js";
import { writeLedgerEvent } from "../ingestion/shopify/ledger.server.js";
import {
  upsertShopifyInventoryLevel,
  upsertShopifyOrder,
  upsertShopifyProduct,
  upsertShopifyVariant,
} from "../ingestion/shopify/canonical.server.js";
import { refreshBeliefs } from "../merchant-memory/service.server.js";
import {
  ACTIVE_BELIEF_STATUSES,
  BOOTSTRAP_SAFE_BELIEF_KEYS,
} from "../merchant-memory/constants.server.js";
import {
  BOOTSTRAP_BACKFILL_DOMAIN,
  upsertBackfillStatus,
} from "../../services/shopify-backfill-status.server.js";
import { trackOnce } from "../../services/analytics/event-log.server.js";

export const BOOTSTRAP_INITIAL_ORDER_LIMIT = 50;
export const BOOTSTRAP_SECOND_PASS_LIMIT = 100;
export const BOOTSTRAP_LOOKBACK_DAYS = 90;
export const BOOTSTRAP_CONNECTION_PAGE_SIZE = 250;
const ACTIVE_CATALOG_KEYS = [
  "catalog.active_product_count",
  "catalog.total_variant_count",
  "catalog.out_of_stock_product_count",
  "catalog.median_variant_price",
  "catalog.minimum_variant_price",
  "catalog.maximum_variant_price",
  "catalog.zero_price_variant_count",
  "catalog.variants_per_product_average",
  "catalog.variants_per_product_median",
  "business.catalogue_shape",
];
const STOCKOUT_KEYS = [
  "inventory.at_risk_stockout_count.trailing_30d",
  "inventory.low_cover_products.trailing_30d",
  "data.inventory_variant_coverage",
  "data.inventory_freshness_hours_p90",
  "data.line_item_product_link_coverage",
  "data.line_item_variant_link_coverage",
];
const COMPLETE_WINDOW_KEYS = [
  "products.top_product_revenue_share.trailing_90d",
  "products.bestseller_by_revenue.trailing_90d",
  "products.bestseller_by_units.trailing_90d",
  "business.discount_depth.trailing_90d",
  "data.currency_consistency",
  "data.priced_order_coverage",
  "data.line_item_product_link_coverage",
];
export const BOOTSTRAP_BELIEF_KEYS = BOOTSTRAP_SAFE_BELIEF_KEYS;

/**
 * Run the bounded first-value pipeline. Full-history status is deliberately not
 * read or written here.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; shopDomain: string; sessionId?: string | null; onboardingEpoch?: string | null; accessToken: string; fetchImpl?: typeof fetch; logger: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function runMerchantMemoryBootstrap(prisma, input) {
  const startedAt = new Date();
  input.logger.info("Merchant Memory bootstrap started", {
    merchantId: input.merchantId,
    shopId: input.shopId,
  });
  await setPhase(prisma, input, "reading_recent_orders", { startedAt: startedAt.toISOString() });
  void trackOnce(prisma, {
    type: "bootstrap_started",
    topic: "onboarding",
    merchantId: input.merchantId,
    shopId: input.shopId,
    shopDomain: input.shopDomain,
    dedupeKey: `bootstrap_started:${input.shopId}:${input.onboardingEpoch ?? "legacy"}`,
    summary: `Fast store read started for ${input.shopDomain}`,
    properties: { onboardingEpoch: input.onboardingEpoch ?? null },
  });

  const client = new ShopifyAdminGraphqlClient({
    shopDomain: input.shopDomain,
    accessToken: input.accessToken,
    fetchImpl: input.fetchImpl,
    logger: input.logger,
  });
  const query = `processed_at:>=${new Date(Date.now() - BOOTSTRAP_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10)}`;
  const first = await fetchRecentOrders(client, {
    first: BOOTSTRAP_INITIAL_ORDER_LIMIT,
    after: null,
    query,
  });
  let orders = first.orders;
  let hasNextPage = first.hasNextPage;
  let endCursor = first.endCursor;
  let passCount = 1;

  await setPhase(prisma, input, "checking_current_products", {
    passCount,
    orderCount: orders.length,
  });
  const catalog = await fetchActiveCatalog(client);
  let orderProductIds = productIdsFromOrders(orders);
  let orderVariantIds = variantIdsFromOrders(orders);
  let productIds = productIdsFromCatalog(catalog);
  let variantIds = variantIdsFromCatalog(catalog);
  await persistBootstrapSlice(prisma, input, { orders, ...catalog });

  let scope = evidenceScope(orders, productIds, variantIds, catalog, !hasNextPage, passCount, {
    orderProductIds,
    orderVariantIds,
  });
  let memory = await refreshBootstrapMemory(prisma, input, scope);
  let contracts = buildEvidenceContracts(memory.beliefs, scope);

  if (contracts.length === 0 && hasNextPage) {
    await setPhase(prisma, input, "checking_more_evidence", {
      passCount: 2,
      orderCount: orders.length,
    });
    const second = await fetchRecentOrders(client, {
      first: BOOTSTRAP_SECOND_PASS_LIMIT,
      after: endCursor,
      query,
    });
    passCount = 2;
    hasNextPage = second.hasNextPage;
    endCursor = second.endCursor;
    const secondProductIds = productIdsFromOrders(second.orders);
    const secondVariantIds = variantIdsFromOrders(second.orders);
    await persistBootstrapSlice(prisma, input, {
      orders: second.orders,
      products: [],
      variants: [],
    });
    orders = dedupeById([...orders, ...second.orders]);
    orderProductIds = [...new Set([...orderProductIds, ...secondProductIds])];
    orderVariantIds = [...new Set([...orderVariantIds, ...secondVariantIds])];
    scope = evidenceScope(orders, productIds, variantIds, catalog, !hasNextPage, passCount, {
      orderProductIds,
      orderVariantIds,
    });
    memory = await refreshBootstrapMemory(prisma, input, scope);
    contracts = buildEvidenceContracts(memory.beliefs, scope);
  }

  const bootstrapMetadata = scopeMetadata(scope);
  await setPhase(prisma, input, "evidence_ready", {
    passCount,
    orderCount: orders.length,
    productCount: productIds.length,
    ...bootstrapMetadata,
    observedFrom: scope.observedFrom,
    observedTo: scope.observedTo,
    completeRequestedWindow: scope.completeRequestedWindow,
    inventoryComplete: scope.inventoryComplete,
    lineItemsComplete: scope.lineItemsComplete,
    truncated: scope.truncated,
    eligibleContracts: contracts.map((contract) => contract.key),
    evidenceSize: {
      orders: orders.length,
      products: productIds.length,
      variants: variantIds.length,
      beliefs: memory.beliefs.length,
    },
  });
  input.logger.info("Merchant Memory bootstrap evidence ready", {
    merchantId: input.merchantId,
    shopId: input.shopId,
    observedFrom: scope.observedFrom,
    observedTo: scope.observedTo,
    orderCount: orders.length,
    productCount: productIds.length,
    variantCount: variantIds.length,
    lineItemCount: bootstrapMetadata.lineItemCount,
    inventoryLevelCount: bootstrapMetadata.inventoryLevelCount,
    activeCatalogComplete: scope.activeCatalogComplete,
    beliefCount: memory.beliefs.length,
    eligibleContractCount: contracts.length,
    passCount,
    truncated: scope.truncated,
  });
  void trackOnce(prisma, {
    type: "bootstrap_evidence_ready",
    topic: "onboarding",
    merchantId: input.merchantId,
    shopId: input.shopId,
    shopDomain: input.shopDomain,
    dedupeKey: `bootstrap_evidence_ready:${input.shopId}:${input.onboardingEpoch ?? "legacy"}`,
    summary: `Fast store evidence ready for ${input.shopDomain}`,
    properties: {
      orderCount: orders.length,
      productCount: productIds.length,
      variantCount: variantIds.length,
      lineItemCount: bootstrapMetadata.lineItemCount,
      inventoryLevelCount: bootstrapMetadata.inventoryLevelCount,
      observedFrom: scope.observedFrom,
      observedTo: scope.observedTo,
      passCount,
      truncated: scope.truncated,
      lineItemsComplete: scope.lineItemsComplete,
      activeCatalogComplete: scope.activeCatalogComplete,
      eligibleContractCount: contracts.length,
      onboardingEpoch: input.onboardingEpoch ?? null,
    },
  });

  if (contracts.length === 0) {
    const result = {
      phase: "insufficient_evidence",
      passCount,
      observedOrderIds: orders.map((order) => stringValue(order.id)).filter(Boolean),
      referencedProductIds: productIds,
      referencedVariantIds: variantIds,
      observedFrom: scope.observedFrom,
      observedTo: scope.observedTo,
      completeRequestedWindow: scope.completeRequestedWindow,
      inventoryComplete: scope.inventoryComplete,
      lineItemsComplete: scope.lineItemsComplete,
      ordersComplete: scope.ordersComplete,
      activeCatalogComplete: scope.activeCatalogComplete,
      truncated: scope.truncated,
      eligibleContracts: [],
      evidenceSize: {
        orders: orders.length,
        products: productIds.length,
        variants: variantIds.length,
        lineItems: bootstrapMetadata.lineItemCount,
        inventoryLevels: bootstrapMetadata.inventoryLevelCount,
        beliefs: memory.beliefs.length,
      },
      ...bootstrapMetadata,
      selectedContract: null,
      insightRunId: null,
      insightRunIds: [],
      planRunIds: [],
      recommendationIds: [],
      onboardingEpoch: input.onboardingEpoch ?? null,
    };
    await setPhase(prisma, input, result.phase, result, "complete");
    return result;
  }

  const merchantPriority = await prisma.merchantMemoryBelief.findFirst({
    where: {
      merchantId: input.merchantId,
      key: "preferences.optimisation_priority",
      status: { in: ACTIVE_BELIEF_STATUSES },
    },
    orderBy: { updatedAt: "desc" },
  });
  if (!merchantPriority) {
    const result = {
      phase: "awaiting_context",
      passCount,
      observedOrderIds: orders.map((order) => stringValue(order.id)).filter(Boolean),
      referencedProductIds: productIds,
      referencedVariantIds: variantIds,
      observedFrom: scope.observedFrom,
      observedTo: scope.observedTo,
      completeRequestedWindow: scope.completeRequestedWindow,
      inventoryComplete: scope.inventoryComplete,
      lineItemsComplete: scope.lineItemsComplete,
      ordersComplete: scope.ordersComplete,
      activeCatalogComplete: scope.activeCatalogComplete,
      truncated: scope.truncated,
      eligibleContracts: contracts.map((candidate) => candidate.key),
      evidenceSize: {
        orders: orders.length,
        products: productIds.length,
        variants: variantIds.length,
        lineItems: bootstrapMetadata.lineItemCount,
        inventoryLevels: bootstrapMetadata.inventoryLevelCount,
        beliefs: memory.beliefs.length,
      },
      ...bootstrapMetadata,
      selectedContract: null,
      insightRunId: null,
      insightRunIds: [],
      planRunIds: [],
      recommendationIds: [],
      onboardingEpoch: input.onboardingEpoch ?? null,
    };
    await setPhase(prisma, input, result.phase, result, "complete");
    return result;
  }
  contracts = rankEligibleContracts(
    contracts,
    preferenceOption(merchantPriority?.value),
  );

  await setPhase(prisma, input, "ready_for_agentic_recommendation", {
    eligibleContracts: contracts.map((contract) => contract.key),
  });
  const result = {
    phase: "ready_for_agentic_recommendation",
    passCount,
    observedOrderIds: orders.map((order) => stringValue(order.id)).filter(Boolean),
    referencedProductIds: productIds,
    referencedVariantIds: variantIds,
    observedFrom: scope.observedFrom,
    observedTo: scope.observedTo,
    completeRequestedWindow: scope.completeRequestedWindow,
    inventoryComplete: scope.inventoryComplete,
    lineItemsComplete: scope.lineItemsComplete,
    ordersComplete: scope.ordersComplete,
    activeCatalogComplete: scope.activeCatalogComplete,
    truncated: scope.truncated,
    eligibleContracts: contracts.map((contract) => contract.key),
    evidenceSize: {
      orders: orders.length,
      products: productIds.length,
      variants: variantIds.length,
      lineItems: bootstrapMetadata.lineItemCount,
      inventoryLevels: bootstrapMetadata.inventoryLevelCount,
      beliefs: memory.beliefs.length,
    },
    ...bootstrapMetadata,
    selectedContract: null,
    insightRunId: null,
    insightRunIds: [],
    planRunIds: [],
    recommendationIds: [],
    onboardingEpoch: input.onboardingEpoch ?? null,
  };
  await setPhase(prisma, input, result.phase, result, "complete");
  input.logger.info("Merchant Memory bootstrap completed", {
    merchantId: input.merchantId,
    shopId: input.shopId,
    phase: result.phase,
    observedFrom: result.observedFrom,
    observedTo: result.observedTo,
    orderCount: result.evidenceSize.orders,
    productCount: result.evidenceSize.products,
    variantCount: result.evidenceSize.variants,
    beliefCount: result.evidenceSize.beliefs,
    selectedContract: result.selectedContract,
    insightRunId: result.insightRunId,
    planRunIds: result.planRunIds,
  });
  return result;
}

/** Generate one requested alternative from the already-captured bootstrap scope. */
export async function generateBootstrapAlternative(_prisma, _input) {
  void _prisma;
  void _input;
  return { status: "retired_agentic_recommendation_only" };
}

export async function resolveBootstrapGenerationPhase(
  _prisma,
  _input,
  generationStatus,
  _recommendationIds = [],
) {
  void _prisma;
  void _input;
  void _recommendationIds;
  return generationStatus === "completed"
    ? "retired_agentic_recommendation_only"
    : generationStatus;
}

export async function reconcileBootstrapIfFullMemoryReady(_prisma, _input) {
  void _prisma;
  void _input;
  return { reconciled: false, status: "retired_agentic_recommendation_only" };
}

async function fetchRecentOrders(client, input) {
  const data = /** @type {any} */ (
    await client.request(BOOTSTRAP_RECENT_ORDERS_QUERY, {
      ...input,
      lineItemsFirst: BOOTSTRAP_CONNECTION_PAGE_SIZE,
    })
  );
  const connection = data?.orders;
  const orders = [];
  for (const order of edgesToNodes(connection).map(jsonObject)) {
    orders.push(await completeOrderLineItems(client, order));
  }
  return {
    orders,
    hasNextPage: Boolean(connection?.pageInfo?.hasNextPage),
    endCursor: stringValue(connection?.pageInfo?.endCursor),
  };
}

async function completeOrderLineItems(client, order) {
  const orderId = stringValue(order.id);
  const initialConnection = jsonObject(order.lineItems);
  const edges = Array.isArray(initialConnection.edges)
    ? [...initialConnection.edges]
    : [];
  let hasNextPage = Boolean(initialConnection.pageInfo?.hasNextPage);
  let after = stringValue(initialConnection.pageInfo?.endCursor);
  while (orderId && hasNextPage) {
    const data = /** @type {any} */ (
      await client.request(BOOTSTRAP_ORDER_LINE_ITEMS_QUERY, {
        id: orderId,
        first: BOOTSTRAP_CONNECTION_PAGE_SIZE,
        after,
      })
    );
    const connection = data?.node?.lineItems;
    edges.push(...(Array.isArray(connection?.edges) ? connection.edges : []));
    hasNextPage = Boolean(connection?.pageInfo?.hasNextPage);
    after = stringValue(connection?.pageInfo?.endCursor);
  }
  return {
    ...order,
    lineItems: {
      ...initialConnection,
      edges,
      pageInfo: { hasNextPage: false, endCursor: after },
    },
  };
}

async function fetchActiveCatalog(client) {
  const products = [];
  const variants = [];
  let inventoryLevelCount = 0;
  let after = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = /** @type {any} */ (
      await client.request(BOOTSTRAP_ACTIVE_PRODUCTS_QUERY, {
        first: BOOTSTRAP_CONNECTION_PAGE_SIZE,
        after,
        query: "status:active",
      })
    );
    const connection = data?.products;
    for (const product of edgesToNodes(connection).map(jsonObject)) {
      products.push(product);
    }
    hasNextPage = Boolean(connection?.pageInfo?.hasNextPage);
    after = stringValue(connection?.pageInfo?.endCursor);
  }

  for (const product of products) {
    const productId = stringValue(product.id);
    if (!productId) continue;
    const productVariants = await fetchProductVariants(client, productId);
    for (const variant of productVariants) {
      const inventoryItem = jsonObject(variant.inventoryItem);
      const inventoryItemId = stringValue(inventoryItem.id);
      if (inventoryItemId) {
        const inventoryLevels = await fetchInventoryLevels(client, inventoryItemId);
        inventoryLevelCount += edgesToNodes(inventoryLevels).length;
        variant.inventoryItem = {
          ...inventoryItem,
          inventoryLevels,
        };
      }
      variants.push(variant);
    }
  }

  return {
    products: dedupeById(products),
    variants: dedupeById(variants),
    inventoryLevelCount,
    activeCatalogComplete: true,
  };
}

async function fetchProductVariants(client, productId) {
  const variants = [];
  let after = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const data = /** @type {any} */ (
      await client.request(BOOTSTRAP_PRODUCT_VARIANTS_QUERY, {
        id: productId,
        first: BOOTSTRAP_CONNECTION_PAGE_SIZE,
        after,
      })
    );
    const connection = data?.node?.variants;
    variants.push(...edgesToNodes(connection).map(jsonObject));
    hasNextPage = Boolean(connection?.pageInfo?.hasNextPage);
    after = stringValue(connection?.pageInfo?.endCursor);
  }
  return variants;
}

async function fetchInventoryLevels(client, inventoryItemId) {
  const edges = [];
  let after = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const data = /** @type {any} */ (
      await client.request(BOOTSTRAP_INVENTORY_LEVELS_QUERY, {
        id: inventoryItemId,
        first: BOOTSTRAP_CONNECTION_PAGE_SIZE,
        after,
      })
    );
    const connection = data?.node?.inventoryLevels;
    edges.push(...(Array.isArray(connection?.edges) ? connection.edges : []));
    hasNextPage = Boolean(connection?.pageInfo?.hasNextPage);
    after = stringValue(connection?.pageInfo?.endCursor);
  }
  return {
    edges,
    pageInfo: { hasNextPage: false, endCursor: after },
  };
}

async function persistBootstrapSlice(prisma, input, slice) {
  // Catalog first so order-line canonical upserts can resolve product/variant FKs.
  const canonicalProductIds = new Map();
  for (const product of slice.products) {
    const productId = stringValue(product.id);
    if (!productId) continue;
    await writeLedgerEvent(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      eventType: "shopify.bootstrap.product",
      source: "shopify",
      sourceEventId: productId,
      dedupeKey: `shopify:bootstrap:product:${input.shopDomain}:${productId}`,
      payload: { shopDomain: input.shopDomain, productId },
      rawPayload: product,
      eventTs: parseDate(product.updatedAt) ?? new Date(),
    });
    const savedProduct = await upsertShopifyProduct(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      product,
    });
    if (savedProduct) canonicalProductIds.set(productId, savedProduct.id);
  }
  for (const variant of slice.variants) {
      const productExternalId = stringValue(variant.product?.id);
      let canonicalProductId = canonicalProductIds.get(productExternalId);
      if (!canonicalProductId && productExternalId) {
        canonicalProductId = (await prisma.product.findUnique({
          where: { shopId_externalId: { shopId: input.shopId, externalId: productExternalId } },
          select: { id: true },
        }))?.id;
      }
      if (!canonicalProductId) continue;
      await upsertShopifyVariant(prisma, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        productId: canonicalProductId,
        variant,
      });
      const inventoryItem = jsonObject(variant.inventoryItem);
      const inventoryItemId = stringValue(inventoryItem.id);
      const variantId = stringValue(variant.id);
      if (!inventoryItemId || !variantId) continue;
      for (const level of edgesToNodes(inventoryItem.inventoryLevels).map(jsonObject)) {
        const locationId = stringValue(level.location?.id);
        if (!locationId) continue;
        await writeLedgerEvent(prisma, {
          merchantId: input.merchantId,
          shopId: input.shopId,
          eventType: "shopify.bootstrap.inventory_level",
          source: "shopify",
          sourceEventId: `${inventoryItemId}:${locationId}`,
          dedupeKey: `shopify:bootstrap:inventory:${input.shopDomain}:${inventoryItemId}:${locationId}`,
          payload: { shopDomain: input.shopDomain, inventoryItemId, locationId },
          rawPayload: { inventoryItem, inventoryLevel: level },
          eventTs: parseDate(level.updatedAt ?? inventoryItem.updatedAt) ?? new Date(),
        });
        await upsertShopifyInventoryLevel(prisma, {
          merchantId: input.merchantId,
          shopId: input.shopId,
          inventoryItemId,
          variantExternalId: variantId,
          inventoryLevel: level,
        });
      }
  }
  for (const order of slice.orders) {
    const orderId = stringValue(order.id);
    if (!orderId) continue;
    await writeLedgerEvent(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      eventType: "shopify.bootstrap.order",
      source: "shopify",
      sourceEventId: orderId,
      dedupeKey: `shopify:bootstrap:order:${input.shopDomain}:${orderId}`,
      payload: { shopDomain: input.shopDomain, orderId },
      rawPayload: order,
      eventTs: parseDate(order.updatedAt) ?? new Date(),
    });
    await upsertShopifyOrder(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      order,
    });
  }
}

async function refreshBootstrapMemory(prisma, input, scope) {
  const beliefKeys = [
    ...(scope.activeCatalogComplete ? ACTIVE_CATALOG_KEYS : []),
    ...STOCKOUT_KEYS,
    ...(scope.completeRequestedWindow ? COMPLETE_WINDOW_KEYS : []),
  ];
  const refresh = await refreshBeliefs(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    refreshType: "bootstrap",
    beliefKeys: [...new Set(beliefKeys)],
    evidenceScope: scope,
    logger: input.logger,
  });
  const beliefs = await prisma.merchantMemoryBelief.findMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      key: { in: beliefKeys },
      status: { in: ACTIVE_BELIEF_STATUSES },
    },
    include: { evidence: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  return { refresh, beliefs };
}

export function buildEvidenceContracts(beliefs, scope) {
  const byKey = new Map(beliefs.map((belief) => [belief.key, belief]));
  const contracts = [];
  const lowCover = byKey.get("inventory.low_cover_products.trailing_30d");
  const inventoryCoverage = ratioValue(byKey.get("data.inventory_variant_coverage"));
  const productLinkCoverage = ratioValue(byKey.get("data.line_item_product_link_coverage"));
  const variantLinkCoverage = ratioValue(byKey.get("data.line_item_variant_link_coverage"));
  const inventoryFreshnessHours = numberValue(byKey.get("data.inventory_freshness_hours_p90"));
  if (
    lowCover &&
    scope.inventoryComplete === true &&
    scope.lineItemsComplete === true &&
    inventoryCoverage >= 0.8 &&
    productLinkCoverage >= 0.9 &&
    variantLinkCoverage >= 0.9 &&
    inventoryFreshnessHours !== null &&
    inventoryFreshnessHours <= 72
  ) {
    contracts.push(contract("stockout_protection", [
      lowCover,
      byKey.get("inventory.at_risk_stockout_count.trailing_30d"),
      byKey.get("data.inventory_variant_coverage"),
      byKey.get("data.inventory_freshness_hours_p90"),
      byKey.get("data.line_item_variant_link_coverage"),
    ], 100));
  }
  if (scope.activeCatalogComplete === true) {
    const outOfStock = byKey.get("catalog.out_of_stock_product_count");
    const zeroPrice = byKey.get("catalog.zero_price_variant_count");
    const catalogueShape = byKey.get("business.catalogue_shape");
    const medianPrice = byKey.get("catalog.median_variant_price");
    const activeProducts = byKey.get("catalog.active_product_count");
    const totalVariants = byKey.get("catalog.total_variant_count");
    const hasOperationalSignal =
      countValue(outOfStock) > 0 ||
      countValue(zeroPrice) > 0 ||
      Boolean(catalogueShape);
    if (hasOperationalSignal) {
      contracts.push(contract("catalog_health", [
        outOfStock,
        zeroPrice,
        catalogueShape,
        medianPrice,
        activeProducts,
        totalVariants,
      ], 80));
    }
  }
  if (scope.completeRequestedWindow && scope.lineItemsComplete === true) {
    const pricedOrderCoverage = ratioValue(byKey.get("data.priced_order_coverage"));
    const currency = byKey.get("data.currency_consistency")?.value ?? {};
    const currencyComplete = Number(currency.currencyCount) === 1 && Number(currency.dominantShare) === 1;
    const completeCommerceEvidence = pricedOrderCoverage >= 0.95 && productLinkCoverage >= 0.9 && currencyComplete;
    const concentration = byKey.get("products.top_product_revenue_share.trailing_90d");
    const bestseller = byKey.get("products.bestseller_by_revenue.trailing_90d");
    if (concentration && bestseller && percentageValue(concentration) >= 30 && completeCommerceEvidence) {
      contracts.push(contract("sales_concentration", [concentration, bestseller, byKey.get("data.line_item_product_link_coverage")], 70));
    }
    const discount = byKey.get("business.discount_depth.trailing_90d");
    if (discount && completeCommerceEvidence && (percentageValue(discount) >= 10 || Number(discount.value?.discountedOrderSharePercent) >= 50)) {
      contracts.push(contract("discount_review", [discount, byKey.get("data.priced_order_coverage"), byKey.get("data.currency_consistency")], 60));
    }
  }
  return contracts.sort((a, b) => b.priority - a.priority);
}

function contract(key, beliefs, priority) {
  const compact = beliefs.filter(Boolean);
  return {
    key,
    priority,
    actionTargets: [],
    beliefIds: compact.map((belief) => belief.id),
    beliefKeys: compact.map((belief) => belief.key),
  };
}

async function setPhase(prisma, input, phase, metadata = {}, status = "running") {
  const current = await prisma.shopBackfillStatus.findUnique({
    where: {
      shopId_domain: {
        shopId: input.shopId,
        domain: BOOTSTRAP_BACKFILL_DOMAIN,
      },
    },
    select: { metadata: true },
  });
  await upsertBackfillStatus(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    domain: BOOTSTRAP_BACKFILL_DOMAIN,
    status,
    startedAt: phase === "reading_recent_orders" ? new Date() : undefined,
    completedAt: status === "complete" ? new Date() : undefined,
    lastError: null,
    metadata: {
      ...jsonObject(current?.metadata),
      phase,
      onboardingEpoch: input.onboardingEpoch ?? null,
      ...metadata,
    },
  });
}

function evidenceScope(orders, productIds, variantIds, catalog, completeRequestedWindow, passCount, references = {}) {
  const timestamps = orders.map((order) => parseDate(order.processedAt ?? order.createdAt)).filter(Boolean).sort((a, b) => a.getTime() - b.getTime());
  const lineItemCount = orders.reduce((sum, order) => sum + edgesToNodes(order.lineItems).length, 0);
  const activeCatalogComplete = catalog.activeCatalogComplete === true;
  const lineItemsComplete = orders.every(
    (order) => order.lineItems?.pageInfo?.hasNextPage !== true,
  );
  return {
    source: "bootstrap",
    orderExternalIds: orders.map((order) => stringValue(order.id)).filter(Boolean),
    productExternalIds: productIds,
    variantExternalIds: variantIds,
    orderProductExternalIds: references.orderProductIds ?? [],
    orderVariantExternalIds: references.orderVariantIds ?? [],
    inventoryComplete: activeCatalogComplete,
    lineItemsComplete,
    ordersComplete: lineItemsComplete,
    activeCatalogComplete,
    selectedOrderCount: orders.length,
    lineItemCount,
    activeProductCount: productIds.length,
    variantCount: variantIds.length,
    inventoryLevelCount: catalog.inventoryLevelCount ?? 0,
    completeRequestedWindow,
    observedFrom: timestamps[0]?.toISOString() ?? null,
    observedTo: timestamps[timestamps.length - 1]?.toISOString() ?? null,
    passCount,
    truncated: !completeRequestedWindow,
  };
}

function scopeMetadata(scope) {
  return {
    selectedOrderCount: scope.selectedOrderCount ?? 0,
    lineItemCount: scope.lineItemCount ?? 0,
    activeProductCount: scope.activeProductCount ?? 0,
    variantCount: scope.variantCount ?? 0,
    inventoryLevelCount: scope.inventoryLevelCount ?? 0,
    ordersComplete: scope.ordersComplete === true,
    activeCatalogComplete: scope.activeCatalogComplete === true,
  };
}

function variantIdsFromCatalog(catalog) {
  return catalog.variants
    .map((variant) => stringValue(variant.id))
    .filter(Boolean);
}

function productIdsFromCatalog(catalog) {
  return catalog.products
    .map((product) => stringValue(product.id))
    .filter(Boolean);
}

function productIdsFromOrders(orders) {
  return [...new Set(orders.flatMap((order) => edgesToNodes(order.lineItems).map((line) => stringValue(jsonObject(line).product?.id)).filter(Boolean)))];
}

function variantIdsFromOrders(orders) {
  return [...new Set(orders.flatMap((order) => edgesToNodes(order.lineItems).map((line) => stringValue(jsonObject(line).variant?.id)).filter(Boolean)))];
}

function ratioValue(belief) {
  const value = belief?.value ?? {};
  const raw = Number(value.ratio ?? value.coverage ?? 0);
  return Number.isFinite(raw) ? raw : 0;
}

function numberValue(belief) {
  const raw = Number(belief?.value?.number);
  return Number.isFinite(raw) ? raw : null;
}

function countValue(belief) {
  const raw = Number(belief?.value?.count);
  return Number.isFinite(raw) ? raw : 0;
}

function percentageValue(belief) {
  const value = belief?.value ?? {};
  const raw = Number(value.percentage ?? value.sharePercent ?? 0);
  return Number.isFinite(raw) ? raw : 0;
}

function rankEligibleContracts(contracts, priority) {
  const secondary = priority === "profit"
    ? ["discount_review", "sales_concentration"]
    : priority === "slow_inventory"
      ? ["stockout_protection", "catalog_health", "discount_review"]
      : priority === "jefe_read_first"
        ? ["stockout_protection", "catalog_health", "sales_concentration", "discount_review"]
        : ["sales_concentration", "stockout_protection", "catalog_health", "discount_review"];
  const order = ["stockout_protection", ...secondary];
  return [...contracts].sort((a, b) => {
    const aIndex = order.includes(a.key) ? order.indexOf(a.key) : order.length;
    const bIndex = order.includes(b.key) ? order.indexOf(b.key) : order.length;
    return aIndex - bIndex;
  });
}

function preferenceOption(value) {
  const object = jsonObject(value);
  return (
    stringValue(object.option) ??
    stringValue(object.value) ??
    stringValue(value) ??
    "jefe_read_first"
  );
}

function dedupeById(items) {
  return [...new Map(items.map((item) => [stringValue(item.id), item])).values()].filter((item) => stringValue(item.id));
}

export const __bootstrapTestHooks = {
  fetchRecentOrders,
  fetchActiveCatalog,
};

function stringValue(value) {
  return typeof value === "string" && value ? value : null;
}
