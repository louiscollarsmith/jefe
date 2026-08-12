// @ts-check

import { logger as baseLogger } from "../observability/logger.server.js";
import { ACTIVE_BELIEF_STATUSES } from "./constants.server.js";
import { labelForBeliefKey } from "./conversational-belief-registry.server.js";
import {
  executeCommerceCalculations,
  heuristicCommerceCalculationRequests,
} from "./commerce-calculations.server.js";

export { retrieveMerchantContext } from "./merchant-context.server.js";

export const PLAN_EVIDENCE_SNAPSHOT_VERSION = "plan_evidence_snapshot_v1";

const MAX_CONTEXT_BLOCKS = 32;
const MAX_EVIDENCE_PER_BELIEF = 2;
const MAX_STRUCTURED_ITEMS = 5;
const MAX_ACTION_HISTORY = 5;
const MAX_TEXT = 420;

/** @type {Readonly<Record<string, string[]>>} */
export const BELIEF_EXPANSION_BY_KEY = Object.freeze({
  "inventory.at_risk_stockout_count.trailing_30d": [
    "inventory.low_cover_products.trailing_30d",
  ],
  "products.no_sale_active_product_count.trailing_90d": [
    "products.dead_stock.trailing_90d",
  ],
  "products.top_product_revenue_share.trailing_90d": [
    "products.bestseller_by_revenue.trailing_90d",
    "products.bestseller_by_units.trailing_90d",
  ],
});

const QUESTION_KEYWORDS = [
  {
    pattern:
      /\b(stock|stockout|stockouts|cover|reorder|replenish|inventory|low stock)\b/i,
    keys: [
      "inventory.at_risk_stockout_count.trailing_30d",
      "inventory.low_cover_products.trailing_30d",
    ],
  },
  {
    pattern:
      /\b(dead stock|clearance|no sale|not sold|slow moving|stale stock)\b/i,
    keys: [
      "products.no_sale_active_product_count.trailing_90d",
      "products.dead_stock.trailing_90d",
    ],
  },
  {
    pattern: /\b(best.?seller|fast.?selling|top product|core range|popular)\b/i,
    keys: [
      "products.top_product_revenue_share.trailing_90d",
      "products.bestseller_by_revenue.trailing_90d",
      "products.bestseller_by_units.trailing_90d",
    ],
  },
];

/**
 * @typedef {object} MerchantContextBlock
 * @property {string} kind
 * @property {string} id
 * @property {string} source
 * @property {Record<string, any>} data
 */

/**
 * Expand selected belief rows with adjacent structured beliefs that make aggregate
 * claims answerable. The order keeps the seed belief first, then its expansion.
 * @param {{ allBeliefs: any[]; seedBeliefs: any[]; max?: number }} input
 */
export function expandBeliefRowsForContext(input) {
  const max = Number.isFinite(Number(input.max))
    ? Number(input.max)
    : MAX_CONTEXT_BLOCKS;
  const allByKey = new Map(
    (input.allBeliefs ?? []).map((belief) => [String(belief.key), belief]),
  );
  const seen = new Set();
  const rows = [];

  for (const belief of input.seedBeliefs ?? []) {
    if (!belief?.id || seen.has(belief.id)) continue;
    rows.push(belief);
    seen.add(belief.id);
    for (const expandedKey of expansionKeysForBelief(String(belief.key))) {
      const expanded = allByKey.get(expandedKey);
      if (expanded?.id && !seen.has(expanded.id)) {
        rows.push(expanded);
        seen.add(expanded.id);
      }
    }
  }

  return rows.slice(0, max);
}

/**
 * Build and persist the evidence snapshot tied to one recommendation.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; recommendation: any; sourceSnapshotHash?: string | null; snapshotSource?: string; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function buildPlanEvidenceSnapshot(prisma, input) {
  if (
    !input.recommendation?.id ||
    !prisma.merchantPlanEvidenceSnapshot?.create
  ) {
    return null;
  }
  const existing = await prisma.merchantPlanEvidenceSnapshot.findUnique?.({
    where: { recommendationId: input.recommendation.id },
  });
  if (existing) {
    input.logger?.info?.("plan evidence snapshot already exists", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      recommendationId: input.recommendation.id,
      snapshotId: existing.id,
    });
    return existing;
  }

  const blocks = await buildPlanEvidenceBlocks(prisma, input);
  const limits = buildLimits({
    snapshotSource: input.snapshotSource ?? "plan_generation",
    blockCount: blocks.length,
  });
  try {
    const snapshot = await prisma.merchantPlanEvidenceSnapshot.create({
      data: {
        recommendationId: input.recommendation.id,
        runId: input.recommendation.runId,
        merchantId: input.merchantId,
        shopId: input.shopId,
        snapshotVersion: PLAN_EVIDENCE_SNAPSHOT_VERSION,
        sourceSnapshotHash: input.sourceSnapshotHash ?? null,
        blocksJson: blocks,
        limitsJson: limits,
      },
    });
    input.logger?.info?.("plan evidence snapshot persisted", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      recommendationId: input.recommendation.id,
      snapshotId: snapshot.id,
      blockCount: blocks.length,
    });
    return snapshot;
  } catch (error) {
    if (
      isUniqueConflict(error) &&
      prisma.merchantPlanEvidenceSnapshot.findUnique
    ) {
      const raced = await prisma.merchantPlanEvidenceSnapshot.findUnique({
        where: { recommendationId: input.recommendation.id },
      });
      if (raced) return raced;
    }
    throw error;
  }
}

/**
 * Build the bounded context packet that action chat sends to the LLM.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; recommendationId?: string | null; actionRunId?: string | null; message?: string | null; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function getMerchantContextForQuestion(prisma, input) {
  const log =
    input.logger ??
    baseLogger.child({ component: "merchant-memory-context-retriever" });
  const warnings = [];
  // Fail closed, loudly. Each loader below independently refuses to read without a shop
  // scope, so an unscoped call returns an EMPTY packet rather than one built from every
  // shop this merchant owns. Log it once here (not per-loader) so the gap is visible:
  // silently answering from nothing is better than silently answering from another shop,
  // but neither should be silent.
  if (!shopScope(input.shopId)) {
    warnings.push("missing_shop_scope_context_withheld");
    log.warn(
      "merchant memory context requested without shop scope; reading nothing",
      {
        merchantId: input.merchantId,
        actionRunId: input.actionRunId ?? null,
        recommendationId: input.recommendationId ?? null,
      },
    );
  }
  const actionRow = await loadActionExecution(prisma, input);
  const actionSourceRecommendation = sourceRecommendationFromAction(actionRow);
  const suppliedRawRecommendationId = identityText(input.recommendationId);
  const suppliedRecommendationId = uuidString(suppliedRawRecommendationId);
  const actionRecommendationId = uuidString(
    identityText(actionSourceRecommendation?.id),
  );
  if (suppliedRawRecommendationId && !suppliedRecommendationId) {
    warnings.push("malformed_recommendation_id_ignored");
    log.warn("action chat ignored malformed recommendation id", {
      merchantId: input.merchantId,
      shopId: input.shopId ?? actionRow?.shopId ?? null,
      actionRunId: actionRow?.runId ?? input.actionRunId ?? null,
    });
  }
  let canonicalRecommendationId =
    suppliedRecommendationId || actionRecommendationId || null;
  if (
    actionRow &&
    suppliedRecommendationId &&
    actionRecommendationId &&
    suppliedRecommendationId !== actionRecommendationId
  ) {
    canonicalRecommendationId = actionRecommendationId;
    warnings.push("supplied_recommendation_id_ignored_action_source_mismatch");
    log.warn(
      "action chat recommendation id mismatch; using action source recommendation",
      {
        merchantId: input.merchantId,
        shopId: input.shopId ?? actionRow.shopId ?? null,
        actionRunId: actionRow.runId,
        suppliedRecommendationId,
        actionRecommendationId,
      },
    );
  }

  const recommendation = await loadPlanRecommendation(prisma, {
    ...input,
    recommendationId: canonicalRecommendationId,
  });
  let scopedActionRow = actionRow;
  if (
    scopedActionRow &&
    recommendation &&
    !recommendationMatchesActionSource(
      recommendation,
      actionSourceRecommendation,
    )
  ) {
    warnings.push("action_preview_dropped_recommendation_mismatch");
    log.warn(
      "action chat action preview dropped after recommendation mismatch",
      {
        merchantId: input.merchantId,
        shopId:
          input.shopId ??
          scopedActionRow.shopId ??
          recommendation.shopId ??
          null,
        actionRunId: scopedActionRow.runId,
        recommendationId: recommendation.id,
        actionRecommendationId: actionRecommendationId || null,
        actionRecommendationRunId: actionSourceRecommendation?.runId || null,
        recommendationRunId: recommendation.runId || null,
      },
    );
    scopedActionRow = null;
  }

  const fallbackRecommendation =
    recommendation ?? sourceRecommendationFromAction(scopedActionRow);
  const planSnapshot = recommendation
    ? await loadOrBackfillPlanEvidenceSnapshot(prisma, {
        merchantId: input.merchantId,
        shopId: String(input.shopId ?? recommendation.shopId ?? ""),
        recommendation,
        logger: log,
      })
    : null;
  const currentBlocks = await buildCurrentSystemBlocks(prisma, {
    merchantId: input.merchantId,
    shopId:
      input.shopId ?? recommendation?.shopId ?? scopedActionRow?.shopId ?? null,
    recommendation: fallbackRecommendation,
    actionRow: scopedActionRow,
    message: input.message ?? "",
  });
  const expansionKeys = expansionKeysForBlocks([
    ...(Array.isArray(planSnapshot?.blocksJson) ? planSnapshot.blocksJson : []),
    ...currentBlocks,
  ]);
  const context = {
    recommendationId:
      uuidString(recommendation?.id) ||
      uuidString(fallbackRecommendation?.id) ||
      canonicalRecommendationId ||
      null,
    actionRunId:
      scopedActionRow?.runId ??
      (actionRow ? null : (input.actionRunId ?? null)),
    planEvidenceAtRecommendationTime: planSnapshot
      ? {
          snapshotId: planSnapshot.id,
          snapshotVersion: planSnapshot.snapshotVersion,
          sourceSnapshotHash: planSnapshot.sourceSnapshotHash ?? null,
          generatedAt: planSnapshot.createdAt?.toISOString?.() ?? null,
          blocks: Array.isArray(planSnapshot.blocksJson)
            ? planSnapshot.blocksJson
            : [],
          limits: planSnapshot.limitsJson ?? {},
        }
      : null,
    currentSystemContext: {
      generatedAt: new Date().toISOString(),
      blocks: currentBlocks,
      limits: buildLimits({
        snapshotSource: "current_system_retrieval",
        blockCount: currentBlocks.length,
      }),
    },
    retrieval: {
      snapshotStatus: planSnapshot
        ? String(planSnapshot.limitsJson?.snapshotSource ?? "available")
        : recommendation
          ? "missing_unavailable"
          : "not_applicable",
      expansionKeys,
      currentBlockCount: currentBlocks.length,
      planBlockCount: Array.isArray(planSnapshot?.blocksJson)
        ? planSnapshot.blocksJson.length
        : 0,
      warnings,
    },
  };
  log.info("merchant memory context retrieved", {
    merchantId: input.merchantId,
    shopId: input.shopId ?? null,
    recommendationId: context.recommendationId,
    actionRunId: context.actionRunId,
    snapshotStatus: context.retrieval.snapshotStatus,
    planBlockCount: context.retrieval.planBlockCount,
    currentBlockCount: context.retrieval.currentBlockCount,
    expansionKeys,
    warningCount: warnings.length,
  });
  return context;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; recommendation: any; sourceSnapshotHash?: string | null; snapshotSource?: string; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
async function buildPlanEvidenceBlocks(prisma, input) {
  const recommendation = normalizeRecommendation(input.recommendation);
  const goalIds = uniqueStrings([
    recommendation.primaryGoalId,
    ...(recommendation.supportingGoalIds ?? []),
  ]);
  const [goals, insights, beliefs] = await Promise.all([
    loadGoals(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      goalIds,
    }),
    loadInsights(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      insightIds: recommendation.supportingInsightIds,
    }),
    loadBeliefsWithExpansion(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      beliefIds: recommendation.supportingBeliefIds,
    }),
  ]);

  const baseBlocks = [
    recommendationBlock(recommendation, "plan_recommendation"),
    ...goals.map(goalBlock),
    ...insights.map(insightBlock),
    ...beliefs.flatMap((belief) => beliefBlocks(belief)),
  ].slice(0, MAX_CONTEXT_BLOCKS);
  const calculationBlocks = await buildPlanCalculationBlocks(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    recommendation,
    blocks: baseBlocks,
    snapshotSource: input.snapshotSource ?? "plan_generation",
    logger: input.logger,
  });
  return [...baseBlocks, ...calculationBlocks].slice(0, MAX_CONTEXT_BLOCKS);
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; recommendation: any; blocks: MerchantContextBlock[]; snapshotSource: string; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 * @returns {Promise<MerchantContextBlock[]>}
 */
async function buildPlanCalculationBlocks(prisma, input) {
  const actionContext = { currentSystemContext: { blocks: input.blocks } };
  const requests = heuristicCommerceCalculationRequests({
    message: [
      input.recommendation.title,
      input.recommendation.summary,
      input.recommendation.whyThisAction,
      input.recommendation.whyNow,
    ]
      .filter(Boolean)
      .join(" "),
    actionContext,
    includeDefaultScopedImpact: true,
  });
  if (!requests.length) return [];
  const packet = await executeCommerceCalculations(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    requests,
    actionContext,
    source: input.snapshotSource,
    logger: input.logger,
  });
  return packet.results
    .filter((result) => result.ok)
    .slice(0, 4)
    .map((result) => ({
      kind: "commerce_metric",
      id: `commerce_metric:${result.id}`,
      source: "commerce_calculations",
      data: result,
    }));
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; recommendation?: any; actionRow?: any; message?: string }} input
 */
async function buildCurrentSystemBlocks(prisma, input) {
  const recommendation = input.recommendation
    ? normalizeRecommendation(input.recommendation)
    : null;
  const beliefIds = recommendation?.supportingBeliefIds ?? [];
  const beliefKeys = questionDrivenBeliefKeys(input.message ?? "");
  const goalIds = uniqueStrings([
    recommendation?.primaryGoalId,
    ...(recommendation?.supportingGoalIds ?? []),
  ]);
  const [goals, insights, beliefs, history] = await Promise.all([
    loadGoals(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      goalIds,
    }),
    loadInsights(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      insightIds: recommendation?.supportingInsightIds ?? [],
    }),
    loadBeliefsWithExpansion(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      beliefIds,
      beliefKeys,
    }),
    loadActionHistory(prisma, input),
  ]);
  const blocks = [
    recommendation
      ? recommendationBlock(recommendation, "current_plan_recommendation")
      : null,
    input.actionRow ? actionPreviewBlock(input.actionRow) : null,
    ...goals.map(goalBlock),
    ...insights.map(insightBlock),
    ...beliefs.flatMap((belief) => beliefBlocks(belief)),
    ...history.map(actionHistoryBlock),
  ].filter(Boolean);
  return blocks.slice(0, MAX_CONTEXT_BLOCKS);
}

/**
 * @param {string} message
 */
function questionDrivenBeliefKeys(message) {
  const keys = new Set();
  for (const rule of QUESTION_KEYWORDS) {
    if (rule.pattern.test(message)) {
      for (const key of rule.keys) keys.add(key);
    }
  }
  return [...keys];
}

/**
 * Tenant scope for every read in this module.
 *
 * ⛔ NEVER `shopId: input.shopId ?? undefined`. Prisma DROPS an `undefined` filter, so a
 * missing shopId silently widens the read to EVERY shop the merchant owns — one merchant's
 * Shop A answering a question with Shop B's beliefs, with nothing in the logs to show it.
 * A missing scope must FAIL CLOSED (read nothing), never fail open. Mirrors the guard in
 * `executeCommerceCalculations` (commerce-calculations.server.js:307).
 *
 * Presence-checked, not UUID-checked: the column is `@db.Uuid` in production but callers in
 * tests use plain ids, and format is not what this guard is for.
 *
 * ⛔ `identityText`, NOT `safeText`. `safeText` is the free-text PII REDACTOR: its
 * phone-number rule (`\+?\d[\d\s().-]{7,}\d`) matches the numeric-and-hyphen runs that occur
 * naturally inside a UUID, so `safeText` turns e.g. `…-1234-5678-…` into `…-[redacted]-…`
 * and Prisma then rejects the id. Same class as the 2026-08-11 fix that kept UUID
 * identifiers out of free-text redaction. An identifier is never free text.
 * @param {unknown} shopId
 * @returns {string} the scoped shop id, or "" when there is no usable scope
 */
function shopScope(shopId) {
  return identityText(shopId);
}

/**
 * Row-level scope for MerchantMemoryBelief, whose `shopId` is NULLABLE: a merchant-wide
 * belief is a real row with `shopId: null`. So the correct read is "this shop's beliefs
 * ∪ the merchant-wide ones" — never other shops'. A plain `shopId: input.shopId` would be
 * just as wrong as the `?? undefined` it replaces, in the opposite direction: it would
 * silently DROP every merchant-wide belief from retrieved context. Ratified by chat 10.
 * @param {string} shopId
 */
function beliefShopFilter(shopId) {
  return { OR: [{ shopId }, { shopId: null }] };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; beliefIds?: string[]; beliefKeys?: string[] }} input
 */
async function loadBeliefsWithExpansion(prisma, input) {
  if (!prisma.merchantMemoryBelief?.findMany) return [];
  const shopId = shopScope(input.shopId);
  if (!shopId) return [];
  const seedIds = uuidStrings(input.beliefIds ?? []);
  const seedKeys = uniqueStrings(input.beliefKeys ?? []);
  /** @type {any[]} */
  const orFilters = [];
  if (seedIds.length) orFilters.push({ id: { in: seedIds } });
  if (seedKeys.length) orFilters.push({ key: { in: seedKeys } });
  const seedBeliefs = orFilters.length
    ? await prisma.merchantMemoryBelief.findMany({
        where: {
          merchantId: input.merchantId,
          AND: [beliefShopFilter(shopId)],
          supersededAt: null,
          status: { in: ACTIVE_BELIEF_STATUSES },
          OR: orFilters,
        },
        include: {
          evidence: {
            orderBy: { createdAt: "desc" },
            take: MAX_EVIDENCE_PER_BELIEF,
          },
        },
      })
    : [];
  const expansionKeys = uniqueStrings(
    seedBeliefs.flatMap((belief) => expansionKeysForBelief(String(belief.key))),
  );
  const missingExpansionKeys = expansionKeys.filter(
    (key) => !seedBeliefs.some((belief) => String(belief.key) === key),
  );
  const expansionBeliefs = missingExpansionKeys.length
    ? await prisma.merchantMemoryBelief.findMany({
        where: {
          merchantId: input.merchantId,
          AND: [beliefShopFilter(shopId)],
          supersededAt: null,
          status: { in: ACTIVE_BELIEF_STATUSES },
          key: { in: missingExpansionKeys },
        },
        include: {
          evidence: {
            orderBy: { createdAt: "desc" },
            take: MAX_EVIDENCE_PER_BELIEF,
          },
        },
      })
    : [];
  return expandBeliefRowsForContext({
    allBeliefs: [...seedBeliefs, ...expansionBeliefs],
    seedBeliefs,
    max: MAX_CONTEXT_BLOCKS,
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; goalIds?: string[] }} input
 */
async function loadGoals(prisma, input) {
  const ids = uuidStrings(input.goalIds ?? []);
  if (!ids.length || !prisma.merchantGoalHorizon?.findMany) return [];
  const shopId = shopScope(input.shopId);
  if (!shopId) return [];
  return prisma.merchantGoalHorizon.findMany({
    where: {
      merchantId: input.merchantId,
      shopId,
      id: { in: ids },
    },
    orderBy: { orderIndex: "asc" },
    take: 6,
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; insightIds?: string[] }} input
 */
async function loadInsights(prisma, input) {
  const ids = uuidStrings(input.insightIds ?? []);
  if (!ids.length || !prisma.merchantInsightFinding?.findMany) return [];
  const shopId = shopScope(input.shopId);
  if (!shopId) return [];
  return prisma.merchantInsightFinding.findMany({
    where: {
      merchantId: input.merchantId,
      shopId,
      id: { in: ids },
    },
    orderBy: { orderIndex: "asc" },
    take: 8,
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; recommendationId?: string | null }} input
 */
async function loadPlanRecommendation(prisma, input) {
  const recommendationId = uuidString(input.recommendationId);
  if (!recommendationId || !prisma.merchantPlanRecommendation?.findFirst)
    return null;
  const shopId = shopScope(input.shopId);
  if (!shopId) return null;
  return prisma.merchantPlanRecommendation.findFirst({
    where: {
      id: recommendationId,
      merchantId: input.merchantId,
      shopId,
    },
    include: {
      run: { select: { snapshotHash: true } },
      evidenceSnapshot: true,
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; actionRunId?: string | null }} input
 */
async function loadActionExecution(prisma, input) {
  if (!input.actionRunId || !prisma.actionExecution?.findFirst) return null;
  const shopId = shopScope(input.shopId);
  if (!shopId) return null;
  return prisma.actionExecution.findFirst({
    where: {
      merchantId: input.merchantId,
      shopId,
      runId: input.actionRunId,
    },
    select: {
      runId: true,
      merchantId: true,
      shopId: true,
      actionType: true,
      actionKind: true,
      status: true,
      resolvedMode: true,
      preview: true,
      proposalSummary: true,
      outcomeStatus: true,
      outcome: true,
      appliedAt: true,
      updatedAt: true,
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; recommendation: any; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
async function loadOrBackfillPlanEvidenceSnapshot(prisma, input) {
  if (input.recommendation?.evidenceSnapshot)
    return input.recommendation.evidenceSnapshot;
  if (!prisma.merchantPlanEvidenceSnapshot?.findUnique) {
    return null;
  }
  const existing = await prisma.merchantPlanEvidenceSnapshot.findUnique({
    where: { recommendationId: input.recommendation.id },
  });
  if (existing) return existing;
  try {
    input.logger?.warn?.(
      "plan evidence snapshot missing; backfilling from current memory",
      {
        merchantId: input.merchantId,
        shopId: input.shopId,
        recommendationId: input.recommendation.id,
      },
    );
    return await buildPlanEvidenceSnapshot(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      recommendation: input.recommendation,
      sourceSnapshotHash: input.recommendation.run?.snapshotHash ?? null,
      snapshotSource: "backfilled_current_memory",
      logger: input.logger,
    });
  } catch (error) {
    input.logger?.warn?.("plan evidence snapshot backfill failed", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      recommendationId: input.recommendation.id,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return null;
  }
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; actionRow?: any }} input
 */
async function loadActionHistory(prisma, input) {
  if (!input.actionRow?.runId || !prisma.actionExecution?.findMany) return [];
  const shopId = shopScope(input.shopId);
  if (!shopId) return [];
  return prisma.actionExecution.findMany({
    where: {
      merchantId: input.merchantId,
      shopId,
      runId: { not: input.actionRow.runId },
      status: { in: ["applied", "partially_applied", "rejected", "reverted"] },
    },
    orderBy: { updatedAt: "desc" },
    take: MAX_ACTION_HISTORY,
    select: {
      runId: true,
      actionType: true,
      actionKind: true,
      status: true,
      proposalSummary: true,
      outcomeStatus: true,
      outcome: true,
      appliedAt: true,
      updatedAt: true,
    },
  });
}

/** @param {unknown} error */
function isUniqueConflict(error) {
  return Boolean(
    error &&
    typeof error === "object" &&
    /** @type {any} */ (error).code === "P2002",
  );
}

/** @param {any} row */
function sourceRecommendationFromAction(row) {
  const summary = asRecord(row?.proposalSummary);
  const source = asRecord(summary?.sourceRecommendation);
  if (!source) return null;
  return normalizeRecommendation({
    id: source.id,
    runId: source.runId,
    merchantId: row?.merchantId,
    shopId: row?.shopId,
    title: source.title,
    summary: source.summary,
    primaryGoalId: source.primaryGoalId,
    supportingGoalIds: source.supportingGoalIds ?? [],
    whyThisAction: source.whyThisAction,
    whyNow: source.whyNow,
    successSignal: source.successSignal,
    expectedBenefit: source.expectedBenefit ?? "",
    supportingBeliefIds: source.supportingBeliefIds ?? [],
    supportingInsightIds: source.supportingInsightIds ?? [],
  });
}

/**
 * @param {any} recommendation
 * @param {any} actionSourceRecommendation
 */
function recommendationMatchesActionSource(
  recommendation,
  actionSourceRecommendation,
) {
  const source = normalizeRecommendation(actionSourceRecommendation);
  const candidate = normalizeRecommendation(recommendation);
  const hasSourceIdentity = Boolean(source.id || source.runId);
  if (!hasSourceIdentity) return false;
  if (source.id && candidate.id && source.id !== candidate.id) return false;
  if (source.runId && candidate.runId && source.runId !== candidate.runId)
    return false;
  return Boolean(
    (source.id && candidate.id) || (source.runId && candidate.runId),
  );
}

/** @param {any} recommendation */
function normalizeRecommendation(recommendation) {
  return {
    id: identityText(recommendation?.id),
    runId: identityText(recommendation?.runId),
    merchantId: identityText(recommendation?.merchantId),
    shopId: identityText(recommendation?.shopId),
    title: safeText(recommendation?.title, 160),
    summary: safeText(recommendation?.summary, 500),
    primaryGoalId: identityText(recommendation?.primaryGoalId),
    supportingGoalIds: uniqueStrings(recommendation?.supportingGoalIds ?? []),
    whyThisAction: safeText(recommendation?.whyThisAction, 700),
    whyNow: safeText(recommendation?.whyNow, 500),
    startToday: safeText(recommendation?.startToday, 500),
    successSignal: compactValue(
      recommendation?.successSignal,
      "successSignal",
      0,
    ),
    expectedBenefit: safeText(recommendation?.expectedBenefit, 500),
    supportingBeliefIds: uniqueStrings(
      recommendation?.supportingBeliefIds ?? [],
    ),
    supportingInsightIds: uniqueStrings(
      recommendation?.supportingInsightIds ?? [],
    ),
    confidence: text(recommendation?.confidence),
  };
}

/**
 * @param {any} recommendation
 * @param {string} source
 * @returns {MerchantContextBlock}
 */
function recommendationBlock(recommendation, source) {
  return {
    kind: "recommendation",
    id: `recommendation:${recommendation.id || recommendation.runId || source}`,
    source,
    data: recommendation,
  };
}

/** @param {any} goal */
function goalBlock(goal) {
  return {
    kind: "goal",
    id: `goal:${goal.id}`,
    source: "merchant_goals",
    data: {
      id: goal.id,
      horizon: text(goal.horizon),
      title: safeText(goal.title, 180),
      description: safeText(goal.description, 360),
      supportingBeliefIds: uniqueStrings(goal.supportingBeliefIds ?? []),
    },
  };
}

/** @param {any} insight */
function insightBlock(insight) {
  return {
    kind: "insight",
    id: `insight:${insight.id}`,
    source: "merchant_insights",
    data: {
      id: insight.id,
      title: safeText(insight.title, 180),
      finding: safeText(insight.finding, 500),
      whyItMatters: safeText(insight.whyItMatters, 360),
      category: text(insight.category),
      confidence: text(insight.confidence),
      supportingBeliefIds: uniqueStrings(insight.supportingBeliefIds ?? []),
    },
  };
}

/** @param {any} belief */
function beliefBlocks(belief) {
  const base = {
    kind: "belief",
    id: `belief:${belief.id}`,
    source: "merchant_memory",
    data: {
      id: belief.id,
      key: belief.key,
      category: belief.category,
      label: labelForBeliefKey(belief.key),
      valueType: belief.valueType,
      status: belief.status,
      confidence: belief.confidence === null ? null : Number(belief.confidence),
      confidenceReason: safeText(belief.confidenceReason, 240),
      value: compactBeliefValue(belief.key, belief.value),
      evidence: (belief.evidence ?? [])
        .slice(0, MAX_EVIDENCE_PER_BELIEF)
        .map((/** @type {any} */ item) => ({
          sourceType: text(item.sourceType),
          evidenceType: text(item.evidenceType),
          summary: safeText(item.summary, 240),
          observedAt: item.observedAt?.toISOString?.() ?? null,
        })),
    },
  };
  const structured = structuredEvidenceBlock(belief);
  return structured ? [base, structured] : [base];
}

/** @param {any} belief */
function structuredEvidenceBlock(belief) {
  const key = String(belief.key ?? "");
  if (key === "inventory.low_cover_products.trailing_30d") {
    const value = asRecord(belief.value) ?? {};
    const items = Array.isArray(value.items) ? value.items : [];
    return {
      kind: "structured_evidence",
      id: `structured:${belief.id}`,
      source: "merchant_memory",
      data: {
        key,
        label: "Low stock cover products",
        atRiskProductCount: numberOrNull(value.atRiskProductCount),
        thresholdDays: numberOrNull(value.thresholdDays),
        window: text(value.window),
        items: items.slice(0, MAX_STRUCTURED_ITEMS).map((item) => ({
          productId: text(item.productId),
          title: safeText(item.title, 180),
          available: numberOrNull(item.available),
          unitsSold: numberOrNull(item.unitsSold),
          dailyVelocity: numberOrNull(item.dailyVelocity),
          daysOfCover: numberOrNull(item.daysOfCover),
        })),
      },
    };
  }
  if (key === "products.dead_stock.trailing_90d") {
    const value = asRecord(belief.value) ?? {};
    const items = Array.isArray(value.items) ? value.items : [];
    return {
      kind: "structured_evidence",
      id: `structured:${belief.id}`,
      source: "merchant_memory",
      data: {
        key,
        label: "Dead stock products",
        deadStockProductCount: numberOrNull(value.deadStockProductCount),
        costCoveredProductCount: numberOrNull(value.costCoveredProductCount),
        totalTrappedCapital: numberOrNull(value.totalTrappedCapital),
        currency: text(value.currency),
        window: text(value.window),
        items: items.slice(0, MAX_STRUCTURED_ITEMS).map((item) => ({
          productId: text(item.productId),
          title: safeText(item.title, 180),
          unitsOnHand: numberOrNull(item.unitsOnHand),
          trappedCapital: numberOrNull(item.trappedCapital),
        })),
      },
    };
  }
  return null;
}

/** @param {any} row */
function actionPreviewBlock(row) {
  const summary = asRecord(row.proposalSummary) ?? {};
  const preview = asRecord(row.preview) ?? {};
  return {
    kind: "action_preview",
    id: `action:${row.runId}`,
    source: "action_execution",
    data: {
      runId: row.runId,
      actionType: row.actionType,
      actionKind: row.actionKind,
      status: row.status,
      resolvedMode: row.resolvedMode,
      variantCount: numberOrNull(summary.variantCount ?? preview.variantCount),
      markdownPercent: numberOrNull(summary.markdownPercent),
      scope: compactValue(summary.scope, "scope", 0),
      topItems: topItems(summary, preview),
      outcomeStatus: row.outcomeStatus ?? null,
      outcome: compactValue(row.outcome, "outcome", 0),
    },
  };
}

/** @param {any} row */
function actionHistoryBlock(row) {
  const summary = asRecord(row.proposalSummary) ?? {};
  return {
    kind: "action_history",
    id: `action_history:${row.runId}`,
    source: "action_execution",
    data: {
      runId: row.runId,
      actionType: row.actionType,
      actionKind: row.actionKind,
      status: row.status,
      title: safeText(asRecord(summary.sourceRecommendation)?.title, 180),
      variantCount: numberOrNull(summary.variantCount),
      outcomeStatus: row.outcomeStatus ?? null,
      outcome: compactValue(row.outcome, "outcome", 0),
      updatedAt: row.updatedAt?.toISOString?.() ?? null,
    },
  };
}

/** @param {{ snapshotSource: string; blockCount: number }} input */
function buildLimits(input) {
  return {
    snapshotSource: input.snapshotSource,
    maxBlocks: MAX_CONTEXT_BLOCKS,
    maxStructuredItemsPerBelief: MAX_STRUCTURED_ITEMS,
    blockCount: input.blockCount,
    excludesRawShopifyPayloads: true,
    excludesCustomerNamesEmailsPhonesAddresses: true,
    excludesCredentialsAndTokens: true,
    excludesFullUploadedDocuments: true,
  };
}

/** @param {Array<MerchantContextBlock>} blocks */
function expansionKeysForBlocks(blocks) {
  return uniqueStrings(
    blocks
      .map((block) => block?.data?.key)
      .filter((key) =>
        Object.values(BELIEF_EXPANSION_BY_KEY).some((keys) =>
          keys.includes(key),
        ),
      ),
  );
}

/**
 * @param {Record<string, any>} summary
 * @param {Record<string, any>} preview
 */
function topItems(summary, preview) {
  const summaryItems = Array.isArray(summary.topItems) ? summary.topItems : [];
  const previewItems = Array.isArray(preview.changes) ? preview.changes : [];
  return (summaryItems.length ? summaryItems : previewItems)
    .slice(0, MAX_STRUCTURED_ITEMS)
    .map((item) => ({
      productId: text(item?.productId),
      variantId: text(item?.variantId),
      title: safeText(
        item?.title ?? item?.productTitle ?? item?.variantId,
        180,
      ),
      unitsOnHand: numberOrNull(item?.unitsOnHand),
      trappedCapital: numberOrNull(item?.trappedCapital),
      fromPrice: numberOrNull(item?.fromPrice),
      toPrice: numberOrNull(item?.toPrice),
      discountPercent: numberOrNull(item?.discountPercent),
    }));
}

/**
 * @param {string} key
 * @param {unknown} value
 */
function compactBeliefValue(key, value) {
  const structured = structuredValueForKnownBelief(key, value);
  return structured ?? compactValue(value, key, 0);
}

/**
 * @param {string} key
 * @param {unknown} value
 */
function structuredValueForKnownBelief(key, value) {
  const record = asRecord(value);
  if (!record) return null;
  if (key === "inventory.low_cover_products.trailing_30d") {
    const items = Array.isArray(record.items) ? record.items : [];
    return {
      atRiskProductCount: numberOrNull(record.atRiskProductCount),
      thresholdDays: numberOrNull(record.thresholdDays),
      window: text(record.window),
      topAtRiskProduct: compactValue(
        record.topAtRiskProduct,
        "topAtRiskProduct",
        0,
      ),
      items: items
        .slice(0, MAX_STRUCTURED_ITEMS)
        .map((item) => compactValue(item, "lowCoverItem", 0)),
    };
  }
  if (key === "products.dead_stock.trailing_90d") {
    const items = Array.isArray(record.items) ? record.items : [];
    return {
      deadStockProductCount: numberOrNull(record.deadStockProductCount),
      costCoveredProductCount: numberOrNull(record.costCoveredProductCount),
      totalTrappedCapital: numberOrNull(record.totalTrappedCapital),
      currency: text(record.currency),
      window: text(record.window),
      topDeadProduct: compactValue(record.topDeadProduct, "topDeadProduct", 0),
      items: items
        .slice(0, MAX_STRUCTURED_ITEMS)
        .map((item) => compactValue(item, "deadStockItem", 0)),
    };
  }
  return null;
}

/**
 * @param {unknown} value
 * @param {string | null} key
 * @param {number} depth
 * @returns {any}
 */
function compactValue(value, key, depth) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string")
    return safeText(value, depth === 0 ? MAX_TEXT : 180);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_STRUCTURED_ITEMS)
      .map((item) => compactValue(item, key, depth + 1));
  }
  if (typeof value !== "object" || depth >= 3 || isLowSignalValueKey(key))
    return null;
  /** @type {Record<string, any>} */
  const output = {};
  for (const [childKey, item] of Object.entries(value).slice(
    0,
    depth === 0 ? 12 : 8,
  )) {
    if (isLowSignalValueKey(childKey)) continue;
    const compact = compactValue(item, childKey, depth + 1);
    if (compact !== undefined && compact !== null && compact !== "")
      output[childKey] = compact;
  }
  return Object.keys(output).length > 0 ? output : null;
}

/** @param {string | null | undefined} key */
function isLowSignalValueKey(key) {
  return /raw|payload|credential|token|secret|email|phone|address|customer/i.test(
    key ?? "",
  );
}

/** @param {unknown} value */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : null;
}

/** @param {unknown} value */
function text(value) {
  return typeof value === "string" && value.trim() ? safeText(value, 240) : "";
}

/** @param {unknown} value */
function identityText(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

/**
 * @param {unknown} value
 * @param {number} max
 */
function safeText(value, max) {
  if (value === null || value === undefined) return "";
  const string = String(value).replace(/\s+/g, " ").trim();
  if (!string) return "";
  return string
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, (match) =>
      /^\d{4}-\d{2}-\d{2}/.test(match) ? match : "[redacted]",
    )
    .slice(0, max);
}

/** @param {unknown} value */
function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** @param {unknown[]} values */
function uniqueStrings(values) {
  /** @type {string[]} */
  const strings = [];
  for (const value of values) {
    if (typeof value === "string" && value.trim()) strings.push(value.trim());
  }
  return [...new Set(strings)];
}

/** @param {unknown[]} values */
function uuidStrings(values) {
  return uniqueStrings(values).filter((value) =>
    /^(urn:uuid:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    ),
  );
}

/** @param {unknown} value */
function uuidString(value) {
  return uuidStrings([value])[0] ?? "";
}

/** @param {string} key */
function expansionKeysForBelief(key) {
  return BELIEF_EXPANSION_BY_KEY[key] ?? [];
}
