// @ts-check

import { executeApprovedAction } from "./execute-approved-action.server.js";
import { produceAssistStepArtifact } from "./assist-steps/run.server.js";
import { logger as baseLogger } from "../observability/logger.server.js";
import {
  prepareExecutionChangeSet,
  recordChangeSetExecution,
  getCurrentChangeSet,
} from "./action-changeset.server.js";

const log = baseLogger.child({ component: "action-step-lifecycle" });

export const ACTION_STEP_STATUS = Object.freeze({
  draft: "draft",
  waiting: "waiting",
  ready: "ready",
  running: "running",
  needsMerchant: "needs_merchant",
  needsAttention: "needs_attention",
  completed: "completed",
  skipped: "skipped",
  superseded: "superseded",
});

export const ACTION_STEP_RUN_STATUS = Object.freeze({
  queued: "queued",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  needsAttention: "needs_attention",
  cancelled: "cancelled",
});

/** @type {Set<string>} */
const TERMINAL_STEP_STATUSES = new Set([
  ACTION_STEP_STATUS.completed,
  ACTION_STEP_STATUS.skipped,
  ACTION_STEP_STATUS.superseded,
]);

/** @type {Set<string>} */
const ACTIVE_STEP_STATUSES = new Set([
  ACTION_STEP_STATUS.ready,
  ACTION_STEP_STATUS.running,
  ACTION_STEP_STATUS.needsMerchant,
  ACTION_STEP_STATUS.needsAttention,
]);

/** @type {Set<string>} */
const STARTABLE_ACTION_STATUSES = new Set(["accepted", "in_progress"]);
/** @type {Set<string>} */
const ACCEPTABLE_ACTION_STATUSES = new Set(["proposed", "accepted"]);

/**
 * Accepting a plan makes it live and unlocks the first eligible step. It never
 * executes the step or mutates Shopify.
 *
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; actor?: string | null; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function acceptMerchantActionPlan(prisma, input) {
  const logger = input.logger ?? log;
  const now = new Date();
  const run = async (/** @type {any} */ tx) => {
    const action = await loadActionForLifecycle(tx, input);
    if (!action) return { ok: false, reason: "not_found" };
    if (!ACCEPTABLE_ACTION_STATUSES.has(String(action.status))) {
      return { ok: false, reason: `not_acceptable:${action.status}` };
    }
    const recommendationId =
      action.sourceRecommendationId ?? action.sourceRecommendation?.id ?? null;
    const workflow = latestWorkflow(action);
    if (recommendationId) {
      await tx.merchantPlanRecommendation.updateMany({
        where: {
          id: recommendationId,
          merchantId: input.merchantId,
          shopId: input.shopId,
          reviewStatus: { in: ["proposed", "accepted"] },
        },
        data: {
          reviewStatus: "accepted",
          acceptedAt: action.sourceRecommendation?.acceptedAt ?? now,
        },
      });
      await tx.merchantRecommendationWorkflow.updateMany({
        where: {
          recommendationId,
          merchantId: input.merchantId,
          shopId: input.shopId,
          status: { in: ["draft", "active"] },
        },
        data: { status: "active" },
      });
    }
    await tx.merchantAction.updateMany({
      where: {
        id: action.id,
        merchantId: input.merchantId,
        shopId: input.shopId,
        status: { in: ["proposed", "accepted"] },
      },
      data: { status: "accepted" },
    });
    const advance = workflow
      ? await advanceActionWorkflow(tx, {
          merchantId: input.merchantId,
          shopId: input.shopId,
          actionId: action.id,
          workflowId: workflow.id,
          now,
        })
      : { currentStep: null, completed: false };
    if (tx.merchantActionEvent?.create) {
      await tx.merchantActionEvent.create({
        data: {
          merchantId: input.merchantId,
          shopId: input.shopId,
          merchantActionId: action.id,
          eventType: "action_plan_accepted",
          metadata: {
            actor: input.actor ?? input.merchantId,
            currentStepId: advance.currentStep?.id ?? null,
          },
        },
      });
    }
    return {
      ok: true,
      actionId: action.id,
      status: "accepted",
      currentStep: advance.currentStep,
    };
  };
  const result = prisma.$transaction ? await prisma.$transaction(run) : await run(prisma);
  if (result.ok) {
    logger.info("merchant accepted action plan", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.actionId,
      currentStepId: result.currentStep?.id ?? null,
    });
  }
  return result;
}

/**
 * Start the current ready step. This only claims state and creates a queued step
 * run; the worker executes any typed adapter.
 *
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; stepId?: string | null; actor?: string | null; idempotencyKey?: string | null; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function startActionStep(prisma, input) {
  const logger = input.logger ?? log;
  const now = new Date();
  const run = async (/** @type {any} */ tx) => {
    const action = await loadActionForLifecycle(tx, input);
    if (!action) return { ok: false, reason: "not_found" };
    if (!STARTABLE_ACTION_STATUSES.has(String(action.status))) {
      return { ok: false, reason: `action_not_startable:${action.status}` };
    }
    const workflow = latestWorkflow(action);
    if (!workflow) return { ok: false, reason: "no_workflow" };
    let steps = orderedSteps(workflow.steps);
    let current = pickCurrentStep(steps);
    if (!current) {
      const advance = await advanceActionWorkflow(tx, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        actionId: action.id,
        workflowId: workflow.id,
        now,
      });
      if (advance.completed) {
        return { ok: false, reason: "no_current_step" };
      }
      const refreshed = await tx.merchantRecommendationStep.findMany({
        where: {
          workflowId: workflow.id,
          merchantId: input.merchantId,
          shopId: input.shopId,
        },
        orderBy: { orderIndex: "asc" },
      });
      steps = orderedSteps(refreshed);
      const advancedStepId = advance.currentStep?.id ?? null;
      current =
        pickCurrentStep(steps) ??
        (advancedStepId
          ? steps.find((/** @type {any} */ step) => step.id === advancedStepId) ?? null
          : null);
    }
    if (!current) return { ok: false, reason: "no_current_step" };
    if (input.stepId && input.stepId !== current.id) {
      return { ok: false, reason: "not_current_step", currentStepId: current.id };
    }
    if (!isStepStartable(current)) {
      return { ok: false, reason: `step_not_ready:${current.status}`, currentStepId: current.id };
    }
    const claimFromStatus = claimStatusForStep(current);
    const claimed = await tx.merchantRecommendationStep.updateMany({
      where: {
        id: current.id,
        merchantId: input.merchantId,
        shopId: input.shopId,
        status: claimFromStatus,
      },
      data: {
        status: ACTION_STEP_STATUS.running,
        startedAt: current.startedAt ?? now,
        statusReason: "Merchant started this step.",
      },
    });
    if (claimed.count !== 1) {
      const fresh = await tx.merchantRecommendationStep.findFirst({
        where: { id: current.id, merchantId: input.merchantId, shopId: input.shopId },
        select: { status: true },
      });
      return {
        ok: false,
        reason: `claim_race:${fresh?.status ?? "missing"}`,
        currentStepId: current.id,
      };
    }
    const execution = actionExecutionForStep(action, current.id);
    const idempotencyKey =
      input.idempotencyKey ?? `start:${action.id}:${current.id}`;
    let stepRun;
    try {
      stepRun = await tx.merchantRecommendationStepRun.create({
        data: {
          stepId: current.id,
          merchantId: input.merchantId,
          shopId: input.shopId,
          actor: input.actor ?? input.merchantId,
          status: ACTION_STEP_RUN_STATUS.queued,
          idempotencyKey,
          actionExecutionRunId: execution?.runId ?? null,
        },
      });
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      stepRun = await tx.merchantRecommendationStepRun.findFirst({
        where: {
          stepId: current.id,
          merchantId: input.merchantId,
          shopId: input.shopId,
          idempotencyKey,
        },
      });
    }
    await tx.merchantAction.updateMany({
      where: { id: action.id, merchantId: input.merchantId, shopId: input.shopId },
      data: { status: "in_progress" },
    });
    if (tx.merchantActionEvent?.create) {
      await tx.merchantActionEvent.create({
        data: {
          merchantId: input.merchantId,
          shopId: input.shopId,
          merchantActionId: action.id,
          eventType: "action_step_started",
          metadata: {
            stepId: current.id,
            stepRunId: stepRun?.id ?? null,
            actor: input.actor ?? input.merchantId,
          },
        },
      });
    }
    return { ok: true, actionId: action.id, stepId: current.id, stepRunId: stepRun?.id ?? null };
  };
  const result = prisma.$transaction ? await prisma.$transaction(run) : await run(prisma);
  if (result.ok) {
    logger.info("merchant started action step", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.actionId,
      stepId: result.stepId,
      stepRunId: result.stepRunId,
    });
  }
  return result;
}

/**
 * Pause the current running/queued step. Cancels the step run and puts the step
 * back to ready so the merchant can start it again. Does not decline the plan.
 *
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; actor?: string | null; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function stopActionStep(prisma, input) {
  const logger = input.logger ?? log;
  const now = new Date();
  const run = async (/** @type {any} */ tx) => {
    const action = await loadActionForLifecycle(tx, input);
    if (!action) return { ok: false, reason: "not_found" };
    const workflow = latestWorkflow(action);
    if (!workflow) return { ok: false, reason: "no_workflow" };
    const steps = orderedSteps(workflow.steps);
    const current =
      steps.find((/** @type {any} */ step) => String(step.status) === ACTION_STEP_STATUS.running) ??
      pickCurrentStep(steps);
    if (!current) return { ok: false, reason: "nothing_running" };
    if (String(current.status) !== ACTION_STEP_STATUS.running) {
      return { ok: false, reason: "nothing_running", currentStepId: current.id };
    }
    await tx.merchantRecommendationStepRun.updateMany({
      where: {
        stepId: current.id,
        merchantId: input.merchantId,
        shopId: input.shopId,
        status: {
          in: [ACTION_STEP_RUN_STATUS.queued, ACTION_STEP_RUN_STATUS.running],
        },
      },
      data: {
        status: ACTION_STEP_RUN_STATUS.cancelled,
        completedAt: now,
        error: { reason: "stopped_by_merchant" },
      },
    });
    const restoredStatus =
      current.mode === "merchant_action" || current.mode === "evidence_required"
        ? ACTION_STEP_STATUS.needsMerchant
        : ACTION_STEP_STATUS.ready;
    await tx.merchantRecommendationStep.updateMany({
      where: {
        id: current.id,
        merchantId: input.merchantId,
        shopId: input.shopId,
        status: ACTION_STEP_STATUS.running,
      },
      data: {
        status: restoredStatus,
        statusReason: "Paused by the merchant.",
        completedAt: null,
      },
    });
    if (tx.merchantActionEvent?.create) {
      await tx.merchantActionEvent.create({
        data: {
          merchantId: input.merchantId,
          shopId: input.shopId,
          merchantActionId: action.id,
          eventType: "action_step_stopped",
          metadata: {
            stepId: current.id,
            actor: input.actor ?? input.merchantId,
          },
        },
      });
    }
    return {
      ok: true,
      actionId: action.id,
      stepId: current.id,
      status: restoredStatus,
    };
  };
  const result = prisma.$transaction ? await prisma.$transaction(run) : await run(prisma);
  if (result.ok) {
    logger.info("merchant stopped action step", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.actionId,
      stepId: result.stepId,
    });
  }
  return result;
}

/**
 * Mark the current merchant-owned step complete, or finish a paused/ready
 * merchant step the merchant says they've already done. Executable Jefe steps
 * cannot be completed from chat without a real step run.
 *
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; actor?: string | null; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function completeCurrentActionStep(prisma, input) {
  const logger = input.logger ?? log;
  const now = new Date();
  const run = async (/** @type {any} */ tx) => {
    const action = await loadActionForLifecycle(tx, input);
    if (!action) return { ok: false, reason: "not_found" };
    const workflow = latestWorkflow(action);
    if (!workflow) return { ok: false, reason: "no_workflow" };
    const steps = orderedSteps(workflow.steps);
    const current = pickCurrentStep(steps);
    if (!current) return { ok: false, reason: "no_current_step" };
    const mode = String(current.mode ?? "");
    const status = String(current.status ?? "");
    if (status === ACTION_STEP_STATUS.running && (mode === "execute" || mode === "assist")) {
      return { ok: false, reason: "jefe_step_still_running", currentStepId: current.id };
    }
    const merchantOwned =
      mode === "merchant_action" ||
      mode === "merchant" ||
      mode === "evidence_required" ||
      status === ACTION_STEP_STATUS.needsMerchant;
    if (!merchantOwned && status !== ACTION_STEP_STATUS.needsAttention) {
      return { ok: false, reason: "not_merchant_completable", currentStepId: current.id };
    }
    await tx.merchantRecommendationStep.updateMany({
      where: {
        id: current.id,
        merchantId: input.merchantId,
        shopId: input.shopId,
      },
      data: {
        status: ACTION_STEP_STATUS.completed,
        completedAt: now,
        statusReason: "Merchant marked this step complete.",
        attention: {},
      },
    });
    const advance = await advanceActionWorkflow(tx, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: action.id,
      workflowId: workflow.id,
      now,
    });
    if (tx.merchantActionEvent?.create) {
      await tx.merchantActionEvent.create({
        data: {
          merchantId: input.merchantId,
          shopId: input.shopId,
          merchantActionId: action.id,
          eventType: "action_step_completed",
          metadata: {
            stepId: current.id,
            actor: input.actor ?? input.merchantId,
            source: "merchant_chat",
          },
        },
      });
    }
    return {
      ok: true,
      actionId: action.id,
      stepId: current.id,
      currentStep: advance.currentStep,
      completed: advance.completed,
    };
  };
  const result = prisma.$transaction ? await prisma.$transaction(run) : await run(prisma);
  if (result.ok) {
    logger.info("merchant completed action step", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.actionId,
      stepId: result.stepId,
      planCompleted: result.completed === true,
    });
  }
  return result;
}

/**
 * Skip the current step and unlock whatever comes next.
 *
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; actor?: string | null; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function skipCurrentActionStep(prisma, input) {
  const logger = input.logger ?? log;
  const now = new Date();
  const run = async (/** @type {any} */ tx) => {
    const action = await loadActionForLifecycle(tx, input);
    if (!action) return { ok: false, reason: "not_found" };
    const workflow = latestWorkflow(action);
    if (!workflow) return { ok: false, reason: "no_workflow" };
    const steps = orderedSteps(workflow.steps);
    const current = pickCurrentStep(steps);
    if (!current) return { ok: false, reason: "no_current_step" };
    if (String(current.status) === ACTION_STEP_STATUS.running) {
      await tx.merchantRecommendationStepRun.updateMany({
        where: {
          stepId: current.id,
          merchantId: input.merchantId,
          shopId: input.shopId,
          status: {
            in: [ACTION_STEP_RUN_STATUS.queued, ACTION_STEP_RUN_STATUS.running],
          },
        },
        data: {
          status: ACTION_STEP_RUN_STATUS.cancelled,
          completedAt: now,
          error: { reason: "skipped_by_merchant" },
        },
      });
    }
    await tx.merchantRecommendationStep.updateMany({
      where: {
        id: current.id,
        merchantId: input.merchantId,
        shopId: input.shopId,
      },
      data: {
        status: ACTION_STEP_STATUS.skipped,
        completedAt: now,
        statusReason: "Skipped by the merchant.",
      },
    });
    const advance = await advanceActionWorkflow(tx, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: action.id,
      workflowId: workflow.id,
      now,
    });
    if (tx.merchantActionEvent?.create) {
      await tx.merchantActionEvent.create({
        data: {
          merchantId: input.merchantId,
          shopId: input.shopId,
          merchantActionId: action.id,
          eventType: "action_step_skipped",
          metadata: {
            stepId: current.id,
            actor: input.actor ?? input.merchantId,
          },
        },
      });
    }
    return {
      ok: true,
      actionId: action.id,
      stepId: current.id,
      currentStep: advance.currentStep,
      completed: advance.completed,
    };
  };
  const result = prisma.$transaction ? await prisma.$transaction(run) : await run(prisma);
  if (result.ok) {
    logger.info("merchant skipped action step", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.actionId,
      stepId: result.stepId,
    });
  }
  return result;
}

/**
 * Recompute the authoritative current/next step for a workflow.
 *
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId?: string | null; workflowId: string; now?: Date }} input
 */
export async function advanceActionWorkflow(prisma, input) {
  const steps = await prisma.merchantRecommendationStep.findMany({
    where: {
      workflowId: input.workflowId,
      merchantId: input.merchantId,
      shopId: input.shopId,
    },
    orderBy: { orderIndex: "asc" },
  });
  const ordered = orderedSteps(steps);
  const active = pickCurrentStep(ordered);
  if (active) return { currentStep: serializeStep(active), completed: false };
  const next = firstEligibleStep(ordered);
  if (!next) {
    const remaining = ordered.filter(
      (step) => !TERMINAL_STEP_STATUSES.has(String(step.status)),
    );
    if (remaining.length > 0) {
      return { currentStep: serializeStep(remaining[0]), completed: false };
    }
    if (input.actionId) {
      await prisma.merchantAction.updateMany({
        where: { id: input.actionId, merchantId: input.merchantId, shopId: input.shopId },
        data: { status: "completed" },
      });
    }
    await prisma.merchantRecommendationWorkflow.updateMany({
      where: { id: input.workflowId, merchantId: input.merchantId, shopId: input.shopId },
      data: { status: "completed" },
    });
    return { currentStep: null, completed: true };
  }
  const status = statusForEligibleStep(next);
  const eligibleIds = new Set([next.id]);
  for (const step of ordered) {
    if (TERMINAL_STEP_STATUSES.has(step.status)) continue;
    const targetStatus = eligibleIds.has(step.id) ? status : ACTION_STEP_STATUS.waiting;
    if (step.status !== targetStatus) {
      await prisma.merchantRecommendationStep.updateMany({
        where: { id: step.id, merchantId: input.merchantId, shopId: input.shopId },
        data: {
          status: targetStatus,
          statusReason:
            targetStatus === ACTION_STEP_STATUS.waiting
              ? "Waiting on an earlier step."
              : statusReasonFor(targetStatus),
          ...(targetStatus === ACTION_STEP_STATUS.ready ||
          targetStatus === ACTION_STEP_STATUS.needsMerchant
            ? { startedAt: null, completedAt: null }
            : {}),
        },
      });
    }
  }
  return {
    currentStep: serializeStep({ ...next, status }),
    completed: false,
  };
}

/**
 * @param {any} prisma
 * @param {{ stepRunId: string; result?: any; attention?: any; error?: any; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function completeActionStepRun(prisma, input) {
  const now = new Date();
  const run = async (/** @type {any} */ tx) => {
    const stepRun = await tx.merchantRecommendationStepRun.findFirst({
      where: { id: input.stepRunId },
      include: {
        step: {
          include: {
            workflow: true,
          },
        },
      },
    });
    if (!stepRun) return { ok: false, reason: "not_found" };
    const hasAttention = Boolean(input.attention) || resultNeedsAttention(input.result);
    const nextStatus = hasAttention
      ? ACTION_STEP_STATUS.needsAttention
      : input.error
        ? ACTION_STEP_STATUS.needsAttention
        : ACTION_STEP_STATUS.completed;
    await tx.merchantRecommendationStepRun.updateMany({
      where: { id: stepRun.id, status: { in: [ACTION_STEP_RUN_STATUS.running, ACTION_STEP_RUN_STATUS.queued] } },
      data: {
        status: hasAttention || input.error ? ACTION_STEP_RUN_STATUS.needsAttention : ACTION_STEP_RUN_STATUS.succeeded,
        result: jsonObject(input.result),
        error: jsonObject(input.error),
        completedAt: now,
      },
    });
    await tx.merchantRecommendationStep.updateMany({
      where: { id: stepRun.stepId, merchantId: stepRun.merchantId, shopId: stepRun.shopId },
      data: {
        status: nextStatus,
        completedAt: nextStatus === ACTION_STEP_STATUS.completed ? now : null,
        progress: jsonObject(input.result),
        attention: jsonObject(input.attention ?? input.error ?? attentionFromResult(input.result)),
        statusReason:
          nextStatus === ACTION_STEP_STATUS.completed
            ? "Step completed."
            : "This step needs attention before Jefe can continue.",
      },
    });
    const action = await tx.merchantAction.findFirst({
      where: {
        merchantId: stepRun.merchantId,
        shopId: stepRun.shopId,
        sourceRecommendationId: stepRun.step.recommendationId,
      },
      select: { id: true },
    });
    const advance =
      nextStatus === ACTION_STEP_STATUS.completed
        ? await advanceActionWorkflow(tx, {
            merchantId: stepRun.merchantId,
            shopId: stepRun.shopId,
            actionId: action?.id ?? null,
            workflowId: stepRun.step.workflowId,
            now,
          })
        : { currentStep: { id: stepRun.stepId, status: nextStatus }, completed: false };
    return {
      ok: true,
      stepId: stepRun.stepId,
      status: nextStatus,
      currentStep: advance.currentStep,
      completed: advance.completed,
    };
  };
  return prisma.$transaction ? prisma.$transaction(run) : run(prisma);
}

/**
 * Claim and execute one queued step run.
 *
 * @param {any} prisma
 * @param {{ logger?: Pick<Console, "info" | "warn" | "error">; loadOfflineToken?: (shop: string) => Promise<string>; createGqlClient?: (opts: any) => { request: (query: string, variables?: any) => Promise<any> } }} [options]
 */
export async function processNextActionStepRun(prisma, options = {}) {
  const logger = options.logger ?? log;
  const now = new Date();
  const stepRun = await prisma.merchantRecommendationStepRun.findFirst({
    where: { status: ACTION_STEP_RUN_STATUS.queued },
    orderBy: [{ queuedAt: "asc" }, { createdAt: "asc" }],
    include: {
      shop: true,
      step: true,
    },
  });
  if (!stepRun) return null;
  const claimed = await prisma.merchantRecommendationStepRun.updateMany({
    where: { id: stepRun.id, status: ACTION_STEP_RUN_STATUS.queued },
    data: { status: ACTION_STEP_RUN_STATUS.running, startedAt: now },
  });
  if (claimed.count !== 1) return null;

  if (stepRun.step.mode === "assist") {
    const action = await prisma.merchantAction.findFirst({
      where: {
        merchantId: stepRun.merchantId,
        shopId: stepRun.shopId,
        sourceRecommendationId: stepRun.step.recommendationId,
      },
      select: { id: true },
    });
    const assist = await produceAssistStepArtifact(prisma, {
      stepRun,
      actionId: action?.id ?? "",
      logger,
    });
    if (assist.ok && assist.progress) {
      await completeActionStepRun(prisma, {
        stepRunId: stepRun.id,
        result: assist.progress,
        logger,
      });
      return {
        status: "succeeded",
        stepRunId: stepRun.id,
        stepId: stepRun.stepId,
        artifactType: assist.progress.artifactType ?? null,
      };
    }
    await completeActionStepRun(prisma, {
      stepRunId: stepRun.id,
      attention: {
        reason: assist.reason ?? "assist_failed",
        detail: "Jefe couldn't finish this assist step yet. Try again from chat.",
      },
      logger,
    });
    return {
      status: "needs_attention",
      stepRunId: stepRun.id,
      stepId: stepRun.stepId,
      reason: assist.reason ?? "assist_failed",
    };
  }

  if (stepRun.step.mode !== "execute") {
    await prisma.merchantRecommendationStepRun.updateMany({
      where: { id: stepRun.id },
      data: {
        status: ACTION_STEP_RUN_STATUS.cancelled,
        completedAt: now,
        error: { reason: "non_executable_step_run_cancelled" },
      },
    });
    await prisma.merchantRecommendationStep.updateMany({
      where: {
        id: stepRun.stepId,
        merchantId: stepRun.merchantId,
        shopId: stepRun.shopId,
        status: ACTION_STEP_STATUS.running,
      },
      data: {
        status:
          stepRun.step.mode === "merchant_action" ||
          stepRun.step.mode === "evidence_required"
            ? ACTION_STEP_STATUS.needsMerchant
            : ACTION_STEP_STATUS.waiting,
        statusReason: "Waiting for merchant input.",
      },
    });
    return {
      status: "cancelled",
      stepRunId: stepRun.id,
      stepId: stepRun.stepId,
      reason: "merchant_owned_step",
    };
  }

  if (!stepRun.actionExecutionRunId) {
    const attention = { reason: "missing_action_execution", detail: "No typed execution row is linked to this step." };
    await completeActionStepRun(prisma, { stepRunId: stepRun.id, attention, logger });
    return { status: "needs_attention", stepRunId: stepRun.id, stepId: stepRun.stepId };
  }

  logger.info("action step run executing", {
    merchantId: stepRun.merchantId,
    shopId: stepRun.shopId,
    stepRunId: stepRun.id,
    stepId: stepRun.stepId,
    actionRunId: stepRun.actionExecutionRunId,
  });

  const merchantAction = await prisma.merchantAction.findFirst({
    where: {
      merchantId: stepRun.merchantId,
      shopId: stepRun.shopId,
      sourceRecommendationId: stepRun.step.recommendationId,
    },
    select: { id: true },
  });
  if (merchantAction?.id) {
    await prepareExecutionChangeSet(prisma, {
      merchantId: stepRun.merchantId,
      shopId: stepRun.shopId,
      actionId: merchantAction.id,
      logger,
    });
  }

  const loadToken = options.loadOfflineToken;
  let result;
  try {
    result = await executeApprovedAction(
      prisma,
      { shop: stepRun.shop.shopDomain },
      {
        merchantId: stepRun.merchantId,
        actionRunId: stepRun.actionExecutionRunId,
        mode: stepRun.actor === "auto" ? "auto" : "approve",
      },
      {
        ...(loadToken
          ? {
              loadOfflineToken: async (
                /** @type {any} */ _prisma,
                /** @type {string} */ shop,
              ) => loadToken(shop),
            }
          : {}),
        ...(options.createGqlClient ? { createGqlClient: options.createGqlClient } : {}),
      },
    );
  } catch (error) {
    logger.error("action step run execution threw", {
      merchantId: stepRun.merchantId,
      shopId: stepRun.shopId,
      stepRunId: stepRun.id,
      stepId: stepRun.stepId,
      actionRunId: stepRun.actionExecutionRunId,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    await completeActionStepRun(prisma, {
      stepRunId: stepRun.id,
      error: { reason: "execution_exception", errorName: error instanceof Error ? error.name : typeof error },
      logger,
    });
    return { status: "needs_attention", stepRunId: stepRun.id, stepId: stepRun.stepId };
  }
  if (merchantAction?.id) {
    const current = await getCurrentChangeSet(prisma, {
      merchantId: stepRun.merchantId,
      shopId: stepRun.shopId,
      actionId: merchantAction.id,
    });
    if (current?.id) {
      await recordChangeSetExecution(prisma, {
        changeSetId: current.id,
        actionRunId: stepRun.actionExecutionRunId,
        result,
        logger,
      });
    }
  }
  if (!result.ok) {
    await completeActionStepRun(prisma, {
      stepRunId: stepRun.id,
      error: { reason: result.reason ?? "execution_failed", result },
      logger,
    });
    return { status: "needs_attention", stepRunId: stepRun.id, stepId: stepRun.stepId, result };
  }
  await completeActionStepRun(prisma, {
    stepRunId: stepRun.id,
    result,
    attention: resultNeedsAttention(result) ? attentionFromResult(result) : null,
    logger,
  });
  return {
    status: resultNeedsAttention(result) ? "needs_attention" : "succeeded",
    stepRunId: stepRun.id,
    stepId: stepRun.stepId,
    result,
  };
}

/**
 * @param {any} prisma
 * @param {{ maxRuns?: number; logger?: Pick<Console, "info" | "warn" | "error">; loadOfflineToken?: (shop: string) => Promise<string>; createGqlClient?: (opts: any) => { request: (query: string, variables?: any) => Promise<any> } }} [options]
 */
export async function processReadyActionStepRuns(prisma, options = {}) {
  const maxRuns = Math.max(1, options.maxRuns ?? 3);
  const results = [];
  for (let index = 0; index < maxRuns; index += 1) {
    const result = await processNextActionStepRun(prisma, options);
    if (!result) break;
    results.push(result);
  }
  return results;
}

/**
 * @param {any} prisma
 * @param {{ now?: Date; staleMs?: number }} [options]
 */
export async function getActionStepRunHealth(prisma, options = {}) {
  if (!prisma?.merchantRecommendationStepRun?.count) {
    return { status: "unknown", queued: null, running: null, failed: null, needsAttention: null, stale: null };
  }
  const now = options.now ?? new Date();
  const staleBefore = new Date(now.getTime() - (options.staleMs ?? 15 * 60_000));
  try {
    const [queued, running, failed, needsAttention, stale] = await Promise.all([
      prisma.merchantRecommendationStepRun.count({ where: { status: ACTION_STEP_RUN_STATUS.queued } }),
      prisma.merchantRecommendationStepRun.count({ where: { status: ACTION_STEP_RUN_STATUS.running } }),
      prisma.merchantRecommendationStepRun.count({ where: { status: ACTION_STEP_RUN_STATUS.failed } }),
      prisma.merchantRecommendationStepRun.count({ where: { status: ACTION_STEP_RUN_STATUS.needsAttention } }),
      prisma.merchantRecommendationStepRun.count({
        where: {
          OR: [
            { status: ACTION_STEP_RUN_STATUS.running, startedAt: { lt: staleBefore } },
            { status: ACTION_STEP_RUN_STATUS.queued, queuedAt: { lt: staleBefore } },
          ],
        },
      }),
    ]);
    return { status: "ok", queued, running, failed, needsAttention, stale };
  } catch {
    return { status: "unknown", queued: null, running: null, failed: null, needsAttention: null, stale: null };
  }
}

/** @param {string} message */
export function isPrimarilyQuestion(message) {
  const text = String(message ?? "").trim();
  if (!text) return false;
  if (/\?\s*$/.test(text)) return true;
  return /^(what|why|how|when|where|who|which|can you|could you|would you|tell me|explain|describe|walk me through|is there|are there|do you)\b/i.test(
    text,
  );
}

/** @param {string} message */
export function isActionStepStartCommand(message) {
  const text = String(message ?? "").trim();
  if (!text || isPrimarilyQuestion(text)) return false;
  if (
    /^(go ahead|do it|start|start it|start this|start the step|start step [0-9]+|do step [0-9]+|analyse them|analyze them|apply the changes|apply changes|start watching)\.?$/i.test(
      text,
    )
  ) {
    return true;
  }
  return (
    /\b(?:go ahead and|please)\s+(?:start|begin|run|do)\b/i.test(text) ||
    /\blet(?:'s| us)\s+(?:go ahead and\s+)?(?:start|begin|run|do)\b/i.test(text) ||
    /\b(?:ok(?:ay)?|yes|sure|yep)[,.\s]+.*\b(?:start|go ahead|do it|do this|run)\b/i.test(
      text,
    ) ||
    /\b(?:start|begin|run|do)\s+(?:that|this|the)\s+step\b/i.test(text) ||
    /\b(?:start|begin|run|do)\s+(?:that|this|it)\b/i.test(text) ||
    /\bstart\s+step\s+[0-9]+\b/i.test(text)
  );
}

/** @param {any} tx @param {{ merchantId: string; shopId: string; actionId: string }} input */
async function loadActionForLifecycle(tx, input) {
  return tx.merchantAction.findFirst({
    where: {
      id: input.actionId,
      merchantId: input.merchantId,
      shopId: input.shopId,
    },
    include: {
      sourceRecommendation: {
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
                  },
                },
              },
            },
          },
        },
      },
      currentExecution: true,
      executions: {
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 5,
      },
    },
  });
}

/** @param {any} action */
function latestWorkflow(action) {
  return Array.isArray(action?.sourceRecommendation?.workflows)
    ? action.sourceRecommendation.workflows[0] ?? null
    : null;
}

/** @param {any[]} steps */
function orderedSteps(steps) {
  return [...(Array.isArray(steps) ? steps : [])].sort(
    (left, right) => Number(left.orderIndex ?? 0) - Number(right.orderIndex ?? 0),
  );
}

/** @param {any[]} steps */
function pickCurrentStep(steps) {
  return (
    steps.find((/** @type {any} */ step) =>
      ACTIVE_STEP_STATUSES.has(String(step.status)),
    ) ?? null
  );
}

/** @param {any[]} steps */
function firstEligibleStep(steps) {
  const byId = new Map(steps.map((step) => [step.id, step]));
  return (
    steps.find((step) => {
      if (TERMINAL_STEP_STATUSES.has(String(step.status))) return false;
      const dependencies = Array.isArray(step.dependsOnStepIds) ? step.dependsOnStepIds : [];
      return dependencies.every((/** @type {string} */ id) =>
        TERMINAL_STEP_STATUSES.has(String(byId.get(id)?.status ?? "")),
      );
    }) ?? null
  );
}

/** @param {any} step */
function statusForEligibleStep(step) {
  if (step.mode === "execute" || step.mode === "assist") {
    return ACTION_STEP_STATUS.ready;
  }
  if (step.mode === "merchant_action" || step.mode === "evidence_required") {
    return ACTION_STEP_STATUS.needsMerchant;
  }
  return ACTION_STEP_STATUS.waiting;
}

/** @param {string} status */
function statusReasonFor(status) {
  if (status === ACTION_STEP_STATUS.ready) return "Ready for the merchant to start.";
  if (status === ACTION_STEP_STATUS.needsMerchant) return "Waiting for merchant input.";
  return "Waiting on more evidence.";
}

/** @param {any} action @param {string} stepId */
function actionExecutionForStep(action, stepId) {
  const workflow = latestWorkflow(action);
  const step = workflow?.steps?.find?.(
    (/** @type {any} */ item) => item.id === stepId,
  );
  return step?.actionExecutions?.[0] ?? action.currentExecution ?? action.executions?.[0] ?? null;
}

/** @param {any} step */
function isStepStartable(step) {
  const status = String(step?.status ?? "");
  const mode = String(step?.mode ?? "");
  if (status === ACTION_STEP_STATUS.ready) return true;
  // Assist steps are Jefe-owned. The UI shows them as ready even though lifecycle
  // unlocks them as needs_merchant — chat and the Review proposals button must
  // be able to start them the same way.
  if (status === ACTION_STEP_STATUS.needsMerchant && mode === "assist") return true;
  return false;
}

/** @param {any} step */
function claimStatusForStep(step) {
  return String(step?.status ?? "") === ACTION_STEP_STATUS.needsMerchant
    ? ACTION_STEP_STATUS.needsMerchant
    : ACTION_STEP_STATUS.ready;
}

/** @param {any} step */
function serializeStep(step) {
  if (!step) return null;
  return {
    id: step.id,
    orderIndex: step.orderIndex,
    title: step.title,
    description: step.description,
    status: step.status,
    mode: step.mode,
    capabilityRef: step.capabilityRef ?? null,
  };
}

/** @param {any} result */
function resultNeedsAttention(result) {
  if (!result || typeof result !== "object") return false;
  if (result.reason === "execution_disabled") return true;
  if (result.status === "partially_applied" || result.status === "failed") return true;
  if (Number(result.skippedCount ?? 0) > 0) return true;
  if (Array.isArray(result.skipped) && result.skipped.length > 0) return true;
  if (Array.isArray(result.refused) && result.refused.length > 0) return true;
  return false;
}

/** @param {any} result */
function attentionFromResult(result) {
  if (!result || typeof result !== "object") return {};
  return {
    reason: result.reason ?? result.status ?? "partial_execution",
    skippedCount: Number(result.skippedCount ?? (Array.isArray(result.skipped) ? result.skipped.length : 0)) || 0,
    refusedCount: Array.isArray(result.refused) ? result.refused.length : 0,
    detail: "Some work needs review before Jefe can continue.",
  };
}

/** @param {any} value */
function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** @param {unknown} error */
function isUniqueConflict(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}
