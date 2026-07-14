// @ts-check

const DEFAULT_PERIOD_DAYS = 7;
const LOW_MARGIN_PERCENT = 30;

/**
 * @typedef {"low" | "medium" | "high"} ConfidenceLevel
 */

/**
 * @typedef {object} DailyVerdictPayload
 * @property {string} merchantId
 * @property {string} shopId
 * @property {string} periodStart
 * @property {string} periodEnd
 * @property {{ label: string, range: string, display: string, startDate: string, endDate: string }} period
 * @property {string} headline
 * @property {string} summary
 * @property {{ whatHappened: string, whatMatters: string, confidence: string, nextStep: string }} sections
 * @property {{ gross: number, net: number, refunded: number, currency: string }} revenue
 * @property {{ estimatedGrossProfit: number | null, estimatedMarginPercent: number | null, confidenceLevel: ConfidenceLevel, missingCogsVariantCount: number, cogsCoveragePercent: number, soldUnitsWithCogs: number, soldUnits: number }} margin
 * @property {Array<Record<string, any>>} highlights
 * @property {Record<string, unknown>} evidence
 * @property {Array<Record<string, unknown>>} provenanceLinks
 */

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; periodStart?: Date; periodEnd?: Date; now?: Date }} input
 */
export async function generateDailyVerdict(prisma, input) {
  const periodEnd = input.periodEnd ?? input.now ?? new Date();
  const periodStart =
    input.periodStart ??
    new Date(periodEnd.getTime() - DEFAULT_PERIOD_DAYS * 24 * 60 * 60 * 1000);

  const verdict = await buildDailyVerdictPayload(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    periodStart,
    periodEnd,
  });
  const verdictJson = toJson(verdict);
  const metricsJson = toJson({
    revenue: verdict.revenue,
    margin: verdict.margin,
    period: { start: verdict.periodStart, end: verdict.periodEnd },
  });
  const evidenceJson = toJson(verdict.evidence);
  const briefDate = dateOnly(periodEnd);
  const idempotencyKey = `daily-verdict:${input.shopId}:${briefDate}`;

  return prisma.dailyBrief.upsert({
    where: {
      merchantId_shopId_briefDate_channel: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        briefDate: new Date(`${briefDate}T00:00:00.000Z`),
        channel: "app",
      },
    },
    create: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      briefDate: new Date(`${briefDate}T00:00:00.000Z`),
      status: "ready",
      channel: "app",
      verdict: verdictJson,
      metrics: metricsJson,
      evidence: evidenceJson,
      idempotencyKey,
    },
    update: {
      status: "ready",
      verdict: verdictJson,
      metrics: metricsJson,
      evidence: evidenceJson,
      idempotencyKey,
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; periodStart: Date; periodEnd: Date }} input
 * @returns {Promise<DailyVerdictPayload>}
 */
export async function buildDailyVerdictPayload(prisma, input) {
  const [lineItems, refunds, goals, houseRule] = await Promise.all([
    prisma.orderLineItem.findMany({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        order: {
          processedAt: { gte: input.periodStart, lt: input.periodEnd },
        },
      },
      include: {
        order: true,
        product: true,
        variant: true,
      },
    }),
    prisma.refund.findMany({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        OR: [
          { processedAt: { gte: input.periodStart, lt: input.periodEnd } },
          { sourceCreatedAt: { gte: input.periodStart, lt: input.periodEnd } },
        ],
      },
      include: { order: true },
    }),
    prisma.goal.findMany({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        status: "active",
      },
      orderBy: { horizon: "asc" },
    }),
    prisma.houseRule.findFirst({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        status: "active",
        title: "Founder House Rules",
      },
      orderBy: { updatedAt: "desc" },
    }),
  ]);
  const variantIds = unique(
    lineItems
      .map((lineItem) => lineItem.variantId)
      .filter((variantId) => typeof variantId === "string"),
  );
  const cogsInputs = variantIds.length
    ? await prisma.cogsInput.findMany({
        where: {
          shopId: input.shopId,
          variantId: { in: variantIds },
          effectiveTo: null,
          effectiveFrom: { lte: input.periodEnd },
        },
        orderBy: [{ updatedAt: "desc" }, { effectiveFrom: "desc" }],
      })
    : [];
  const cogsByVariantId = new Map();

  for (const cogsInput of cogsInputs) {
    if (cogsInput.variantId && !cogsByVariantId.has(cogsInput.variantId)) {
      cogsByVariantId.set(cogsInput.variantId, cogsInput);
    }
  }

  const currency = firstCurrency(lineItems) ?? "GBP";
  const aggregates = aggregateLineItems(lineItems, cogsByVariantId, currency);
  const refundedAmount = roundMoney(
    refunds.reduce((sum, refund) => sum + money(refund.amount), 0),
  );
  const netRevenue = roundMoney(aggregates.grossRevenue - refundedAmount);
  const refundRate =
    aggregates.grossRevenue > 0
      ? roundPercent((refundedAmount / aggregates.grossRevenue) * 100)
      : 0;
  const confidenceLevel = cogsConfidenceFromCoverage(
    aggregates.cogsCoveragePercent,
  );
  const topRevenueProducts = topValues(aggregates.products, "revenue", 5);
  const topGrossProfitProducts = topValues(
    aggregates.products.filter((product) => product.soldUnitsWithCogs > 0),
    "grossProfit",
    5,
  );
  const lowMarginProducts = aggregates.products
    .filter(
      (product) =>
        product.soldUnitsWithCogs > 0 &&
        product.marginPercent !== null &&
        product.marginPercent < LOW_MARGIN_PERCENT,
    )
    .sort((a, b) => (a.marginPercent ?? 0) - (b.marginPercent ?? 0))
    .slice(0, 5);
  const missingCogsProducts = aggregates.products
    .filter((product) => product.missingCogsUnits > 0)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);
  const topSellersByUnits = topValues(aggregates.variants, "units", 5);
  const highlights = buildHighlights({
    currency,
    variants: aggregates.variants,
    topRevenueProducts,
    topGrossProfitProducts,
    lowMarginProducts,
    missingCogsProducts,
    refundRate,
    refundedAmount,
    confidenceLevel,
    cogsCoveragePercent: aggregates.cogsCoveragePercent,
  });
  const summary = buildSummary({
    currency,
    grossRevenue: aggregates.grossRevenue,
    netRevenue,
    estimatedGrossProfit: aggregates.estimatedGrossProfit,
    estimatedMarginPercent: aggregates.estimatedMarginPercent,
    confidenceLevel,
    cogsCoveragePercent: aggregates.cogsCoveragePercent,
    topRevenueProduct: topRevenueProducts[0],
    topGrossProfitProduct: topGrossProfitProducts[0],
    missingCogsVariantCount: aggregates.missingCogsVariantCount,
    refundRate,
    lineItemCount: lineItems.length,
  });
  const headline = buildHeadline({
    currency,
    grossRevenue: aggregates.grossRevenue,
    confidenceLevel,
    cogsCoveragePercent: aggregates.cogsCoveragePercent,
    soldUnits: aggregates.soldUnits,
    soldUnitsWithCogs: aggregates.soldUnitsWithCogs,
    lineItemCount: lineItems.length,
  });
  const sections = buildSections({
    currency,
    grossRevenue: aggregates.grossRevenue,
    netRevenue,
    estimatedGrossProfit: aggregates.estimatedGrossProfit,
    estimatedMarginPercent: aggregates.estimatedMarginPercent,
    confidenceLevel,
    cogsCoveragePercent: aggregates.cogsCoveragePercent,
    topRevenueProduct: topRevenueProducts[0],
    topGrossProfitProduct: topGrossProfitProducts[0],
    lowMarginProduct: lowMarginProducts[0],
    missingCogsProduct: missingCogsProducts[0],
    missingCogsVariantCount: aggregates.missingCogsVariantCount,
    refundRate,
    lineItemCount: lineItems.length,
  });
  const period = buildPeriodView(input.periodStart, input.periodEnd);

  return {
    merchantId: input.merchantId,
    shopId: input.shopId,
    periodStart: input.periodStart.toISOString(),
    periodEnd: input.periodEnd.toISOString(),
    period,
    headline,
    summary,
    sections,
    revenue: {
      gross: aggregates.grossRevenue,
      net: netRevenue,
      refunded: refundedAmount,
      currency,
    },
    margin: {
      estimatedGrossProfit: aggregates.estimatedGrossProfit,
      estimatedMarginPercent: aggregates.estimatedMarginPercent,
      confidenceLevel,
      missingCogsVariantCount: aggregates.missingCogsVariantCount,
      cogsCoveragePercent: aggregates.cogsCoveragePercent,
      soldUnitsWithCogs: aggregates.soldUnitsWithCogs,
      soldUnits: aggregates.soldUnits,
    },
    highlights,
    evidence: {
      period: {
        start: input.periodStart.toISOString(),
        end: input.periodEnd.toISOString(),
      },
      orderLineItemCount: lineItems.length,
      orderCount: unique(lineItems.map((lineItem) => lineItem.orderId)).length,
      refundCount: refunds.length,
      refundRatePercent: refundRate,
      refundDataCompleteness:
        refunds.length > 0 ? "order_level_only" : "no_refunds_recorded",
      shippingCostCompleteness: "order_shipping_available_not_allocated_to_sku",
      cogsSource: "active_cogs_inputs",
      goals: goals.map((goal) => ({
        horizon: goal.horizon,
        description: goal.description,
      })),
      houseRules: houseRule
        ? {
            houseRuleId: houseRule.id,
            maxDefaultDiscountBps: houseRule.maxDefaultDiscountBps,
            maxWinbackDiscountBps: houseRule.maxWinbackDiscountBps,
            minimumMarginPercent:
              objectValue(houseRule.marginPriorityRules).minimumMarginPercent ??
              null,
          }
        : null,
      revenueByVariant: aggregates.variants,
      revenueByProduct: aggregates.products,
      topRevenueProducts,
      topGrossProfitProducts,
      lowMarginProducts,
      missingCogsProducts,
      topSellersByUnits,
    },
    provenanceLinks: [],
  };
}

/**
 * @param {Array<any>} lineItems
 * @param {Map<string, any>} cogsByVariantId
 * @param {string} currency
 */
function aggregateLineItems(lineItems, cogsByVariantId, currency) {
  const productMap = new Map();
  const variantMap = new Map();
  let grossRevenue = 0;
  let estimatedGrossProfit = 0;
  let soldUnits = 0;
  let soldUnitsWithCogs = 0;
  const missingCogsVariantIds = new Set();

  for (const lineItem of lineItems) {
    const quantity = Number(lineItem.quantity ?? 0);
    const revenue = lineRevenue(lineItem);
    const unitSalePrice = quantity > 0 ? revenue / quantity : money(lineItem.unitPrice);
    const productId = lineItem.productId ?? `unknown-product:${lineItem.title ?? lineItem.sku ?? lineItem.id}`;
    const variantId = lineItem.variantId ?? `unknown-variant:${lineItem.sku ?? lineItem.id}`;
    const productTitle = lineItem.product?.title ?? lineItem.title ?? "Unknown product";
    const variantTitle = lineItem.variant?.title ?? lineItem.title ?? "Unknown variant";
    const sku = lineItem.sku ?? lineItem.variant?.sku ?? null;
    const cogs = lineItem.variantId ? cogsByVariantId.get(lineItem.variantId) : null;
    const cogsAmount = cogs ? money(cogs.costAmount) : null;
    const grossProfit =
      cogsAmount !== null ? roundMoney((unitSalePrice - cogsAmount) * quantity) : null;

    grossRevenue += revenue;
    soldUnits += quantity;

    if (cogsAmount !== null) {
      soldUnitsWithCogs += quantity;
      estimatedGrossProfit += grossProfit ?? 0;
    } else if (lineItem.variantId) {
      missingCogsVariantIds.add(lineItem.variantId);
    }

    const product = ensureAggregate(productMap, productId, {
      id: productId,
      title: productTitle,
      revenue: 0,
      units: 0,
      grossProfit: 0,
      soldUnitsWithCogs: 0,
      missingCogsUnits: 0,
      marginPercent: null,
      currency,
    });
    product.revenue = roundMoney(product.revenue + revenue);
    product.units += quantity;

    const variant = ensureAggregate(variantMap, variantId, {
      id: variantId,
      productId,
      title: variantTitle,
      productTitle,
      sku,
      revenue: 0,
      units: 0,
      unitSalePrice: roundMoney(unitSalePrice),
      unitCogs: cogsAmount === null ? null : roundMoney(cogsAmount),
      grossProfit: 0,
      grossProfitPerUnit:
        cogsAmount === null ? null : roundMoney(unitSalePrice - cogsAmount),
      marginPercent: null,
      hasCogs: cogsAmount !== null,
      currency,
    });
    variant.revenue = roundMoney(variant.revenue + revenue);
    variant.units += quantity;

    if (grossProfit !== null) {
      product.grossProfit = roundMoney(product.grossProfit + grossProfit);
      product.soldUnitsWithCogs += quantity;
      variant.grossProfit = roundMoney(variant.grossProfit + grossProfit);
    } else {
      product.missingCogsUnits += quantity;
    }
  }

  const products = Array.from(productMap.values()).map((product) => ({
    ...product,
    estimatedGrossProfit:
      product.soldUnitsWithCogs > 0 ? roundMoney(product.grossProfit) : null,
    marginPercent:
      product.soldUnitsWithCogs > 0 && product.revenue > 0
        ? roundPercent((product.grossProfit / product.revenue) * 100)
        : null,
  }));
  const variants = Array.from(variantMap.values()).map((variant) => ({
    ...variant,
    grossProfit: variant.hasCogs ? roundMoney(variant.grossProfit) : null,
    marginPercent:
      variant.hasCogs && variant.revenue > 0
        ? roundPercent((variant.grossProfit / variant.revenue) * 100)
        : null,
  }));
  const estimatedMarginPercent =
    grossRevenue > 0 && soldUnitsWithCogs > 0
      ? roundPercent((estimatedGrossProfit / grossRevenue) * 100)
      : null;
  const cogsCoveragePercent =
    soldUnits > 0 ? roundPercent((soldUnitsWithCogs / soldUnits) * 100) : 0;

  return {
    grossRevenue: roundMoney(grossRevenue),
    estimatedGrossProfit:
      soldUnitsWithCogs > 0 ? roundMoney(estimatedGrossProfit) : null,
    estimatedMarginPercent,
    soldUnits,
    soldUnitsWithCogs,
    cogsCoveragePercent,
    missingCogsVariantCount: missingCogsVariantIds.size,
    products,
    variants,
  };
}

/**
 * @param {{ currency: string; variants: any[]; topRevenueProducts: any[]; topGrossProfitProducts: any[]; lowMarginProducts: any[]; missingCogsProducts: any[]; refundRate: number; refundedAmount: number; confidenceLevel: ConfidenceLevel; cogsCoveragePercent: number }} input
 */
function buildHighlights(input) {
  const highlights = [];
  const topRevenueProduct = input.topRevenueProducts[0];
  const topGrossProfitProduct = input.topGrossProfitProducts[0];
  const lowMarginProduct = input.lowMarginProducts[0];
  const missingCogsProduct = input.missingCogsProducts[0];

  if (topRevenueProduct) {
    const variant = topVariantForProduct(input.variants, topRevenueProduct.id, "revenue");

    highlights.push({
      type: "top_revenue_product",
      title: "Top revenue product",
      message: `${topRevenueProduct.title} drove ${formatMoney(
        topRevenueProduct.revenue,
        input.currency,
      )} of revenue.`,
      evidence: productHighlightEvidence(topRevenueProduct, variant),
      confidence: productCogsConfidence(topRevenueProduct),
    });
  }

  if (topGrossProfitProduct) {
    const variant = topVariantForProduct(
      input.variants,
      topGrossProfitProduct.id,
      "grossProfit",
    );

    highlights.push({
      type: "top_gross_profit_product",
      title: "Top gross-profit product",
      message: `${topGrossProfitProduct.title} contributed an estimated ${formatMoney(
        topGrossProfitProduct.grossProfit,
        input.currency,
      )} of gross profit where COGS exists.`,
      evidence: productHighlightEvidence(topGrossProfitProduct, variant),
      confidence: productCogsConfidence(topGrossProfitProduct),
    });
  }

  if (lowMarginProduct) {
    const variant = topVariantForProduct(input.variants, lowMarginProduct.id, "revenue");

    highlights.push({
      type: "low_margin",
      title: "Low-margin concern",
      message: `${lowMarginProduct.title} has an estimated gross margin of ${lowMarginProduct.marginPercent}%. Check price, discounting and COGS before scaling it.`,
      evidence: productHighlightEvidence(lowMarginProduct, variant),
      confidence: productCogsConfidence(lowMarginProduct),
    });
  }

  if (missingCogsProduct) {
    const variant = topMissingCogsVariantForProduct(
      input.variants,
      missingCogsProduct.id,
    );

    highlights.push({
      type: "missing_cogs",
      title: "Missing COGS",
      message: `${missingCogsProduct.title} sold ${missingCogsProduct.missingCogsUnits} units without COGS, so its margin is not trusted yet.`,
      evidence: productHighlightEvidence(missingCogsProduct, variant),
      confidence: "low",
    });
  }

  if (input.refundRate >= 10) {
    highlights.push({
      type: "refund_warning",
      title: "Refund rate needs review",
      message: `Refunds were ${input.refundRate}% of gross revenue (${formatMoney(
        input.refundedAmount,
        input.currency,
      )}). Product-level refund attribution is incomplete in v0.`,
      evidence: {
        refundRatePercent: input.refundRate,
        refundedAmount: input.refundedAmount,
      },
      confidence: "medium",
    });
  }

  if (input.cogsCoveragePercent < 90) {
    highlights.push({
      type: "missing_cogs",
      title: "Margin confidence is limited",
      message: `${input.cogsCoveragePercent}% of sold units have COGS. Fill the missing sellers before trusting margin rankings.`,
      evidence: { cogsCoveragePercent: input.cogsCoveragePercent },
      confidence: "high",
    });
  }

  return highlights.slice(0, 6);
}

/**
 * @param {{ currency: string; grossRevenue: number; confidenceLevel: ConfidenceLevel; cogsCoveragePercent: number; soldUnits: number; soldUnitsWithCogs: number; lineItemCount: number }} input
 */
function buildHeadline(input) {
  if (input.lineItemCount === 0) {
    return "Not enough order data yet. Once orders sync, Jefe will show revenue, margin confidence and product-level highlights.";
  }

  if (input.soldUnitsWithCogs === 0) {
    return `Revenue was ${formatMoney(
      input.grossRevenue,
      input.currency,
    )}, but margin confidence is low because product costs are missing.`;
  }

  if (input.confidenceLevel === "high") {
    return `Revenue was ${formatMoney(
      input.grossRevenue,
      input.currency,
    )}, with high margin confidence because ${input.cogsCoveragePercent}% of sold units have COGS.`;
  }

  const missingCoverage = roundPercent(100 - input.cogsCoveragePercent);

  return `Revenue was ${formatMoney(
    input.grossRevenue,
    input.currency,
  )}, but margin confidence is ${input.confidenceLevel} because ${missingCoverage}% of sold units are missing COGS.`;
}

/**
 * @param {{ currency: string; grossRevenue: number; netRevenue: number; estimatedGrossProfit: number | null; estimatedMarginPercent: number | null; confidenceLevel: ConfidenceLevel; cogsCoveragePercent: number; topRevenueProduct?: any; topGrossProfitProduct?: any; lowMarginProduct?: any; missingCogsProduct?: any; missingCogsVariantCount: number; refundRate: number; lineItemCount: number }} input
 */
function buildSections(input) {
  if (input.lineItemCount === 0) {
    return {
      whatHappened:
        "No Shopify sales were recorded in this period, so Daily Verdict has no product winners or margin concerns to rank.",
      whatMatters:
        "The read model is ready, but order sync needs real sales before Jefe can make an accountable call.",
      confidence:
        "Margin confidence is low because there are no sold units with COGS in the period.",
      nextStep: "Wait for Shopify orders to sync, then check the first product-level highlight.",
    };
  }

  const grossProfitText =
    input.estimatedGrossProfit === null
      ? "Gross profit is not available because the sold products do not have COGS."
      : `Estimated gross profit was ${formatMoney(
          input.estimatedGrossProfit,
          input.currency,
        )} at ${input.estimatedMarginPercent}% margin.`;
  const matters = input.lowMarginProduct
    ? `${input.lowMarginProduct.title} is below the ${LOW_MARGIN_PERCENT}% low-margin threshold.`
    : input.topGrossProfitProduct
      ? `${input.topGrossProfitProduct.title} is the strongest gross-profit signal where COGS exists.`
      : "Revenue can be ranked, but margin winners cannot be trusted until COGS coverage improves.";
  const confidence =
    input.missingCogsVariantCount > 0
      ? `Margin confidence is ${input.confidenceLevel}: ${input.cogsCoveragePercent}% of sold units have COGS and ${input.missingCogsVariantCount} selling variant${input.missingCogsVariantCount === 1 ? " is" : "s are"} missing product costs.`
      : `Margin confidence is ${input.confidenceLevel}: every selling variant in this period has COGS.`;
  const nextStep = input.missingCogsProduct
    ? `Add product costs for ${input.missingCogsProduct.title} before relying on margin recommendations.`
    : input.lowMarginProduct
      ? `Review price, discounting and product cost for ${input.lowMarginProduct.title} before scaling it.`
      : input.refundRate >= 10
        ? "Review the refund warning before trusting this period's net revenue signal."
        : input.topGrossProfitProduct
          ? `Use ${input.topGrossProfitProduct.title} as the margin benchmark for the next brief.`
          : input.topRevenueProduct
            ? `Use ${input.topRevenueProduct.title} as the revenue benchmark for the next brief.`
            : "Keep monitoring this period until a stronger product-level highlight appears.";

  return {
    whatHappened: `${formatMoney(
      input.grossRevenue,
      input.currency,
    )} gross revenue, ${formatMoney(
      input.netRevenue,
      input.currency,
    )} after recorded refunds. ${grossProfitText}`,
    whatMatters: `${matters} Refunds were ${input.refundRate}% of gross revenue.`,
    confidence,
    nextStep,
  };
}

/**
 * @param {{ currency: string; grossRevenue: number; netRevenue: number; estimatedGrossProfit: number | null; estimatedMarginPercent: number | null; confidenceLevel: ConfidenceLevel; cogsCoveragePercent: number; topRevenueProduct?: any; topGrossProfitProduct?: any; missingCogsVariantCount: number; refundRate: number; lineItemCount: number }} input
 */
function buildSummary(input) {
  if (input.lineItemCount === 0) {
    return "No Shopify sales were recorded in the selected period. Daily Verdict can still run, but it needs synced orders before it can identify winners, margin leaks or refund risk.";
  }

  const marginText =
    input.estimatedGrossProfit === null
      ? "Gross profit could not be estimated because sold products are missing COGS"
      : `estimated gross profit was ${formatMoney(
          input.estimatedGrossProfit,
          input.currency,
        )} (${input.estimatedMarginPercent}% margin)`;
  const topRevenueText = input.topRevenueProduct
    ? `${input.topRevenueProduct.title} drove the most revenue`
    : "No clear revenue winner emerged";
  const topProfitText = input.topGrossProfitProduct
    ? `${input.topGrossProfitProduct.title} led estimated gross profit`
    : "no gross-profit winner can be trusted yet";
  const missingText =
    input.missingCogsVariantCount > 0
      ? `${input.missingCogsVariantCount} selling variant${
          input.missingCogsVariantCount === 1 ? " is" : "s are"
        } missing COGS`
      : "all selling variants have COGS";

  return `Revenue was ${formatMoney(
    input.grossRevenue,
    input.currency,
  )} over the period, net of recorded refunds was ${formatMoney(
    input.netRevenue,
    input.currency,
  )}, and ${marginText}. ${topRevenueText}, while ${topProfitText}. Margin confidence is ${input.confidenceLevel} because ${input.cogsCoveragePercent}% of sold units have COGS and ${missingText}. Refunds were ${input.refundRate}% of gross revenue.`;
}

/**
 * @param {number} coveragePercent
 * @returns {ConfidenceLevel}
 */
function cogsConfidenceFromCoverage(coveragePercent) {
  if (coveragePercent >= 90) return "high";
  if (coveragePercent >= 50) return "medium";
  return "low";
}

/**
 * @param {Date} periodStart
 * @param {Date} periodEnd
 */
function buildPeriodView(periodStart, periodEnd) {
  const dayMs = 24 * 60 * 60 * 1000;
  const days = Math.max(1, Math.round((periodEnd.getTime() - periodStart.getTime()) / dayMs));
  const label = days === 1 ? "Today" : `Last ${days} days`;
  const displayEnd = new Date(periodEnd.getTime() - 1);
  const range =
    dateOnly(periodStart) === dateOnly(displayEnd)
      ? formatDayMonth(periodStart)
      : `${formatDayMonth(periodStart)}-${formatDayMonth(displayEnd)}`;

  return {
    label,
    range,
    display: `${label} · ${range}`,
    startDate: dateOnly(periodStart),
    endDate: dateOnly(displayEnd),
  };
}

/**
 * @param {Date} date
 */
function formatDayMonth(date) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(date);
}

/**
 * @param {Array<any>} variants
 * @param {string} productId
 * @param {string} key
 */
function topVariantForProduct(variants, productId, key) {
  return topValues(
    variants.filter((variant) => variant.productId === productId && money(variant[key]) > 0),
    key,
    1,
  )[0] ?? null;
}

/**
 * @param {Array<any>} variants
 * @param {string} productId
 */
function topMissingCogsVariantForProduct(variants, productId) {
  return topValues(
    variants.filter((variant) => variant.productId === productId && !variant.hasCogs),
    "revenue",
    1,
  )[0] ?? null;
}

/**
 * @param {any} product
 * @param {any | null} variant
 */
function productHighlightEvidence(product, variant) {
  return {
    productName: product.title,
    variantName: variant?.title ?? null,
    sku: variant?.sku ?? null,
    unitsSold: product.units,
    revenue: product.revenue,
    unitCogs: variant?.unitCogs ?? null,
    grossProfit: product.estimatedGrossProfit ?? null,
    marginPercent: product.marginPercent ?? null,
    confidence: productCogsConfidence(product),
  };
}

/**
 * @param {any} product
 * @returns {ConfidenceLevel}
 */
function productCogsConfidence(product) {
  if (product.units > 0 && product.soldUnitsWithCogs >= product.units) return "high";
  if (product.soldUnitsWithCogs > 0) return "medium";
  return "low";
}

/**
 * @param {{ ENABLE_DUMMY_STORE_LOADER?: string }} env
 */
export function shouldShowDailyVerdictDevTools(env = process.env) {
  return env.ENABLE_DUMMY_STORE_LOADER === "true";
}

/**
 * @param {any} lineItem
 */
function lineRevenue(lineItem) {
  const total = money(lineItem.totalPrice);
  if (total > 0) return total;

  return roundMoney(money(lineItem.unitPrice) * Number(lineItem.quantity ?? 0));
}

/**
 * @param {unknown} value
 */
function money(value) {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @param {number} value
 */
function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * @param {number} value
 */
function roundPercent(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * @param {number} value
 * @param {string} currency
 */
function formatMoney(value, currency) {
  const symbol = currency === "GBP" ? "£" : `${currency} `;

  return `${symbol}${roundMoney(value).toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * @param {Array<any>} lineItems
 */
function firstCurrency(lineItems) {
  return (
    lineItems.find((lineItem) => lineItem.order?.currency)?.order?.currency ??
    lineItems.find((lineItem) => lineItem.variant?.currency)?.variant?.currency ??
    null
  );
}

/**
 * @param {Date} date
 */
function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * @template T
 * @param {Array<T>} values
 * @returns {Array<T>}
 */
function unique(values) {
  return [...new Set(values)];
}

/**
 * @param {Array<any>} items
 * @param {string} key
 * @param {number} limit
 */
function topValues(items, key, limit) {
  return [...items].sort((a, b) => money(b[key]) - money(a[key])).slice(0, limit);
}

/**
 * @param {Map<any, any>} map
 * @param {string} key
 * @param {Record<string, any>} initialValue
 */
function ensureAggregate(map, key, initialValue) {
  if (!map.has(key)) {
    map.set(key, initialValue);
  }

  return map.get(key);
}

/**
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

/**
 * @param {unknown} value
 * @returns {any}
 */
function toJson(value) {
  return JSON.parse(JSON.stringify(value));
}
