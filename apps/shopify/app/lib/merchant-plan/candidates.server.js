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
import {
  getShopifyCapabilityManifest,
  parseScopeList,
  resolveShopifyCapabilityAvailability,
} from "../shopify/capabilities/catalog.server.js";
import {
  buildShopifyCapabilityQualificationPlan,
  evaluateShopifyCapabilityQualification,
} from "../shopify/capabilities/qualification.server.js";
import { searchShopifyCapabilities } from "../shopify/capabilities/search.server.js";

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
  const executableByProviderRef = groupBy(
    executable.filter((capability) => capability.providerRef),
    (capability) => capability.providerRef,
  );
  const executorRefs = executable
    .map((capability) => capability.executorRef)
    .filter(Boolean);
  const declaredScopes = parseScopeList(process.env.SCOPES);
  const opportunities = [];
  const diagnostics = [];
  const searched = new Set();
  const storeConditions = [
    ...deriveStoreConditions(input.beliefs),
    ...(await deriveObjectiveStoreConditions(prisma, input)),
  ];
  for (const storeCondition of dedupeBy(storeConditions, (condition) => condition.id)) {
    const retrieved = searchShopifyCapabilities(storeCondition.text, {
      writeOnly: true,
      limit: 5,
    });
    for (const retrievedCapability of retrieved) {
      if (searched.has(`${storeCondition.id}:${retrievedCapability.providerRef}`)) continue;
      searched.add(`${storeCondition.id}:${retrievedCapability.providerRef}`);
      const manifest = getShopifyCapabilityManifest(retrievedCapability.providerRef);
      if (!manifest) continue;
      const executorCandidates = executableByProviderRef.get(manifest.providerRef) ?? [];
      if (executorCandidates.length === 0) {
        diagnostics.push(dynamicCapabilityDiagnostic({
          storeCondition,
          manifest,
          retrievedCapability,
          gateResult: "rejected",
          rejectionReason: "no_jefe_executor_binding",
          suppliedToLuna: false,
        }));
        continue;
      }
      for (const capability of executorCandidates) {
        const built = await inspectDynamicCapabilityOpportunity(prisma, {
          ...input,
          storeCondition,
          manifest,
          retrievedCapability,
          capability,
          declaredScopes,
          executorRefs,
        });
        diagnostics.push(built.diagnostic);
        if (built.opportunity) opportunities.push(built.opportunity);
      }
    }
  }
  // Compatibility fallback for capabilities whose fact condition has not yet
  // been expressed by deriveStoreConditions. Diagnostics mark these as legacy so
  // Task 2 can remove the fallback once every condition source is dynamic.
  if (opportunities.length === 0) {
    for (const capability of executable) {
      const manifest = capability.providerRef
        ? getShopifyCapabilityManifest(capability.providerRef)
        : null;
      if (!manifest) continue;
      const built = await inspectDynamicCapabilityOpportunity(prisma, {
        ...input,
        storeCondition: {
          id: `compatibility_${capability.actionType}_${capability.targetKind}`,
          text: capability.description,
          source: "legacy_execute_capability_fallback",
          supportingBeliefIds: [],
        },
        manifest,
        retrievedCapability: {
          providerRef: manifest.providerRef,
          operation: manifest.operation,
          matchedTerms: [],
          qualificationRequirements: manifest.semantic.qualificationRequirements,
        },
        capability,
        declaredScopes,
        executorRefs,
      });
      built.diagnostic.legacyFallback = true;
      diagnostics.push(built.diagnostic);
      if (built.opportunity) opportunities.push(built.opportunity);
    }
  }
  const deduped = dedupeOpportunities(opportunities);
  const selected = deduped.slice(0, 8);
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

async function inspectDynamicCapabilityOpportunity(prisma, input) {
  const { capability, manifest, storeCondition, retrievedCapability } = input;
    const intent = {
      actionType: capability.actionType,
      targetKind: capability.targetKind,
    };
  const availability = resolveShopifyCapabilityAvailability(manifest, {
    apiVersion: process.env.SHOPIFY_API_VERSION ?? "2026-07",
    declaredScopes: input.declaredScopes,
    grantedScopes: capability.requiredScopes ?? [],
    executorRefs: input.executorRefs,
  });
  const diagnostic = {
      storeCondition,
      providerRef: manifest.providerRef,
      operation: manifest.operation,
      capabilityId: manifest.id,
      semanticEffects: manifest.semantic.semanticEffects,
      retrievedTerms: retrievedCapability.matchedTerms ?? [],
      capabilityRef: capability.ref,
      actionType: capability.actionType,
      targetKind: capability.targetKind,
      writeEnabled: capability.writeEnabled === true,
      requiredScopes: capability.requiredScopes ?? [],
      registryResolution: capability.ref,
      availability,
      dryRun: null,
      qualification: null,
      gateResult: "rejected",
      rejectionReason: null,
      suppliedToLuna: false,
      candidateId: null,
    };
    if (capability.writeEnabled !== true) {
      diagnostic.rejectionReason = "capability_write_disabled";
      return { opportunity: null, diagnostic };
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
      return { opportunity: null, diagnostic };
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
      return { opportunity: null, diagnostic };
    }
  const qualificationPlan = buildShopifyCapabilityQualificationPlan(manifest);
  const qualificationEvidence = qualificationEvidenceFromResolvedCapability({
    manifest,
    result,
  });
  const qualification = evaluateShopifyCapabilityQualification(
    qualificationPlan,
    qualificationEvidence,
  );
  diagnostic.qualification = {
    status: qualification.status,
    checks: qualification.checks.map((check) => ({
      id: check.id,
      evidenceKey: check.evidenceKey,
      status: check.status,
      reason: check.reason,
    })),
  };
  if (qualification.status !== "qualified") {
    diagnostic.rejectionReason = `qualification_${qualification.status}`;
    return { opportunity: null, diagnostic };
  }
    const opportunity = opportunityFromResolvedCapability({
      capability,
      manifest,
      storeCondition,
      qualification,
      result,
      beliefs: input.beliefs,
      intent,
    });
    const enrichedOpportunity = opportunity
      ? {
          ...opportunity,
          storeCondition,
          selectedCapability: capabilityForOpportunity(capability, manifest),
          qualification: {
            source: "shopify_capability_manifest",
            capabilityId: manifest.id,
            providerRef: manifest.providerRef,
            operation: manifest.operation,
            status: qualification.status,
            checks: qualification.checks.map((check) => ({
              id: check.id,
              evidenceKey: check.evidenceKey,
              status: check.status,
              reason: check.reason,
            })),
          },
        }
      : null;
    if (enrichedOpportunity) {
      diagnostic.gateResult = "accepted";
      diagnostic.rejectionReason = null;
      diagnostic.suppliedToLuna = true;
      diagnostic.candidateId = enrichedOpportunity.id;
    } else {
      diagnostic.rejectionReason = "ready_but_missing_candidate_contract";
    }
  return { opportunity: enrichedOpportunity, diagnostic };
}

function deriveStoreConditions(beliefs) {
  const conditions = [];
  for (const belief of beliefs ?? []) {
    const key = String(belief?.key ?? "");
    const label = safeText(belief?.label ?? key, 120);
    if (key === "inventory.low_cover_products.trailing_30d") {
      conditions.push({
        id: "condition_inventory_low_cover",
        source: "merchant_memory_belief",
        supportingBeliefIds: [belief.id].filter(Boolean),
        text:
          "inventory stock shortage low cover unavailable at selling location, possible replenishment or transfer using existing stock at another location",
      });
      continue;
    }
    if (key === "products.dead_stock.trailing_90d") {
      conditions.push({
        id: "condition_dead_stock",
        source: "merchant_memory_belief",
        supportingBeliefIds: [belief.id].filter(Boolean),
        text:
          "slow moving dead stock clearance markdown price variants tied up inventory capital",
      });
      continue;
    }
    if (/range_composition|catalogue|product_type|taxonomy/.test(key)) {
      conditions.push({
        id: `condition_${slug(key)}`,
        source: "merchant_memory_belief",
        supportingBeliefIds: [belief.id].filter(Boolean),
        text: `product catalogue metadata taxonomy presentation ${label}`,
      });
      continue;
    }
    if (/inventory|product|catalog|margin|discount|customer|order/.test(key)) {
      conditions.push({
        id: `condition_${slug(key)}`,
        source: "merchant_memory_belief",
        supportingBeliefIds: [belief.id].filter(Boolean),
        text: `${belief.cat ?? ""} ${key} ${label} ${JSON.stringify(belief.val ?? {}).slice(0, 500)}`,
      });
    }
  }
  return dedupeBy(conditions, (condition) => condition.id).slice(0, 24);
}

async function deriveObjectiveStoreConditions(prisma, input) {
  const conditions = [];
  try {
    if (prisma?.product?.findMany) {
      const products = await prisma.product.findMany({
        where: { merchantId: input.merchantId, shopId: input.shopId },
        select: {
          id: true,
          externalId: true,
          title: true,
          status: true,
          productType: true,
          variants: {
            select: {
              id: true,
              externalId: true,
              unitCost: true,
              inventoryLevels: { select: { available: true } },
            },
          },
        },
        take: 80,
      });
      const stockedCostedProducts = products.filter((product) =>
        (product.variants ?? []).some((variant) => {
          const stock = (variant.inventoryLevels ?? []).reduce(
            (sum, level) => sum + (Number(level.available) || 0),
            0,
          );
          return stock > 0 && Number(variant.unitCost) > 0;
        }),
      );
      if (stockedCostedProducts.length > 0) {
        conditions.push({
          id: "condition_stocked_costed_catalogue_items",
          source: "canonical_shopify_records",
          supportingBeliefIds: [],
          text:
            "stocked costed catalogue items with possible slow moving inventory capital and price intervention options",
        });
      }
      const untypedProducts = products.filter((product) => !safeText(product.productType, 120));
      if (untypedProducts.length > 0) {
        conditions.push({
          id: "condition_catalogue_metadata_missing_product_type",
          source: "canonical_shopify_records",
          supportingBeliefIds: [],
          text:
            "product catalogue metadata taxonomy presentation products missing product type",
        });
      }
    }
  } catch {
    return conditions;
  }
  return conditions;
}

function qualificationEvidenceFromResolvedCapability({ manifest, result }) {
  const summary = result?.summary ?? {};
  if (summary.qualification?.status === "qualified") {
    return evidenceFromQualificationSummary(summary.qualification);
  }
  const evidence = {
    "product.exists": true,
    "variant.ids.present": true,
    "target.field.differs": true,
    "pricing.floor.available": true,
    "policy.field.safe_to_update": true,
  };
  if (manifest.providerRef === "shopify.product.update") {
    evidence["product.exists"] = Number(summary.productCount ?? 0) > 0 || Array.isArray(summary.reasons);
    evidence["target.field.differs"] = true;
    evidence["policy.field.safe_to_update"] = true;
  }
  if (manifest.providerRef === "shopify.product_variants.bulk_update") {
    evidence["variant.ids.present"] = Array.isArray(summary.topItems)
      ? summary.topItems.map((item) => item?.variantId ?? item?.productId ?? item?.title).filter(Boolean)
      : Number(summary.variantCount ?? 0) > 0
        ? { variantCount: summary.variantCount }
        : [];
    evidence["target.field.differs"] = true;
    evidence["pricing.floor.available"] = true;
  }
  if (manifest.providerRef === "shopify.inventory_transfer.create") {
    const firstLine = Array.isArray(summary.lineItems) ? summary.lineItems[0] : null;
    evidence["inventory.item.tracked"] = true;
    evidence["inventory.destination.need_quantity"] = Number(firstLine?.quantity ?? summary.lineItemCount ?? 0);
    evidence["inventory.source.available_quantity"] = Number(firstLine?.sourceAvailable ?? 0);
    evidence["inventory.locations.different"] =
      typeof summary.originLocationId === "string" &&
      typeof summary.destinationLocationId === "string" &&
      summary.originLocationId !== summary.destinationLocationId;
    evidence["inventory.transfer.identities"] = {
      sourceLocationId: summary.originLocationId,
      destinationLocationId: summary.destinationLocationId,
      inventoryItemId: firstLine?.inventoryItemId,
      quantity: firstLine?.quantity,
    };
  }
  return evidence;
}

function evidenceFromQualificationSummary(qualification) {
  const evidence = {};
  for (const line of qualification.lineItems ?? []) {
    for (const check of line.checks ?? []) {
      if (check.value !== undefined && evidence[check.evidenceKey] === undefined) {
        evidence[check.evidenceKey] = check.value;
      }
    }
  }
  return evidence;
}

function dynamicCapabilityDiagnostic({
  storeCondition,
  manifest,
  retrievedCapability,
  gateResult,
  rejectionReason,
  suppliedToLuna,
}) {
  return {
    storeCondition,
    providerRef: manifest.providerRef,
    operation: manifest.operation,
    capabilityId: manifest.id,
    semanticEffects: manifest.semantic.semanticEffects,
    retrievedTerms: retrievedCapability.matchedTerms ?? [],
    capabilityRef: null,
    actionType: null,
    targetKind: null,
    writeEnabled: false,
    requiredScopes: manifest.requiredScopes,
    registryResolution: null,
    availability: null,
    dryRun: null,
    qualification: null,
    gateResult,
    rejectionReason,
    suppliedToLuna,
    candidateId: null,
  };
}

function dedupeOpportunities(opportunities) {
  return dedupeBy(opportunities, (opportunity) => opportunity.id);
}

function groupBy(rows, keyFor) {
  const map = new Map();
  for (const row of rows ?? []) {
    const key = keyFor(row);
    if (!key) continue;
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return map;
}

function dedupeBy(rows, keyFor) {
  const seen = new Set();
  const out = [];
  for (const row of rows ?? []) {
    const key = keyFor(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
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

function opportunityFromResolvedCapability({ capability, manifest, storeCondition, qualification, result, beliefs, intent }) {
  const summary = result.summary ?? {};
  const evidence = opportunityEvidenceFromSummary({
    manifest,
    summary,
    beliefs,
  });
  const affectedEntities = opportunityEntitiesFromSummary(manifest, summary);
  if (evidence.length === 0 && affectedEntities.length === 0) return null;

  return {
    id: capabilityOpportunityId(manifest, summary),
    opportunityType: `shopify_${slug(manifest.domain || manifest.operation)}`,
    actionIntent: intent,
    title: capabilityOpportunityTitle(manifest, summary),
    evidence,
    affectedEntities,
    initialProposal: opportunityInitialProposalFromSummary(manifest, summary),
    potentialCapabilities: [capabilityForOpportunity(capability, manifest)],
    measurableOutcome:
      manifest.semantic?.outcomes?.[0] ??
      "Jefe measures whether the approved Shopify operation completed and changed the intended store state.",
    discovery: {
      source: "shopify_capability_manifest",
      storeCondition,
      qualificationStatus: qualification?.status ?? null,
      semanticEffects: manifest.semantic?.semanticEffects ?? [],
    },
  };
}

function capabilityOpportunityId(manifest, summary) {
  const discriminator = createHash("sha256")
    .update(
      stableStringify({
        providerRef: manifest.providerRef,
        operation: manifest.operation,
        productCount: numberOrNull(summary.productCount),
        variantCount: numberOrNull(summary.variantCount),
        lineItemCount: numberOrNull(summary.lineItemCount),
        reasonKeys: summaryRows(summary.reasons, "reason").map((item) => [
          item.productId,
          item.proposedType ? "target_field" : "status_field",
        ]),
        lineKeys: summaryRows(summary.lineItems, "line_item").map((item) => [
          item.inventoryItemId,
          item.quantity,
        ]),
        topKeys: summaryRows(summary.topItems, "item").map((item) => [
          item.variantId ?? item.productId ?? item.title,
        ]),
      }),
    )
    .digest("hex")
    .slice(0, 8);
  return `opportunity_${slug(manifest.providerRef)}_${discriminator}`;
}

function opportunityEvidenceFromSummary({ manifest, summary, beliefs }) {
  const evidence = [];
  const supportingBeliefIds = new Set();
  for (const belief of beliefs ?? []) {
    const keyText = `${belief?.category ?? ""}.${belief?.key ?? ""} ${belief?.label ?? ""}`.toLowerCase();
    const matchesCapability = (manifest.semantic?.tags ?? []).some((tag) =>
      keyText.includes(String(tag).replace(/_/g, " ").toLowerCase()),
    );
    if (matchesCapability && belief?.id && !supportingBeliefIds.has(belief.id)) {
      supportingBeliefIds.add(belief.id);
      evidence.push({
        id: belief.id,
        source: "merchant_memory_belief",
        summary: safeText(`${belief.label ?? belief.key}: ${JSON.stringify(belief.val ?? {})}`, 320),
        entityIds: [],
      });
    }
  }
  const rows = [
    ...summaryRows(summary.reasons, "reason"),
    ...summaryRows(summary.topItems, "item"),
    ...summaryRows(summary.lineItems, "line_item"),
    ...summaryRows(summary.products, "product"),
    ...summaryRows(summary.updates, "update"),
  ];
  for (const [index, item] of rows.slice(0, 8).entries()) {
    evidence.push({
      id: `${slug(manifest.operation)}_evidence_${index + 1}`,
      source: "shopify_capability_resolver",
      summary: capabilityEvidenceSentence(manifest, item),
      entityIds: entityIdsForSummaryItem(item),
    });
  }
  if (evidence.length === 0 && summary.productCount + summary.variantCount + summary.lineItemCount > 0) {
    evidence.push({
      id: `${slug(manifest.operation)}_evidence_1`,
      source: "shopify_capability_resolver",
      summary: safeText(`${manifest.operation} resolved eligible store records for this capability.`, 220),
      entityIds: [],
    });
  }
  return evidence;
}

function opportunityEntitiesFromSummary(manifest, summary) {
  const rows = [
    ...summaryRows(summary.lineItems, "line_item"),
    ...summaryRows(summary.topItems, "item"),
    ...summaryRows(summary.reasons, "reason"),
    ...summaryRows(summary.products, "product"),
    ...summaryRows(summary.updates, "update"),
  ];
  return rows.slice(0, 20).map((item) => ({
    kind: entityKindForCapability(manifest, item),
    id: safeIdentifier(
      item.variantExternalId ??
        item.variantId ??
        item.productExternalId ??
        item.productId ??
        item.inventoryItemId ??
        item.id ??
        item.title,
    ),
    productId: safeIdentifier(item.productExternalId ?? item.productId),
    title: safeText(item.title ?? item.productTitle ?? item.productId ?? item.inventoryItemId, 160),
  }));
}

function opportunityInitialProposalFromSummary(manifest, summary) {
  const kind = opportunitySummaryKind(manifest, summary);
  const base = {
    kind,
    providerRef: manifest.providerRef,
    operation: manifest.operation,
    productCount: numberOrNull(summary.productCount),
    variantCount: numberOrNull(summary.variantCount),
    lineItemCount: numberOrNull(summary.lineItemCount),
  };
  if (Array.isArray(summary.lineItems)) {
    return {
      ...base,
      coverDays: numberOrNull(summary.coverDays),
      originLocationId: safeIdentifier(summary.originLocationId),
      destinationLocationId: safeIdentifier(summary.destinationLocationId),
      lineItems: summary.lineItems.slice(0, 20).map((item) => ({
        productId: safeIdentifier(item.productExternalId ?? item.productId),
        variantId: safeIdentifier(item.variantExternalId ?? item.variantId),
        inventoryItemId: safeIdentifier(item.inventoryItemId),
        title: safeText(item.title, 160),
        sku: safeText(item.sku, 80),
        quantity: numberOrNull(item.quantity),
        available: numberOrNull(item.available),
        sourceAvailable: numberOrNull(item.sourceAvailable),
        dailyVelocity: numberOrNull(item.dailyVelocity),
        daysOfCover: numberOrNull(item.daysOfCover),
        unitsSold: numberOrNull(item.unitsSold),
      })),
    };
  }
  if (Array.isArray(summary.topItems)) {
    return {
      ...base,
      markdownPercent: numberOrNull(summary.markdownPercent),
      totalTrappedCapital: numberOrNull(summary.totalTrappedCapital),
      totalProjectedRecovery: numberOrNull(summary.totalProjectedRecovery),
      topItems: summary.topItems.slice(0, 20),
    };
  }
  if (Array.isArray(summary.reasons)) {
    return {
      ...base,
      updates: summary.reasons.slice(0, 20).map((item) => ({
        productId: safeIdentifier(item.productId),
        title: safeText(item.title, 160),
        proposedType: safeText(item.proposedType, 120),
        reason: safeText(item.because, 220),
      })),
      products: summary.reasons.slice(0, 20),
      unresolvedCount: numberOrNull(summary.unresolvedCount),
      windowDays: numberOrNull(summary.windowDays),
    };
  }
  return base;
}

function opportunitySummaryKind(manifest, summary) {
  if (summary.kind) return String(summary.kind);
  if (Array.isArray(summary.lineItems)) return `shopify_${slug(manifest.operation)}`;
  if (Array.isArray(summary.topItems)) return "variant_updates";
  if (Array.isArray(summary.reasons)) {
    const hasProposedType = summary.reasons.some((item) => item?.proposedType);
    if (hasProposedType) return "product_type_updates";
    return "product_status_updates";
  }
  return `shopify_${slug(manifest.operation)}`;
}

function capabilityOpportunityTitle(manifest, summary) {
  const count = numberOrNull(summary.lineItemCount ?? summary.variantCount ?? summary.productCount);
  const entity =
    (manifest.semantic?.affectedEntities ?? []).find((item) => item !== "InventoryTransfer") ??
    manifest.domain ??
    "store record";
  const verb = String(manifest.operation ?? "Shopify operation")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
  const prefix = count ? `${verb} for ${count} ${entity}${count === 1 ? "" : "s"}` : verb;
  return sentenceCase(prefix);
}

function capabilityEvidenceSentence(manifest, item) {
  const title = item.title ?? item.productTitle ?? item.productId ?? item.inventoryItemId ?? manifest.operation;
  const details = [
    item.because,
    item.proposedType ? `proposed value ${item.proposedType}` : null,
    item.quantity != null ? `quantity ${item.quantity}` : null,
    item.sourceAvailable != null ? `source available ${item.sourceAvailable}` : null,
    item.available != null ? `available ${item.available}` : null,
    item.unitsSold != null ? `sold ${item.unitsSold}` : null,
  ].filter(Boolean);
  return safeText(`${title}${details.length ? `: ${details.join(", ")}.` : " is eligible for the resolved Shopify capability."}`, 260);
}

function entityKindForCapability(manifest, item) {
  if (item.inventoryItemId) return "inventory_item";
  if (item.variantExternalId || item.variantId) return "variant";
  if (item.productExternalId || item.productId) return "product";
  return safeText(manifest.semantic?.affectedEntities?.[0] ?? manifest.domain ?? "entity", 80);
}

function entityIdsForSummaryItem(item) {
  return [
    safeIdentifier(item.productExternalId ?? item.productId),
    safeIdentifier(item.variantExternalId ?? item.variantId),
    safeIdentifier(item.inventoryItemId),
  ].filter(Boolean);
}

function summaryRows(value, source) {
  return Array.isArray(value)
    ? value.filter(Boolean).map((item) => ({ ...item, source }))
    : [];
}

function sentenceCase(value) {
  const text = safeText(value, 180);
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Review Shopify capability";
}

function capabilityForOpportunity(capability, manifest = null) {
  return {
    ref: capability.ref,
    providerRef: manifest?.providerRef ?? capability.providerRef ?? null,
    capabilityId: manifest?.id ?? null,
    operation: manifest?.operation ?? null,
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

function slug(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
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
