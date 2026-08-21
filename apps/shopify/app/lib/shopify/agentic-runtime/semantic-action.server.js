// @ts-check

import { createHash } from "node:crypto";

/**
 * @param {any} recommendation
 */
export function semanticActionFromRecommendation(recommendation) {
  const semanticAction = {
    title: recommendation.title,
    summary: recommendation.summary,
    outcome: recommendation.outcome,
    scope: recommendation.scope,
    constraints: recommendation.constraints ?? [],
    materialExpectedEffects: recommendation.materialExpectedEffects ?? [],
    feasibleWriteOperations: recommendation.feasibleWriteOperations ?? [],
    verificationPlan: recommendation.verificationPlan,
    whyThisAction: recommendation.whyThisAction,
    whyNow: recommendation.whyNow,
    supportingBeliefIds: recommendation.supportingBeliefIds ?? [],
    supportingInsightIds: recommendation.supportingInsightIds ?? [],
    confidence: recommendation.confidence ?? "emerging",
    assumption: recommendation.assumption ?? null,
    caveat: recommendation.caveat ?? null,
  };
  return {
    ...semanticAction,
    revision: semanticActionRevision(semanticAction),
  };
}

/**
 * @param {any} prisma
 * @param {{
 *   merchantId: string;
 *   shopId: string;
 *   recommendation: any;
 *   diagnostics?: any;
 * }} input
 */
export async function materializeAgenticShopifyAction(prisma, input) {
  const semanticAction = semanticActionFromRecommendation(input.recommendation);
  const action = await prisma.merchantAction.create({
    data: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      title: semanticAction.title,
      summary: semanticAction.summary,
      status: "proposed",
      plan: {
        agentic: {
          runtime: "shopify_admin_api",
          currentActionRevision: semanticAction.revision,
          semanticAction,
        },
      },
      progress: {
        agentic: {
          runtime: "shopify_admin_api",
          currentActionRevision: semanticAction.revision,
          semanticAction,
          diagnostics: input.diagnostics ?? {},
        },
      },
      outcome: {},
    },
  });
  await prisma.merchantActionEvent?.create?.({
    data: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      merchantActionId: action.id,
      eventType: "agentic_shopify_action_proposed",
      metadata: {
        currentActionRevision: semanticAction.revision,
        feasibleWriteOperations: semanticAction.feasibleWriteOperations,
      },
    },
  });
  return { action, semanticAction };
}

/**
 * @param {any} prisma
 * @param {{
 *   merchantId: string;
 *   shopId: string;
 *   actionId: string;
 *   actor?: string | null;
 * }} input
 */
export async function acceptAgenticShopifyAction(prisma, input) {
  const now = new Date();
  const run = async (/** @type {any} */ tx) => {
    const action = await tx.merchantAction.findFirst({
      where: {
        id: input.actionId,
        merchantId: input.merchantId,
        shopId: input.shopId,
        status: { in: ["proposed", "accepted"] },
      },
    });
    if (!action) return { ok: false, reason: "not_found_or_not_acceptable" };
    const progress = asRecord(action.progress) ?? {};
    const agentic = asRecord(progress.agentic) ?? {};
    const currentActionRevision = String(agentic.currentActionRevision ?? "");
    if (!currentActionRevision) return { ok: false, reason: "missing_current_revision" };
    const acceptedActionRevision = currentActionRevision;
    const updatedProgress = {
      ...progress,
      agentic: {
        ...agentic,
        acceptedActionRevision,
        acceptedAt: now.toISOString(),
        acceptedBy: input.actor ?? input.merchantId,
      },
    };
    const updated = await tx.merchantAction.update({
      where: { id: action.id },
      data: {
        status: "accepted",
        progress: updatedProgress,
      },
    });
    await tx.merchantActionEvent?.create?.({
      data: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        merchantActionId: action.id,
        eventType: "agentic_shopify_action_accepted",
        metadata: {
          actor: input.actor ?? input.merchantId,
          acceptedActionRevision,
        },
      },
    });
    return { ok: true, action: updated, acceptedActionRevision };
  };
  return prisma.$transaction ? prisma.$transaction(run) : run(prisma);
}

/**
 * @param {any} semanticAction
 */
export function semanticActionRevision(semanticAction) {
  const stable = stableJson({
    title: semanticAction.title,
    outcome: semanticAction.outcome,
    scope: semanticAction.scope,
    constraints: semanticAction.constraints ?? [],
    materialExpectedEffects: semanticAction.materialExpectedEffects ?? [],
    feasibleWriteOperations: semanticAction.feasibleWriteOperations ?? [],
    verificationPlan: semanticAction.verificationPlan,
  });
  return `sar_${createHash("sha256").update(stable).digest("hex").slice(0, 16)}`;
}

/** @param {unknown} value */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : null;
}

/** @param {unknown} value @returns {string} */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value ?? null);
  const object = /** @type {Record<string, unknown>} */ (value);
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}
