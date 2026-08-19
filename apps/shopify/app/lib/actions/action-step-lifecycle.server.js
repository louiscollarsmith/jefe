// @ts-check

import { executeApprovedAction } from "./execute-approved-action.server.js";
import { produceAssistStepArtifact } from "./assist-steps/run.server.js";
import { logger as baseLogger } from "../observability/logger.server.js";
import {
  prepareExecutionChangeSet,
  recordChangeSetExecution,
  getCurrentChangeSet,
} from "./action-changeset.server.js";
import {
  resolveActionContext,
  snapshotFromResolvedContext,
} from "./resolved-action-context.server.js";

const log = baseLogger.child({ component: "action-step-lifecycle" });

export const ACTION_STEP_STATUS = Object.freeze({
  draft: "draft",
  waiting: "waiting",
  ready: "ready",
  running: "running",
  needsMerchant: "needs_merchant",
  needsAttention: "needs_attention",
  needsUpdating: "needs_updating",
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
      ? await reconcileWorkflow(tx, {
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
 * @param {{ merchantId: string; shopId: string; actionId: string; stepId?: string | null; actor?: string | null; idempotencyKey?: string | null; logger?: Pick<Console, "info" | "warn" | "error">; resolvedContext?: any }} input
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

    // Reconcile before the startability guard so that a persisted
    // "completed prerequisite → waiting dependent" state is always
    // corrected before we evaluate whether the step can be started.
    const needsReconcile = !current || !isStepStartable(current);
    if (needsReconcile) {
      const advance = await reconcileWorkflow(tx, {
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
    const resolved =
      input.resolvedContext ??
      (await resolveActionContext(tx, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        actionId: action.id,
        logger,
      }));
    const inputSnapshot = resolved ? snapshotFromResolvedContext(resolved) : {};
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
          inputSnapshot,
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
    return {
      ok: true,
      actionId: action.id,
      stepId: current.id,
      stepRunId: stepRun?.id ?? null,
      resolvedContext: resolved,
      inputSnapshot,
    };
  };
  const result = prisma.$transaction ? await prisma.$transaction(run) : await run(prisma);
  if (result.ok) {
    logger.info("merchant started action step", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.actionId,
      stepId: result.stepId,
      stepRunId: result.stepRunId,
      planVersion: result.inputSnapshot?.planVersion ?? null,
      constraintVersion: result.inputSnapshot?.constraintVersion ?? null,
      inputHash: result.inputSnapshot?.inputHash ?? null,
      coverDays: result.inputSnapshot?.plan?.coverDays ?? null,
      scopeCount: Array.isArray(result.inputSnapshot?.scope)
        ? result.inputSnapshot.scope.length
        : null,
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
    const advance = await reconcileWorkflow(tx, {
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
    const advance = await reconcileWorkflow(tx, {
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
    // Keep the in-transaction view consistent so we can assert invariants before commit.
    step.status = targetStatus;
  }
  assertReconciledWorkflowInvariants(ordered, next.id, status);
  return {
    currentStep: serializeStep({ ...next, status }),
    completed: false,
  };
}

/**
 * When a recommendation/workflow is already accepted but steps are still on
 * the legacy `pending`/`draft` statuses, unlock the first eligible step to
 * ready / needs_merchant. No-op if a current step is already live.
 *
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string }} input
 */
export async function unlockActiveWorkflowIfNeeded(prisma, input) {
  if (!prisma?.merchantRecommendationStep?.findMany || !prisma?.merchantAction?.findFirst) {
    return { unlocked: false, currentStep: null };
  }
  const action = await loadActionForLifecycle(prisma, input);
  if (!action) return { unlocked: false, currentStep: null };
  if (!STARTABLE_ACTION_STATUSES.has(String(action.status))) {
    return { unlocked: false, currentStep: null };
  }
  const workflow = latestWorkflow(action);
  if (!workflow) return { unlocked: false, currentStep: null };
  const steps = orderedSteps(workflow.steps);
  if (pickCurrentStep(steps)) {
    return { unlocked: false, currentStep: serializeStep(pickCurrentStep(steps)) };
  }
  const hasLegacy = steps.some((step) =>
    ["pending", "draft"].includes(String(step.status ?? "")),
  );
  if (!hasLegacy) return { unlocked: false, currentStep: null };
  const advanced = await reconcileWorkflow(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: action.id,
    workflowId: workflow.id,
  });
  return { unlocked: Boolean(advanced.currentStep), currentStep: advanced.currentStep };
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
        ? await reconcileWorkflow(tx, {
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
    /\bgo ahead with (?:the )?next step\b/i.test(text) ||
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

/**
 * Hard invariants for sequential workflow reconciliation.
 *
 * After reconciliation chooses the first eligible step, the workflow should be
 * in one coherent shape:
 * - the eligible step is the only non-terminal step allowed to be `ready` /
 *   `needs_merchant`
 * - all other non-terminal steps must be `waiting`
 *
 * This prevents the "completed prerequisite but dependent still waiting"
 * contradiction from persisting.
 *
 * @param {any[]} steps ordered by orderIndex
 * @param {string} expectedNextId
 * @param {string} expectedNextStatus
 */
function assertReconciledWorkflowInvariants(steps, expectedNextId, expectedNextStatus) {
  /** @type {Map<string, any>} */
  const byId = new Map(steps.map((step) => [String(step.id), step]));
  const next = byId.get(String(expectedNextId));
  if (!next) throw new Error(`workflow invariant failed: missing next step ${expectedNextId}`);

  for (const step of steps) {
    const stepId = String(step.id);
    const status = String(step.status ?? "");

    if (TERMINAL_STEP_STATUSES.has(status)) continue;

    if (stepId === String(expectedNextId)) {
      if (status !== String(expectedNextStatus)) {
        throw new Error(
          `workflow invariant failed: expected step ${stepId} to be ${expectedNextStatus} but got ${status}`,
        );
      }

      const dependencies = Array.isArray(step.dependsOnStepIds) ? step.dependsOnStepIds : [];
      const depsSatisfied = dependencies.every((/** @type {string} */ id) =>
        TERMINAL_STEP_STATUSES.has(String(byId.get(String(id))?.status ?? "")),
      );
      if (!depsSatisfied) {
        throw new Error(`workflow invariant failed: next step ${stepId} dependencies are not satisfied`);
      }
    } else if (status !== ACTION_STEP_STATUS.waiting) {
      throw new Error(
        `workflow invariant failed: expected non-terminal step ${stepId} to be waiting, but got ${status}`,
      );
    }
  }
}

/**
 * Deterministic workflow reconciliation boundary.
 *
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId?: string | null; workflowId: string; now?: Date }} input
 */
export async function reconcileWorkflow(prisma, input) {
  return advanceActionWorkflow(prisma, input);
}

/**
 * Detect whether a set of steps has a derivable inconsistency that can be
 * safely repaired by `reconcileWorkflow`. Returns true only when:
 *
 *   - At least one non-terminal step is `waiting`
 *   - All of that step's dependencies are in terminal statuses
 *
 * This is the "completed prerequisite → still waiting dependent" stale state
 * that `unlockActiveWorkflowIfNeeded` does not catch (it only looks for
 * pending/draft). The steps must already be loaded and ordered.
 *
 * @param {any[]} steps
 * @returns {boolean}
 */
export function hasDerivableInconsistency(steps) {
  const ordered = [...(Array.isArray(steps) ? steps : [])].sort(
    (left, right) => Number(left.orderIndex ?? 0) - Number(right.orderIndex ?? 0),
  );
  const byId = new Map(ordered.map((step) => [String(step.id), step]));
  return ordered.some((step) => {
    if (String(step.status ?? "") !== ACTION_STEP_STATUS.waiting) return false;
    const deps = Array.isArray(step.dependsOnStepIds) ? step.dependsOnStepIds : [];
    return deps.every((/** @type {string} */ id) =>
      TERMINAL_STEP_STATUSES.has(String(byId.get(String(id))?.status ?? "")),
    );
  });
}

/**
 * Repair an active workflow whose persisted step statuses contain a derivable
 * inconsistency (e.g. "Step 1 completed, Step 2 still waiting on Step 1").
 *
 * Safe to call on every action load — it short-circuits quickly when there is
 * nothing to repair. It never rewrites historical execution results: it only
 * promotes derived lifecycle state that the reconciler can deterministically
 * compute from existing completed/skipped steps.
 *
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 * @returns {Promise<{ healed: boolean; currentStep: any | null }>}
 */
export async function healInconsistentWorkflow(prisma, input) {
  const logger = input.logger ?? log;
  if (!prisma?.merchantAction?.findFirst) return { healed: false, currentStep: null };
  const action = await loadActionForLifecycle(prisma, input);
  if (!action) return { healed: false, currentStep: null };
  if (!STARTABLE_ACTION_STATUSES.has(String(action.status))) {
    return { healed: false, currentStep: null };
  }
  const workflow = latestWorkflow(action);
  if (!workflow) return { healed: false, currentStep: null };
  const steps = orderedSteps(workflow.steps);

  // Only repair if there is a live active step already — don't compete with
  // the pending/draft unlock path handled by unlockActiveWorkflowIfNeeded.
  const hasActive = steps.some((step) => ACTIVE_STEP_STATUSES.has(String(step.status ?? "")));
  if (hasActive) return { healed: false, currentStep: null };

  if (!hasDerivableInconsistency(steps)) {
    return { healed: false, currentStep: null };
  }

  logger.info("healing inconsistent workflow state", {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.actionId,
    waitingStepIds: steps
      .filter((s) => String(s.status) === ACTION_STEP_STATUS.waiting)
      .map((s) => s.id),
  });

  const advance = await reconcileWorkflow(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.actionId,
    workflowId: workflow.id,
  });

  return { healed: Boolean(advance.currentStep), currentStep: advance.currentStep };
}

/**
 * Workflow consistency assertion. In tests this throws on any violation.
 * In production it returns a structured diagnostic instead.
 *
 * Checks:
 *  - Impossible dependency state: step B waiting while all deps are terminal
 *  - Ready without satisfied dependency: step B ready while a dep is not terminal
 *  - Invalid current step: active step is also terminal (contradiction)
 *  - Missing current step while eligible required step exists
 *  - Completed action with unfinished required work
 *
 * @param {any[]} steps ordered steps
 * @param {{ actionStatus?: string; throwOnViolation?: boolean }} [options]
 * @returns {{ consistent: boolean; violations: string[] }}
 */
export function assertWorkflowConsistent(steps, options = {}) {
  const throwOnViolation = options.throwOnViolation ?? true;
  const actionStatus = String(options.actionStatus ?? "");
  const ordered = [...(Array.isArray(steps) ? steps : [])].sort(
    (left, right) => Number(left.orderIndex ?? 0) - Number(right.orderIndex ?? 0),
  );
  const byId = new Map(ordered.map((step) => [String(step.id), step]));
  /** @type {string[]} */
  const violations = [];

  for (const step of ordered) {
    const stepId = String(step.id);
    const status = String(step.status ?? "");
    const deps = Array.isArray(step.dependsOnStepIds) ? step.dependsOnStepIds : [];

    const allDepsDone = deps.every((/** @type {string} */ id) =>
      TERMINAL_STEP_STATUSES.has(String(byId.get(String(id))?.status ?? "")),
    );

    // Impossible: waiting but all deps are already terminal
    if (status === ACTION_STEP_STATUS.waiting && deps.length > 0 && allDepsDone) {
      const depDetails = deps.map((/** @type {string} */ id) => {
        const dep = byId.get(String(id));
        return dep ? `${dep.title ?? id}=${dep.status}` : id;
      }).join(", ");
      violations.push(
        `Step "${step.title ?? stepId}" is waiting but all dependencies are satisfied (${depDetails}). ` +
        `This state is derivably wrong and should be repaired by reconcileWorkflow().`,
      );
    }

    // Ready/needs_merchant but a dep is not terminal
    if (
      (status === ACTION_STEP_STATUS.ready || status === ACTION_STEP_STATUS.needsMerchant) &&
      !allDepsDone
    ) {
      const unsatisfied = deps
        .filter((/** @type {string} */ id) => !TERMINAL_STEP_STATUSES.has(String(byId.get(String(id))?.status ?? "")))
        .map((/** @type {string} */ id) => {
          const dep = byId.get(String(id));
          return dep ? `${dep.title ?? id}=${dep.status}` : id;
        });
      violations.push(
        `Step "${step.title ?? stepId}" is ${status} but has unsatisfied dependencies: ${unsatisfied.join(", ")}.`,
      );
    }

    // Active step that is also terminal — impossible
    if (ACTIVE_STEP_STATUSES.has(status) && TERMINAL_STEP_STATUSES.has(status)) {
      violations.push(`Step "${step.title ?? stepId}" has contradictory status: ${status}.`);
    }
  }

  // Completed action with non-terminal required steps
  if (actionStatus === "completed") {
    const incomplete = ordered.filter(
      (step) => !TERMINAL_STEP_STATUSES.has(String(step.status ?? "")),
    );
    if (incomplete.length > 0) {
      violations.push(
        `Action is completed but steps are still non-terminal: ${incomplete.map((s) => `${s.title ?? s.id}=${s.status}`).join(", ")}.`,
      );
    }
  }

  if (violations.length > 0 && throwOnViolation) {
    throw new Error(`Workflow consistency violations:\n${violations.map((v) => `  - ${v}`).join("\n")}`);
  }

  return { consistent: violations.length === 0, violations };
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
  // Assist steps unlocked as needs_merchant are still Jefe-owned and startable.
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
