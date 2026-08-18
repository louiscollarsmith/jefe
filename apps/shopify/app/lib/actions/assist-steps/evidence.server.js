// @ts-check

import { getMerchantContextForQuestion } from "../../merchant-memory/context-retriever.server.js";
import { getMerchantAction } from "../merchant-action.server.js";

export const DEFAULT_RESTOCK_COVER_DAYS = 120;

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; stepId?: string | null; conversationId?: string | null; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function loadAssistStepContext(prisma, input) {
  const action = await getMerchantAction(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.actionId,
  });
  const actionEvidence = await getMerchantContextForQuestion(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    conversationId: input.conversationId ?? null,
    focusedActionId: input.actionId,
    recommendationId: action?.sourceRecommendationId ?? null,
    actionRunId: action?.actionRunId ?? null,
    message: "",
    logger: input.logger,
  });
  const step =
    findWorkflowStep(action, input.stepId) ??
    findWorkflowStep(action, input.step?.id) ??
    null;
  const priorStepArtifacts = collectPriorStepArtifacts(action, step?.id ?? null);
  return {
    action,
    actionEvidence,
    step,
    lowCoverProducts: lowCoverProductsFromEvidence(actionEvidence),
    priorStepArtifacts,
  };
}

/** @param {any} action @param {string | null | undefined} stepId */
function findWorkflowStep(action, stepId) {
  if (!stepId) return null;
  const steps = action?.workflow?.steps ?? action?.displaySteps ?? [];
  return steps.find((/** @type {any} */ row) => row?.id === stepId) ?? null;
}

/** @param {any} action @param {string | null} beforeStepId */
function collectPriorStepArtifacts(action, beforeStepId) {
  const steps = action?.workflow?.steps ?? action?.displaySteps ?? [];
  const artifacts = [];
  for (const step of steps) {
    if (beforeStepId && step?.id === beforeStepId) break;
    const progress = step?.progress;
    if (progress && typeof progress === "object" && progress.artifactType) {
      artifacts.push({ stepId: step.id, title: step.title ?? step.label ?? "", progress });
    }
  }
  return artifacts;
}

/** @param {any} actionEvidence */
export function lowCoverProductsFromEvidence(actionEvidence) {
  const blocks = [
    ...(Array.isArray(actionEvidence?.planEvidenceAtRecommendationTime?.blocks)
      ? actionEvidence.planEvidenceAtRecommendationTime.blocks
      : []),
    ...(Array.isArray(actionEvidence?.currentSystemContext?.blocks)
      ? actionEvidence.currentSystemContext.blocks
      : []),
  ];
  const items = [];
  for (const block of blocks) {
    if (
      block?.kind !== "structured_evidence" ||
      block?.data?.key !== "inventory.low_cover_products.trailing_30d" ||
      !Array.isArray(block.data.items)
    ) {
      continue;
    }
    for (const item of block.data.items) {
      const title = safeText(item?.title);
      if (!title) continue;
      const row = {
        title,
        available: finiteNumber(item?.available),
        dailyVelocity: finiteNumber(item?.dailyVelocity),
        daysOfCover: finiteNumber(item?.daysOfCover),
      };
      items.push({
        ...row,
        recommendedUnitsAtDefaultCover: recommendedPurchaseUnits(
          row,
          DEFAULT_RESTOCK_COVER_DAYS,
        ),
      });
    }
  }
  const seen = new Set();
  return items
    .filter((item) => {
      const key = item.title.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 6);
}

/**
 * @param {{ available: number | null; dailyVelocity: number | null }} item
 * @param {number} targetCoverDays
 */
export function recommendedPurchaseUnits(item, targetCoverDays) {
  if (item.available === null || item.dailyVelocity === null) return null;
  return Math.max(
    0,
    Math.ceil(item.dailyVelocity * targetCoverDays - item.available),
  );
}

/** @param {unknown} value */
function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** @param {unknown} value */
function safeText(value) {
  return typeof value === "string" ? value.trim() : "";
}
