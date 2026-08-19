// @ts-nocheck

import crypto from "node:crypto";
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
  MEMORY_BACKFILL_DOMAIN,
} from "../merchant-memory/constants.server.js";
import { createLlmProvider } from "../llm/provider.server.js";
import {
  isActionExecuteEnabled,
  listActionCapabilities,
  listActionTypes,
} from "../actions/action-intent.server.js";
import { proposeActionFromIntent } from "../actions/action-resolution.server.js";
import { ensureMerchantActionForRecommendation } from "../actions/merchant-action.server.js";
import { advanceActionWorkflow } from "../actions/action-step-lifecycle.server.js";
import { buildPlanEvidenceSnapshot } from "../merchant-memory/context-retriever.server.js";
import {
  acquireProposalCreationLock,
  checkProposedCreationAllowed,
  PROPOSAL_CREATION_TRIGGERS,
  repairDuplicateProposedActions,
  shouldDeferAutonomousProposalCreation,
  supersedeAllProposedRecommendations,
} from "../merchant-plan/proposal-creation-invariant.server.js";
import { BOOTSTRAP_OUTPUT_SCHEMA, parseBootstrapOutput } from "./bootstrap-schema.server.js";
import { buildBootstrapPrompt, buildBootstrapSystemPrompt } from "./bootstrap-prompt.server.js";
import {
  BOOTSTRAP_BACKFILL_DOMAIN,
  upsertBackfillStatus,
} from "../../services/shopify-backfill-status.server.js";
import { trackOnce } from "../../services/analytics/event-log.server.js";

export const BOOTSTRAP_INITIAL_ORDER_LIMIT = 50;
export const BOOTSTRAP_SECOND_PASS_LIMIT = 100;
export const BOOTSTRAP_LOOKBACK_DAYS = 90;
export const BOOTSTRAP_CONNECTION_PAGE_SIZE = 250;
export const BOOTSTRAP_PROMPT_VERSION = "bootstrap-v2";
export const BOOTSTRAP_SCHEMA_VERSION = "bootstrap-v1";
export const BOOTSTRAP_SNAPSHOT_VERSION = "bootstrap-v1";

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

  await setPhase(prisma, input, "choosing_first_move", {
    eligibleContracts: contracts.map((contract) => contract.key),
  });
  const generated = await generateAndPersistBootstrapOpportunities(prisma, input, {
    beliefs: memory.beliefs,
    contracts: [contracts[0]],
    scope,
  });
  const generatedPhase = await resolveBootstrapGenerationPhase(
    prisma,
    input,
    generated.status,
    generated.recommendationIds,
  );
  if (generatedPhase === "completed") {
    trackFirstInsightReady(prisma, input, generated);
  }
  const result = {
    phase: generatedPhase === "completed" ? "ready" : generatedPhase,
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
    selectedContract: generated.selectedContract ?? null,
    insightRunId: generated.insightRunId ?? null,
    insightRunIds: generated.insightRunId ? [generated.insightRunId] : [],
    planRunIds: generated.planRunIds ?? [],
    recommendationIds: generated.recommendationIds ?? [],
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
export async function generateBootstrapAlternative(prisma, input) {
  const bootstrapJob = await prisma.backfillJob.findUnique({
    where: { shopId_jobType: { shopId: input.shopId, jobType: "merchant_memory_bootstrap" } },
  });
  const result = jsonObject(bootstrapJob?.resultJson);
  const generationInput = {
    ...input,
    onboardingEpoch: stringValue(result.onboardingEpoch),
  };
  const contractKey = stringValue(input.contractKey);
  if (!contractKey || !Array.isArray(result.eligibleContracts) || !result.eligibleContracts.includes(contractKey)) {
    return { status: "no_alternative" };
  }
  const scope = {
    source: "bootstrap",
    orderExternalIds: stringArray(result.observedOrderIds),
    productExternalIds: stringArray(result.referencedProductIds),
    variantExternalIds: stringArray(result.referencedVariantIds),
    inventoryComplete: result.inventoryComplete === true,
    lineItemsComplete: result.lineItemsComplete === true,
    ordersComplete: result.ordersComplete === true,
    activeCatalogComplete: result.activeCatalogComplete === true,
    lineItemCount: Number(result.lineItemCount) || 0,
    activeProductCount: Number(result.activeProductCount) || 0,
    inventoryLevelCount: Number(result.inventoryLevelCount) || 0,
    completeRequestedWindow: result.completeRequestedWindow === true,
    observedFrom: stringValue(result.observedFrom),
    observedTo: stringValue(result.observedTo),
    passCount: Number(result.passCount) || 1,
    truncated: result.truncated === true,
  };
  const beliefKeys = [...new Set([...ACTIVE_CATALOG_KEYS, ...STOCKOUT_KEYS, ...COMPLETE_WINDOW_KEYS])];
  const beliefs = await prisma.merchantMemoryBelief.findMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      key: { in: beliefKeys },
      status: { in: ACTIVE_BELIEF_STATUSES },
    },
    include: { evidence: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  const selected = buildEvidenceContracts(beliefs, scope).find((candidate) => candidate.key === contractKey);
  if (!selected) return { status: "no_longer_supported" };
  const generated = await generateAndPersistBootstrapOpportunities(prisma, {
    ...generationInput,
    proposalTrigger: PROPOSAL_CREATION_TRIGGERS.MERCHANT_ONBOARDING,
  }, {
    beliefs,
    contracts: [selected],
    scope,
  });
  if (generated.status === "completed") {
    const generatedPhase = await resolveBootstrapGenerationPhase(
      prisma,
      generationInput,
      generated.status,
      generated.recommendationIds,
    );
    const surfaceable = generatedPhase === "completed";
    if (!surfaceable) {
      return { ...generated, status: "no_longer_supported" };
    }
    trackFirstInsightReady(prisma, generationInput, generated);
    const status = await prisma.shopBackfillStatus.findUnique({
      where: { shopId_domain: { shopId: input.shopId, domain: BOOTSTRAP_BACKFILL_DOMAIN } },
      select: { metadata: true },
    });
    const statusMetadata = jsonObject(status?.metadata);
    await upsertBackfillStatus(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      domain: BOOTSTRAP_BACKFILL_DOMAIN,
      status: "complete",
      completedAt: new Date(),
      lastError: null,
      metadata: {
        ...statusMetadata,
        phase: "ready",
        insightRunId: generated.insightRunId ?? null,
        insightRunIds: uniqueStrings([
          ...stringArray(statusMetadata.insightRunIds),
          generated.insightRunId,
        ]),
        planRunIds: uniqueStrings([
          ...stringArray(statusMetadata.planRunIds),
          ...(generated.planRunIds ?? []),
        ]),
        recommendationIds: uniqueStrings([
          ...stringArray(statusMetadata.recommendationIds),
          ...(generated.recommendationIds ?? []),
        ]),
        selectedContract: contractKey,
      },
    });
    await prisma.backfillJob.update({
      where: { id: bootstrapJob.id },
      data: {
        resultJson: {
          ...result,
          phase: "ready",
          selectedContract: contractKey,
          insightRunId: generated.insightRunId ?? null,
          insightRunIds: uniqueStrings([
            ...stringArray(result.insightRunIds),
            generated.insightRunId,
          ]),
          planRunIds: uniqueStrings([
            ...stringArray(result.planRunIds),
            ...(generated.planRunIds ?? []),
          ]),
          recommendationIds: uniqueStrings([
            ...stringArray(result.recommendationIds),
            ...(generated.recommendationIds ?? []),
          ]),
        },
      },
    });
  }
  return generated;
}

export async function resolveBootstrapGenerationPhase(
  prisma,
  input,
  generationStatus,
  recommendationIds = [],
) {
  if (generationStatus !== "completed") return generationStatus;
  await reconcileBootstrapIfFullMemoryReady(prisma, input);
  return (await hasSurfaceableBootstrapRecommendation(
    prisma,
    input,
    recommendationIds,
  ))
    ? "completed"
    : "insufficient_evidence";
}

async function hasSurfaceableBootstrapRecommendation(
  prisma,
  input,
  recommendationIds,
) {
  const ids = uniqueStrings(recommendationIds);
  if (ids.length === 0) return false;
  const recommendation = await prisma.merchantPlanRecommendation.findFirst({
    where: {
      id: { in: ids },
      merchantId: input.merchantId,
      shopId: input.shopId,
      sourceMode: "bootstrap",
      reviewStatus: "proposed",
    },
    select: { id: true },
  });
  return Boolean(recommendation);
}

/**
 * Close the ordering gap where a complete memory rebuild can reconcile before
 * a still-running bootstrap generation publishes its recommendation.
 */
export async function reconcileBootstrapIfFullMemoryReady(prisma, input) {
  const memoryStatus = await prisma.shopBackfillStatus.findUnique({
    where: {
      shopId_domain: {
        shopId: input.shopId,
        domain: MEMORY_BACKFILL_DOMAIN,
      },
    },
    select: { status: true },
  });
  if (memoryStatus?.status !== "complete") {
    return { reconciled: false };
  }

  // Dynamic import avoids a module-initialisation cycle: reconciliation uses
  // the bootstrap contract definitions to evaluate the completed memory.
  const { reconcileBootstrapRecommendationsAfterFullRefresh } = await import(
    "./reconciliation.server.js"
  );
  const result = await reconcileBootstrapRecommendationsAfterFullRefresh(
    prisma,
    input,
  );
  return { reconciled: true, ...result };
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

async function generateAndPersistBootstrapOpportunities(prisma, input, prepared) {
  await repairDuplicateProposedActions(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    logger: input.logger,
  }).catch(() => ({ retained: 0, superseded: 0 }));

  const snapshotHash = hashJson({
    scope: prepared.scope,
    contracts: prepared.contracts,
    beliefs: prepared.beliefs.map((belief) => ({
      id: belief.id,
      key: belief.key,
      value: belief.value,
      derivationVersion: belief.derivationVersion ?? null,
    })),
  });
  const existing = await prisma.merchantInsightRun.findUnique({
    where: {
      shopId_beliefSnapshotHash_promptVersion_schemaVersion: {
        shopId: input.shopId,
        beliefSnapshotHash: snapshotHash,
        promptVersion: BOOTSTRAP_PROMPT_VERSION,
        schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
      },
    },
    include: { findings: true },
  });
  if (existing?.status === "completed") {
    const recommendations = await prisma.merchantPlanRecommendation.findMany({
      where: { shopId: input.shopId, sourceMode: "bootstrap", supportingInsightIds: { hasSome: existing.findings.map((finding) => finding.id) } },
      select: { id: true, runId: true, run: { select: { result: true } } },
    });
    const reused = {
      status: "completed",
      selectedContract: stringValue(jsonObject(recommendations[0]?.run?.result).contractKey),
      insightRunId: existing.id,
      planRunIds: recommendations.map((row) => row.runId),
      recommendationIds: recommendations.map((row) => row.id),
    };
    return reused;
  }

  const insightRun = existing
    ? await prisma.merchantInsightRun.update({
        where: { id: existing.id },
        data: { status: "running", sourceMode: "bootstrap", startedAt: new Date(), failedAt: null, safeErrorCode: null, lastError: null },
      })
    : await prisma.merchantInsightRun.create({
        data: {
          merchantId: input.merchantId,
          shopId: input.shopId,
          status: "running",
          sourceMode: "bootstrap",
          beliefSnapshotVersion: BOOTSTRAP_SNAPSHOT_VERSION,
          beliefSnapshotHash: snapshotHash,
          relevantBeliefIds: prepared.beliefs.map((belief) => belief.id),
          promptVersion: BOOTSTRAP_PROMPT_VERSION,
          schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
          startedAt: new Date(),
        },
      });
  const provider = createLlmProvider({
    logger: input.logger,
    usage: {
      prisma,
      merchantId: input.merchantId,
      shopId: input.shopId,
      feature: "onboarding_bootstrap",
      runType: "MerchantInsightRun",
      runId: insightRun.id,
    },
  });
  if (!provider.enabled || !provider.generateStructuredJson) {
    await prisma.merchantInsightRun.update({
      where: { id: insightRun.id },
      data: { status: "model_disabled", completedAt: new Date(), safeErrorCode: "llm_disabled", result: { reason: "llm_disabled" } },
    });
    return { status: "model_disabled", selectedContract: null, insightRunId: insightRun.id, planRunIds: [], recommendationIds: [] };
  }
  await prisma.merchantInsightRun.update({
    where: { id: insightRun.id },
    data: { provider: provider.provider, modelIdentifier: provider.model },
  });
  const priority = await prisma.merchantMemoryBelief.findFirst({
    where: { merchantId: input.merchantId, key: "preferences.optimisation_priority", status: { in: ACTIVE_BELIEF_STATUSES } },
    orderBy: { updatedAt: "desc" },
  });
  const runtimeCapabilities = new Map(listActionTypes().map((capability) => [capability.actionType, capability]));
  const capabilities = listActionCapabilities().map((capability) => ({
    ...capability,
    live: runtimeCapabilities.get(capability.actionType)?.live === true,
    requiredScopes: runtimeCapabilities.get(capability.actionType)?.requiredScopes ?? [],
  }));
  const suppliedBeliefs = prepared.beliefs.map((belief) => ({
    id: belief.id,
    key: belief.key,
    value: belief.value,
    confidence: belief.confidence,
    evidence: belief.evidence?.[0]?.metadata?.evidenceScope ?? null,
  }));
  let parsed = null;
  let lastResult = null;
  let validationError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    lastResult = await provider.generateStructuredJson({
      systemPrompt: buildBootstrapSystemPrompt(),
      prompt: buildBootstrapPrompt({
        merchantPriority: preferenceOption(priority?.value),
        capabilities,
        contracts: prepared.contracts,
        beliefs: suppliedBeliefs,
      }, validationError),
      schema: BOOTSTRAP_OUTPUT_SCHEMA,
      maxInputTokens: 10000,
      maxOutputTokens: 2400,
      timeoutMs: 15000,
    });
    const candidate = parseBootstrapOutput(lastResult.json, {
      contracts: prepared.contracts,
      beliefs: suppliedBeliefs,
      capabilities,
    });
    if (candidate.ok) { parsed = candidate; break; }
    validationError = candidate.error;
  }
  if (!parsed) {
    await prisma.merchantInsightRun.update({
      where: { id: insightRun.id },
      data: {
        status: "failed",
        completedAt: null,
        failedAt: new Date(),
        safeErrorCode: "invalid_model_output",
        lastError: null,
        result: { reason: "invalid_model_output", validationError },
      },
    });
    return { status: "generation_failed", selectedContract: null, insightRunId: insightRun.id, planRunIds: [], recommendationIds: [] };
  }

  const proposalTrigger =
    input.proposalTrigger === PROPOSAL_CREATION_TRIGGERS.MERCHANT_ONBOARDING
      ? PROPOSAL_CREATION_TRIGGERS.MERCHANT_ONBOARDING
      : PROPOSAL_CREATION_TRIGGERS.BACKGROUND;
  if (
    proposalTrigger === "background" &&
    (await shouldDeferAutonomousProposalCreation(prisma, input))
  ) {
    await prisma.merchantInsightRun.update({
      where: { id: insightRun.id },
      data: {
        status: "completed",
        completedAt: new Date(),
        result: {
          sourceMode: "bootstrap",
          skipped: "deferred_initial_proposal_exists",
          opportunityCount: 0,
        },
      },
    });
    input.logger?.info?.("Bootstrap proposal skipped — initial proposal already exists", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      insightRunId: insightRun.id,
    });
    return {
      status: "deferred_initial_proposal_exists",
      selectedContract: null,
      insightRunId: insightRun.id,
      planRunIds: [],
      recommendationIds: [],
    };
  }

  const recommendationIds = [];
  const planRunIds = [];
  const actionCandidates = [];
  let proposalGateReason = null;
  await prisma.$transaction(async (tx) => {
    await acquireProposalCreationLock(tx, {
      merchantId: input.merchantId,
      shopId: input.shopId,
    });
    const gate = await checkProposedCreationAllowed(tx, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      trigger: proposalTrigger,
    });
    if (!gate.allowed) {
      if (proposalTrigger === "merchant_onboarding" && gate.reason === "proposed_exists") {
        await supersedeAllProposedRecommendations(tx, {
          merchantId: input.merchantId,
          shopId: input.shopId,
        });
        const retryGate = await checkProposedCreationAllowed(tx, {
          merchantId: input.merchantId,
          shopId: input.shopId,
          trigger: proposalTrigger,
        });
        if (!retryGate.allowed) proposalGateReason = retryGate.reason;
      } else {
        proposalGateReason = gate.reason;
      }
    }
    await tx.merchantInsightFinding.deleteMany({ where: { runId: insightRun.id } });
    for (let index = 0; index < parsed.opportunities.length; index += 1) {
      if (proposalGateReason) break;
      const opportunity = parsed.opportunities[index];
      const finding = await tx.merchantInsightFinding.create({
        data: {
          runId: insightRun.id,
          merchantId: input.merchantId,
          shopId: input.shopId,
          orderIndex: index,
          title: opportunity.headline,
          finding: opportunity.explanation,
          whyItMatters: opportunity.whyItMatters,
          confidence: opportunity.confidence,
          category: contractCategory(opportunity.contractKey),
          caveat: opportunity.caveat,
          supportingBeliefIds: opportunity.supportingBeliefIds,
        },
      });
      const planHash = hashJson({ snapshotHash, contractKey: opportunity.contractKey });
      const planRun = await tx.merchantPlanRun.upsert({
        where: { shopId_snapshotHash_promptVersion_schemaVersion: { shopId: input.shopId, snapshotHash: planHash, promptVersion: BOOTSTRAP_PROMPT_VERSION, schemaVersion: BOOTSTRAP_SCHEMA_VERSION } },
        create: {
          merchantId: input.merchantId,
          shopId: input.shopId,
          status: "completed",
          sourceMode: "bootstrap",
          snapshotVersion: BOOTSTRAP_SNAPSHOT_VERSION,
          snapshotHash: planHash,
          relevantBeliefIds: opportunity.supportingBeliefIds,
          insightRunId: insightRun.id,
          promptVersion: BOOTSTRAP_PROMPT_VERSION,
          schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
          provider: provider.provider,
          modelIdentifier: provider.model,
          completedAt: new Date(),
          result: { contractKey: opportunity.contractKey, rankIndex: index },
        },
        update: { status: "completed", sourceMode: "bootstrap", completedAt: new Date(), result: { contractKey: opportunity.contractKey, rankIndex: index } },
      });
      const reviewAt = new Date(Date.now() + 14 * 86400000);
      planRunIds.push(planRun.id);
      const recommendation = await tx.merchantPlanRecommendation.upsert({
        where: { runId: planRun.id },
        create: {
          runId: planRun.id,
          merchantId: input.merchantId,
          shopId: input.shopId,
          title: opportunity.recommendationHeadline,
          summary: opportunity.explanation,
          primaryGoalId: null,
          whyThisAction: opportunity.whyItMatters,
          whyNow: opportunity.whyItMatters,
          startToday: opportunity.whatIllDo,
          successSignal: { description: opportunity.howWellKnow, timeframe: "14 days" },
          expectedBenefit: opportunity.expectedBenefit,
          supportingBeliefIds: opportunity.supportingBeliefIds,
          supportingInsightIds: [finding.id],
          confidence: opportunity.confidence,
          caveat: opportunity.caveat,
          sourceMode: "bootstrap",
          reviewAt,
          outcomeStatus: "pending",
          reviewStatus: "proposed",
        },
        update: {
          title: opportunity.recommendationHeadline,
          summary: opportunity.explanation,
          whyThisAction: opportunity.whyItMatters,
          whyNow: opportunity.whyItMatters,
          startToday: opportunity.whatIllDo,
          successSignal: { description: opportunity.howWellKnow, timeframe: "14 days" },
          expectedBenefit: opportunity.expectedBenefit,
          supportingBeliefIds: opportunity.supportingBeliefIds,
          supportingInsightIds: [finding.id],
          confidence: opportunity.confidence,
          caveat: opportunity.caveat,
          reviewAt,
        },
      });
      recommendationIds.push(recommendation.id);
      const workflow = await tx.merchantRecommendationWorkflow.upsert({
        where: {
          recommendationId_version: {
            recommendationId: recommendation.id,
            version: 1,
          },
        },
        create: {
          recommendationId: recommendation.id,
          merchantId: input.merchantId,
          shopId: input.shopId,
          version: 1,
          status: "active",
          source: "bootstrap_generation",
        },
        update: {
          merchantId: input.merchantId,
          shopId: input.shopId,
          status: "active",
          source: "bootstrap_generation",
        },
      });
      await tx.merchantRecommendationStep.deleteMany({
        where: { workflowId: workflow.id, status: { in: ["draft", "pending"] } },
      });
      const step = await tx.merchantRecommendationStep.create({
        data: {
          workflowId: workflow.id,
          recommendationId: recommendation.id,
          merchantId: input.merchantId,
          shopId: input.shopId,
          orderIndex: 0,
          title: opportunity.actionIntent ? "Review and approve the Shopify action" : "Track the signal",
          description: opportunity.whatIllDo,
          completionCriteria: opportunity.howWellKnow,
          status: "draft",
          mode: opportunity.actionIntent ? "execute" : "assist",
          capabilityRef: opportunity.actionIntent
            ? `execute:${opportunity.actionIntent.actionType}:${opportunity.actionIntent.targetKind}`
            : null,
          dependsOnStepIds: [],
          evidenceIds: [],
        },
      });
      const recommendationWithWorkflow = {
        ...recommendation,
        workflows: [{ ...workflow, steps: [step] }],
      };
      const action = await ensureMerchantActionForRecommendation(tx, {
        recommendation: recommendationWithWorkflow,
      });
      await advanceActionWorkflow(tx, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        actionId: action?.id ?? null,
        workflowId: workflow.id,
      });
      if (opportunity.actionIntent) {
        actionCandidates.push({
          recommendation: recommendationWithWorkflow,
          intent: opportunity.actionIntent,
          recommendationStepId: step.id,
        });
      }
      await buildPlanEvidenceSnapshot(tx, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        recommendation,
        sourceSnapshotHash: snapshotHash,
        snapshotSource: "bootstrap_generation",
        logger: input.logger,
      });
    }
    await tx.merchantInsightRun.update({
      where: { id: insightRun.id },
      data: {
        status: "completed",
        completedAt: new Date(),
        result: {
          sourceMode: "bootstrap",
          opportunityCount: proposalGateReason ? 0 : parsed.opportunities.length,
          skipped: proposalGateReason,
          durationMs: lastResult?.durationMs ?? null,
          usage: lastResult?.usage ?? null,
        },
      },
    });
  });
  if (proposalGateReason) {
    return {
      status: proposalGateReason,
      selectedContract: null,
      insightRunId: insightRun.id,
      planRunIds,
      recommendationIds,
    };
  }
  for (const candidate of actionCandidates) {
    const proposal = await proposeActionFromIntent(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      intent: candidate.intent,
      writeEnabled: isActionExecuteEnabled(candidate.intent.actionType),
      sourceRecommendation: candidate.recommendation,
      recommendationStepId: candidate.recommendationStepId,
    });
    input.logger.info("Bootstrap recommendation action resolved", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      recommendationId: candidate.recommendation.id,
      actionType: candidate.intent.actionType,
      status: proposal.status,
      actionRunId: proposal.execution?.runId ?? null,
    });
  }
  return {
    status: "completed",
    selectedContract: parsed.opportunities[0]?.contractKey ?? null,
    insightRunId: insightRun.id,
    planRunIds,
    recommendationIds,
  };
}

function trackFirstInsightReady(prisma, input, generated) {
  void trackOnce(prisma, {
    type: "first_insight_ready",
    topic: "onboarding",
    merchantId: input.merchantId,
    shopId: input.shopId,
    shopDomain: input.shopDomain,
    dedupeKey: `first_insight_ready:${input.shopId}:${input.onboardingEpoch ?? "legacy"}`,
    summary: `First insight ready for ${input.shopDomain}`,
    properties: {
      insightRunId: generated.insightRunId,
      recommendationCount: generated.recommendationIds?.length ?? 0,
      onboardingEpoch: input.onboardingEpoch ?? null,
    },
  });
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

function contractCategory(key) {
  return key === "stockout_protection"
    ? "inventory"
    : key === "discount_review"
      ? "business"
      : key === "catalog_health"
        ? "catalog"
        : "products";
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

function hashJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
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

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item) : [];
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value))];
}
