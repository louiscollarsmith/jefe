// @ts-check

import { ACTIVE_BELIEF_STATUSES } from "../merchant-memory/constants.server.js";
import { BOOTSTRAP_BELIEF_KEYS, buildEvidenceContracts } from "./bootstrap.server.js";

/**
 * Reconcile bootstrap recommendations after complete Merchant Memory replaces
 * their partial-evidence beliefs. Recommendation snapshots stay immutable;
 * applied actions and their ledger rows are never removed.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function reconcileBootstrapRecommendationsAfterFullRefresh(prisma, input) {
  const recommendations = await prisma.merchantPlanRecommendation.findMany({
    where: { merchantId: input.merchantId, shopId: input.shopId, sourceMode: "bootstrap" },
    include: {
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
                select: { status: true },
              },
            },
          },
        },
      },
      run: { select: { result: true } },
    },
  });
  const currentBeliefs = await prisma.merchantMemoryBelief.findMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      key: { in: [...BOOTSTRAP_BELIEF_KEYS] },
      status: { in: ACTIVE_BELIEF_STATUSES },
    },
  });
  const eligibleContracts = new Set(
    buildEvidenceContracts(currentBeliefs, {
      completeRequestedWindow: true,
      inventoryComplete: true,
      lineItemsComplete: true,
    })
      .map((contract) => contract.key),
  );
  let superseded = 0;
  let needsReview = 0;
  for (const recommendation of recommendations) {
    const result = jsonObject(recommendation.run.result);
    const contractKey = stringValue(result.contractKey);
    const supported = Boolean(contractKey && eligibleContracts.has(contractKey));
    if (supported) continue;
    const execution = currentExecutionFromRecommendation(recommendation);
    const applied = ["applied", "partially_applied", "reverted"].includes(
      execution?.status ?? "",
    );
    if (applied) continue;
    if (recommendation.reviewStatus === "accepted") {
      await prisma.merchantPlanRecommendation.update({
        where: { id: recommendation.id },
        data: { reviewStatus: "needs_review" },
      });
      needsReview += 1;
    } else if (["proposed", "deferred"].includes(recommendation.reviewStatus)) {
      await prisma.merchantPlanRecommendation.update({
        where: { id: recommendation.id },
        data: { reviewStatus: "superseded" },
      });
      superseded += 1;
    }
  }
  input.logger?.info("Bootstrap recommendations reconciled after full memory refresh", {
    merchantId: input.merchantId,
    shopId: input.shopId,
    recommendationCount: recommendations.length,
    superseded,
    needsReview,
  });
  return { recommendations: recommendations.length, superseded, needsReview };
}

/** @param {any} recommendation */
function currentExecutionFromRecommendation(recommendation) {
  const workflow = Array.isArray(recommendation?.workflows)
    ? recommendation.workflows[0] ?? null
    : null;
  const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
  return steps.map((/** @type {any} */ step) => step.actionExecutions?.[0]).find(Boolean) ?? null;
}

/** @param {unknown} value @returns {Record<string, any>} */
function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** @param {unknown} value */
function stringValue(value) {
  return typeof value === "string" && value ? value : null;
}
