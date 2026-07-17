// @ts-check

import {
  jsonObject,
  moneyAmount,
  parseDate,
} from "../lib/ingestion/shopify/normalize.server.js";

export const COGS_SOURCE_SHOPIFY = "shopify_unit_cost";
export const COGS_SOURCE_MANUAL = "manual";
export const COGS_SOURCE_MANUAL_ONBOARDING = "manual_onboarding";
export const COGS_SOURCE_MERCHANT_RULE = "merchant_rule";
export const COGS_SOURCE_MISSING = "missing";

const ACTIVE_COST_WHERE = {
  effectiveTo: null,
};

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{
 *   merchantId: string;
 *   shopId: string;
 *   productId?: string | null;
 *   variantId: string;
 *   inventoryItemExternalId?: string | null;
 *   sku?: string | null;
 *   costAmount?: string | number | null;
 *   currency?: string | null;
 *   source: string;
 *   confidenceLevel?: string | null;
 *   ruleId?: string | null;
 *   confirmedBy?: string | null;
 *   confirmedByMerchant?: boolean;
 *   importedAt?: Date | null;
 *   shopifyInventoryItemUpdatedAt?: Date | null;
 *   lastSyncedAt?: Date | null;
 *   missingReason?: string | null;
 *   rawPayload?: unknown;
 * }} input
 */
export async function upsertVariantCost(prisma, input) {
  const now = new Date();
  const costAmount = decimalStringOrNull(input.costAmount);
  const source = input.source;
  const confidenceLevel =
    input.confidenceLevel ??
    (source === COGS_SOURCE_MERCHANT_RULE
      ? "merchant_rule"
      : costAmount
        ? "confirmed"
        : "missing");

  const existing = await prisma.cogsInput.findFirst({
    where: {
      shopId: input.shopId,
      variantId: input.variantId,
      ...ACTIVE_COST_WHERE,
    },
    orderBy: [{ updatedAt: "desc" }, { effectiveFrom: "desc" }],
  });

  if (
    source === COGS_SOURCE_SHOPIFY &&
    existing &&
    isMerchantOwnedCost(existing) &&
    costAmount
  ) {
    return prisma.cogsInput.update({
      where: { id: existing.id },
      data: {
        inventoryItemExternalId:
          input.inventoryItemExternalId ?? existing.inventoryItemExternalId,
        lastSyncedAt: input.lastSyncedAt ?? now,
        shopifyInventoryItemUpdatedAt:
          input.shopifyInventoryItemUpdatedAt ??
          existing.shopifyInventoryItemUpdatedAt,
        rawPayload: {
          ...jsonObject(existing.rawPayload),
          latestShopifyUnitCost: jsonObject(input.rawPayload),
          shopifyCostPreservedMerchantCost: true,
        },
      },
    });
  }

  if (
    source === COGS_SOURCE_SHOPIFY &&
    existing &&
    isMerchantOwnedCost(existing) &&
    !costAmount
  ) {
    return existing;
  }

  const data = {
    merchantId: input.merchantId,
    shopId: input.shopId,
    productId: input.productId ?? existing?.productId ?? null,
    variantId: input.variantId,
    inventoryItemExternalId:
      input.inventoryItemExternalId ??
      existing?.inventoryItemExternalId ??
      null,
    sku: input.sku ?? existing?.sku ?? null,
    costAmount,
    currency: normalizeCurrency(input.currency ?? existing?.currency),
    source: costAmount ? source : COGS_SOURCE_MISSING,
    confidence: confidenceScore(confidenceLevel),
    confidenceLevel,
    ruleId: input.ruleId ?? null,
    confirmedByMerchant:
      input.confirmedByMerchant ??
      (source === COGS_SOURCE_MANUAL ||
        source === COGS_SOURCE_MANUAL_ONBOARDING),
    confirmedAt: confidenceLevel === "confirmed" ? now : null,
    confirmedBy: input.confirmedBy ?? null,
    importedAt:
      input.importedAt ??
      (source === COGS_SOURCE_SHOPIFY && costAmount ? now : null),
    shopifyInventoryItemUpdatedAt: input.shopifyInventoryItemUpdatedAt ?? null,
    lastSyncedAt:
      input.lastSyncedAt ?? (source === COGS_SOURCE_SHOPIFY ? now : null),
    missingReason: costAmount
      ? null
      : (input.missingReason ?? "shopify_cost_missing"),
    effectiveFrom: now,
    effectiveTo: null,
    rawPayload: {
      ...jsonObject(input.rawPayload),
      confidenceState: confidenceLevel,
    },
  };

  if (existing) {
    return prisma.cogsInput.update({
      where: { id: existing.id },
      data,
    });
  }

  return prisma.cogsInput.create({ data });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; productId: string; variant: any; now?: Date }} input
 */
export async function upsertShopifyUnitCostFromVariant(prisma, input) {
  const variant = jsonObject(input.variant);
  const inventoryItem = jsonObject(
    variant.inventoryItem ?? variant.inventory_item,
  );
  const inventoryItemExternalId = inventoryItemIdFromVariant(variant);
  const unitCost = jsonObject(
    inventoryItem.unitCost ?? inventoryItem.unit_cost,
  );
  const costAmount =
    moneyAmount(unitCost) ??
    moneyAmount(inventoryItem.cost) ??
    moneyAmount(variant.cost);
  const missingReason = inventoryItemExternalId
    ? costAmount
      ? null
      : "shopify_cost_missing"
    : "inventory_item_missing";

  const variantExternalId = stringValue(
    variant.id ?? variant.admin_graphql_api_id,
  );
  if (!variantExternalId) return null;

  const savedVariant = await prisma.variant.findUnique({
    where: {
      shopId_externalId: {
        shopId: input.shopId,
        externalId: variantExternalId,
      },
    },
  });

  if (!savedVariant) return null;

  return upsertVariantCost(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    productId: input.productId,
    variantId: savedVariant.id,
    inventoryItemExternalId,
    sku: stringValue(variant.sku),
    costAmount,
    currency: currencyFromUnitCost(unitCost, savedVariant.currency),
    source: COGS_SOURCE_SHOPIFY,
    confidenceLevel: costAmount ? "confirmed" : "missing",
    importedAt: input.now ?? new Date(),
    shopifyInventoryItemUpdatedAt: parseDate(inventoryItem.updatedAt),
    lastSyncedAt: input.now ?? new Date(),
    missingReason,
    rawPayload: { source: COGS_SOURCE_SHOPIFY, inventoryItem },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; inventoryItem: unknown; now?: Date }} input
 */
export async function upsertShopifyUnitCostFromInventoryItem(prisma, input) {
  const inventoryItem = jsonObject(input.inventoryItem);
  const inventoryItemExternalId =
    inventoryItemExternalIdFromInventoryItem(inventoryItem);
  if (!inventoryItemExternalId) return null;

  const variantExternalId = stringValue(inventoryItem.variant?.id);
  const variant = variantExternalId
    ? await prisma.variant.findUnique({
        where: {
          shopId_externalId: {
            shopId: input.shopId,
            externalId: variantExternalId,
          },
        },
      })
    : await findVariantForInventoryItem(prisma, {
        shopId: input.shopId,
        inventoryItemExternalId,
        sku: stringValue(inventoryItem.sku),
      });

  if (!variant) return null;

  const unitCost = jsonObject(
    inventoryItem.unitCost ?? inventoryItem.unit_cost,
  );
  const costAmount = moneyAmount(unitCost) ?? moneyAmount(inventoryItem.cost);

  return upsertVariantCost(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    productId: variant.productId,
    variantId: variant.id,
    inventoryItemExternalId,
    sku: variant.sku,
    costAmount,
    currency: currencyFromUnitCost(unitCost, variant.currency),
    source: COGS_SOURCE_SHOPIFY,
    confidenceLevel: costAmount ? "confirmed" : "missing",
    importedAt: input.now ?? new Date(),
    shopifyInventoryItemUpdatedAt: parseDate(
      inventoryItem.updatedAt ?? inventoryItem.updated_at,
    ),
    lastSyncedAt: input.now ?? new Date(),
    missingReason: costAmount ? null : "shopify_cost_missing",
    rawPayload: { source: COGS_SOURCE_SHOPIFY, inventoryItem },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} shopId
 */
export async function getCogsCoverage(prisma, shopId) {
  const [shop, variants, lineItems, cogsInputs] = await Promise.all([
    prisma.shop.findUnique({
      where: { id: shopId },
      include: { merchant: true },
    }),
    prisma.variant.findMany({
      where: { shopId },
      include: { product: true, inventoryLevels: true },
    }),
    prisma.orderLineItem.findMany({
      where: { shopId },
      include: { order: true, product: true, variant: true },
    }),
    prisma.cogsInput.findMany({
      where: { shopId, variantId: { not: null }, ...ACTIVE_COST_WHERE },
      orderBy: [{ updatedAt: "desc" }, { effectiveFrom: "desc" }],
    }),
  ]);
  const cogsByVariantId = firstBy(cogsInputs, "variantId");
  const aggregateByVariant = aggregateSoldLineItems(lineItems, cogsByVariantId);
  const variantStatusCounts = { confirmed: 0, merchant_rule: 0, missing: 0 };

  for (const variant of variants) {
    const status = costStatus(cogsByVariantId.get(variant.id));
    variantStatusCounts[status] += 1;
  }

  const sold = coverageTotals([...aggregateByVariant.values()]);
  const totalVariants = variants.length;
  const fallbackCoveragePercent =
    totalVariants > 0
      ? roundPercent(
          ((variantStatusCounts.confirmed + variantStatusCounts.merchant_rule) /
            totalVariants) *
            100,
        )
      : 0;
  const usableRevenueCoveragePercent =
    sold.soldRevenueTotal > 0
      ? roundPercent(
          ((sold.soldRevenueConfirmedCost + sold.soldRevenueMerchantRuleCost) /
            sold.soldRevenueTotal) *
            100,
        )
      : fallbackCoveragePercent;
  const confirmedRevenueCoveragePercent =
    sold.soldRevenueTotal > 0
      ? roundPercent(
          (sold.soldRevenueConfirmedCost / sold.soldRevenueTotal) * 100,
        )
      : totalVariants > 0
        ? roundPercent((variantStatusCounts.confirmed / totalVariants) * 100)
        : 0;
  const missingRevenueCoveragePercent = roundPercent(
    Math.max(0, 100 - usableRevenueCoveragePercent),
  );
  const marginConfidence = marginConfidenceFromCoverage(
    usableRevenueCoveragePercent,
  );

  return {
    totalVariants,
    variantsWithConfirmedCost: variantStatusCounts.confirmed,
    variantsWithMerchantRuleCost: variantStatusCounts.merchant_rule,
    variantsMissingCost: variantStatusCounts.missing,
    soldRevenueTotal: sold.soldRevenueTotal,
    soldRevenueConfirmedCost: sold.soldRevenueConfirmedCost,
    soldRevenueMerchantRuleCost: sold.soldRevenueMerchantRuleCost,
    soldRevenueMissingCost: sold.soldRevenueMissingCost,
    soldUnitsTotal: sold.soldUnitsTotal,
    soldUnitsConfirmedCost: sold.soldUnitsConfirmedCost,
    soldUnitsMerchantRuleCost: sold.soldUnitsMerchantRuleCost,
    soldUnitsMissingCost: sold.soldUnitsMissingCost,
    confirmedRevenueCoveragePercent,
    usableRevenueCoveragePercent,
    missingRevenueCoveragePercent,
    marginConfidence,
    coverageBasis: sold.soldRevenueTotal > 0 ? "sold_revenue" : "variant_count",
    currency: shop?.merchant.primaryCurrency ?? "GBP",
    lastSuccessfulCogsSyncAt:
      shop?.lastSuccessfulCogsSyncAt?.toISOString() ?? null,
    lastInventoryItemCostWebhookAt:
      shop?.lastInventoryItemCostWebhookAt?.toISOString() ?? null,
    lastCogsRecomputeAt: shop?.lastCogsRecomputeAt?.toISOString() ?? null,
    lastCogsSyncError: shop?.lastCogsSyncError ?? null,
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopId: string; limit?: number }} input
 */
export async function getPrioritizedMissingCosts(prisma, input) {
  const [variants, lineItems, cogsInputs] = await Promise.all([
    prisma.variant.findMany({
      where: { shopId: input.shopId },
      include: { product: true, inventoryLevels: true },
    }),
    prisma.orderLineItem.findMany({
      where: { shopId: input.shopId, variantId: { not: null } },
      include: { order: true },
    }),
    prisma.cogsInput.findMany({
      where: {
        shopId: input.shopId,
        variantId: { not: null },
        ...ACTIVE_COST_WHERE,
      },
      orderBy: [{ updatedAt: "desc" }, { effectiveFrom: "desc" }],
    }),
  ]);
  const cogsByVariantId = firstBy(cogsInputs, "variantId");
  const aggregateByVariant = aggregateSoldLineItems(lineItems, cogsByVariantId);
  const rows = variants
    .filter(
      (variant) => costStatus(cogsByVariantId.get(variant.id)) === "missing",
    )
    .map((variant) => {
      const aggregate = aggregateByVariant.get(variant.id);
      const currentInventory = variant.inventoryLevels.reduce(
        (sum, level) => sum + Number(level.available ?? 0),
        0,
      );
      return {
        productId: variant.productId,
        variantId: variant.id,
        inventoryItemId: variant.inventoryItemExternalId,
        productExternalId: variant.product?.externalId ?? null,
        productTitle: variant.product?.title ?? "Unknown product",
        variantTitle: variant.title ?? "Default",
        sku: variant.sku,
        price: decimalNumber(variant.price),
        soldUnits: aggregate?.soldUnits ?? 0,
        soldRevenue: aggregate?.soldRevenue ?? 0,
        recentSalesAt: aggregate?.lastSoldAt ?? null,
        currentInventory,
        currentCostStatus: "missing",
        missingReason:
          cogsByVariantId.get(variant.id)?.missingReason ??
          "shopify_cost_missing",
        suggestedAction:
          (aggregate?.soldRevenue ?? 0) > 0
            ? "Add this cost first because it affects margin coverage."
            : "Add when this product starts selling.",
      };
    })
    .sort(compareMissingCostRows)
    .slice(0, input.limit ?? 20);

  return rows;
}

/**
 * @param {ReturnType<typeof getCogsCoverage> extends Promise<infer T> ? T : never} coverage
 * @param {Array<{ soldRevenue: number }>} rows
 */
export function projectedCoverageAfterRows(coverage, rows) {
  if (coverage.soldRevenueTotal <= 0)
    return coverage.usableRevenueCoveragePercent;
  const unlocked = rows.reduce((sum, row) => sum + row.soldRevenue, 0);
  return roundPercent(
    ((coverage.soldRevenueConfirmedCost +
      coverage.soldRevenueMerchantRuleCost +
      unlocked) /
      coverage.soldRevenueTotal) *
      100,
  );
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} shopId
 */
export async function recomputeCogsCoverage(prisma, shopId) {
  const coverage = await getCogsCoverage(prisma, shopId);
  await prisma.shop.update({
    where: { id: shopId },
    data: {
      cogsCompletionPercentage:
        coverage.usableRevenueCoveragePercent.toFixed(2),
      cogsConfidenceLevel: coverage.marginConfidence,
      lastCogsRecomputeAt: new Date(),
    },
  });
  return coverage;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; rows: Array<{ variantId: string; productId?: string | null; sku?: string | null; costAmount?: string | number | null; currency?: string | null }> }} input
 */
export async function saveManualCosts(prisma, input) {
  for (const row of input.rows) {
    await upsertVariantCost(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      variantId: row.variantId,
      productId: row.productId,
      sku: row.sku,
      costAmount: row.costAmount,
      currency: row.currency,
      source: COGS_SOURCE_MANUAL,
      confidenceLevel: decimalStringOrNull(row.costAmount)
        ? "confirmed"
        : "missing",
      confirmedByMerchant: true,
      missingReason: decimalStringOrNull(row.costAmount)
        ? null
        : "merchant_cleared_cost",
      rawPayload: { source: COGS_SOURCE_MANUAL },
    });
  }

  return recomputeCogsCoverage(prisma, input.shopId);
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; productId: string; costAmount: string | number }} input
 */
export async function applyCostToProductVariants(prisma, input) {
  const variants = await prisma.variant.findMany({
    where: { shopId: input.shopId, productId: input.productId },
  });
  await saveManualCosts(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    rows: variants.map((variant) => ({
      variantId: variant.id,
      productId: variant.productId,
      sku: variant.sku,
      costAmount: input.costAmount,
      currency: variant.currency,
    })),
  });
  return { updated: variants.length };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; variantIds: string[]; percent: string | number }} input
 */
export async function applyRetailPercentageRule(prisma, input) {
  const percent = numberOrNull(input.percent);
  if (percent === null || percent < 0 || percent > 100) {
    throw new Error("Percentage must be between 0 and 100.");
  }

  const variants = await prisma.variant.findMany({
    where: { shopId: input.shopId, id: { in: input.variantIds } },
  });
  for (const variant of variants) {
    const price = decimalNumber(variant.price);
    await upsertVariantCost(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      productId: variant.productId,
      variantId: variant.id,
      inventoryItemExternalId: variant.inventoryItemExternalId,
      sku: variant.sku,
      costAmount: price === null ? null : roundMoney(price * (percent / 100)),
      currency: variant.currency,
      source: COGS_SOURCE_MERCHANT_RULE,
      confidenceLevel: price === null ? "missing" : "merchant_rule",
      confirmedByMerchant: false,
      missingReason: price === null ? "variant_price_missing" : null,
      rawPayload: {
        source: COGS_SOURCE_MERCHANT_RULE,
        rule: "retail_price_percentage",
        percent,
      },
    });
  }

  await recomputeCogsCoverage(prisma, input.shopId);
  return { updated: variants.length, percent };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} shopId
 */
export async function getCogsDiagnostics(prisma, shopId) {
  const [coverage, bySource] = await Promise.all([
    getCogsCoverage(prisma, shopId),
    prisma.cogsInput.groupBy({
      by: ["source"],
      where: { shopId, effectiveTo: null },
      _count: { _all: true },
    }),
  ]);

  return {
    ...coverage,
    variantsWithShopifyCost:
      bySource.find((row) => row.source === COGS_SOURCE_SHOPIFY)?._count._all ??
      0,
    variantsWithManualCost:
      (bySource.find((row) => row.source === COGS_SOURCE_MANUAL)?._count._all ??
        0) +
      (bySource.find((row) => row.source === COGS_SOURCE_MANUAL_ONBOARDING)
        ?._count._all ?? 0),
    variantsWithMerchantRuleCost:
      bySource.find((row) => row.source === COGS_SOURCE_MERCHANT_RULE)?._count
        ._all ?? 0,
    variantsMissingCost:
      bySource.find((row) => row.source === COGS_SOURCE_MISSING)?._count._all ??
      coverage.variantsMissingCost,
  };
}

/** @param {any} cogsInput */
export function hasUsableCost(cogsInput) {
  return decimalStringOrNull(cogsInput?.costAmount) !== null;
}

/** @param {any} cogsInput */
export function costStatus(cogsInput) {
  if (!hasUsableCost(cogsInput)) return "missing";
  if (
    cogsInput.source === COGS_SOURCE_MERCHANT_RULE ||
    cogsInput.confidenceLevel === "merchant_rule"
  ) {
    return "merchant_rule";
  }
  return "confirmed";
}

/** @param {any} cogsInput */
function isMerchantOwnedCost(cogsInput) {
  return (
    cogsInput.source === COGS_SOURCE_MANUAL ||
    cogsInput.source === COGS_SOURCE_MANUAL_ONBOARDING ||
    cogsInput.source === COGS_SOURCE_MERCHANT_RULE
  );
}

/** @param {Array<any>} lineItems @param {Map<string, any>} cogsByVariantId */
function aggregateSoldLineItems(lineItems, cogsByVariantId) {
  const byVariant = new Map();
  for (const lineItem of lineItems) {
    const variantId = lineItem.variantId;
    const revenue = lineRevenue(lineItem);
    const soldUnits = Number(lineItem.quantity ?? 0);
    const status = variantId
      ? costStatus(cogsByVariantId.get(variantId))
      : "missing";
    const key = variantId ?? `missing:${lineItem.id}`;
    const current = byVariant.get(key) ?? {
      variantId,
      soldRevenue: 0,
      soldUnits: 0,
      confirmedRevenue: 0,
      merchantRuleRevenue: 0,
      missingRevenue: 0,
      confirmedUnits: 0,
      merchantRuleUnits: 0,
      missingUnits: 0,
      lastSoldAt: null,
    };
    current.soldRevenue = roundMoney(current.soldRevenue + revenue);
    current.soldUnits += soldUnits;
    if (status === "confirmed") {
      current.confirmedRevenue = roundMoney(current.confirmedRevenue + revenue);
      current.confirmedUnits += soldUnits;
    } else if (status === "merchant_rule") {
      current.merchantRuleRevenue = roundMoney(
        current.merchantRuleRevenue + revenue,
      );
      current.merchantRuleUnits += soldUnits;
    } else {
      current.missingRevenue = roundMoney(current.missingRevenue + revenue);
      current.missingUnits += soldUnits;
    }
    const processedAt = lineItem.order?.processedAt
      ? new Date(lineItem.order.processedAt)
      : null;
    if (
      processedAt &&
      (!current.lastSoldAt || processedAt > new Date(current.lastSoldAt))
    ) {
      current.lastSoldAt = processedAt.toISOString();
    }
    byVariant.set(key, current);
  }
  return byVariant;
}

/** @param {Array<any>} aggregates */
function coverageTotals(aggregates) {
  return aggregates.reduce(
    (totals, row) => ({
      soldRevenueTotal: roundMoney(totals.soldRevenueTotal + row.soldRevenue),
      soldRevenueConfirmedCost: roundMoney(
        totals.soldRevenueConfirmedCost + row.confirmedRevenue,
      ),
      soldRevenueMerchantRuleCost: roundMoney(
        totals.soldRevenueMerchantRuleCost + row.merchantRuleRevenue,
      ),
      soldRevenueMissingCost: roundMoney(
        totals.soldRevenueMissingCost + row.missingRevenue,
      ),
      soldUnitsTotal: totals.soldUnitsTotal + row.soldUnits,
      soldUnitsConfirmedCost:
        totals.soldUnitsConfirmedCost + row.confirmedUnits,
      soldUnitsMerchantRuleCost:
        totals.soldUnitsMerchantRuleCost + row.merchantRuleUnits,
      soldUnitsMissingCost: totals.soldUnitsMissingCost + row.missingUnits,
    }),
    {
      soldRevenueTotal: 0,
      soldRevenueConfirmedCost: 0,
      soldRevenueMerchantRuleCost: 0,
      soldRevenueMissingCost: 0,
      soldUnitsTotal: 0,
      soldUnitsConfirmedCost: 0,
      soldUnitsMerchantRuleCost: 0,
      soldUnitsMissingCost: 0,
    },
  );
}

/** @param {number} coveragePercent */
function marginConfidenceFromCoverage(coveragePercent) {
  if (coveragePercent >= 80) return "high";
  if (coveragePercent >= 50) return "medium";
  return "low";
}

/** @param {any} a @param {any} b */
function compareMissingCostRows(a, b) {
  if (b.soldRevenue !== a.soldRevenue) return b.soldRevenue - a.soldRevenue;
  if (b.soldUnits !== a.soldUnits) return b.soldUnits - a.soldUnits;
  if (b.recentSalesAt && a.recentSalesAt) {
    return Date.parse(b.recentSalesAt) - Date.parse(a.recentSalesAt);
  }
  if (b.recentSalesAt) return 1;
  if (a.recentSalesAt) return -1;
  return b.currentInventory - a.currentInventory;
}

/** @param {Array<any>} items @param {string} key */
function firstBy(items, key) {
  const map = new Map();
  for (const item of items) {
    const value = item?.[key];
    if (value && !map.has(value)) map.set(value, item);
  }
  return map;
}

/** @param {any} lineItem */
function lineRevenue(lineItem) {
  const total = decimalNumber(lineItem.totalPrice);
  if (total !== null && total > 0) return total;
  const unitPrice = decimalNumber(lineItem.unitPrice) ?? 0;
  return roundMoney(unitPrice * Number(lineItem.quantity ?? 0));
}

/** @param {unknown} value */
function decimalStringOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text === "") return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed.toFixed(4);
}

/** @param {unknown} value */
function decimalNumber(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** @param {unknown} value */
function numberOrNull(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** @param {string | null | undefined} confidenceLevel */
function confidenceScore(confidenceLevel) {
  if (confidenceLevel === "confirmed") return "1.0000";
  if (confidenceLevel === "merchant_rule") return "0.7000";
  return null;
}

/** @param {unknown} value */
function normalizeCurrency(value) {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : "GBP";
}

/** @param {Record<string, any>} unitCost @param {string | null | undefined} fallback */
function currencyFromUnitCost(unitCost, fallback) {
  return normalizeCurrency(unitCost.currencyCode ?? fallback);
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopId: string; inventoryItemExternalId: string; sku?: string | null }} input
 */
async function findVariantForInventoryItem(prisma, input) {
  const variant = await prisma.variant.findFirst({
    where: {
      shopId: input.shopId,
      inventoryItemExternalId: input.inventoryItemExternalId,
    },
  });
  if (variant || !input.sku) return variant;

  const skuMatches = await prisma.variant.findMany({
    where: { shopId: input.shopId, sku: input.sku },
    take: 2,
  });
  return skuMatches.length === 1 ? skuMatches[0] : null;
}

/** @param {Record<string, any>} inventoryItem */
function inventoryItemExternalIdFromInventoryItem(inventoryItem) {
  return (
    stringValue(inventoryItem.admin_graphql_api_id) ||
    shopifyGidFromValue("InventoryItem", inventoryItem.id) ||
    inventoryItemGid(inventoryItem)
  );
}

/** @param {Record<string, any>} variant */
function inventoryItemIdFromVariant(variant) {
  return (
    stringValue(variant.inventoryItem?.id) ||
    stringValue(variant.inventory_item?.admin_graphql_api_id) ||
    inventoryItemGid(variant)
  );
}

/** @param {Record<string, any>} payload */
function inventoryItemGid(payload) {
  const id = payload.inventory_item_id ?? payload.inventoryItemId ?? payload.id;
  return shopifyGidFromValue("InventoryItem", id);
}

/**
 * @param {string} resource
 * @param {unknown} id
 */
function shopifyGidFromValue(resource, id) {
  if (typeof id === "string" && id.startsWith("gid://")) return id;
  if (id === null || id === undefined || id === "") return null;
  if (typeof id !== "string" && typeof id !== "number") return null;
  return `gid://shopify/${resource}/${id}`;
}

/** @param {unknown} value */
function stringValue(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

/** @param {number} value */
function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** @param {number} value */
function roundPercent(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
