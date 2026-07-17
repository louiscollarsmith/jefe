// @ts-check

export const INVENTORY_GUARDIAN_ACTION_TYPE =
  "inventory_guardian_stockout_risk";
export const INVENTORY_GUARDIAN_FORMULA_VERSION = "inventory_guardian_v0";

const SALES_WINDOW_DAYS = 14;
const EVIDENCE_WINDOWS = [7, 14, 30];
const TARGET_COVER_DAYS = 30;
const RISKY_LEVELS = new Set([
  "out_of_stock",
  "critical",
  "warning",
  "watch",
]);

/**
 * @typedef {"out_of_stock" | "critical" | "warning" | "watch" | "healthy" | "not_selling"} InventoryRiskLevel
 * @typedef {"out_of_stock_no_recent_demand" | "active_stockout_risk" | "monitoring"} InventoryStatusReason
 * @typedef {"low" | "medium" | "high"} InventoryConfidence
 */

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; now?: Date }} input
 */
export async function generateInventoryGuardian(prisma, input) {
  const payload = await buildInventoryGuardianPayload(prisma, input);
  const actions = await persistInventoryGuardianWarnings(prisma, payload);

  return { ...payload, persistedActionCount: actions.length };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; now?: Date }} input
 */
export async function buildInventoryGuardianPayload(prisma, input) {
  const now = input.now ?? new Date();
  const periodStart30d = subtractDays(now, 30);
  const [merchant, variants, lineItems, cogsInputs] = await Promise.all([
    prisma.merchant.findUnique({
      where: { id: input.merchantId },
      select: { primaryCurrency: true },
    }),
    prisma.variant.findMany({
      where: { merchantId: input.merchantId, shopId: input.shopId },
      include: {
        product: true,
        inventoryLevels: true,
      },
      orderBy: [{ updatedAt: "desc" }],
    }),
    prisma.orderLineItem.findMany({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        variantId: { not: null },
        order: {
          processedAt: { gte: periodStart30d, lt: now },
        },
      },
      include: { order: true },
      orderBy: [{ createdAt: "desc" }],
    }),
    prisma.cogsInput.findMany({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        variantId: { not: null },
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      orderBy: [{ updatedAt: "desc" }, { effectiveFrom: "desc" }],
    }),
  ]);
  const lineItemsByVariantId = groupBy(lineItems, "variantId");
  const cogsByVariantId = firstBy(cogsInputs, "variantId");
  const records = variants.map((variant) =>
    calculateInventoryGuardianRecord({
      merchantId: input.merchantId,
      shopId: input.shopId,
      product: variant.product,
      variant,
      inventoryLevels: variant.inventoryLevels,
      lineItems: lineItemsByVariantId.get(variant.id) ?? [],
      cogsInput: cogsByVariantId.get(variant.id) ?? null,
      now,
      fallbackCurrency: variant.currency ?? "GBP",
    }),
  );

  return buildInventoryGuardianView({
    merchantId: input.merchantId,
    shopId: input.shopId,
    generatedAt: now,
    records,
    orderLineItemCount: lineItems.length,
    inventoryLevelCount: variants.reduce(
      (sum, variant) => sum + variant.inventoryLevels.length,
      0,
    ),
    currency: firstCurrency(records) ?? merchant?.primaryCurrency ?? "GBP",
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {Awaited<ReturnType<typeof buildInventoryGuardianPayload>>} payload
 */
export async function persistInventoryGuardianWarnings(prisma, payload) {
  const warningRecords = payload.records.filter((record) =>
    isMeaningfulWarning(record.riskLevel),
  );
  const proposedAt = new Date(payload.generatedAt);
  const actionDate = dateOnly(proposedAt);

  return Promise.all(
    warningRecords.map((record) =>
      prisma.action.upsert({
        where: {
          merchantId_idempotencyKey: {
            merchantId: payload.merchantId,
            idempotencyKey: `inventory-guardian:${payload.shopId}:${actionDate}:${record.variantId}`,
          },
        },
        create: {
          merchantId: payload.merchantId,
          shopId: payload.shopId,
          actionType: INVENTORY_GUARDIAN_ACTION_TYPE,
          status: "proposed",
          expectedValue: actionExpectedValue(record),
          confidence: confidenceScore(record.confidence).toFixed(4),
          riskLevel: record.riskLevel,
          evidence: actionEvidence(record),
          rulesConsulted: [],
          ruleConstraintsApplied: [],
          preview: actionPreview(record),
          verificationClass: "ESTIMATED",
          idempotencyKey: `inventory-guardian:${payload.shopId}:${actionDate}:${record.variantId}`,
          proposedAt,
        },
        update: {
          status: "proposed",
          expectedValue: actionExpectedValue(record),
          confidence: confidenceScore(record.confidence).toFixed(4),
          riskLevel: record.riskLevel,
          evidence: actionEvidence(record),
          preview: actionPreview(record),
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
 *   product: any;
 *   variant: any;
 *   inventoryLevels?: any[];
 *   lineItems?: any[];
 *   cogsInput?: any | null;
 *   now: Date;
 *   fallbackCurrency?: string;
 * }} input
 */
export function calculateInventoryGuardianRecord(input) {
  const inventory = aggregateInventory(input.inventoryLevels ?? []);
  const soldUnits = Object.fromEntries(
    EVIDENCE_WINDOWS.map((days) => [
      days,
      unitsSoldInWindow(input.lineItems ?? [], input.now, days),
    ]),
  );
  const velocity = soldUnits[14] / SALES_WINDOW_DAYS;
  const price = averageSellingPrice(input.lineItems ?? [], input.variant);
  const cogsAmount =
    input.cogsInput &&
    input.cogsInput.costAmount !== undefined &&
    input.cogsInput.costAmount !== null
      ? money(input.cogsInput.costAmount)
      : null;
  const daysUntilStockout = calculateDaysUntilStockout(
    inventory.currentInventory,
    velocity,
  );
  const riskLevel = assignInventoryRiskLevel({
    currentInventory: inventory.currentInventory,
    averageUnitsSoldPerDay: velocity,
    daysUntilStockout,
  });
  const statusReason = inventoryStatusReason({
    currentInventory: inventory.currentInventory,
    averageUnitsSoldPerDay: velocity,
    unitsSold7d: soldUnits[7],
    unitsSold14d: soldUnits[14],
    unitsSold30d: soldUnits[30],
    riskLevel,
  });
  const projectedUnitsNext14Days = velocity * SALES_WINDOW_DAYS;
  const unitsShort =
    inventory.currentInventory === null
      ? 0
      : Math.max(0, projectedUnitsNext14Days - inventory.currentInventory);
  const revenueAtRisk =
    price.averageSellingPrice === null
      ? 0
      : roundMoney(unitsShort * price.averageSellingPrice);
  const grossProfitAtRisk =
    cogsAmount === null || price.averageSellingPrice === null
      ? null
      : roundMoney(unitsShort * (price.averageSellingPrice - cogsAmount));
  const suggestedReorderQuantity =
    velocity <= 0 || inventory.currentInventory === null
      ? null
      : Math.max(
          0,
          Math.ceil(velocity * TARGET_COVER_DAYS - inventory.currentInventory),
        );
  const confidence = inventoryConfidence({
    currentInventory: inventory.currentInventory,
    unitsSold14d: soldUnits[14],
    priceSource: price.priceSource,
    averageSellingPrice: price.averageSellingPrice,
    cogsAmount,
    variantId: input.variant?.id,
    productId: input.product?.id,
  });
  const currency =
    firstCurrencyCode([
      input.lineItems?.find((lineItem) => isCurrencyCode(lineItem.order?.currency))
        ?.order?.currency,
      input.variant?.currency,
      input.fallbackCurrency,
      "GBP",
    ]) ?? "GBP";
  const productTitle =
    input.product?.title ?? input.lineItems?.[0]?.title ?? "Unknown product";
  const variantTitle = input.variant?.title ?? "Default";
  const sku = input.variant?.sku ?? input.lineItems?.[0]?.sku ?? null;

  return {
    merchantId: input.merchantId,
    shopId: input.shopId,
    productId: input.product?.id ?? null,
    variantId: input.variant?.id ?? null,
    sku,
    title: productTitle,
    variantTitle,
    inventoryItemExternalId:
      input.variant?.inventoryItemExternalId ??
      inventory.inventoryItemExternalId ??
      null,
    locationExternalId: inventory.locationExternalId,
    currentInventory: inventory.currentInventory,
    averageUnitsSoldPerDay: roundNumber(velocity, 4),
    unitsSold7d: soldUnits[7],
    unitsSold14d: soldUnits[14],
    unitsSold30d: soldUnits[30],
    daysUntilStockout,
    riskLevel,
    statusReason,
    averageSellingPrice: price.averageSellingPrice,
    priceSource: price.priceSource,
    revenueAtRisk,
    grossProfitAtRisk,
    suggestedReorderQuantity,
    confidence,
    currency,
    evidence: {
      formulaVersion: INVENTORY_GUARDIAN_FORMULA_VERSION,
      calculationPeriodDays: SALES_WINDOW_DAYS,
      evidenceWindowsDays: EVIDENCE_WINDOWS,
      productId: input.product?.id ?? null,
      variantId: input.variant?.id ?? null,
      sku,
      currentInventory: inventory.currentInventory,
      inventoryLevels: inventory.levels,
      inventoryLastSyncedAt: inventory.inventoryLastSyncedAt,
      orderLineItemIds: (input.lineItems ?? [])
        .map((lineItem) => lineItem.id)
        .filter(Boolean),
      sourceOrderRefs: (input.lineItems ?? [])
        .map((lineItem) => lineItem.order?.orderName ?? lineItem.order?.externalId)
        .filter(Boolean),
      unitsSold7d: soldUnits[7],
      unitsSold14d: soldUnits[14],
      unitsSold30d: soldUnits[30],
      priceUsed: price.averageSellingPrice,
      priceSource: price.priceSource,
      cogsInputId: input.cogsInput?.id ?? null,
      unitCogs: cogsAmount,
      limitations: evidenceLimitations({
        currentInventory: inventory.currentInventory,
        unitsSold14d: soldUnits[14],
        unitsSold30d: soldUnits[30],
        statusReason,
        priceSource: price.priceSource,
        cogsAmount,
      }),
    },
    verificationClass: "estimated",
  };
}

/**
 * @param {{ currentInventory: number | null; averageUnitsSoldPerDay: number; unitsSold7d: number; unitsSold14d: number; unitsSold30d: number; riskLevel: InventoryRiskLevel }} input
 * @returns {InventoryStatusReason}
 */
function inventoryStatusReason(input) {
  if (
    input.currentInventory === 0 &&
    input.averageUnitsSoldPerDay === 0 &&
    input.unitsSold7d === 0 &&
    input.unitsSold14d === 0 &&
    input.unitsSold30d === 0
  ) {
    return "out_of_stock_no_recent_demand";
  }

  if (isActiveStockoutRisk(input.riskLevel)) return "active_stockout_risk";

  return "monitoring";
}

/**
 * @param {number | null} currentInventory
 * @param {number} averageUnitsSoldPerDay
 */
export function calculateDaysUntilStockout(
  currentInventory,
  averageUnitsSoldPerDay,
) {
  if (currentInventory === null) return null;
  if (currentInventory === 0) return 0;
  if (averageUnitsSoldPerDay <= 0) return null;

  return roundNumber(currentInventory / averageUnitsSoldPerDay, 1);
}

/**
 * @param {{ currentInventory: number | null; averageUnitsSoldPerDay: number; daysUntilStockout: number | null }} input
 * @returns {InventoryRiskLevel}
 */
export function assignInventoryRiskLevel(input) {
  if (input.currentInventory === 0) return "out_of_stock";
  if (input.averageUnitsSoldPerDay <= 0) return "not_selling";
  if (input.daysUntilStockout !== null && input.daysUntilStockout <= 7) {
    return "critical";
  }
  if (input.daysUntilStockout !== null && input.daysUntilStockout <= 14) {
    return "warning";
  }
  if (input.daysUntilStockout !== null && input.daysUntilStockout <= 30) {
    return "watch";
  }

  return "healthy";
}

/**
 * @param {{ merchantId: string; shopId: string; generatedAt: Date; records: any[]; orderLineItemCount: number; inventoryLevelCount: number; currency: string }} input
 */
function buildInventoryGuardianView(input) {
  const sortedRecords = [...input.records].sort(compareInventoryRecords);
  const activeStockoutRisk = sortedRecords.filter((record) =>
    isActiveStockoutRiskRecord(record),
  );
  const outOfStockNoRecentDemand = sortedRecords.filter(
    (record) => record.statusReason === "out_of_stock_no_recent_demand",
  );
  const revenueAtRisk = roundMoney(
    activeStockoutRisk.reduce((sum, record) => sum + record.revenueAtRisk, 0),
  );
  const grossProfitValues = activeStockoutRisk
    .map((record) => record.grossProfitAtRisk)
    .filter((value) => typeof value === "number");
  const grossProfitAtRisk =
    grossProfitValues.length > 0
      ? roundMoney(grossProfitValues.reduce((sum, value) => sum + value, 0))
      : null;
  const missingCogsCount = activeStockoutRisk.filter(
    (record) => record.revenueAtRisk > 0 && record.grossProfitAtRisk === null,
  ).length;
  const inventoryLastSyncedAt = latestDate(
    sortedRecords.flatMap((record) =>
      record.evidence.inventoryLevels.map(
        /** @param {{ observedAt?: string | null }} level */
        (level) => level.observedAt,
      ),
    ),
  );
  const confidence = summaryConfidence(sortedRecords);
  const emptyState = inventoryEmptyState({
    inventoryLevelCount: input.inventoryLevelCount,
    orderLineItemCount: input.orderLineItemCount,
    atRiskWithin14Count: activeStockoutRisk.length,
  });

  return {
    merchantId: input.merchantId,
    shopId: input.shopId,
    generatedAt: input.generatedAt.toISOString(),
    statusStrip: {
      salesVelocityPeriod: "Last 14 days sales velocity",
      inventoryLastSyncedAt,
    },
    hero: {
      atRiskVariantCount: activeStockoutRisk.length,
      outOfStockNoRecentDemandCount: outOfStockNoRecentDemand.length,
      revenueAtRisk,
      grossProfitAtRisk,
      confidence,
      message: heroMessage({
        atRiskVariantCount: activeStockoutRisk.length,
        outOfStockNoRecentDemandCount: outOfStockNoRecentDemand.length,
        revenueAtRisk,
        currency: input.currency,
      }),
    },
    metrics: {
      outOfStock: countRisk(sortedRecords, "out_of_stock"),
      critical: countRisk(sortedRecords, "critical"),
      warning: countRisk(sortedRecords, "warning"),
      watch: countRisk(sortedRecords, "watch"),
      healthy: countRisk(sortedRecords, "healthy"),
      notSelling: countRisk(sortedRecords, "not_selling"),
      outOfStockNoRecentDemand: outOfStockNoRecentDemand.length,
      revenueAtRisk,
      grossProfitAtRisk,
      missingCogsCount,
      currency: input.currency,
    },
    emptyState,
    records: sortedRecords,
    riskyRecords: sortedRecords.filter((record) =>
      isMeaningfulWarning(record.riskLevel),
    ),
    verificationClass: "estimated",
  };
}

/**
 * @param {any[]} inventoryLevels
 */
function aggregateInventory(inventoryLevels) {
  const levels = inventoryLevels.map((level) => ({
    inventoryLevelId: level.id ?? null,
    inventoryItemExternalId: level.inventoryItemExternalId ?? null,
    locationExternalId: level.locationExternalId ?? null,
    available:
      level.available === null || level.available === undefined
        ? null
        : Number(level.available),
    observedAt: dateString(level.observedAt ?? level.sourceUpdatedAt),
    sourceUpdatedAt: dateString(level.sourceUpdatedAt),
  }));
  const availableLevels = levels.filter((level) =>
    Number.isFinite(level.available),
  );
  const currentInventory =
    availableLevels.length === 0
      ? null
      : availableLevels.reduce(
          (sum, level) => sum + Number(level.available ?? 0),
          0,
        );

  return {
    currentInventory,
    inventoryItemExternalId:
      firstString(levels.map((level) => level.inventoryItemExternalId)) ?? null,
    locationExternalId:
      levels.length === 1
        ? levels[0].locationExternalId
        : levels.length > 1
          ? "multiple"
          : null,
    inventoryLastSyncedAt: latestDate(
      levels.map((level) => level.observedAt ?? level.sourceUpdatedAt),
    ),
    levels,
  };
}

/**
 * @param {any[]} lineItems
 * @param {Date} now
 * @param {number} days
 */
function unitsSoldInWindow(lineItems, now, days) {
  const start = subtractDays(now, days);

  return lineItems.reduce((sum, lineItem) => {
    const processedAt = lineItem.order?.processedAt
      ? new Date(lineItem.order.processedAt)
      : null;
    if (!processedAt || processedAt < start || processedAt >= now) return sum;

    return sum + Number(lineItem.quantity ?? 0);
  }, 0);
}

/**
 * @param {any[]} lineItems
 * @param {any} variant
 */
function averageSellingPrice(lineItems, variant) {
  let revenue = 0;
  let units = 0;

  for (const lineItem of lineItems) {
    const quantity = Number(lineItem.quantity ?? 0);
    const lineRevenueValue = lineRevenue(lineItem);

    if (quantity > 0 && lineRevenueValue > 0) {
      units += quantity;
      revenue += lineRevenueValue;
    }
  }

  if (units > 0) {
    return {
      averageSellingPrice: roundMoney(revenue / units),
      priceSource: "order_line_items",
    };
  }

  const variantPrice = moneyOrNull(variant?.price);
  if (variantPrice !== null) {
    return {
      averageSellingPrice: roundMoney(variantPrice),
      priceSource: "variant_price",
    };
  }

  return { averageSellingPrice: null, priceSource: "missing" };
}

/**
 * @param {{ currentInventory: number | null; unitsSold14d: number; priceSource: string; averageSellingPrice: number | null; cogsAmount: number | null; variantId?: string | null; productId?: string | null }} input
 * @returns {InventoryConfidence}
 */
function inventoryConfidence(input) {
  if (
    input.currentInventory === null ||
    input.unitsSold14d === 0 ||
    input.averageSellingPrice === null ||
    input.priceSource !== "order_line_items" ||
    !input.variantId ||
    !input.productId
  ) {
    return "low";
  }

  if (input.cogsAmount === null) return "medium";

  return "high";
}

/**
 * @param {{ currentInventory: number | null; unitsSold14d: number; unitsSold30d: number; statusReason: InventoryStatusReason; priceSource: string; cogsAmount: number | null }} input
 */
function evidenceLimitations(input) {
  const limitations = [];

  if (input.statusReason === "out_of_stock_no_recent_demand") {
    limitations.push("No recent demand detected.");
    limitations.push("This variant is out of stock, but no sales were found in the last 30 days. Jefe is not recommending a reorder.");
    return limitations;
  }
  if (input.currentInventory === null) {
    limitations.push("Inventory is missing for this variant.");
  }
  if (input.unitsSold14d === 0) {
    limitations.push("No sales were found in the default 14-day velocity window.");
  }
  if (input.priceSource === "variant_price") {
    limitations.push("Average selling price uses variant price because recent line-item revenue is unavailable.");
  }
  if (input.priceSource === "missing") {
    limitations.push("Price is missing, so revenue at risk cannot be estimated.");
  }
  if (input.cogsAmount === null) {
    limitations.push("COGS is missing, so margin at risk is unavailable.");
  }

  return limitations;
}

/**
 * @param {any} record
 */
function actionExpectedValue(record) {
  return {
    type: "estimated_prevention",
    revenueAtRisk: record.revenueAtRisk,
    grossProfitAtRisk: record.grossProfitAtRisk,
    currency: record.currency,
    windowDays: SALES_WINDOW_DAYS,
    verificationClass: "estimated",
  };
}

/**
 * @param {any} record
 */
function actionEvidence(record) {
  return {
    ...record,
    evidence: record.evidence,
    verificationClass: "estimated",
  };
}

/**
 * @param {any} record
 */
function actionPreview(record) {
  return {
    title: `${record.title} / ${record.variantTitle}`,
    message:
      record.statusReason === "out_of_stock_no_recent_demand"
        ? "Out of stock with no recent demand. No reorder is recommended."
        : `${riskLabel(record.riskLevel)} stockout risk based on ${record.unitsSold14d} units sold in the last 14 days.`,
    suggestedReorderQuantity: record.suggestedReorderQuantity,
    noWriteAction: true,
  };
}

/**
 * @param {InventoryRiskLevel} riskLevel
 */
export function isMeaningfulWarning(riskLevel) {
  return RISKY_LEVELS.has(riskLevel);
}

/**
 * @param {InventoryConfidence} confidence
 */
function confidenceScore(confidence) {
  if (confidence === "high") return 0.9;
  if (confidence === "medium") return 0.6;
  return 0.3;
}

/**
 * @param {any[]} records
 * @returns {InventoryConfidence}
 */
function summaryConfidence(records) {
  const meaningfulRisk = records.filter((record) => record.revenueAtRisk > 0);
  if (meaningfulRisk.length === 0) return "high";
  const totalRevenueAtRisk = meaningfulRisk.reduce(
    (sum, record) => sum + record.revenueAtRisk,
    0,
  );

  if (totalRevenueAtRisk <= 0) return "high";

  const weightedScore =
    meaningfulRisk.reduce(
      (sum, record) =>
        sum + confidenceScore(record.confidence) * record.revenueAtRisk,
      0,
    ) / totalRevenueAtRisk;

  if (weightedScore >= 0.8) return "high";
  if (weightedScore >= 0.5) return "medium";
  return "low";
}

/**
 * @param {{ inventoryLevelCount: number; orderLineItemCount: number; atRiskWithin14Count: number }} input
 */
function inventoryEmptyState(input) {
  if (input.inventoryLevelCount === 0) return "no_inventory";
  if (input.orderLineItemCount === 0) return "no_sales";
  if (input.atRiskWithin14Count === 0) return "healthy";
  return null;
}

/**
 * @param {{ atRiskVariantCount: number; outOfStockNoRecentDemandCount: number; revenueAtRisk: number; currency: string }} input
 */
function heroMessage(input) {
  const activeRiskText =
    input.atRiskVariantCount > 0
      ? `${input.atRiskVariantCount} variant${
          input.atRiskVariantCount === 1 ? " is" : "s are"
        } likely to stock out within 14 days.`
      : "No selling variants are likely to stock out within 14 days.";
  const noDemandText =
    input.outOfStockNoRecentDemandCount > 0
      ? ` ${input.outOfStockNoRecentDemandCount} variant${
          input.outOfStockNoRecentDemandCount === 1 ? " is" : "s are"
        } already out of stock with no recent demand.`
      : "";

  if (input.atRiskVariantCount === 0 && input.outOfStockNoRecentDemandCount === 0) {
    return "No urgent stockout risks found. Current inventory appears healthy based on recent sales velocity.";
  }

  if (input.revenueAtRisk === 0) {
    return `${activeRiskText}${noDemandText} No revenue at risk detected.`;
  }

  return `${activeRiskText}${noDemandText} Estimated revenue at risk is ${formatMoney(
    input.revenueAtRisk,
    input.currency,
  )}.`;
}

/**
 * @param {InventoryRiskLevel} riskLevel
 */
function isActiveStockoutRisk(riskLevel) {
  return ["out_of_stock", "critical", "warning"].includes(riskLevel);
}

/**
 * @param {{ riskLevel: InventoryRiskLevel; statusReason?: InventoryStatusReason }} record
 */
function isActiveStockoutRiskRecord(record) {
  return (
    record.statusReason !== "out_of_stock_no_recent_demand" &&
    isActiveStockoutRisk(record.riskLevel)
  );
}

/**
 * @param {{ riskLevel: InventoryRiskLevel; statusReason?: InventoryStatusReason; revenueAtRisk: number; daysUntilStockout: number | null; title: string; variantTitle: string }} a
 * @param {{ riskLevel: InventoryRiskLevel; statusReason?: InventoryStatusReason; revenueAtRisk: number; daysUntilStockout: number | null; title: string; variantTitle: string }} b
 */
function compareInventoryRecords(a, b) {
  /** @type {Record<InventoryRiskLevel, number>} */
  const riskOrder = {
    out_of_stock: 0,
    critical: 1,
    warning: 2,
    watch: 3,
    healthy: 4,
    not_selling: 5,
  };
  const aHasRevenueRisk = a.revenueAtRisk > 0 ? 0 : 1;
  const bHasRevenueRisk = b.revenueAtRisk > 0 ? 0 : 1;
  const aNoDemandNote = a.statusReason === "out_of_stock_no_recent_demand" ? 1 : 0;
  const bNoDemandNote = b.statusReason === "out_of_stock_no_recent_demand" ? 1 : 0;

  return (
    aHasRevenueRisk - bHasRevenueRisk ||
    b.revenueAtRisk - a.revenueAtRisk ||
    aNoDemandNote - bNoDemandNote ||
    riskOrder[a.riskLevel] - riskOrder[b.riskLevel] ||
    (a.daysUntilStockout ?? Number.POSITIVE_INFINITY) -
      (b.daysUntilStockout ?? Number.POSITIVE_INFINITY) ||
    `${a.title} ${a.variantTitle}`.localeCompare(`${b.title} ${b.variantTitle}`)
  );
}

/**
 * @param {any[]} records
 * @param {InventoryRiskLevel} riskLevel
 */
function countRisk(records, riskLevel) {
  return records.filter((record) => record.riskLevel === riskLevel).length;
}

/**
 * @param {any} lineItem
 */
function lineRevenue(lineItem) {
  const total = money(lineItem.totalPrice);
  if (total > 0) return total;

  return money(lineItem.unitPrice) * Number(lineItem.quantity ?? 0);
}

/**
 * @param {unknown} value
 */
function money(value) {
  const parsed = Number(value ?? 0);

  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @param {unknown} value
 */
function moneyOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @param {number} value
 */
function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * @param {number} value
 * @param {number} decimals
 */
function roundNumber(value, decimals) {
  const factor = 10 ** decimals;

  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * @param {Date} date
 * @param {number} days
 */
function subtractDays(date, days) {
  return new Date(date.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * @param {Date} date
 */
function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * @param {unknown} value
 */
function dateString(value) {
  if (!value) return null;
  const date = new Date(/** @type {any} */ (value));

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * @param {Array<string | null | undefined>} values
 */
function latestDate(values) {
  const dates = values
    .filter(Boolean)
    .map((value) => new Date(/** @type {string} */ (value)))
    .filter((date) => !Number.isNaN(date.getTime()));
  if (dates.length === 0) return null;

  return new Date(Math.max(...dates.map((date) => date.getTime()))).toISOString();
}

/**
 * @param {Array<string | null | undefined>} values
 */
function firstString(values) {
  return values.find((value) => typeof value === "string" && value.length > 0) ?? null;
}

/**
 * @param {any[]} records
 */
function firstCurrency(records) {
  return firstCurrencyCode(records.map((record) => record.currency));
}

/**
 * @param {Array<string | null | undefined>} values
 */
function firstCurrencyCode(values) {
  return values.find((value) => isCurrencyCode(value)) ?? null;
}

/**
 * @param {unknown} value
 */
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

  return `${symbol}${roundMoney(value).toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * @param {InventoryRiskLevel} riskLevel
 */
function riskLabel(riskLevel) {
  const labels = {
    out_of_stock: "Out of stock",
    critical: "Critical",
    warning: "Warning",
    watch: "Watch",
    healthy: "Healthy",
    not_selling: "Not selling",
  };

  return labels[riskLevel];
}

/**
 * @param {any[]} items
 * @param {string} key
 */
function groupBy(items, key) {
  const map = new Map();

  for (const item of items) {
    const value = item[key];
    if (!value) continue;
    if (!map.has(value)) map.set(value, []);
    map.get(value).push(item);
  }

  return map;
}

/**
 * @param {any[]} items
 * @param {string} key
 */
function firstBy(items, key) {
  const map = new Map();

  for (const item of items) {
    const value = item[key];
    if (value && !map.has(value)) map.set(value, item);
  }

  return map;
}
