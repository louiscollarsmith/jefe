// @ts-check

import { logger as baseLogger } from "../../observability/logger.server.js";
import { loadAssistStepContext } from "./evidence.server.js";
import {
  formatAssistArtifactForChat,
  isAssistStepArtifact,
} from "./format.server.js";
import { resolveAssistHandler } from "./registry.server.js";

const log = baseLogger.child({ component: "assist-steps" });

/**
 * Produce the assist artifact for one step run without mutating lifecycle state.
 *
 * @param {any} prisma
 * @param {{
 *   stepRun: any;
 *   actionId: string;
 *   conversationId?: string | null;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 *   resolvedContext?: any;
 *   provider?: any;
 * }} input
 */
export async function produceAssistStepArtifact(prisma, input) {
  const logger = input.logger ?? log;
  const stepRun = input.stepRun;
  const step = stepRun?.step;
  if (!step || step.mode !== "assist") {
    return { ok: false, reason: "not_assist_step", chatReply: null, progress: null };
  }
  const handler = resolveAssistHandler(step);
  if (!handler) {
    return { ok: false, reason: "no_handler", chatReply: null, progress: null };
  }
  const context = await loadAssistStepContext(prisma, {
    merchantId: stepRun.merchantId,
    shopId: stepRun.shopId,
    actionId: input.actionId,
    stepId: step.id,
    conversationId: input.conversationId ?? null,
    resolvedContext: input.resolvedContext ?? null,
    provider: input.provider ?? null,
    logger,
  });
  try {
    const handlerResult = await handler(context);
    const progress = handlerResult?.progress ?? null;
    if (!isAssistStepArtifact(progress)) {
      return {
        ok: false,
        reason: "empty_artifact",
        chatReply: handlerResult?.chatReply ?? null,
        progress,
      };
    }
    return {
      ok: true,
      chatReply: handlerResult.chatReply ?? formatAssistArtifactForChat(progress),
      progress,
    };
  } catch (error) {
    logger.warn("assist step handler failed", {
      merchantId: stepRun.merchantId,
      shopId: stepRun.shopId,
      stepRunId: stepRun.id,
      stepId: step.id,
      capabilityRef: step.capabilityRef ?? null,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return { ok: false, reason: "handler_failed", chatReply: null, progress: null };
  }
}

/**
 * @param {any} prisma
 * @param {{ stepRunId: string; actionId: string; conversationId?: string | null; logger?: Pick<Console, "info" | "warn" | "error">; completeActionStepRun?: typeof import("../action-step-lifecycle.server.js").completeActionStepRun; resolvedContext?: any }} input
 */
export async function executeStartedAssistStepRun(prisma, input) {
  const logger = input.logger ?? log;
  const complete =
    input.completeActionStepRun ??
    (await import("../action-step-lifecycle.server.js")).completeActionStepRun;
  const { ACTION_STEP_RUN_STATUS } = await import("../action-step-lifecycle.server.js");
  const stepRun = await prisma.merchantRecommendationStepRun.findFirst({
    where: {
      id: input.stepRunId,
      status: { in: [ACTION_STEP_RUN_STATUS.queued, ACTION_STEP_RUN_STATUS.running] },
    },
    include: { step: true },
  });
  if (!stepRun) {
    return { ok: false, reason: "step_run_not_found", chatReply: null, progress: null };
  }
  if (stepRun.status === ACTION_STEP_RUN_STATUS.queued) {
    await prisma.merchantRecommendationStepRun.updateMany({
      where: { id: stepRun.id, status: ACTION_STEP_RUN_STATUS.queued },
      data: { status: ACTION_STEP_RUN_STATUS.running, startedAt: new Date() },
    });
  }
  const produced = await produceAssistStepArtifact(prisma, {
    stepRun: { ...stepRun, step: stepRun.step },
    actionId: input.actionId,
    conversationId: input.conversationId ?? null,
    resolvedContext: input.resolvedContext ?? null,
    provider: input.provider ?? null,
    logger,
  });
  if (!produced.ok || !produced.progress) return produced;
  const stampedProgress = stampArtifactVersions(produced.progress, input.resolvedContext);
  const completion = await complete(prisma, {
    stepRunId: stepRun.id,
    result: stampedProgress,
    logger,
  });
  if (!completion.ok) {
    return {
      ok: false,
      reason: "completion_failed",
      chatReply: produced.chatReply,
      progress: produced.progress,
    };
  }
  logger.info("assist step completed with artifact", {
    merchantId: stepRun.merchantId,
    shopId: stepRun.shopId,
    stepRunId: stepRun.id,
    stepId: stepRun.step.id,
    artifactType: produced.progress.artifactType,
  });
  return { ...produced, progress: stampedProgress, completion };
}

/** @param {any} progress @param {any} resolvedContext */
function stampArtifactVersions(progress, resolvedContext) {
  if (!progress || typeof progress !== "object") return progress;
  return {
    ...progress,
    planVersion: resolvedContext?.plan?.version ?? progress.planVersion ?? null,
    constraintVersion: resolvedContext?.constraintVersion ?? progress.constraintVersion ?? null,
    scopeVersion: resolvedContext?.scopeVersion ?? progress.scopeVersion ?? null,
    evidenceVersion: resolvedContext?.evidenceVersion ?? progress.evidenceVersion ?? null,
    inputHash: resolvedContext?.inputHash ?? progress.inputHash ?? null,
  };
}

export { formatAssistArtifactForChat, isAssistStepArtifact } from "./format.server.js";
