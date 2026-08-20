// @ts-nocheck

import { createHash } from "node:crypto";
import {
  ACTIVE_BELIEF_STATUSES,
  BELIEF_PRECEDENCE,
  BELIEF_STATUS,
} from "../merchant-memory/constants.server.js";
import { getBeliefDefinition } from "../merchant-memory/conversational-belief-registry.server.js";
import { GOAL_RUN_STATUS } from "../merchant-goals/constants.server.js";
import { INSIGHT_RUN_STATUS } from "../merchant-insights/constants.server.js";
import {
  MAX_PLAN_BELIEFS,
  MERCHANT_PLAN_SNAPSHOT_VERSION,
  PLAN_REVIEW_STATUS,
} from "./constants.server.js";
import { expandBeliefRowsForContext } from "../merchant-memory/context-retriever.server.js";
import { retrieveMerchantContext } from "../merchant-memory/merchant-context.server.js";
import { inspectActionIntentOpportunity } from "../actions/action-resolution.server.js";
import { listExecutableStepCapabilities } from "./step-capabilities.server.js";

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string }} input
 */
export async function buildMerchantPlanSnapshot(prisma, input) {
  const [
    goalRun,
    insightRun,
    beliefs,
    contextEvidence,
    priorRecommendations,
    unifiedContext,
  ] = await Promise.all([
    prisma.merchantGoalRun.findFirst({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        status: GOAL_RUN_STATUS.completed,
        supersededAt: null,
      },
      include: { horizons: { orderBy: { orderIndex: "asc" } } },
      orderBy: { completedAt: "desc" },
    }),
    prisma.merchantInsightRun.findFirst({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        status: INSIGHT_RUN_STATUS.completed,
        supersededAt: null,
      },
      include: { findings: { orderBy: { orderIndex: "asc" } } },
      orderBy: { completedAt: "desc" },
    }),
    prisma.merchantMemoryBelief.findMany({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        status: { in: ACTIVE_BELIEF_STATUSES },
        supersededAt: null,
      },
      include: {
        evidence: { orderBy: { createdAt: "desc" }, take: 2 },
      },
      orderBy: [{ category: "asc" }, { key: "asc" }, { updatedAt: "desc" }],
    }),
    prisma.merchantMemoryEvidence.findMany({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        evidenceType: {
          in: [
            "merchant_goal_coaching",
            "merchant_goal_document_context",
            "merchant_insight_correction",
            "merchant_plan_refinement",
          ],
        },
      },
      orderBy: { createdAt: "desc" },
      take: 12,
    }),
    prisma.merchantPlanRecommendation.findMany({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        reviewStatus: {
          in: [
            PLAN_REVIEW_STATUS.accepted,
            PLAN_REVIEW_STATUS.rejected,
            PLAN_REVIEW_STATUS.refinementRequested,
            PLAN_REVIEW_STATUS.completed,
          ],
        },
      },
      include: { run: true },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
    retrieveMerchantContext(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      task: "plan",
      query:
        "Choose the next action that best advances current goals while respecting every current merchant policy and constraint.",
      tokenBudget: 8000,
    }),
  ]);

  const allowedGoalIds = new Set(
    (goalRun?.horizons ?? []).map((goal) => goal.id),
  );
  const allowedInsightIds = new Set(
    (insightRun?.findings ?? []).map((finding) => finding.id),
  );
  const directlySupportedBeliefIds = new Set([
    ...(goalRun?.horizons ?? []).flatMap((goal) => goal.supportingBeliefIds),
    ...(insightRun?.findings ?? []).flatMap(
      (finding) => finding.supportingBeliefIds,
    ),
  ]);
  const eligibleBeliefs = beliefs.filter(
    (belief) => !isGeneratedOnboardingBelief(belief),
  );
  const seedBeliefRows = eligibleBeliefs
    .map((belief) => ({
      belief,
      score: beliefRelevanceScore(belief, directlySupportedBeliefIds),
    }))
    .filter((item) => item.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        String(a.belief.category).localeCompare(String(b.belief.category)) ||
        String(a.belief.key).localeCompare(String(b.belief.key)),
    )
    .slice(0, MAX_PLAN_BELIEFS)
    .map((item) => item.belief);
  const selectedBeliefs = expandBeliefRowsForContext({
    allBeliefs: eligibleBeliefs,
    seedBeliefs: seedBeliefRows,
    max: MAX_PLAN_BELIEFS,
  })
    .map((belief) => normalizeBelief(belief))
    .filter(Boolean);

  const goals = (goalRun?.horizons ?? []).map((goal) => ({
    id: goal.id,
    horizon: goal.horizon,
    title: safeText(goal.title, 90),
    description: safeText(goal.description, 260),
    supportingBeliefIds: goal.supportingBeliefIds.filter((id) =>
      selectedBeliefs.some((belief) => belief.id === id),
    ),
  }));
  const insights = (insightRun?.findings ?? []).map((finding) => ({
    id: finding.id,
    title: safeText(finding.title, 90),
    finding: safeText(finding.finding, 260),
    whyItMatters: safeText(finding.whyItMatters, 180),
    category: finding.category,
    confidence: finding.confidence,
    reviewStatus: finding.reviewStatus,
    supportingBeliefIds: finding.supportingBeliefIds.filter((id) =>
      selectedBeliefs.some((belief) => belief.id === id),
    ),
  }));
  const previousRecommendations = priorRecommendations.map((item) => ({
    id: item.id,
    title: safeText(item.title, 90),
    summary: safeText(item.summary, 260),
    reviewStatus: item.reviewStatus,
    acceptedAt: item.acceptedAt?.toISOString?.() ?? null,
    rejectedAt: item.rejectedAt?.toISOString?.() ?? null,
    completedAt: item.completedAt?.toISOString?.() ?? null,
    supersededAt: item.run?.supersededAt?.toISOString?.() ?? null,
  }));
  const opportunityBuild = await buildGroundedOpportunityCandidates(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    beliefs: selectedBeliefs,
  });
  const opportunityCandidates = opportunityBuild.opportunities;

  const snapshot = {
    snapshotVersion: MERCHANT_PLAN_SNAPSHOT_VERSION,
    merchantId: input.merchantId,
    shopId: input.shopId,
    goalRunId: goalRun?.id ?? null,
    insightRunId: insightRun?.id ?? null,
    privacy: {
      source: "merchant_memory_goals_insights_and_safe_context",
      excludesRawShopifyRecords: true,
      // PII scrubbing was removed on 2026-08-13 (founder's call), so this packet no longer
      // excludes customer identifiers. Left declared and FALSE rather than deleted: the model
      // and any reader were being told the data was clean, and a stale `true` here is a lie in
      // the payload rather than a merely out-of-date comment.
      excludesCustomerNamesEmailsPhonesAddresses: false,
      excludesCredentialsAndTokens: true,
      excludesFullUploadedDocuments: true,
    },
    goals,
    insights,
    beliefCount: selectedBeliefs.length,
    beliefs: selectedBeliefs,
    merchantContext: [
      ...contextEvidence
        .map((item) => ({
          id: item.id,
          sourceType: item.sourceType,
          evidenceType: item.evidenceType,
          summary: safeText(item.summary, 700),
          observedAt: item.observedAt?.toISOString?.() ?? null,
        }))
        .reverse(),
      ...unifiedContext.episodicMemory
        .filter(isMerchantAuthoredContext)
        .map((item) => ({
          id: item.id,
          sourceType: "conversation_episode",
          evidenceType:
            item.temporalStatus === "historical"
              ? "historical_context"
              : "current_conversation_context",
          summary: safeText(item.content, 700),
          observedAt: item.occurredAt,
          provenance: item.source,
        })),
      ...unifiedContext.actionMemory
        .filter(isCompletedActionContext)
        .map((item) => ({
          id: item.id,
          sourceType: "action_memory",
          evidenceType: "action_status_or_outcome",
          summary: safeText(item.content, 700),
          observedAt: item.occurredAt,
          provenance: item.source,
        })),
    ],
    previousRecommendations,
    opportunityCandidates,
    opportunityCandidateDiagnostics: opportunityBuild.diagnostics,
  };
  const snapshotHash = hashSnapshot(snapshot);
  return {
    snapshot,
    snapshotHash,
    beliefIds: selectedBeliefs.map((belief) => belief.id),
    goalIds: [...allowedGoalIds],
    insightIds: [...allowedInsightIds],
    candidateCount: selectedBeliefs.length,
    opportunityCount: opportunityCandidates.length,
    goalRunId: goalRun?.id ?? null,
    insightRunId: insightRun?.id ?? null,
    hasGoals: goals.length === 3,
  };
}

async function buildGroundedOpportunityCandidates(prisma, input) {
  const executable = listExecutableStepCapabilities();
  const opportunities = [];
  const diagnostics = [];
  for (const capability of executable) {
    const intent = {
      actionType: capability.actionType,
      targetKind: capability.targetKind,
    };
    const diagnostic = {
      capabilityRef: capability.ref,
      actionType: capability.actionType,
      targetKind: capability.targetKind,
      writeEnabled: capability.writeEnabled === true,
      requiredScopes: capability.requiredScopes ?? [],
      registryResolution: capability.ref,
      dryRun: null,
      gateResult: "rejected",
      rejectionReason: null,
      suppliedToLuna: false,
      candidateId: null,
    };
    if (capability.writeEnabled !== true) {
      diagnostic.rejectionReason = "capability_write_disabled";
      diagnostics.push(diagnostic);
      continue;
    }
    let result;
    try {
      result = await inspectActionIntentOpportunity(prisma, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        intent,
      });
    } catch {
      diagnostic.rejectionReason = "capability_resolver_threw";
      diagnostics.push(diagnostic);
      continue;
    }
    diagnostic.dryRun = {
      status: result.status,
      reason: result.reason ?? null,
      summary: summarizeCapabilityDryRun(result.summary),
    };
    if (result.status !== "ready") {
      diagnostic.rejectionReason = result.reason
        ? `${result.status}:${result.reason}`
        : result.status;
      diagnostics.push(diagnostic);
      continue;
    }
    const opportunity = opportunityFromResolvedCapability({
      capability,
      result,
      beliefs: input.beliefs,
      intent,
    });
    if (opportunity) {
      diagnostic.gateResult = "accepted";
      diagnostic.rejectionReason = null;
      diagnostic.suppliedToLuna = true;
      diagnostic.candidateId = opportunity.id;
      opportunities.push(opportunity);
    } else {
      diagnostic.rejectionReason = "ready_but_missing_candidate_contract";
    }
    diagnostics.push(diagnostic);
  }
  const selected = opportunities.slice(0, 8);
  const selectedIds = new Set(selected.map((opportunity) => opportunity.id));
  for (const diagnostic of diagnostics) {
    if (diagnostic.candidateId && !selectedIds.has(diagnostic.candidateId)) {
      diagnostic.suppliedToLuna = false;
      diagnostic.gateResult = "rejected";
      diagnostic.rejectionReason = "candidate_limit_exceeded";
    }
  }
  return { opportunities: selected, diagnostics };
}

function summarizeCapabilityDryRun(summary) {
  if (!summary || typeof summary !== "object") return null;
  return {
    kind: safeText(summary.kind, 80),
    productCount: numberOrNull(summary.productCount),
    variantCount: numberOrNull(summary.variantCount),
    lineItemCount: numberOrNull(summary.lineItemCount),
    coverDays: numberOrNull(summary.coverDays),
    topItems: Array.isArray(summary.topItems)
      ? summary.topItems.slice(0, 5).map((item) => ({
          title: safeText(item?.title, 120),
          quantity: numberOrNull(item?.quantity),
          available: numberOrNull(item?.available),
          daysOfCover: numberOrNull(item?.daysOfCover),
          unitsSold: numberOrNull(item?.unitsSold),
        }))
      : [],
  };
}

function opportunityFromResolvedCapability({ capability, result, beliefs, intent }) {
  const ref = capability.ref;
  const summary = result.summary ?? {};
  if (ref === "execute:listing_copy:missing_product_type") {
    const reasons = Array.isArray(summary.reasons) ? summary.reasons : [];
    if (reasons.length === 0) return null;
    return {
      id: "opportunity_listing_copy_missing_product_type",
      opportunityType: "catalogue_taxonomy_gap",
      actionIntent: intent,
      title: "Categorise uncategorised Shopify products",
      evidence: reasons.slice(0, 8).map((item, index) => ({
        id: `listing_copy_evidence_${index + 1}`,
        source: "shopify_product_records",
        summary: safeText(
          `${item.title ?? item.productId} has no product type; proposed ${item.proposedType} because ${item.because}.`,
          240,
        ),
        entityIds: [safeIdentifier(item.productId)].filter(Boolean),
      })),
      affectedEntities: reasons.slice(0, 20).map((item) => ({
        kind: "product",
        id: safeIdentifier(item.productId),
        title: safeText(item.title, 160),
      })),
      initialProposal: {
        kind: "product_type_updates",
        productCount: numberOrNull(summary.productCount) ?? reasons.length,
        updates: reasons.slice(0, 20).map((item) => ({
          productId: safeIdentifier(item.productId),
          title: safeText(item.title, 160),
          proposedType: safeText(item.proposedType, 120),
          reason: safeText(item.because, 220),
        })),
        unresolvedCount: numberOrNull(summary.unresolvedCount),
      },
      potentialCapabilities: [capabilityForOpportunity(capability)],
      measurableOutcome:
        "Product type coverage improves on the affected products after Jefe applies the approved updates.",
    };
  }
  if (ref === "execute:price_markdown:dead_stock") {
    const topItems = Array.isArray(summary.topItems) ? summary.topItems : [];
    if (topItems.length === 0) return null;
    const belief = findBelief(beliefs, "products.dead_stock.trailing_90d");
    return {
      id: "opportunity_price_markdown_dead_stock",
      opportunityType: "dead_stock_clearance",
      actionIntent: intent,
      title: "Clear dead stock with a floored markdown",
      evidence: [
        belief
          ? {
              id: belief.id,
              source: "merchant_memory_belief",
              summary: safeText(`${belief.label}: ${JSON.stringify(belief.val)}`, 260),
              entityIds: [],
            }
          : null,
        ...topItems.slice(0, 8).map((item, index) => ({
          id: `dead_stock_evidence_${index + 1}`,
          source: "shopify_product_inventory_and_orders",
          summary: safeText(
            `${item.title ?? "Product"} has ${item.unitsOnHand ?? "stock"} units on hand and no recent sale in the clearance window.`,
            240,
          ),
          entityIds: [],
        })),
      ].filter(Boolean),
      affectedEntities: topItems.slice(0, 20).map((item) => ({
        kind: "variant_or_product",
        id: safeIdentifier(item.variantId ?? item.productId ?? item.title),
        title: safeText(item.title, 160),
      })),
      initialProposal: {
        kind: "floored_markdown",
        variantCount: numberOrNull(summary.variantCount),
        markdownPercent: numberOrNull(summary.markdownPercent),
        totalTrappedCapital: numberOrNull(summary.totalTrappedCapital),
        totalProjectedRecovery: numberOrNull(summary.totalProjectedRecovery),
        topItems: topItems.slice(0, 20),
      },
      potentialCapabilities: [capabilityForOpportunity(capability)],
      measurableOutcome:
        "Jefe measures whether the marked-down dead-stock variants sell after the approved price change.",
    };
  }
  if (ref === "execute:tidy_up:stale_listing") {
    const reasons = Array.isArray(summary.reasons) ? summary.reasons : [];
    if (reasons.length === 0) return null;
    return {
      id: "opportunity_tidy_up_stale_listing",
      opportunityType: "stale_storefront_listing",
      actionIntent: intent,
      title: "Archive unbuyable stale storefront products",
      evidence: reasons.slice(0, 8).map((item, index) => ({
        id: `tidy_up_evidence_${index + 1}`,
        source: "shopify_product_inventory_and_orders",
        summary: safeText(`${item.title ?? item.productId}: ${item.because}.`, 240),
        entityIds: [safeIdentifier(item.productId)].filter(Boolean),
      })),
      affectedEntities: reasons.slice(0, 20).map((item) => ({
        kind: "product",
        id: safeIdentifier(item.productId),
        title: safeText(item.title, 160),
      })),
      initialProposal: {
        kind: "archive_products",
        productCount: numberOrNull(summary.productCount),
        windowDays: numberOrNull(summary.windowDays),
        products: reasons.slice(0, 20),
      },
      potentialCapabilities: [capabilityForOpportunity(capability)],
      measurableOutcome:
        "Buyable active product coverage improves after Jefe archives the approved stale products.",
    };
  }
  if (ref === "execute:shopify_inventory_transfer:restock") {
    const lineItems = Array.isArray(summary.lineItems) ? summary.lineItems : [];
    if (lineItems.length === 0) return null;
    const belief = findBelief(beliefs, "inventory.low_cover_products.trailing_30d");
    return {
      id: "opportunity_inventory_transfer_low_cover_restock",
      opportunityType: "low_cover_restock",
      actionIntent: intent,
      title: "Replenish products with proven recent demand",
      evidence: [
        belief
          ? {
              id: belief.id,
              source: "merchant_memory_belief",
              summary: safeText(`${belief.label}: ${JSON.stringify(belief.val)}`, 320),
              entityIds: lineItems
                .map((item) => safeIdentifier(item.productId))
                .filter(Boolean),
            }
          : null,
        ...lineItems.slice(0, 8).map((item, index) => ({
          id: `low_cover_restock_evidence_${index + 1}`,
          source: "shopify_orders_inventory_and_catalogue",
          summary: safeText(
            `${item.title ?? item.productId} sold ${item.unitsSold ?? "recent"} unit(s) in the evidence window, has ${item.available ?? 0} available, and is proposed for ${item.quantity} replenishment unit(s).`,
            260,
          ),
          entityIds: [
            safeIdentifier(item.productId),
            safeIdentifier(item.variantExternalId ?? item.variantId),
            safeIdentifier(item.inventoryItemId),
          ].filter(Boolean),
        })),
      ].filter(Boolean),
      affectedEntities: lineItems.slice(0, 20).map((item) => ({
        kind: "variant",
        id: safeIdentifier(item.variantExternalId ?? item.variantId ?? item.inventoryItemId),
        productId: safeIdentifier(item.productExternalId ?? item.productId),
        title: safeText(item.title, 160),
      })),
      initialProposal: {
        kind: "shopify_inventory_transfer",
        coverDays: numberOrNull(summary.coverDays),
        lineItemCount: numberOrNull(summary.lineItemCount),
        originLocationId: safeIdentifier(summary.originLocationId),
        destinationLocationId: safeIdentifier(summary.destinationLocationId),
        lineItems: lineItems.slice(0, 20).map((item) => ({
          productId: safeIdentifier(item.productExternalId ?? item.productId),
          variantId: safeIdentifier(item.variantExternalId ?? item.variantId),
          inventoryItemId: safeIdentifier(item.inventoryItemId),
          title: safeText(item.title, 160),
          sku: safeText(item.sku, 80),
          quantity: numberOrNull(item.quantity),
          available: numberOrNull(item.available),
          dailyVelocity: numberOrNull(item.dailyVelocity),
          daysOfCover: numberOrNull(item.daysOfCover),
          unitsSold: numberOrNull(item.unitsSold),
        })),
      },
      potentialCapabilities: [capabilityForOpportunity(capability)],
      measurableOutcome:
        "Jefe measures whether the approved Shopify inventory transfer is created for the low-cover items and whether stock cover improves after receipt.",
    };
  }
  return null;
}

function capabilityForOpportunity(capability) {
  return {
    ref: capability.ref,
    mode: capability.mode,
    actionType: capability.actionType,
    targetKind: capability.targetKind,
    write: capability.write === true,
    writeEnabled: capability.writeEnabled === true,
    requiredScopes: Array.isArray(capability.requiredScopes)
      ? capability.requiredScopes
      : [],
    description: safeText(capability.description, 220),
  };
}

function findBelief(beliefs, key) {
  return (beliefs ?? []).find((belief) => belief.key === key) ?? null;
}

/** @param {any} item */
function isMerchantAuthoredContext(item) {
  return item.authority === "merchant_statement";
}

/** @param {any} item */
function isCompletedActionContext(item) {
  return (
    item.data?.outcomeStatus === "measured" ||
    [
      "applied",
      "partially_applied",
      "reverted",
      "failed",
      "completed",
    ].includes(item.data?.status)
  );
}

function beliefRelevanceScore(belief, directlySupportedBeliefIds) {
  const confidence =
    belief.confidence === null ? null : Number(belief.confidence);
  if (Number.isFinite(confidence) && confidence <= 0) return 0;
  if (isRejectedInference(belief)) return 0;
  let score = directlySupportedBeliefIds.has(belief.id) ? 100 : 0;
  const key = `${belief.category}.${belief.key}`.toLowerCase();
  if (/goal|constraint|preference|policy|priority|business/.test(key))
    score += 34;
  if (
    /revenue|order|customer|retention|product|catalog|inventory|margin|refund|growth|operation/.test(
      key,
    )
  )
    score += 22;
  if (belief.status === BELIEF_STATUS.merchantCorrected) score += 40;
  if (belief.status === BELIEF_STATUS.merchantConfirmed) score += 32;
  if (Number(belief.precedence ?? 0) >= BELIEF_PRECEDENCE.directObservation)
    score += 18;
  if (Number.isFinite(confidence)) score += Math.round(confidence * 20);
  return score;
}

function isRejectedInference(belief) {
  return String(belief.status ?? "").includes("rejected");
}

function normalizeBelief(belief) {
  const confidence =
    belief.confidence === null ? null : Number(belief.confidence);
  const evidence = Array.isArray(belief.evidence) ? belief.evidence : [];
  const definition = getBeliefDefinition(belief.key);
  return {
    id: belief.id,
    key: belief.key,
    cat: belief.category,
    label: safeText(definition?.label ?? humanizeBeliefKey(belief.key), 80),
    val: safeValue(belief.value, belief.key),
    type: belief.valueType,
    conf: Number.isFinite(confidence) ? Number(confidence.toFixed(2)) : null,
    status: String(belief.status ?? ""),
    authority: authorityLevel(
      Number(belief.precedence ?? 0),
      String(belief.status ?? ""),
    ),
    evidence: evidence
      .map((item) => safeText(item.summary, 140))
      .filter(Boolean)
      .slice(0, 2),
    caveat: importantCaveat(belief, confidence),
  };
}

/** @param {any} belief */
function isGeneratedOnboardingBelief(belief) {
  return (belief.evidence ?? []).some(
    (evidence) =>
      evidence?.sourceType === "merchant_goals" &&
      evidence?.evidenceType === "model_goal_generation",
  );
}

function authorityLevel(precedence, status) {
  if (status === BELIEF_STATUS.merchantCorrected) return "merchant_corrected";
  if (status === BELIEF_STATUS.merchantConfirmed) return "merchant_confirmed";
  if (precedence >= BELIEF_PRECEDENCE.directObservation) return "deterministic";
  if (precedence <= BELIEF_PRECEDENCE.llmInference)
    return "lower_authority_inference";
  return "system_inference";
}

function safeValue(value, key = null) {
  return (
    compactKnownStructuredValue(key, value) ?? compactValue(value, null, 0)
  );
}

function compactKnownStructuredValue(key, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (key === "inventory.low_cover_products.trailing_30d") {
    const items = Array.isArray(value.items) ? value.items : [];
    return {
      items: items.slice(0, 5).map((item) => ({
        productId: safeText(item?.productId, 80),
        title: safeText(item?.title, 120),
        unitsSold: numberOrNull(item?.unitsSold),
        available: numberOrNull(item?.available),
        dailyVelocity: numberOrNull(item?.dailyVelocity),
        daysOfCover: numberOrNull(item?.daysOfCover),
      })),
      topAtRiskProduct: value.topAtRiskProduct
        ? {
            productId: safeText(value.topAtRiskProduct?.productId, 80),
            title: safeText(value.topAtRiskProduct?.title, 120),
            unitsSold: numberOrNull(value.topAtRiskProduct?.unitsSold),
            available: numberOrNull(value.topAtRiskProduct?.available),
            dailyVelocity: numberOrNull(value.topAtRiskProduct?.dailyVelocity),
            daysOfCover: numberOrNull(value.topAtRiskProduct?.daysOfCover),
          }
        : null,
      atRiskProductCount: numberOrNull(value.atRiskProductCount),
      thresholdDays: numberOrNull(value.thresholdDays),
      window: safeText(value.window, 80),
    };
  }
  if (key === "products.dead_stock.trailing_90d") {
    const items = Array.isArray(value.items) ? value.items : [];
    return {
      items: items.slice(0, 5).map((item) => ({
        productId: safeText(item?.productId, 80),
        title: safeText(item?.title, 120),
        unitsOnHand: numberOrNull(item?.unitsOnHand),
        trappedCapital: numberOrNull(item?.trappedCapital),
      })),
      topDeadProduct: value.topDeadProduct
        ? {
            productId: safeText(value.topDeadProduct?.productId, 80),
            title: safeText(value.topDeadProduct?.title, 120),
            unitsOnHand: numberOrNull(value.topDeadProduct?.unitsOnHand),
            trappedCapital: numberOrNull(value.topDeadProduct?.trappedCapital),
          }
        : null,
      deadStockProductCount: numberOrNull(value.deadStockProductCount),
      costCoveredProductCount: numberOrNull(value.costCoveredProductCount),
      totalTrappedCapital: numberOrNull(value.totalTrappedCapital),
      currency: safeText(value.currency, 12),
      window: safeText(value.window, 80),
    };
  }
  return null;
}

function compactValue(value, key, depth) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return safeText(value, depth === 0 ? 120 : 70);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value))
    return value.slice(0, 5).map((item) => compactValue(item, key, depth + 1));
  if (typeof value !== "object" || depth >= 2 || isLowSignalValueKey(key))
    return null;
  const output = {};
  for (const [childKey, item] of Object.entries(value).slice(
    0,
    depth === 0 ? 10 : 5,
  )) {
    if (isLowSignalValueKey(childKey)) continue;
    const compact = compactValue(item, childKey, depth + 1);
    if (compact !== undefined && compact !== null && compact !== "")
      output[childKey] = compact;
  }
  return Object.keys(output).length > 0 ? output : null;
}

function importantCaveat(belief, confidence) {
  if (
    Number.isFinite(confidence) &&
    confidence < 0.75 &&
    belief.confidenceReason
  ) {
    return safeText(belief.confidenceReason, 90);
  }
  return null;
}

function humanizeBeliefKey(key) {
  return String(key).split(".").slice(-1)[0].replace(/_/g, " ");
}

function isLowSignalValueKey(key) {
  return /policy|formula|rule|url|source|dependency|included|excluded|handling|provenance|raw/i.test(
    key ?? "",
  );
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** @param {unknown} value @param {number} max */
export function safeText(value, max) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, (match) =>
      /^\d{4}-\d{2}-\d{2}/.test(match) ? match : "[redacted]",
    )
    .slice(0, max);
}

/** @param {unknown} value @param {number} [max] */
function safeIdentifier(value, max = 180) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.slice(0, max);
}

function hashSnapshot(snapshot) {
  return createHash("sha256").update(stableStringify(snapshot)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
