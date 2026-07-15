// @ts-check

import { buildDailyVerdictPayload } from "./daily-verdict.server.js";
import { buildInventoryGuardianPayload } from "./inventory-guardian.server.js";
import { buildWatchdogPayload } from "./watchdog.server.js";

export const DAILY_BRIEF_CHANNEL = "daily_brief";
const DEFAULT_PERIOD_DAYS = 7;

/**
 * @typedef {"low" | "medium" | "high"} BriefConfidence
 * @typedef {"generated" | "degraded" | "failed"} BriefStatus
 * @typedef {"daily_verdict" | "inventory_guardian" | "watchdog" | "suggested_focus"} BriefSectionType
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
 * @property {Record<string, string>} [sourceErrors]
 * @typedef {object} DailyBriefHeadlineInput
 * @property {any | null} dailyVerdict
 * @property {any | null} inventoryGuardian
 * @property {any | null} watchdog
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
      select: { id: true, shopDomain: true },
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
    sourceErrors: sourceErrors(sourceResults),
  });
  const deliveryStatus = await deliverDailyBrief(brief, input.env ?? process.env);
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

  const [dailyVerdict, inventoryGuardian, watchdog] = await Promise.all([
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
  ]);

  return { dailyVerdict, inventoryGuardian, watchdog };
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
  return Object.fromEntries(
    Object.entries(results)
      .filter(([, result]) => !result.ok)
      .map(([source, result]) => [source, result.error ?? "Failed"]),
  );
}

/** @param {DailyBriefViewInput} input */
export function buildDailyBriefView(input) {
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
          currency: input.currency,
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
    sections,
    metrics: {
      revenue: input.dailyVerdict?.revenue ?? {
        gross: 0,
        net: 0,
        refunded: 0,
        currency: input.currency,
      },
      margin: input.dailyVerdict?.margin ?? null,
      inventory: input.inventoryGuardian?.metrics ?? null,
      watchdog: input.watchdog?.metrics ?? null,
    },
    evidence: {
      sourceErrors: input.sourceErrors ?? {},
      dailyVerdict: input.dailyVerdict,
      inventoryGuardian: input.inventoryGuardian,
      watchdog: input.watchdog,
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
  const marginConfidence =
    input.dailyVerdict?.margin?.confidenceLevel ?? "low";
  const stockoutCount = input.inventoryGuardian?.hero?.atRiskVariantCount ?? 0;
  const alertCount = input.watchdog?.hero?.alertCount ?? 0;

  if (revenue === 0 && stockoutCount === 0 && alertCount === 0) {
    return "Not enough order data yet. Jefe checked available inventory and Watchdog signals, but there is not enough synced sales history for a full brief.";
  }

  if (stockoutCount > 0 || alertCount > 0) {
    const findings = [
      stockoutCount > 0
        ? `${stockoutCount} stockout risk${stockoutCount === 1 ? "" : "s"}`
        : null,
      alertCount > 0
        ? `${alertCount} Watchdog issue${alertCount === 1 ? "" : "s"}`
        : null,
    ].filter(Boolean);

    return `Revenue was ${formatMoney(
      revenue,
      currency,
    )}, margin confidence is ${marginConfidence}, and Jefe found ${joinList(
      findings,
    )} worth checking.`;
  }

  return `No urgent issues found. Revenue was ${formatMoney(
    revenue,
    currency,
  )} and inventory appears healthy based on recent sales velocity.`;
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
    } because ${verdict.margin.cogsCoveragePercent}% of sold units have COGS. ${topInsight}`,
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
      confidence:
        watchdog.emptyState === "not_enough_history" ? "low" : "high",
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
function unavailableSection(type, title, summary, verificationClass = undefined) {
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
  if ((verdict.margin?.cogsCoveragePercent ?? 0) < 90) {
    reasons.push("Margin confidence is limited by missing COGS.");
  }
  if (verdict.evidence?.refundDataCompleteness === "no_refunds_recorded") {
    reasons.push("Refund checks are limited because no refunds are synced.");
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
    return ["Inventory velocity is limited because no recent sales were found."];
  }
  return [];
}

/** @param {any | null} watchdog */
function watchdogDegradedReasons(watchdog) {
  if (!watchdog) return [];
  const reasons = [];
  if (watchdog.emptyState === "not_enough_history") {
    reasons.push("Watchdog needs more history before baseline checks are trusted.");
  }
  if (watchdog.limitations?.refundData) reasons.push(watchdog.limitations.refundData);
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

  if (degradedReasons.some((reason) => /failed|unavailable|No synced order/i.test(reason))) {
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

/** @param {Array<string | null>} items */
function joinList(items) {
  const values = items.filter(Boolean);
  if (values.length <= 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} plus ${values.at(-1)}`;
}

/** @param {unknown} value */
function toJson(value) {
  return JSON.parse(JSON.stringify(value));
}
