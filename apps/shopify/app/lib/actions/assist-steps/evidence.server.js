// @ts-check

import { getMerchantAction } from "../merchant-action.server.js";
import {
  DEFAULT_RESTOCK_COVER_DAYS,
  resolveActionContext,
} from "../resolved-action-context.server.js";
import { recommendedPurchaseUnits } from "../action-capability.server.js";

export { DEFAULT_RESTOCK_COVER_DAYS, recommendedPurchaseUnits };

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; stepId?: string | null; step?: { id?: string | null } | null; conversationId?: string | null; logger?: Pick<Console, "info" | "warn" | "error">; resolvedContext?: any }} input
 */
export async function loadAssistStepContext(prisma, input) {
  const resolved =
    input.resolvedContext ??
    (await resolveActionContext(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.actionId,
      conversationId: input.conversationId ?? null,
      logger: input.logger,
    }));
  const action = resolved?.action ?? (await getMerchantAction(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.actionId,
  }));
  const step =
    findWorkflowStep(action, input.stepId) ??
    findWorkflowStep(action, input.step?.id) ??
    resolved?.currentStep ??
    null;
  const priorStepArtifacts = collectPriorStepArtifacts(action, step?.id ?? null);
  const coverDays =
    resolved?.plan?.values?.coverDays ?? DEFAULT_RESTOCK_COVER_DAYS;
  const lowCoverProducts =
    resolved?.evidence?.kind === "restock"
      ? (resolved.scope?.items ?? []).map((/** @type {any} */ item) => ({
          ...item,
          recommendedUnitsAtDefaultCover:
            item.recommendedUnits ??
            recommendedPurchaseUnits(item, coverDays),
        }))
      : [];
  return {
    action,
    resolvedContext: resolved,
    actionEvidence: null,
    step,
    lowCoverProducts,
    targetCoverDays: coverDays,
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
