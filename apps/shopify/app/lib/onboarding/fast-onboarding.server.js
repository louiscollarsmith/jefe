// @ts-nocheck

import crypto from "node:crypto";
import { isActionExecuteEnabled } from "../actions/action-intent.server.js";
import { updateMerchantActionForRecommendation } from "../actions/merchant-action.server.js";
import { advanceActionWorkflow } from "../actions/action-step-lifecycle.server.js";
import { labelForBeliefKey } from "../merchant-memory/conversational-belief-registry.server.js";
import { renderBeliefStatement } from "../merchant-memory/belief-statement.server.js";
import { ACTIVE_BELIEF_STATUSES } from "../merchant-memory/constants.server.js";
import { upsertMerchantSuppliedBelief } from "../merchant-memory/service.server.js";
import { trackOnce } from "../../services/analytics/event-log.server.js";
import {
  BOOTSTRAP_BACKFILL_DOMAIN,
  ensureBootstrapAlternativeQueued,
  ensureMerchantBootstrapQueued,
  ensureRecommendationReviewQueued,
  FULL_BACKFILL_JOB_TYPES,
  INITIAL_COMMERCE_BACKFILL_DOMAINS,
  MERCHANT_BOOTSTRAP_JOB_TYPE,
  retryFailedBackfillJobs,
} from "../../services/shopify-backfill-status.server.js";
import { ensureMerchantPlanQueued } from "../merchant-plan/service.server.js";
import { PLAN_RUN_STATUS } from "../merchant-plan/constants.server.js";

export const ONBOARDING_CONTEXT_OPTIONS = Object.freeze([
  { value: "revenue", label: "Grow revenue", echo: "revenue comes first" },
  { value: "profit", label: "Improve margin", echo: "margin comes first" },
  { value: "slow_inventory", label: "Move slow inventory", echo: "you want slow stock moving" },
  { value: "retention", label: "Increase repeat purchases", echo: "you want customers coming back" },
  { value: "jefe_read_first", label: "Not sure — tell me what you see", echo: "you wanted my read first" },
]);

const MILESTONES = new Set([
  "first_insight_shown",
  "recommendation_shown",
]);

export async function getFastOnboardingExperience(prisma, input) {
  const [shop, bootstrapStatus, bootstrapJob, priority, recommendations, latestPlanRun, fullStatuses, fullJobs] = await Promise.all([
    prisma.shop.findUniqueOrThrow({
      where: { id: input.shopId },
      select: { onboardingCompletedAt: true, onboardingMetadata: true, backfillCompletedAt: true },
    }),
    prisma.shopBackfillStatus.findUnique({
      where: { shopId_domain: { shopId: input.shopId, domain: BOOTSTRAP_BACKFILL_DOMAIN } },
    }),
    prisma.backfillJob.findUnique({
      where: { shopId_jobType: { shopId: input.shopId, jobType: MERCHANT_BOOTSTRAP_JOB_TYPE } },
    }),
    prisma.merchantMemoryBelief.findFirst({
      where: {
        merchantId: input.merchantId,
        key: "preferences.optimisation_priority",
        status: { in: ACTIVE_BELIEF_STATUSES },
      },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.merchantPlanRecommendation.findMany({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        sourceMode: { in: ["bootstrap", "full"] },
      },
      orderBy: [{ createdAt: "desc" }],
      include: {
        run: { select: { insightRunId: true, result: true } },
        evidenceSnapshot: true,
        ...recommendationWorkflowInclude(),
      },
    }),
    prisma.merchantPlanRun?.findFirst
      ? prisma.merchantPlanRun.findFirst({
          where: {
            merchantId: input.merchantId,
            shopId: input.shopId,
            sourceMode: { in: ["bootstrap", "full"] },
          },
          select: {
            id: true,
            status: true,
            sourceMode: true,
            safeErrorCode: true,
            lastError: true,
            failedAt: true,
            updatedAt: true,
          },
          orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
        })
      : null,
    prisma.shopBackfillStatus.findMany({
      where: {
        shopId: input.shopId,
        domain: { in: INITIAL_COMMERCE_BACKFILL_DOMAINS },
      },
      select: { domain: true, status: true, lastError: true },
    }),
    prisma.backfillJob.findMany({
      where: { shopId: input.shopId, jobType: { in: FULL_BACKFILL_JOB_TYPES } },
      select: { jobType: true, status: true, lastError: true },
    }),
  ]);

  const handoff = input.handoffToken
    ? await findValidHandoff(prisma, { shopId: input.shopId, token: input.handoffToken })
    : null;
  const context = contextFromBelief(priority);
  const selected = selectRecommendation(recommendations, handoff != null);
  const finding = selected?.supportingInsightIds?.length
    ? await prisma.merchantInsightFinding.findFirst({
        where: {
          merchantId: input.merchantId,
          shopId: input.shopId,
          id: { in: selected.supportingInsightIds },
        },
      })
    : null;
  const beliefs = selected?.supportingBeliefIds?.length
    ? await prisma.merchantMemoryBelief.findMany({
        where: {
          merchantId: input.merchantId,
          shopId: input.shopId,
          id: { in: selected.supportingBeliefIds },
        },
        include: { evidence: { orderBy: { createdAt: "desc" }, take: 1 } },
      })
    : [];

  const metadata = jsonObject(shop.onboardingMetadata);
  const onboardingEpoch = bootstrapEpoch(bootstrapStatus, bootstrapJob);
  const bootstrapPhase = stringValue(jsonObject(bootstrapStatus?.metadata).phase) ??
    (bootstrapJob?.status === "queued" ? "queued" : bootstrapJob?.status === "running" ? "starting" : "not_started");
  const fullLearning = shapeFullLearning(fullStatuses, fullJobs);
  const failure = classifyFailure(bootstrapStatus, bootstrapJob, {
    bootstrapPhase,
    contextAnswered: Boolean(context),
    hasSurfaceableRecommendation: Boolean(selected),
    inAppHandoff: Boolean(handoff),
    fullLearningState: fullLearning.state,
    latestPlanRun,
  });
  let stage = "connect";
  if (handoff) stage = "app";
  else if (
    context ||
    bootstrapStatus?.startedAt ||
    !["not_started", "queued"].includes(bootstrapPhase) ||
    bootstrapJob?.status === "running" ||
    bootstrapJob?.status === "succeeded" ||
    bootstrapStatus?.status === "complete" ||
    bootstrapStatus?.status === "failed"
  ) {
    if (!context) stage = "context";
    else if (selected) stage = metadata.fastOnboardingStage === "action" ? "action" : "insight";
    else stage = "context";
  }

  if (stage === "context") {
    void trackOnce(prisma, {
      type: "context_question_shown",
      topic: "onboarding",
      merchantId: input.merchantId,
      shopId: input.shopId,
      shopDomain: input.shopDomain,
      dedupeKey: `context_question_shown:${input.shopId}:${onboardingEpoch}`,
      summary: `Onboarding context question shown for ${input.shopDomain}`,
      properties: {
        bootstrapJobId: bootstrapJob?.id ?? null,
        onboardingEpoch,
      },
    });
  }

  const evidence = shapeEvidence(beliefs).slice(0, 3);
  const recommendation = selected ? shapeRecommendation(selected) : null;
  const insight = finding && selected
    ? {
        id: finding.id,
        runId: selected.run.insightRunId,
        headline: humanizeOnboardingInsightText(finding.title),
        explanation: humanizeOnboardingInsightText(finding.finding),
        whyItMatters: finding.whyItMatters,
        confidence: finding.confidence,
        caveat: finding.caveat ? humanizeOnboardingInsightText(finding.caveat) : null,
        evidence,
      }
    : null;
  const queueItems = recommendations
    .filter(
      (row) =>
        ["proposed", "deferred", "accepted", "needs_review"].includes(
          row.reviewStatus,
        ) && (!selected || row.id !== selected.id),
    )
    .slice(0, 2)
    .map((row) => ({
      id: row.id,
      title: row.title,
      status: queueStatus(row),
    }));

  return {
    stage,
    bootstrapPhase,
    context,
    insight,
    recommendation,
    queueItems,
    failure,
    fullLearning,
    handoff: handoff ? { id: handoff.id, token: input.handoffToken } : null,
    devToolsEnabled: process.env.ENABLE_DEV_TOOLS === "true",
  };
}

export async function answerOnboardingContext(prisma, input) {
  const option = ONBOARDING_CONTEXT_OPTIONS.find((candidate) => candidate.value === input.value);
  if (!option) return { ok: false, error: "Choose one of the available priorities." };
  await upsertMerchantSuppliedBelief(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    category: "preferences",
    key: "preferences.optimisation_priority",
    value: { option: option.value, label: option.label, echo: option.echo },
    valueType: "enum",
    suppliedBy: "fast_onboarding_context",
    evidenceSummary: `Merchant chose “${option.label}” during onboarding.`,
    evidenceSourceType: "merchant_input",
    evidenceSourceReference: "fast_onboarding_context",
    metadata: { suppliedLabel: option.label, acknowledgementEcho: option.echo },
  });
  const bootstrap = await prisma.backfillJob.findUnique({
    where: { shopId_jobType: { shopId: input.shopId, jobType: MERCHANT_BOOTSTRAP_JOB_TYPE } },
  });
  const result = jsonObject(bootstrap?.resultJson);
  const onboardingEpoch = bootstrapEpoch(null, bootstrap);
  const eligible = stringArray(result.eligibleContracts);
  if (eligible.length > 0) {
    await ensureBootstrapAlternativeQueued(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      contractKey: rankContracts(eligible, option.value)[0],
    });
  }
  void trackOnce(prisma, {
    type: "context_answered",
    topic: "onboarding",
    merchantId: input.merchantId,
    shopId: input.shopId,
    shopDomain: input.shopDomain,
    dedupeKey: `context_answered:${input.shopId}:${onboardingEpoch}`,
    summary: `Onboarding context answered for ${input.shopDomain}`,
    properties: {
      priority: option.value,
      bootstrapJobId: bootstrap?.id ?? null,
      onboardingEpoch,
    },
  });
  return { ok: true, context: option };
}

export async function continueOnboardingInsight(prisma, input) {
  const recommendation = await ownedRecommendation(prisma, input);
  if (!recommendation) return { ok: false, error: "That recommendation is no longer available." };
  await mergeOnboardingMetadata(prisma, input.shopId, { fastOnboardingStage: "action" });
  return { ok: true };
}

export async function requestOnboardingAlternative(prisma, input) {
  const bootstrap = await prisma.backfillJob.findUnique({
    where: { shopId_jobType: { shopId: input.shopId, jobType: MERCHANT_BOOTSTRAP_JOB_TYPE } },
  });
  const eligible = stringArray(jsonObject(bootstrap?.resultJson).eligibleContracts);
  const runs = await prisma.merchantPlanRun.findMany({
    where: { merchantId: input.merchantId, shopId: input.shopId, sourceMode: "bootstrap" },
    select: { result: true },
  });
  const generated = new Set(runs.map((run) => stringValue(jsonObject(run.result).contractKey)).filter(Boolean));
  const priority = await prisma.merchantMemoryBelief.findFirst({
    where: { merchantId: input.merchantId, key: "preferences.optimisation_priority", status: { in: ACTIVE_BELIEF_STATUSES } },
    orderBy: { updatedAt: "desc" },
  });
  const next = rankContracts(eligible, contextFromBelief(priority)?.value ?? "jefe_read_first")
    .find((contractKey) => !generated.has(contractKey));
  if (!next) return { ok: true, queued: false, reason: "strongest_supported_finding" };
  await ensureBootstrapAlternativeQueued(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    contractKey: next,
  });
  await mergeOnboardingMetadata(prisma, input.shopId, { fastOnboardingStage: "insight" });
  return { ok: true, queued: true };
}

export async function approveOnboardingRecommendation(prisma, input) {
  const recommendation = await ownedRecommendation(prisma, input, true);
  if (!recommendation) return { ok: false, error: "That recommendation is no longer available." };
  if (
    isRunnableOnboardingExecution(
      currentExecutionFromRecommendation(recommendation),
      input.merchantId,
      input.shopId,
    )
  ) {
    const execution = currentExecutionFromRecommendation(recommendation);
    return {
      ok: true,
      mode: "execute",
      actionRunId: execution.runId,
      recommendationId: recommendation.id,
    };
  }
  const acceptedAt = recommendation.acceptedAt ?? new Date();
  const reviewAt = recommendation.reviewAt ?? new Date(Date.now() + 14 * 86400000);
  await acceptRecommendationWorkflow(prisma, {
    recommendationId: recommendation.id,
    merchantId: input.merchantId,
    shopId: input.shopId,
    data: { reviewStatus: "accepted", acceptedAt, reviewAt, outcomeStatus: "pending" },
  });
  await ensureRecommendationReviewQueued(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    runAfter: reviewAt,
    payload: { reason: "tracked_onboarding_recommendation" },
  });
  return completeRecommendationHandoff(prisma, input, recommendation.id, "approved_track_only");
}

export async function completeExecutedRecommendationHandoff(prisma, input) {
  await acceptRecommendationWorkflow(prisma, {
    recommendationId: input.recommendationId,
    merchantId: input.merchantId,
    shopId: input.shopId,
    data: { reviewStatus: "accepted", acceptedAt: new Date() },
  });
  return completeRecommendationHandoff(prisma, input, input.recommendationId, "approved_execution");
}

export async function deferOnboardingRecommendation(prisma, input) {
  const recommendation = await ownedRecommendation(prisma, input);
  if (!recommendation) return { ok: false, error: "That recommendation is no longer available." };
  await prisma.merchantPlanRecommendation.update({
    where: { id: recommendation.id },
    data: { reviewStatus: "deferred" },
  });
  await updateMerchantActionForRecommendation(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    recommendationId: recommendation.id,
    recommendation: { ...recommendation, reviewStatus: "deferred" },
  });
  return createOnboardingHandoff(prisma, input, "recommendation_deferred");
}

export async function skipFastOnboarding(prisma, input) {
  return createOnboardingHandoff(prisma, input, "skipped");
}

export async function retryFastOnboarding(prisma, input) {
  if (input.target === "full_learning") {
    const retried = await retryFailedBackfillJobs(prisma, {
      shopId: input.shopId,
      jobTypes: FULL_BACKFILL_JOB_TYPES,
    });
    return { ok: true, retried: retried.retried };
  }
  if (input.target === "merchant_plan") {
    await ensureMerchantPlanQueued(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      resetAttempts: true,
      proposalTrigger: "merchant_onboarding",
    });
    await mergeOnboardingMetadata(prisma, input.shopId, { fastOnboardingStage: "context" });
    return { ok: true };
  }
  await ensureMerchantBootstrapQueued(prisma, { ...input, reset: true });
  await mergeOnboardingMetadata(prisma, input.shopId, { fastOnboardingStage: "context" });
  return { ok: true };
}

export async function recordFastOnboardingMilestone(prisma, input) {
  const bootstrap = await prisma.backfillJob.findUnique({
    where: {
      shopId_jobType: {
        shopId: input.shopId,
        jobType: MERCHANT_BOOTSTRAP_JOB_TYPE,
      },
    },
    select: { payloadJson: true },
  });
  const onboardingEpoch = bootstrapEpoch(null, bootstrap);
  if (input.type === "entered_app") {
    const handoff = await findValidHandoff(prisma, { shopId: input.shopId, token: input.token });
    if (!handoff) return { ok: false };
    await prisma.onboardingHandoff.updateMany({
      where: { id: handoff.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    await trackOnce(prisma, {
      type: "entered_app",
      topic: "onboarding",
      merchantId: input.merchantId,
      shopId: input.shopId,
      shopDomain: input.shopDomain,
      dedupeKey: `entered_app:${handoff.id}`,
      summary: `Merchant entered Jefe after onboarding for ${input.shopDomain}`,
      properties: { handoffId: handoff.id, onboardingEpoch },
    });
    return { ok: true };
  }
  if (!MILESTONES.has(input.type) || !input.entityId) return { ok: false };
  await trackOnce(prisma, {
    type: input.type,
    topic: "onboarding",
    merchantId: input.merchantId,
    shopId: input.shopId,
    shopDomain: input.shopDomain,
    dedupeKey: `${input.type}:${onboardingEpoch}:${input.entityId}`,
    summary: `${input.type.replaceAll("_", " ")} for ${input.shopDomain}`,
    properties: { entityId: input.entityId, onboardingEpoch },
  });
  return { ok: true };
}

async function completeRecommendationHandoff(prisma, input, recommendationId, reason) {
  const bootstrap = await prisma.backfillJob.findUnique({
    where: {
      shopId_jobType: {
        shopId: input.shopId,
        jobType: MERCHANT_BOOTSTRAP_JOB_TYPE,
      },
    },
    select: { payloadJson: true },
  });
  const onboardingEpoch = bootstrapEpoch(null, bootstrap);
  void trackOnce(prisma, {
    type: "recommendation_approved",
    topic: "onboarding",
    merchantId: input.merchantId,
    shopId: input.shopId,
    shopDomain: input.shopDomain,
    dedupeKey: `recommendation_approved:${onboardingEpoch}:${recommendationId}`,
    summary: `Onboarding recommendation approved for ${input.shopDomain}`,
    properties: { recommendationId, onboardingEpoch },
  });
  const handoff = await createOnboardingHandoff(prisma, input, reason);
  return reason === "approved_execution" ? { ...handoff, mode: "execute" } : handoff;
}

async function createOnboardingHandoff(prisma, input, reason) {
  const token = crypto.randomBytes(24).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  const handoff = await prisma.$transaction(async (tx) => {
    await tx.shop.update({
      where: { id: input.shopId },
      data: {
        onboardingCompletedAt: new Date(),
        onboardingMetadata: {
          ...jsonObject((await tx.shop.findUnique({ where: { id: input.shopId }, select: { onboardingMetadata: true } }))?.onboardingMetadata),
          completedStep: "app",
          completedSource: reason,
          fastOnboardingStage: "app",
        },
      },
    });
    return tx.onboardingHandoff.create({
      data: { merchantId: input.merchantId, shopId: input.shopId, tokenHash, reason, expiresAt },
    });
  });
  return { ok: true, mode: "track", token, handoffId: handoff.id };
}

async function findValidHandoff(prisma, input) {
  if (!input.token) return null;
  return prisma.onboardingHandoff.findFirst({
    where: {
      shopId: input.shopId,
      tokenHash: hashToken(input.token),
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
}

async function ownedRecommendation(prisma, input, includeExecution = false) {
  return prisma.merchantPlanRecommendation.findFirst({
    where: {
      id: input.recommendationId,
      merchantId: input.merchantId,
      shopId: input.shopId,
      sourceMode: { in: ["bootstrap", "full"] },
    },
    include: includeExecution ? recommendationWorkflowInclude() : undefined,
  });
}

async function mergeOnboardingMetadata(prisma, shopId, patch) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { onboardingMetadata: true } });
  return prisma.shop.update({
    where: { id: shopId },
    data: { onboardingMetadata: { ...jsonObject(shop?.onboardingMetadata), ...patch } },
  });
}

function selectRecommendation(recommendations, inApp) {
  if (inApp) {
    return recommendations.find((row) => ["accepted", "needs_review"].includes(row.reviewStatus)) ?? null;
  }
  return recommendations.find((row) => row.reviewStatus === "proposed") ?? null;
}

export function shapeRecommendation(row) {
  const success = jsonObject(row.successSignal);
  const executable = isRunnableOnboardingExecution(
    currentExecutionFromRecommendation(row),
    row.merchantId,
    row.shopId,
  );
  const execution = currentExecutionFromRecommendation(row);
  return {
    id: row.id,
    runId: row.runId,
    title: row.title,
    summary: row.summary,
    whyItMatters: row.whyThisAction,
    whatIllDo: row.startToday,
    howWellKnow: stringValue(success.description) ?? row.expectedBenefit,
    successMeasure: stringValue(success.description) ?? null,
    reviewAt: row.reviewAt?.toISOString() ?? null,
    status: row.reviewStatus,
    outcomeStatus: row.outcomeStatus,
    executable,
    actionRunId: execution?.runId ?? null,
    executionStatus: execution?.status ?? null,
    approvalLabel: executable ? "Approve — I’ll handle it" : "Track this for me",
    sourceMode: row.sourceMode,
  };
}

function shapeEvidence(beliefs) {
  return [...beliefs]
    .sort((left, right) => evidencePriority(left.key) - evidencePriority(right.key))
    .flatMap((belief) => {
      const value = evidenceValue(belief);
      return value
        ? [{ key: onboardingEvidenceLabel(belief.key), value, source: "Shopify" }]
        : [];
    });
}

const ONBOARDING_EVIDENCE_LABELS = {
  "inventory.low_cover_products.trailing_30d": "Running low",
  "inventory.at_risk_stockout_count.trailing_30d": "Stock risk",
  "catalog.active_product_count": "Your range",
  "catalog.total_variant_count": "Sizes & colours",
  "business.catalogue_shape": "Your shop",
  "catalog.out_of_stock_product_count": "Out of stock",
  "catalog.zero_price_variant_count": "Pricing",
  "products.top_product_revenue_share.trailing_90d": "Revenue mix",
  "products.bestseller_by_revenue.trailing_90d": "Best seller",
  "business.discount_depth.trailing_90d": "Discounting",
  "data.line_item_product_link_coverage": "Recent orders",
  "data.inventory_variant_coverage": "Stock levels",
  "data.line_item_variant_link_coverage": "Recent orders",
};

function onboardingEvidenceLabel(key) {
  return ONBOARDING_EVIDENCE_LABELS[key] ?? labelForBeliefKey(key);
}

function evidencePriority(key) {
  const ordered = [
    "inventory.low_cover_products.trailing_30d",
    "inventory.at_risk_stockout_count.trailing_30d",
    "products.top_product_revenue_share.trailing_90d",
    "products.bestseller_by_revenue.trailing_90d",
    "business.discount_depth.trailing_90d",
  ];
  const index = ordered.indexOf(key);
  return index === -1 ? ordered.length : index;
}

function evidenceValue(belief) {
  const statement = renderBeliefStatement(belief);
  if (statement) return statement;

  const value = jsonObject(belief.value);
  if (belief.key === "catalog.active_product_count") {
    const count = Number(value.count ?? value.number);
    return Number.isFinite(count) ? `You're selling ${count} live products.` : null;
  }
  if (belief.key === "catalog.total_variant_count") {
    const count = Number(value.count ?? value.number);
    return Number.isFinite(count)
      ? `${count} sizes and colours across those products.`
      : null;
  }
  if (belief.key === "business.catalogue_shape") {
    const products = Number(value.activeProductCount);
    const variants = Number(value.activeVariantCount);
    if (!Number.isFinite(products)) return null;
    const shape = String(value.enum ?? "");
    if (shape === "single_product") return "You're focused on one product right now.";
    if (shape === "focused") {
      return `${products} products — a compact range to stay on top of.`;
    }
    if (shape === "broad") {
      return `${products} products — a broad range to manage.`;
    }
    if (shape === "long_tail") {
      return `${products} products — a wide catalogue with a long tail.`;
    }
    return Number.isFinite(variants)
      ? `${products} products with ${variants} sizes and colours between them.`
      : `${products} products in your live range.`;
  }
  if (belief.key === "inventory.at_risk_stockout_count.trailing_30d") {
    const count = Number(value.count);
    return Number.isFinite(count) && count > 0
      ? `${count} product${count === 1 ? "" : "s"} at risk of running out soon.`
      : null;
  }
  if (belief.key === "catalog.out_of_stock_product_count") {
    const count = Number(value.count);
    return Number.isFinite(count) && count > 0
      ? `${count} product${count === 1 ? " is" : "s are"} out of stock right now.`
      : null;
  }
  if (Number.isFinite(Number(value.percentage))) {
    return "This stood out in your recent trading.";
  }
  if (Number.isFinite(Number(value.count))) {
    return "Worth a look in your recent trading.";
  }
  return null;
}

function humanizeOnboardingInsightText(text) {
  if (!text || typeof text !== "string") return text;
  return text
    .replace(/\bactive product catalog\b/gi, "product range")
    .replace(/\bproduct catalog\b/gi, "product range")
    .replace(/\bactive variants?\b/gi, "sizes and colours")
    .replace(/\brecorded prices\b/gi, "prices set")
    .replace(/\bvariant link coverage\b/gi, "orders linking to products")
    .replace(/\bcomplete variant link coverage\b/gi, "orders linking cleanly to products")
    .replace(/\bactive items\b/gi, "products")
    .replace(/\bcatalog consists of\b/gi, "has")
    .replace(/\bcatalogue consists of\b/gi, "has")
    .replace(/\bcaptured evidence contains a supported recent signal\.?/gi, "This showed up clearly in your recent trading.")
    .replace(/\bthe captured evidence\b/gi, "what I've read")
    .replace(/\bsupported recent signal\b/gi, "clear recent pattern")
    .replace(/\bdays of cover at the observed pace\b/gi, "days of stock left at the current pace")
    .replace(/\bat most about 0 days of cover\b/gi, "may already be out of stock")
    .trim();
}

export function shapeFullLearning(statuses, jobs) {
  const failed =
    jobs.find((job) => job.status === "failed") ??
    statuses.find(
      (status) =>
        INITIAL_COMMERCE_BACKFILL_DOMAINS.includes(status.domain) &&
        status.status === "failed",
    );
  if (failed && /access|permission|scope|unauth|403/i.test(failed.lastError ?? "")) {
    return {
      state: "access_failure",
      label: "Jefe needs Shopify access to keep learning",
      detail: "Reconnect Shopify so I can continue reading the history behind future recommendations.",
    };
  }
  if (failed) {
    return {
      state: "failed",
      label: "Jefe paused while learning your business",
      detail: "Retry the background read and I’ll continue from the durable store record.",
    };
  }
  const fullComplete = INITIAL_COMMERCE_BACKFILL_DOMAINS.every(
    (domain) => statuses.some((status) => status.domain === domain && status.status === "complete"),
  ) && jobs.some(
    (job) => job.jobType === "backfill_finalize" && job.status === "succeeded",
  );
  if (fullComplete) {
    return {
      state: "complete",
      label: "Jefe has finished reading your available history",
      detail: "I’ve finished reading the Shopify history currently available to me, and I’ll keep your understanding current as the store changes.",
    };
  }
  return {
    state: "learning",
    label: "Jefe is still learning your business",
    detail: "I’ve read your recent trading and I’m working back through your order, refund and customer history. My recommendations get sharper as that lands — nothing to wait for.",
  };
}

export function classifyFailure(status, job, experience = {}) {
  const failed = status?.status === "failed" || job?.status === "failed";
  if (!failed) {
    if (
      experience.contextAnswered === true &&
      experience.hasSurfaceableRecommendation !== true &&
      [PLAN_RUN_STATUS.failed, PLAN_RUN_STATUS.modelDisabled].includes(
        experience.latestPlanRun?.status,
      )
    ) {
      if (experience.latestPlanRun.status === PLAN_RUN_STATUS.modelDisabled) {
        return {
          type: "retryable",
          retryTarget: "merchant_plan",
          message:
            "I can’t generate the first recommendation while AI generation is disabled. Turn AI generation back on and I can retry from the same durable evidence.",
        };
      }
      return {
        type: "retryable",
        retryTarget: "merchant_plan",
        message:
          "I couldn’t safely turn the store evidence into a recommendation. I can retry the generation from the same durable evidence.",
      };
    }
    const phase =
      stringValue(experience.bootstrapPhase) ??
      stringValue(jsonObject(status?.metadata).phase);
    if (experience.hasSurfaceableRecommendation === true) return null;
    if (phase === "generation_failed") {
      return {
        type: "retryable",
        message: "I couldn’t safely turn the store evidence into a recommendation. I can retry the generation from the same durable evidence.",
      };
    }
    if (["insufficient_evidence", "model_disabled"].includes(phase)) {
      if (phase === "model_disabled") {
        return {
          type: "retryable",
          message: "I can’t generate the first recommendation while AI generation is disabled. Turn AI generation back on and I can retry from the same durable evidence.",
        };
      }
      // Recommendation rows can land just after the bootstrap phase flips. Treat
      // thin evidence as "keep checking" in onboarding rather than a terminal
      // merchant-facing dead end; a manual refresh should never be required to
      // reveal an insight that already exists.
      return null;
    }
    if (
      phase === "ready" &&
      experience.contextAnswered === true &&
      experience.hasSurfaceableRecommendation === false &&
      experience.inAppHandoff !== true
    ) {
      return null;
    }
    return null;
  }
  const message = `${status?.lastError ?? ""} ${job?.lastError ?? ""}`;
  if (/access|permission|scope|unauth|403/i.test(message)) {
    return { type: "access", message: "I need Shopify access again before I can finish this read." };
  }
  return { type: "retryable", message: "I hit a snag reading the recent store evidence. I can safely retry from here." };
}

export function contextFromBelief(belief) {
  const value = jsonObject(belief?.value);
  const selectedValue = value.option ?? value.value ?? belief?.value;
  const option = ONBOARDING_CONTEXT_OPTIONS.find((candidate) => candidate.value === selectedValue);
  return option ? { ...option, label: stringValue(value.label) ?? option.label, echo: stringValue(value.echo) ?? option.echo } : null;
}

function isRunnableOnboardingExecution(
  execution,
  merchantId,
  shopId,
) {
  return Boolean(
    execution &&
      execution.merchantId === merchantId &&
      execution.shopId === shopId &&
      ["proposed", "approved"].includes(execution.status) &&
      execution.actionType === "price_markdown" &&
      isActionExecuteEnabled(execution.actionType) &&
      execution.resolvedMode !== "recommend",
  );
}

function recommendationWorkflowInclude() {
  return {
    workflows: {
      orderBy: { version: "desc" },
      take: 1,
      include: {
        steps: {
          orderBy: { orderIndex: "asc" },
          include: {
            actionExecutions: {
              orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
              take: 1,
            },
          },
        },
      },
    },
  };
}

function currentExecutionFromRecommendation(recommendation) {
  const workflow = Array.isArray(recommendation?.workflows)
    ? recommendation.workflows[0] ?? null
    : null;
  const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
  return steps.map((step) => step.actionExecutions?.[0]).find(Boolean) ?? null;
}

/**
 * @param {any} prisma
 * @param {{ recommendationId: string; merchantId: string; shopId: string; data: Record<string, any> }} input
 */
async function acceptRecommendationWorkflow(prisma, input) {
  const run = async (tx) => {
    await tx.merchantPlanRecommendation.updateMany({
      where: {
        id: input.recommendationId,
        merchantId: input.merchantId,
        shopId: input.shopId,
      },
      data: input.data,
    });
    await tx.merchantRecommendationWorkflow.updateMany({
      where: {
        recommendationId: input.recommendationId,
        merchantId: input.merchantId,
        shopId: input.shopId,
        status: "draft",
      },
      data: { status: "active" },
    });
    await updateMerchantActionForRecommendation(tx, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      recommendationId: input.recommendationId,
      recommendation: input.data,
    });
    const workflow = tx.merchantRecommendationWorkflow.findFirst
      ? await tx.merchantRecommendationWorkflow.findFirst({
          where: {
            recommendationId: input.recommendationId,
            merchantId: input.merchantId,
            shopId: input.shopId,
          },
          orderBy: { version: "desc" },
          select: { id: true },
        })
      : null;
    const actionRow = tx.merchantAction?.findFirst
      ? await tx.merchantAction.findFirst({
          where: {
            merchantId: input.merchantId,
            shopId: input.shopId,
            sourceRecommendationId: input.recommendationId,
          },
          select: { id: true },
        })
      : null;
    if (workflow?.id) {
      await advanceActionWorkflow(tx, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        actionId: actionRow?.id ?? null,
        workflowId: workflow.id,
      });
    }
  };
  return prisma.$transaction ? prisma.$transaction(run) : run(prisma);
}

function bootstrapEpoch(status, job) {
  return (
    stringValue(jsonObject(job?.payloadJson).onboardingEpoch) ??
    stringValue(jsonObject(status?.metadata).onboardingEpoch) ??
    "legacy"
  );
}

function rankContracts(contracts, priority) {
  const preference = {
    slow_inventory: ["stockout_protection", "discount_review", "sales_concentration"],
    profit: ["stockout_protection", "discount_review", "sales_concentration"],
    revenue: ["stockout_protection", "sales_concentration", "discount_review"],
    growth: ["stockout_protection", "sales_concentration", "discount_review"],
    retention: ["stockout_protection", "sales_concentration", "discount_review"],
    jefe_read_first: ["stockout_protection", "sales_concentration", "discount_review"],
  }[priority] ?? ["stockout_protection", "sales_concentration", "discount_review"];
  return [...contracts].sort((a, b) => preference.indexOf(a) - preference.indexOf(b));
}

function queueStatus(row) {
  if (row.reviewStatus === "accepted") return "TRACKING";
  if (row.reviewStatus === "deferred") return "ON YOUR LIST";
  return "READY WHEN YOU ARE";
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item) : [];
}

function stringValue(value) {
  return typeof value === "string" && value ? value : null;
}
