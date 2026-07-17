// @ts-check

import { buildDailyVerdictPayload } from "./daily-verdict.server.js";
import { buildInventoryGuardianPayload } from "./inventory-guardian.server.js";
import {
  getCogsCoverage,
  getPrioritizedMissingCosts,
  projectedCoverageAfterRows,
} from "./cogs.server.js";
import { buildWinbackProposal } from "./klaviyo-winback.server.js";
import { buildWatchdogPayload } from "./watchdog.server.js";

export const DAILY_BRIEF_CHANNEL = "daily_brief";
const DEFAULT_PERIOD_DAYS = 7;

/**
 * @typedef {"low" | "medium" | "high"} BriefConfidence
 * @typedef {"generated" | "degraded" | "failed"} BriefStatus
 * @typedef {"daily_verdict" | "inventory_guardian" | "watchdog" | "suggested_focus"} BriefSectionType
 * @typedef {"high" | "medium" | "low" | "estimated" | "limited"} BriefConfidenceLabel
 * @typedef {object} DailyBriefViewInput
 * @property {string} merchantId
 * @property {string} shopId
 * @property {string} merchantName
 * @property {string} shopDomain
 * @property {Date} generatedAt
 * @property {Date} periodStart
 * @property {Date} periodEnd
 * @property {string} currency
 * @property {any | null} dailyVerdict
 * @property {any | null} inventoryGuardian
 * @property {any | null} watchdog
 * @property {any | null} cogsCoverage
 * @property {any[]} missingCosts
 * @property {any | null} winbackProposal
 * @property {boolean} productCostsSkipped
 * @property {Record<string, string>} [sourceErrors]
 * @typedef {object} DailyBriefHeadlineInput
 * @property {any | null} dailyVerdict
 * @property {any | null} inventoryGuardian
 * @property {any | null} watchdog
 * @property {any | null} cogsCoverage
 * @property {any | null} recommendedFocus
 * @property {any | null} winbackProposal
 * @property {boolean} productCostsSkipped
 * @property {string} currency
 */

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; now?: Date; periodStart?: Date; periodEnd?: Date; env?: Record<string, string | undefined>; force?: boolean }} input
 */
export async function generateDailyBrief(prisma, input) {
  const generatedAt = input.now ?? new Date();
  const periodEnd = input.periodEnd ?? generatedAt;
  const periodStart =
    input.periodStart ??
    new Date(periodEnd.getTime() - DEFAULT_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  const briefDate = dateOnly(periodEnd);
  const idempotencyKey = `daily-brief:${input.shopId}:${briefDate}`;

  const [merchant, shop] = await Promise.all([
    prisma.merchant.findUnique({
      where: { id: input.merchantId },
      select: { id: true, name: true, primaryCurrency: true },
    }),
    prisma.shop.findUnique({
      where: { id: input.shopId },
      select: { id: true, shopDomain: true, productCostsSkipped: true },
    }),
  ]);

  const sourceResults = await resolveSources(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    generatedAt,
    periodStart,
    periodEnd,
  });
  const brief = buildDailyBriefView({
    merchantId: input.merchantId,
    shopId: input.shopId,
    merchantName: merchant?.name ?? "Merchant",
    shopDomain: shop?.shopDomain ?? "Unknown shop",
    generatedAt,
    periodStart,
    periodEnd,
    currency: merchant?.primaryCurrency ?? "GBP",
    dailyVerdict: sourceResults.dailyVerdict.value,
    inventoryGuardian: sourceResults.inventoryGuardian.value,
    watchdog: sourceResults.watchdog.value,
    cogsCoverage: sourceResults.cogsCoverage.value,
    missingCosts: sourceResults.missingCosts.value ?? [],
    winbackProposal: sourceResults.winbackProposal.value,
    productCostsSkipped: shop?.productCostsSkipped ?? false,
    sourceErrors: sourceErrors(sourceResults),
  });
  const deliveryStatus = await deliverDailyBrief(
    brief,
    input.env ?? process.env,
  );
  const status = deliveryStatus.inApp === "failed" ? "failed" : brief.status;

  return prisma.dailyBrief.upsert({
    where: {
      merchantId_shopId_briefDate_channel: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        briefDate: new Date(`${briefDate}T00:00:00.000Z`),
        channel: DAILY_BRIEF_CHANNEL,
      },
    },
    create: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      briefDate: new Date(`${briefDate}T00:00:00.000Z`),
      periodStart,
      periodEnd,
      generatedAt,
      status,
      channel: DAILY_BRIEF_CHANNEL,
      confidenceLevel: brief.confidenceLevel,
      headline: brief.headline,
      sections: toJson(brief.sections),
      verdict: toJson(brief),
      metrics: toJson(brief.metrics),
      evidence: toJson(brief.evidence),
      deliveryStatus: toJson(deliveryStatus),
      failureReason: brief.failureReason,
      dataIncomplete: brief.dataIncomplete,
      degradedReasons: toJson(brief.degradedReasons),
      idempotencyKey,
      sentAt: deliveryStatus.email === "sent" ? generatedAt : null,
    },
    update: {
      periodStart,
      periodEnd,
      generatedAt,
      status,
      confidenceLevel: brief.confidenceLevel,
      headline: brief.headline,
      sections: toJson(brief.sections),
      verdict: toJson(brief),
      metrics: toJson(brief.metrics),
      evidence: toJson(brief.evidence),
      deliveryStatus: toJson(deliveryStatus),
      failureReason: brief.failureReason,
      dataIncomplete: brief.dataIncomplete,
      degradedReasons: toJson(brief.degradedReasons),
      idempotencyKey,
      sentAt: deliveryStatus.email === "sent" ? generatedAt : undefined,
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; }} input
 */
export async function getLatestDailyBrief(prisma, input) {
  return prisma.dailyBrief.findFirst({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      channel: DAILY_BRIEF_CHANNEL,
    },
    orderBy: [{ generatedAt: "desc" }, { updatedAt: "desc" }],
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; generatedAt: Date; periodStart: Date; periodEnd: Date; }} input
 */
async function resolveSources(prisma, input) {
  const sourceInputs = {
    merchantId: input.merchantId,
    shopId: input.shopId,
    now: input.generatedAt,
  };

  const [
    dailyVerdict,
    inventoryGuardian,
    watchdog,
    cogsCoverage,
    missingCosts,
    winbackProposal,
  ] = await Promise.all([
    safely(() =>
      buildDailyVerdictPayload(prisma, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
      }),
    ),
    safely(() => buildInventoryGuardianPayload(prisma, sourceInputs)),
    safely(() => buildWatchdogPayload(prisma, sourceInputs)),
    safely(() => getCogsCoverage(prisma, input.shopId)),
    safely(() =>
      getPrioritizedMissingCosts(prisma, {
        shopId: input.shopId,
        limit: 10,
      }),
    ),
    safely(() => buildWinbackProposal(prisma, sourceInputs)),
  ]);

  return {
    dailyVerdict,
    inventoryGuardian,
    watchdog,
    cogsCoverage,
    missingCosts,
    winbackProposal,
  };
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<{ ok: true; value: T; error: null } | { ok: false; value: null; error: string }>}
 */
async function safely(fn) {
  try {
    return { ok: true, value: await fn(), error: null };
  } catch (error) {
    return {
      ok: false,
      value: null,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * @param {Record<string, { ok: boolean; error: string | null }>} results
 */
function sourceErrors(results) {
  const optionalSources = new Set(["missingCosts", "winbackProposal"]);
  return Object.fromEntries(
    Object.entries(results)
      .filter(([source]) => !optionalSources.has(source))
      .filter(([, result]) => !result.ok)
      .map(([source, result]) => [source, result.error ?? "Failed"]),
  );
}

/** @param {DailyBriefViewInput} input */
export function buildDailyBriefView(input) {
  const cogsCoverage = normalizeCogsCoverage(input);
  const recommendedFocus = selectRecommendedFocus({
    dailyVerdict: input.dailyVerdict,
    inventoryGuardian: input.inventoryGuardian,
    watchdog: input.watchdog,
    cogsCoverage,
    missingCosts: input.missingCosts ?? [],
    winbackProposal: input.winbackProposal,
    productCostsSkipped: input.productCostsSkipped,
    currency: input.currency,
  });
  const degradedReasons = [
    ...sourceDegradedReasons(input.sourceErrors ?? {}),
    ...dailyVerdictDegradedReasons(input.dailyVerdict),
    ...inventoryDegradedReasons(input.inventoryGuardian),
    ...watchdogDegradedReasons(input.watchdog),
  ];
  const allSourcesFailed =
    !input.dailyVerdict && !input.inventoryGuardian && !input.watchdog;
  const status = /** @type {BriefStatus} */ (
    allSourcesFailed
      ? "failed"
      : degradedReasons.length > 0
        ? "degraded"
        : "generated"
  );
  const confidenceLevel = allSourcesFailed
    ? "low"
    : combinedConfidence(
        input.dailyVerdict,
        input.inventoryGuardian,
        input.watchdog,
        degradedReasons,
      );
  const sections = buildSections(input);
  const headline =
    status === "failed"
      ? "Daily Brief could not be generated. Check the source data jobs before relying on today's readout."
      : buildHeadline({
          dailyVerdict: input.dailyVerdict,
          inventoryGuardian: input.inventoryGuardian,
          watchdog: input.watchdog,
          cogsCoverage,
          recommendedFocus,
          winbackProposal: input.winbackProposal,
          productCostsSkipped: input.productCostsSkipped,
          currency: input.currency,
        });
  const verdict = buildVerdictCopy({
    dailyVerdict: input.dailyVerdict,
    inventoryGuardian: input.inventoryGuardian,
    watchdog: input.watchdog,
    cogsCoverage,
    recommendedFocus,
    productCostsSkipped: input.productCostsSkipped,
    currency: input.currency,
  });
  const todayNumbers = buildTodayNumbers({
    dailyVerdict: input.dailyVerdict,
    inventoryGuardian: input.inventoryGuardian,
    watchdog: input.watchdog,
    cogsCoverage,
    recommendedFocus,
    productCostsSkipped: input.productCostsSkipped,
    currency: input.currency,
  });
  const whatChanged = buildWhatChanged({
    dailyVerdict: input.dailyVerdict,
    inventoryGuardian: input.inventoryGuardian,
    watchdog: input.watchdog,
    cogsCoverage,
    winbackProposal: input.winbackProposal,
    productCostsSkipped: input.productCostsSkipped,
    currency: input.currency,
  });
  const evidenceItems = buildEvidenceItems({
    dailyVerdict: input.dailyVerdict,
    inventoryGuardian: input.inventoryGuardian,
    watchdog: input.watchdog,
    cogsCoverage,
    recommendedFocus,
    winbackProposal: input.winbackProposal,
    currency: input.currency,
  });
  const recommendationEvidence = buildRecommendationEvidence({
    dailyVerdict: input.dailyVerdict,
    inventoryGuardian: input.inventoryGuardian,
    watchdog: input.watchdog,
    cogsCoverage,
    recommendedFocus,
    missingCosts: input.missingCosts ?? [],
    winbackProposal: input.winbackProposal,
    currency: input.currency,
  });
  const moduleSummaries = buildModuleSummaries({
    dailyVerdict: input.dailyVerdict,
    inventoryGuardian: input.inventoryGuardian,
    watchdog: input.watchdog,
    cogsCoverage,
    winbackProposal: input.winbackProposal,
  });
  const optionalWarnings = buildOptionalWarnings({
    cogsCoverage,
    productCostsSkipped: input.productCostsSkipped,
    winbackProposal: input.winbackProposal,
  });

  return {
    merchantId: input.merchantId,
    shopId: input.shopId,
    merchantName: input.merchantName,
    shopDomain: input.shopDomain,
    generatedAt: input.generatedAt.toISOString(),
    periodStart: input.periodStart.toISOString(),
    periodEnd: input.periodEnd.toISOString(),
    period: {
      label: `Last ${DEFAULT_PERIOD_DAYS} days`,
      display: `${formatDayMonth(input.periodStart)}-${formatDayMonth(
        new Date(input.periodEnd.getTime() - 1),
      )}`,
    },
    status,
    confidenceLevel,
    dataIncomplete: degradedReasons.length > 0,
    degradedReasons,
    failureReason: allSourcesFailed
      ? "Revenue & Margin, Inventory Guardian and Watchdog all failed."
      : null,
    headline,
    verdict,
    todayNumbers,
    whatChanged,
    recommendedFocus,
    evidenceItems,
    recommendationEvidence,
    moduleSummaries,
    optionalWarnings,
    sections,
    metrics: {
      revenue: input.dailyVerdict?.revenue ?? {
        gross: 0,
        net: 0,
        refunded: 0,
        currency: input.currency,
      },
      margin: {
        ...(input.dailyVerdict?.margin ?? {}),
        cogsCoverage,
        confidenceLabel: marginConfidenceDisplay(
          cogsCoverage,
          input.productCostsSkipped,
        ),
      },
      inventory: input.inventoryGuardian?.metrics ?? null,
      watchdog: input.watchdog?.metrics ?? null,
      winback: input.winbackProposal?.audience ?? null,
    },
    evidence: {
      sourceErrors: input.sourceErrors ?? {},
      dailyVerdict: input.dailyVerdict,
      inventoryGuardian: input.inventoryGuardian,
      watchdog: input.watchdog,
      cogsCoverage,
      missingCosts: input.missingCosts ?? [],
      winbackProposal: input.winbackProposal,
      verification: {
        dailyVerdict: "observed store data with margin confidence labels",
        inventoryGuardian: "estimated prevention",
        watchdog: "estimated prevention",
        verifiedLift: "not_available_in_daily_brief_v0",
      },
    },
  };
}

/** @param {DailyBriefHeadlineInput} input */
function buildHeadline(input) {
  const revenue = input.dailyVerdict?.revenue?.gross ?? 0;
  const currency = input.dailyVerdict?.revenue?.currency ?? input.currency;
  const stockoutCount = input.inventoryGuardian?.hero?.atRiskVariantCount ?? 0;
  const alertCount = input.watchdog?.hero?.alertCount ?? 0;
  const focus = input.recommendedFocus;

  if (revenue === 0 && stockoutCount === 0 && alertCount === 0) {
    return "Not enough order data yet. Jefe checked available inventory and Watchdog signals, but there is not enough synced sales history for a full brief.";
  }

  if (focus?.type === "watchdog_critical") {
    return `${focus.title} is the highest-priority issue Jefe found today.`;
  }

  if (focus?.type === "stockout_risk") {
    return `Your highest-value issue is a stockout risk on ${focus.subject}, with ${focus.estimatedValue} revenue at risk.`;
  }

  if (focus?.type === "cogs_coverage") {
    const missing = input.cogsCoverage?.missingRevenueCoveragePercent ?? 0;
    if (input.productCostsSkipped) {
      return "Margin insights are limited because product costs were skipped during setup.";
    }
    return `Revenue was ${formatBriefMoney(revenue, currency)}, but margin confidence is ${focus.confidence} because product costs are missing for ${formatCoveragePercent(missing)} of sold revenue.`;
  }

  if (focus?.type === "winback") {
    const count = input.winbackProposal?.audience?.eligibleCount ?? 0;
    return `Jefe found ${count} dormant customer${count === 1 ? "" : "s"} worth preparing a winback draft for.`;
  }

  return `No urgent issues found. Revenue was ${formatBriefMoney(
    revenue,
    currency,
  )} and Jefe recommends reviewing the brief evidence before taking action.`;
}

/**
 * @param {{
 *   dailyVerdict: any | null;
 *   inventoryGuardian: any | null;
 *   watchdog: any | null;
 *   cogsCoverage: any | null;
 *   recommendedFocus: any;
 *   productCostsSkipped: boolean;
 *   currency: string;
 * }} input
 */
function buildVerdictCopy(input) {
  const revenue = input.dailyVerdict?.revenue;
  const currency = revenue?.currency ?? input.currency;
  const coverage = input.cogsCoverage?.usableRevenueCoveragePercent ?? 0;
  const missing = input.cogsCoverage?.missingRevenueCoveragePercent ?? 0;
  const confidence = marginConfidenceDisplay(
    input.cogsCoverage,
    input.productCostsSkipped,
  );

  if (input.recommendedFocus?.type === "cogs_coverage") {
    if (input.productCostsSkipped) {
      return {
        title: "Margin insight is limited.",
        body: "Product costs were skipped during setup, so Jefe cannot calculate reliable gross profit yet.",
      };
    }

    return {
      title: `Margin confidence is ${confidence}.`,
      body: `Revenue was ${formatBriefMoney(revenue?.gross ?? 0, currency)}, but product costs are missing for ${formatCoveragePercent(missing)} of sold revenue, so Jefe cannot calculate reliable gross profit yet.`,
    };
  }

  if (input.recommendedFocus?.type === "stockout_risk") {
    return {
      title: "A stockout risk is the highest-value issue.",
      body: `${input.recommendedFocus.subject} is at risk, with ${input.recommendedFocus.estimatedValue} revenue at stake based on recent sales velocity.`,
    };
  }

  if (input.recommendedFocus?.type === "watchdog_critical") {
    return {
      title: "A critical Watchdog issue needs attention.",
      body: input.recommendedFocus.reason,
    };
  }

  if (input.recommendedFocus?.type === "winback") {
    return {
      title: "A winback draft is ready to prepare.",
      body: input.recommendedFocus.reason,
    };
  }

  return {
    title: "No urgent issue outranked the brief.",
    body: `Revenue was ${formatBriefMoney(revenue?.gross ?? 0, currency)} and product costs cover ${formatCoveragePercent(coverage)} of sold revenue.`,
  };
}

/**
 * @param {{
 *   dailyVerdict: any | null;
 *   inventoryGuardian: any | null;
 *   watchdog: any | null;
 *   cogsCoverage: any | null;
 *   missingCosts: any[];
 *   winbackProposal: any | null;
 *   productCostsSkipped: boolean;
 *   currency: string;
 * }} input
 */
function selectRecommendedFocus(input) {
  const currency = input.dailyVerdict?.revenue?.currency ?? input.currency;
  const criticalAlert = /** @type {any[]} */ (
    input.watchdog?.alerts ?? []
  ).find((alert) => alert.severity === "critical");
  if (criticalAlert) {
    return {
      type: "watchdog_critical",
      title: criticalAlert.title ?? "Critical Watchdog issue",
      subject: criticalAlert.title ?? "Watchdog issue",
      reason: criticalAlert.suggestedCheck ?? criticalAlert.summary,
      estimatedValue: moneyOrUnavailable(
        criticalAlert.estimatedValueAtRisk,
        input.watchdog?.metrics?.currency ?? currency,
        true,
      ),
      valueLabel: "Value at risk",
      confidence: criticalAlert.confidence ?? "medium",
      riskLabel: "High",
      effortLabel: "~10 minutes",
      href: "/app/watchdog",
      buttonLabel: "Open Watchdog alert",
      verificationClass: "estimated",
    };
  }

  const stockoutRisk = highestValueStockout(input.inventoryGuardian);
  const stockoutValue = Number(
    stockoutRisk?.revenueAtRisk ??
      input.inventoryGuardian?.metrics?.revenueAtRisk ??
      0,
  );
  const missingSoldRevenue = Number(
    input.cogsCoverage?.soldRevenueMissingCost ?? 0,
  );
  if (
    stockoutRisk &&
    stockoutValue > 0 &&
    (!lowCogsCoverage(input.cogsCoverage, input.productCostsSkipped) ||
      stockoutValue >= missingSoldRevenue)
  ) {
    return {
      type: "stockout_risk",
      title: `Review stockout risk for ${stockoutRisk.title}`,
      subject: stockoutRisk.title,
      reason: `${stockoutRisk.title} / ${stockoutRisk.variantTitle} may stock out ${formatDaysUntilStockout(stockoutRisk.daysUntilStockout)}.`,
      estimatedValue: formatBriefMoney(
        stockoutValue,
        stockoutRisk.currency ??
          input.inventoryGuardian?.metrics?.currency ??
          currency,
      ),
      valueLabel: "Revenue at risk",
      confidence: stockoutRisk.confidence ?? "medium",
      riskLabel: "Medium",
      effortLabel: "~5 minutes",
      href: "/app/inventory-guardian",
      buttonLabel: "Review stockout risk",
      verificationClass: "estimated",
    };
  }

  if (lowCogsCoverage(input.cogsCoverage, input.productCostsSkipped)) {
    const topRows = input.missingCosts.slice(0, 6);
    const projectedCoverage =
      input.cogsCoverage && topRows.length > 0
        ? projectedCoverageAfterRows(input.cogsCoverage, topRows)
        : (input.cogsCoverage?.usableRevenueCoveragePercent ?? 0);
    const currentCoverage =
      input.cogsCoverage?.usableRevenueCoveragePercent ?? 0;
    const count = Math.max(
      topRows.length,
      input.cogsCoverage?.variantsMissingCost ?? 0,
    );
    return {
      type: "cogs_coverage",
      title:
        count > 0
          ? `Confirm product costs for ${Math.min(count, 6)} high-revenue product${Math.min(count, 6) === 1 ? "" : "s"}`
          : "Confirm product costs",
      subject: "product costs",
      reason: input.productCostsSkipped
        ? "Margin insights are limited because product costs were skipped during setup."
        : `This would raise margin coverage from ${formatPercentLabel(currentCoverage)} to ${formatPercentLabel(projectedCoverage)} of sold revenue.`,
      estimatedValue: moneyOrUnavailable(
        input.cogsCoverage?.soldRevenueMissingCost,
        input.cogsCoverage?.currency ?? currency,
        true,
      ),
      valueLabel: "Sold revenue affected",
      confidence: marginConfidenceDisplay(
        input.cogsCoverage,
        input.productCostsSkipped,
      ),
      riskLabel: "Low",
      effortLabel: "~5 minutes",
      currentCoverage,
      projectedCoverage,
      href: "/app/manager-settings?task=product-costs",
      buttonLabel: "Review product costs",
      verificationClass: "estimated",
    };
  }

  const refundRate = Number(
    input.dailyVerdict?.evidence?.refundRatePercent ?? 0,
  );
  const refunded = Number(input.dailyVerdict?.revenue?.refunded ?? 0);
  const lowMarginProduct =
    input.dailyVerdict?.evidence?.lowMarginProducts?.[0] ?? null;
  if (refunded > 0 && (refundRate >= 10 || refunded >= 50)) {
    return {
      type: "refund_margin_leak",
      title: "Review refund margin leak",
      subject: "refunds",
      reason: `Refunds reduced net revenue by ${formatMoney(refunded, currency)} in the selected period.`,
      estimatedValue: formatBriefMoney(refunded, currency),
      valueLabel: "Estimated margin impact",
      confidence: input.dailyVerdict?.margin?.confidenceLevel ?? "medium",
      riskLabel: "Low",
      effortLabel: "~10 minutes",
      href: "/app/revenue-margin",
      buttonLabel: "Review margin leak",
      verificationClass: "estimated",
    };
  }
  if (lowMarginProduct) {
    return {
      type: "refund_margin_leak",
      title: `Review margin leak on ${lowMarginProduct.title}`,
      subject: lowMarginProduct.title,
      reason: `${lowMarginProduct.title} is below the margin threshold in the selected period.`,
      estimatedValue: moneyOrUnavailable(
        lowMarginProduct.revenue,
        currency,
        true,
      ),
      valueLabel: "Estimated margin impact",
      confidence: input.dailyVerdict?.margin?.confidenceLevel ?? "medium",
      riskLabel: "Low",
      effortLabel: "~10 minutes",
      href: "/app/revenue-margin",
      buttonLabel: "Review margin leak",
      verificationClass: "estimated",
    };
  }

  if (
    input.winbackProposal?.status === "ready" &&
    (input.winbackProposal?.audience?.eligibleCount ?? 0) > 0
  ) {
    return {
      type: "winback",
      title: "Prepare dormant customer winback draft",
      subject: "Klaviyo winback",
      reason: `${input.winbackProposal.audience.eligibleCount} dormant customer${input.winbackProposal.audience.eligibleCount === 1 ? "" : "s"} are eligible with a planned 10% holdout.`,
      estimatedValue: formatBriefMoney(
        input.winbackProposal.economics?.expectedRevenueAfterDiscount ?? 0,
        input.winbackProposal.economics?.currency ?? currency,
      ),
      valueLabel: "Estimated upside",
      confidence: "estimated",
      riskLabel: "Medium",
      effortLabel: "~10 minutes",
      href: "/app/klaviyo-winback",
      buttonLabel: "Review winback draft",
      verificationClass: "estimated",
    };
  }

  return {
    type: "review_daily_brief",
    title: "Review Daily Brief",
    subject: "Daily Brief",
    reason: "No urgent issue outranked the morning evidence review.",
    estimatedValue: "No urgent value at risk",
    valueLabel: "Value at risk",
    confidence: "high",
    riskLabel: "Low",
    effortLabel: "~2 minutes",
    href: "/app/daily-brief",
    buttonLabel: "Review Daily Brief",
    verificationClass: "estimated",
  };
}

/**
 * @param {{
 *   dailyVerdict: any | null;
 *   inventoryGuardian: any | null;
 *   watchdog: any | null;
 *   cogsCoverage: any | null;
 *   recommendedFocus: any;
 *   productCostsSkipped: boolean;
 *   currency: string;
 * }} input
 */
function buildTodayNumbers(input) {
  const revenue = input.dailyVerdict?.revenue ?? {
    gross: 0,
    net: 0,
    refunded: 0,
    currency: input.currency,
  };
  const currency = revenue.currency ?? input.currency;
  const stockoutRisk = input.inventoryGuardian?.metrics?.revenueAtRisk ?? 0;

  return [
    {
      label: "Revenue",
      value: formatBriefMoney(revenue.gross, currency),
    },
    {
      label: "Net revenue after refunds",
      value: formatBriefMoney(revenue.net, currency),
    },
    {
      label: "Revenue at risk",
      value: formatBriefMoney(
        stockoutRisk,
        input.inventoryGuardian?.metrics?.currency ?? currency,
      ),
    },
    {
      label: "Margin coverage",
      value: formatCoveragePercent(
        input.cogsCoverage?.usableRevenueCoveragePercent ?? 0,
      ),
    },
  ];
}

/**
 * @param {{
 *   dailyVerdict: any | null;
 *   inventoryGuardian: any | null;
 *   watchdog: any | null;
 *   cogsCoverage: any | null;
 *   winbackProposal: any | null;
 *   productCostsSkipped: boolean;
 *   currency: string;
 * }} input
 */
function buildWhatChanged(input) {
  const bullets = [];
  const revenue = input.dailyVerdict?.revenue;
  const currency = revenue?.currency ?? input.currency;

  if (revenue) {
    bullets.push(
      `Revenue was ${formatBriefMoney(revenue.gross, currency)} this period.`,
    );
  }
  if ((revenue?.refunded ?? 0) > 0) {
    bullets.push(
      `Refunds reduced net revenue by ${formatBriefMoney(revenue.refunded, currency)}.`,
    );
  }
  if (input.productCostsSkipped) {
    bullets.push(
      "Product costs were skipped during setup, so margin insight is limited.",
    );
  } else if (input.cogsCoverage) {
    bullets.push(
      `Product costs cover ${formatCoveragePercent(input.cogsCoverage.usableRevenueCoveragePercent)} of sold revenue.`,
    );
  }
  const riskCount = input.inventoryGuardian?.hero?.atRiskVariantCount ?? 0;
  if (riskCount > 0) {
    bullets.push(
      `Inventory Guardian found ${riskCount} stockout risk${riskCount === 1 ? "" : "s"} worth ${formatBriefMoney(input.inventoryGuardian?.metrics?.revenueAtRisk ?? 0, input.inventoryGuardian?.metrics?.currency ?? currency)}.`,
    );
  }
  const alertCount = input.watchdog?.hero?.alertCount ?? 0;
  if (alertCount > 0) {
    bullets.push(
      `Watchdog found ${alertCount} alert${alertCount === 1 ? "" : "s"} worth checking.`,
    );
  }
  if (
    bullets.length < 4 &&
    input.winbackProposal?.status === "ready" &&
    (input.winbackProposal?.audience?.eligibleCount ?? 0) > 0
  ) {
    bullets.push(
      `${input.winbackProposal.audience.eligibleCount} dormant customer${input.winbackProposal.audience.eligibleCount === 1 ? "" : "s"} are eligible for a winback draft.`,
    );
  }

  return bullets.slice(0, 3);
}

/**
 * @param {{
 *   dailyVerdict: any | null;
 *   inventoryGuardian: any | null;
 *   watchdog: any | null;
 *   cogsCoverage: any | null;
 *   recommendedFocus: any;
 *   winbackProposal: any | null;
 *   currency: string;
 * }} input
 */
function buildEvidenceItems(input) {
  const items = [];
  const revenue = input.dailyVerdict?.revenue;
  const currency = revenue?.currency ?? input.currency;

  if (revenue) {
    items.push(
      `${formatMoney(revenue.gross, currency)} revenue in selected period`,
    );
    items.push(
      `${formatMoney(revenue.net, currency)} net revenue after refunds`,
    );
  }
  if (input.cogsCoverage) {
    items.push(
      `${input.cogsCoverage.usableRevenueCoveragePercent}% sold revenue has product costs`,
    );
  }
  const stockoutRisk = input.inventoryGuardian?.metrics?.revenueAtRisk ?? 0;
  if (stockoutRisk > 0) {
    items.push(
      `${input.inventoryGuardian.hero.atRiskVariantCount} stockout risk${input.inventoryGuardian.hero.atRiskVariantCount === 1 ? "" : "s"} worth ${formatMoney(stockoutRisk, input.inventoryGuardian.metrics.currency ?? currency)}`,
    );
  }
  const alertCount = input.watchdog?.hero?.alertCount ?? 0;
  if (alertCount > 0) {
    items.push(
      `${alertCount} Watchdog alert${alertCount === 1 ? "" : "s"} with ${formatMoney(input.watchdog.metrics.estimatedValueAtRisk ?? 0, input.watchdog.metrics.currency ?? currency)} estimated prevention`,
    );
  }
  if (input.winbackProposal?.audience?.eligibleCount > 0) {
    items.push(
      `${input.winbackProposal.audience.eligibleCount} dormant customer${input.winbackProposal.audience.eligibleCount === 1 ? "" : "s"} in winback audience`,
    );
  }

  return items.slice(0, 6);
}

/**
 * @param {{
 *   dailyVerdict: any | null;
 *   inventoryGuardian: any | null;
 *   watchdog: any | null;
 *   cogsCoverage: any | null;
 *   recommendedFocus: any;
 *   missingCosts: any[];
 *   winbackProposal: any | null;
 *   currency: string;
 * }} input
 */
function buildRecommendationEvidence(input) {
  const revenue = input.dailyVerdict?.revenue;
  const currency = revenue?.currency ?? input.currency;
  const stockoutCount = input.inventoryGuardian?.hero?.atRiskVariantCount ?? 0;
  const stockoutRisk = input.inventoryGuardian?.metrics?.revenueAtRisk ?? 0;
  const alertCount = input.watchdog?.hero?.alertCount ?? 0;
  const winbackCount = input.winbackProposal?.audience?.eligibleCount ?? 0;

  if (input.recommendedFocus?.type === "cogs_coverage") {
    return {
      title: "Product costs are the blocker today.",
      summary: `Product costs are the blocker today. Only ${formatCoveragePercent(input.cogsCoverage?.usableRevenueCoveragePercent ?? 0)} of sold revenue has product costs, so Jefe cannot calculate reliable gross profit yet. Adding costs for ${Math.min(input.missingCosts.length || input.cogsCoverage?.variantsMissingCost || 0, 6)} high-revenue products would raise margin coverage to ${formatPercentLabel(input.recommendedFocus.projectedCoverage ?? input.cogsCoverage?.usableRevenueCoveragePercent ?? 0)}. That makes Revenue & Margin useful and improves the quality of future recommendations.`,
      items: [
        `Only ${formatCoveragePercent(input.cogsCoverage?.usableRevenueCoveragePercent ?? 0)} of sold revenue has product costs.`,
        "Gross profit cannot be calculated reliably until more costs are added.",
        `Adding costs for ${Math.min(input.missingCosts.length || input.cogsCoverage?.variantsMissingCost || 0, 6)} products would raise coverage to ${formatPercentLabel(input.recommendedFocus.projectedCoverage ?? input.cogsCoverage?.usableRevenueCoveragePercent ?? 0)}.`,
        lowerPrioritySummary({
          stockoutCount,
          stockoutRisk,
          alertCount,
          winbackCount,
          currency,
        }),
      ].filter(Boolean),
      secondaryItems: [
        stockoutCount > 0
          ? `${stockoutCount} stockout risk${stockoutCount === 1 ? "" : "s"} worth ${formatBriefMoney(stockoutRisk, input.inventoryGuardian?.metrics?.currency ?? currency)}`
          : null,
        alertCount > 0
          ? `${alertCount} Watchdog alert${alertCount === 1 ? "" : "s"}`
          : null,
        winbackCount > 0
          ? `${winbackCount} dormant customer${winbackCount === 1 ? "" : "s"} in winback audience`
          : null,
      ].filter(Boolean),
    };
  }

  if (input.recommendedFocus?.type === "stockout_risk") {
    return {
      title: "Stockout prevention has the most money at stake.",
      summary: `${input.recommendedFocus.subject} is the highest-value operational issue today. Reviewing the stockout risk protects ${input.recommendedFocus.estimatedValue} of revenue at risk before the product runs out.`,
      items: [
        `${input.recommendedFocus.subject} is the highest-value inventory risk.`,
        `${input.recommendedFocus.estimatedValue} revenue is at risk based on recent sales velocity.`,
        `Margin coverage is ${formatCoveragePercent(input.cogsCoverage?.usableRevenueCoveragePercent ?? 0)}, so product-cost work is not blocking this recommendation.`,
      ],
      secondaryItems: compactSecondaryItems({ alertCount, winbackCount }),
    };
  }

  if (input.recommendedFocus?.type === "watchdog_critical") {
    return {
      title: "The critical alert outranks normal opportunities.",
      summary: `The critical Watchdog alert outranks normal opportunities today. Jefe is asking you to review the evidence before assuming the change is noise.`,
      items: [
        input.recommendedFocus.reason,
        `${input.recommendedFocus.estimatedValue} is the estimated value at risk.`,
        "No action will execute automatically; this opens the Watchdog evidence.",
      ],
      secondaryItems: compactSecondaryItems({
        stockoutCount,
        alertCount,
        winbackCount,
      }),
    };
  }

  if (input.recommendedFocus?.type === "winback") {
    return {
      title: "Winback is the best available growth action.",
      summary: `No higher-priority risk is blocking the store today. The winback audience is ready, and the draft can be reviewed with a planned holdout before anything sends.`,
      items: [
        `${winbackCount} dormant customer${winbackCount === 1 ? "" : "s"} are eligible.`,
        "The draft uses a planned 10% randomised holdout.",
        `${input.recommendedFocus.estimatedValue} is estimated upside, not verified lift.`,
      ],
      secondaryItems: compactSecondaryItems({ stockoutCount, alertCount }),
    };
  }

  return {
    title: "The brief is the recommendation today.",
    summary:
      "No higher-priority action passed the recommendation threshold today. Review the brief, then keep monitoring until Jefe has stronger evidence.",
    items: [
      `Revenue was ${formatBriefMoney(revenue?.gross ?? 0, currency)}.`,
      `Product costs cover ${formatCoveragePercent(input.cogsCoverage?.usableRevenueCoveragePercent ?? 0)} of sold revenue.`,
      "No higher-priority action passed the recommendation threshold.",
    ],
    secondaryItems: compactSecondaryItems({
      stockoutCount,
      alertCount,
      winbackCount,
    }),
  };
}

/**
 * @param {{
 *   dailyVerdict: any | null;
 *   inventoryGuardian: any | null;
 *   watchdog: any | null;
 *   cogsCoverage: any | null;
 *   winbackProposal: any | null;
 * }} input
 */
function buildModuleSummaries(input) {
  const inventoryRisk = input.inventoryGuardian?.metrics?.revenueAtRisk ?? 0;
  const inventoryCurrency =
    input.inventoryGuardian?.metrics?.currency ??
    input.dailyVerdict?.revenue?.currency ??
    "GBP";
  const watchdogAlerts = input.watchdog?.hero?.alertCount ?? 0;

  return [
    {
      key: "revenue_margin",
      title: "Revenue & Margin",
      status: marginConfidenceLabel(input.cogsCoverage, false),
      detail: input.dailyVerdict
        ? `${formatCoveragePercent(input.cogsCoverage?.usableRevenueCoveragePercent ?? input.dailyVerdict.margin?.cogsCoveragePercent ?? 0)} margin coverage`
        : "Unavailable",
      href: "/app/revenue-margin",
      confidence: input.dailyVerdict?.margin?.confidenceLevel ?? "low",
    },
    {
      key: "inventory_guardian",
      title: "Inventory Guardian",
      status: `${input.inventoryGuardian?.hero?.atRiskVariantCount ?? 0} risk${(input.inventoryGuardian?.hero?.atRiskVariantCount ?? 0) === 1 ? "" : "s"}`,
      detail:
        input.inventoryGuardian?.emptyState === "no_inventory"
          ? "Inventory unavailable"
          : `${formatBriefMoney(inventoryRisk, inventoryCurrency)} revenue at risk`,
      href: "/app/inventory-guardian",
      confidence: input.inventoryGuardian?.hero?.confidence ?? "low",
    },
    {
      key: "watchdog",
      title: "Watchdog",
      status: `${watchdogAlerts} alert${watchdogAlerts === 1 ? "" : "s"}`,
      detail: watchdogAlerts > 0 ? "Review unusual changes" : "No urgent alert",
      href: "/app/watchdog",
      confidence: input.watchdog?.alerts?.[0]?.confidence ?? "high",
    },
    {
      key: "klaviyo_winback",
      title: "Klaviyo Winback",
      status:
        input.winbackProposal?.status === "ready"
          ? `${input.winbackProposal.audience.eligibleCount} eligible customer${input.winbackProposal.audience.eligibleCount === 1 ? "" : "s"}`
          : "Unavailable",
      detail:
        input.winbackProposal?.status === "ready"
          ? "Draft can be prepared with holdout"
          : (input.winbackProposal?.blockedReasons?.[0] ??
            "Needs eligible audience"),
      href: "/app/klaviyo-winback",
      confidence: "estimated",
    },
  ];
}

/** @param {{ stockoutCount?: number; stockoutRisk?: number; alertCount?: number; winbackCount?: number; currency?: string }} input */
function lowerPrioritySummary(input) {
  const parts = [];
  if ((input.stockoutCount ?? 0) > 0) {
    parts.push(
      `${input.stockoutCount} stockout risk${input.stockoutCount === 1 ? "" : "s"}`,
    );
  }
  if ((input.alertCount ?? 0) > 0) {
    parts.push(
      `${input.alertCount} Watchdog alert${input.alertCount === 1 ? "" : "s"}`,
    );
  }
  if (parts.length === 0) return null;

  return `Jefe found ${parts.join(" and ")}, but margin confidence is the blocker today.`;
}

/** @param {{ stockoutCount?: number; alertCount?: number; winbackCount?: number }} input */
function compactSecondaryItems(input) {
  return [
    (input.stockoutCount ?? 0) > 0
      ? `${input.stockoutCount} stockout risk${input.stockoutCount === 1 ? "" : "s"}`
      : null,
    (input.alertCount ?? 0) > 0
      ? `${input.alertCount} Watchdog alert${input.alertCount === 1 ? "" : "s"}`
      : null,
    (input.winbackCount ?? 0) > 0
      ? `${input.winbackCount} dormant customer${input.winbackCount === 1 ? "" : "s"} in winback audience`
      : null,
  ].filter(Boolean);
}

/** @param {{ cogsCoverage: any | null; productCostsSkipped: boolean; winbackProposal: any | null }} input */
function buildOptionalWarnings(input) {
  const warnings = [];

  if (input.productCostsSkipped) {
    warnings.push(
      "Until product costs are added, gross profit and margin-based recommendations will stay limited.",
    );
  } else if ((input.cogsCoverage?.usableRevenueCoveragePercent ?? 100) < 80) {
    warnings.push(
      "Until product costs are added, gross profit and margin-based recommendations will stay limited.",
    );
  }
  if (input.winbackProposal?.status !== "ready") {
    warnings.push(
      "Klaviyo is not connected or no eligible audience is available, so winback drafts are unavailable.",
    );
  }

  return warnings;
}

/**
 * @param {Parameters<typeof buildDailyBriefView>[0]} input
 */
function buildSections(input) {
  const dailyVerdictSection = input.dailyVerdict
    ? dailyVerdictBriefSection(input.dailyVerdict)
    : unavailableSection(
        "daily_verdict",
        "Revenue & Margin",
        "Revenue & Margin data is unavailable. Here is what Jefe can verify from the other modules.",
      );
  const inventorySection = input.inventoryGuardian
    ? inventoryBriefSection(input.inventoryGuardian)
    : unavailableSection(
        "inventory_guardian",
        "Inventory Guardian",
        "Inventory Guardian data is unavailable, so stockout risk is degraded for this brief.",
        "estimated",
      );
  const watchdogSection = input.watchdog
    ? watchdogBriefSection(input.watchdog)
    : unavailableSection(
        "watchdog",
        "Watchdog",
        "Watchdog data is unavailable, so breakage checks are degraded for this brief.",
        "estimated",
      );

  return [
    dailyVerdictSection,
    inventorySection,
    watchdogSection,
    suggestedFocusSection({
      dailyVerdict: input.dailyVerdict,
      inventoryGuardian: input.inventoryGuardian,
      watchdog: input.watchdog,
    }),
  ];
}

/** @param {any} verdict */
function dailyVerdictBriefSection(verdict) {
  const grossProfit =
    verdict.margin.estimatedGrossProfit === null
      ? "Gross profit is unavailable because product costs are missing."
      : `Estimated gross profit was ${formatMoney(
          verdict.margin.estimatedGrossProfit,
          verdict.revenue.currency,
        )}.`;
  const topInsight =
    verdict.highlights?.[0]?.message ?? "No product-level highlight yet.";

  return {
    type: "daily_verdict",
    title: "Revenue & Margin",
    summary: `Revenue was ${formatMoney(
      verdict.revenue.gross,
      verdict.revenue.currency,
    )}. Net after refunds was ${formatMoney(
      verdict.revenue.net,
      verdict.revenue.currency,
    )}. ${grossProfit} Margin confidence is ${
      verdict.margin.confidenceLevel
    } because ${verdict.margin.cogsCoveragePercent}% of sold revenue has product costs. ${topInsight}`,
    confidence: verdict.margin.confidenceLevel,
    verificationClass: "estimated",
  };
}

/** @param {any} guardian */
function inventoryBriefSection(guardian) {
  if (guardian.emptyState === "no_inventory") {
    return {
      type: "inventory_guardian",
      title: "Inventory Guardian",
      summary:
        "Inventory data is unavailable, so Jefe cannot verify stockout risk yet.",
      confidence: "low",
      valueAtRisk: 0,
      verificationClass: "estimated",
    };
  }

  const urgent = guardian.riskyRecords?.[0] ?? null;
  const riskCount = guardian.hero.atRiskVariantCount;
  const urgentText = urgent
    ? `${urgent.title} / ${urgent.variantTitle} may stock out ${
        urgent.daysUntilStockout === null
          ? "soon"
          : `in ${urgent.daysUntilStockout} days`
      }${
        urgent.suggestedReorderQuantity === null
          ? ""
          : `; suggested reorder is ${urgent.suggestedReorderQuantity} units`
      }.`
    : "No selling variants are likely to stock out within 14 days.";

  return {
    type: "inventory_guardian",
    title: "Inventory Guardian",
    summary: `${riskCount} variant${
      riskCount === 1 ? " is" : "s are"
    } likely to stock out within 14 days. ${urgentText} Estimated revenue at risk is ${formatMoney(
      guardian.metrics.revenueAtRisk,
      guardian.metrics.currency,
    )}.`,
    confidence: guardian.hero.confidence,
    valueAtRisk: guardian.metrics.revenueAtRisk,
    verificationClass: "estimated",
  };
}

/** @param {any} watchdog */
function watchdogBriefSection(watchdog) {
  const topAlert = watchdog.alerts?.[0] ?? null;

  if (!topAlert) {
    return {
      type: "watchdog",
      title: "Watchdog",
      summary:
        watchdog.emptyState === "not_enough_history"
          ? "Watchdog needs more order and inventory history before it can compare against a baseline."
          : "Jefe found no urgent silent-breakage alerts in this period.",
      confidence: watchdog.emptyState === "not_enough_history" ? "low" : "high",
      valueAtRisk: 0,
      verificationClass: "estimated",
    };
  }

  return {
    type: "watchdog",
    title: "Watchdog",
    summary: `Jefe found ${watchdog.hero.alertCount} issue${
      watchdog.hero.alertCount === 1 ? "" : "s"
    } worth checking. Highest severity is ${
      watchdog.hero.highestSeverity
    }. Top issue: ${topAlert.summary}`,
    confidence: topAlert.confidence,
    valueAtRisk: watchdog.metrics.estimatedValueAtRisk,
    verificationClass: "estimated",
  };
}

/**
 * @param {{ dailyVerdict: any | null; inventoryGuardian: any | null; watchdog: any | null }} input
 */
function suggestedFocusSection(input) {
  const urgentInventory = input.inventoryGuardian?.riskyRecords?.[0] ?? null;
  const topAlert = input.watchdog?.alerts?.[0] ?? null;
  const verdictNextStep = input.dailyVerdict?.sections?.nextStep ?? null;
  let summary =
    "Today's focus: keep monitoring until Jefe has stronger store evidence.";

  if (urgentInventory) {
    summary = `Today's focus: check ${urgentInventory.title} / ${urgentInventory.variantTitle} inventory and confirm whether to reorder.`;
  } else if (topAlert) {
    summary = `Today's focus: ${topAlert.suggestedCheck}`;
  } else if (verdictNextStep) {
    summary = `Today's focus: ${verdictNextStep}`;
  }

  return {
    type: "suggested_focus",
    title: "Suggested focus",
    summary,
  };
}

/**
 * @param {BriefSectionType} type
 * @param {string} title
 * @param {string} summary
 * @param {"estimated" | undefined} verificationClass
 */
function unavailableSection(
  type,
  title,
  summary,
  verificationClass = undefined,
) {
  return {
    type,
    title,
    summary,
    confidence: "low",
    ...(verificationClass ? { verificationClass } : {}),
  };
}

/**
 * @param {Record<string, string>} errors
 */
function sourceDegradedReasons(errors) {
  return Object.entries(errors).map(
    ([source, error]) => `${source} failed: ${error}`,
  );
}

/** @param {any | null} verdict */
function dailyVerdictDegradedReasons(verdict) {
  if (!verdict) return [];
  const reasons = [];
  if ((verdict.evidence?.orderLineItemCount ?? 0) === 0) {
    reasons.push("No synced order history for the selected period.");
  }
  return reasons;
}

/** @param {any | null} guardian */
function inventoryDegradedReasons(guardian) {
  if (!guardian) return [];
  if (guardian.emptyState === "no_inventory") {
    return ["Inventory data is unavailable."];
  }
  if (guardian.emptyState === "no_sales") {
    return [
      "Inventory velocity is limited because no recent sales were found.",
    ];
  }
  return [];
}

/** @param {any | null} watchdog */
function watchdogDegradedReasons(watchdog) {
  if (!watchdog) return [];
  const reasons = [];
  if (watchdog.emptyState === "not_enough_history") {
    reasons.push(
      "Watchdog needs more history before baseline checks are trusted.",
    );
  }
  if (watchdog.limitations?.refundData)
    reasons.push(watchdog.limitations.refundData);
  if (watchdog.limitations?.inventoryMovement) {
    reasons.push(watchdog.limitations.inventoryMovement);
  }
  return reasons;
}

/**
 * @param {any | null} verdict
 * @param {any | null} guardian
 * @param {any | null} watchdog
 * @param {string[]} degradedReasons
 * @returns {BriefConfidence}
 */
function combinedConfidence(verdict, guardian, watchdog, degradedReasons) {
  const confidences = [
    verdict?.margin?.confidenceLevel,
    guardian?.hero?.confidence,
    watchdog?.alerts?.[0]?.confidence,
  ].filter(Boolean);

  if (
    degradedReasons.some((reason) =>
      /failed|unavailable|No synced order/i.test(reason),
    )
  ) {
    confidences.push("low");
  }

  return lowestConfidence(confidences);
}

/**
 * @param {any[]} confidences
 * @returns {BriefConfidence}
 */
function lowestConfidence(confidences) {
  if (confidences.includes("low")) return "low";
  if (confidences.includes("medium")) return "medium";
  return "high";
}

/** @param {Parameters<typeof buildDailyBriefView>[0]} input */
function normalizeCogsCoverage(input) {
  if (input.cogsCoverage) return input.cogsCoverage;

  const margin = input.dailyVerdict?.margin ?? {};
  const soldRevenue = Number(margin.soldRevenue ?? 0);
  const soldRevenueWithCogs = Number(margin.soldRevenueWithCogs ?? 0);
  const coveragePercent = Number(margin.cogsCoveragePercent ?? 0);

  return {
    usableRevenueCoveragePercent: coveragePercent,
    missingRevenueCoveragePercent: roundPercent(
      Math.max(0, 100 - coveragePercent),
    ),
    soldRevenueTotal: soldRevenue,
    soldRevenueConfirmedCost: soldRevenueWithCogs,
    soldRevenueMerchantRuleCost: 0,
    soldRevenueMissingCost: Math.max(0, soldRevenue - soldRevenueWithCogs),
    variantsMissingCost: Number(margin.missingCogsVariantCount ?? 0),
    marginConfidence: margin.confidenceLevel ?? "low",
    coverageBasis: soldRevenue > 0 ? "sold_revenue" : "variant_count",
    currency: input.dailyVerdict?.revenue?.currency ?? input.currency,
  };
}

/** @param {any | null} coverage @param {boolean} productCostsSkipped */
function marginConfidenceDisplay(coverage, productCostsSkipped) {
  if (productCostsSkipped) return "limited";
  const confidence = coverage?.marginConfidence;
  if (
    confidence === "high" ||
    confidence === "medium" ||
    confidence === "low"
  ) {
    return confidence;
  }
  const percent = coverage?.usableRevenueCoveragePercent ?? 0;
  if (percent >= 80) return "high";
  if (percent >= 50) return "medium";
  return percent > 0 ? "low" : "limited";
}

/** @param {any | null} coverage @param {boolean} productCostsSkipped */
function marginConfidenceLabel(coverage, productCostsSkipped) {
  const confidence = marginConfidenceDisplay(coverage, productCostsSkipped);
  if (confidence === "limited") return "Limited";
  if (confidence === "estimated") return "Estimated";
  return `${confidence[0].toUpperCase()}${confidence.slice(1)} confidence`;
}

/** @param {any | null} coverage @param {boolean} productCostsSkipped */
function lowCogsCoverage(coverage, productCostsSkipped) {
  if (productCostsSkipped) return true;
  return (coverage?.usableRevenueCoveragePercent ?? 0) < 50;
}

/** @param {any | null} guardian */
function highestValueStockout(guardian) {
  const risks = guardian?.riskyRecords ?? [];
  if (risks.length === 0) return null;

  return [...risks].sort(
    (a, b) => Number(b.revenueAtRisk ?? 0) - Number(a.revenueAtRisk ?? 0),
  )[0];
}

/** @param {number | null | undefined} days */
function formatDaysUntilStockout(days) {
  if (days === null || days === undefined) return "soon";
  if (days === 0) return "today";
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

/** @param {number | null | undefined} value @param {string} currency @param {boolean} [rounded] */
function moneyOrUnavailable(value, currency, rounded = false) {
  if (value === null || value === undefined) return "Unavailable";
  if (rounded) return formatBriefMoney(Number(value), currency);
  return formatMoney(Number(value), currency);
}

/**
 * @param {ReturnType<typeof buildDailyBriefView>} brief
 * @param {Record<string, string | undefined>} env
 */
export async function deliverDailyBrief(brief, env = process.env) {
  const base = {
    inApp: /** @type {"ready" | "failed"} */ (
      brief.status === "failed" ? "failed" : "ready"
    ),
  };

  if (env.ENABLE_DAILY_BRIEF_EMAIL !== "true") {
    return {
      ...base,
      email: "not_configured",
      mode: "dev_preview",
      reason: "ENABLE_DAILY_BRIEF_EMAIL is not true.",
    };
  }

  if (!env.DAILY_BRIEF_EMAIL_TO) {
    return {
      ...base,
      email: "not_configured",
      mode: "dev_logger",
      reason: "DAILY_BRIEF_EMAIL_TO is not set.",
    };
  }

  console.info(
    JSON.stringify(
      {
        event: "daily_brief.email_preview",
        to: env.DAILY_BRIEF_EMAIL_TO,
        subject: `Daily Brief for ${brief.shopDomain}`,
        headline: brief.headline,
        generatedAt: brief.generatedAt,
        sections: brief.sections,
      },
      null,
      2,
    ),
  );

  return {
    ...base,
    email: "logged",
    mode: "dev_logger",
    recipient: env.DAILY_BRIEF_EMAIL_TO,
  };
}

/** @param {Date} date */
function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

/** @param {Date} date */
function formatDayMonth(date) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(date);
}

/**
 * @param {number} value
 * @param {string} currency
 */
function formatMoney(value, currency) {
  const safeCurrency = /^[A-Z]{3}$/.test(currency) ? currency : "GBP";
  const symbol = safeCurrency === "GBP" ? "£" : `${safeCurrency} `;

  return `${symbol}${Number(value).toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * @param {number} value
 * @param {string} currency
 */
function formatBriefMoney(value, currency) {
  const safeCurrency = /^[A-Z]{3}$/.test(currency) ? currency : "GBP";
  const symbol = safeCurrency === "GBP" ? "£" : `${safeCurrency} `;

  return `${symbol}${Math.round(Number(value)).toLocaleString("en-GB")}`;
}

/** @param {number} value */
function roundPercent(value) {
  return Math.round(Number(value) * 100) / 100;
}

/** @param {number} value */
function formatPercentLabel(value) {
  return `${Math.round(Number(value))}%`;
}

/** @param {number} value */
function formatCoveragePercent(value) {
  const rounded = roundPercent(value);
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

/** @param {unknown} value */
function toJson(value) {
  return JSON.parse(JSON.stringify(value));
}
