// @ts-check

import { isActionExecuteEnabled } from "./action-intent.server.js";
import { buildActionRaise } from "./action-raise.server.js";
import { logger as baseLogger } from "../observability/logger.server.js";

const log = baseLogger.child({ component: "merchant-action" });

export const MERCHANT_ACTION_STATUS = Object.freeze({
  proposed: "proposed",
  accepted: "accepted",
  inProgress: "in_progress",
  deferred: "deferred",
  declined: "declined",
  completed: "completed",
  superseded: "superseded",
});

export const MERCHANT_CURRENT_FOCUS_KIND = Object.freeze({
  merchantInput: "merchant_input",
  actionProblem: "action_problem",
  actionReady: "action_ready",
  recommendation: "recommendation",
  progress: "progress",
  empty: "empty",
});

export const MERCHANT_ATTENTION_TYPE = Object.freeze({
  needsAttention: "NEEDS_ATTENTION",
  merchantInputRequired: "MERCHANT_INPUT_REQUIRED",
  stepReady: "STEP_READY",
});

const ACTIVE_STATUSES = new Set([
  MERCHANT_ACTION_STATUS.proposed,
  MERCHANT_ACTION_STATUS.accepted,
  MERCHANT_ACTION_STATUS.inProgress,
]);

/**
 * @param {{ recommendation?: any | null; execution?: any | null }} input
 */
export function deriveMerchantActionStatus(input) {
  const execution = input.execution ?? null;
  const recommendation = input.recommendation ?? null;
  const executionStatus = normalizeToken(execution?.status);
  const reviewStatus = normalizeToken(recommendation?.reviewStatus);
  if (
    recommendation?.completedAt ||
    reviewStatus === "completed" ||
    (["applied", "partially_applied"].includes(executionStatus) &&
      execution?.outcomeStatus === "measured")
  ) {
    return MERCHANT_ACTION_STATUS.completed;
  }
  if (["applied", "partially_applied", "approved"].includes(executionStatus)) {
    return MERCHANT_ACTION_STATUS.inProgress;
  }
  if (["rejected", "reverted"].includes(executionStatus)) {
    return MERCHANT_ACTION_STATUS.declined;
  }
  if (reviewStatus === "accepted" && recommendationHasStartedWorkflowStep(recommendation)) {
    return MERCHANT_ACTION_STATUS.inProgress;
  }
  if (reviewStatus === "accepted") return MERCHANT_ACTION_STATUS.accepted;
  if (reviewStatus === "deferred") return MERCHANT_ACTION_STATUS.deferred;
  if (reviewStatus === "rejected") return MERCHANT_ACTION_STATUS.declined;
  if (reviewStatus === "superseded" || executionStatus === "superseded") {
    return MERCHANT_ACTION_STATUS.superseded;
  }
  return MERCHANT_ACTION_STATUS.proposed;
}

/**
 * Keep the durable MerchantAction identity in step with the current recommendation
 * and execution ledgers. Best-effort: callers can use this on read paths without
 * risking a failed page if a narrow test double lacks the new model.
 *
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function syncMerchantActionsForShop(prisma, input) {
  if (!prisma?.merchantAction?.upsert) return { synced: false };
  const logger = input.logger ?? log;
  try {
    const recommendations = await prisma.merchantPlanRecommendation.findMany({
      where: { merchantId: input.merchantId, shopId: input.shopId },
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
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 100,
    });

    for (const recommendation of recommendations) {
      const action = await prisma.merchantAction.upsert({
        where: { sourceRecommendationId: recommendation.id },
        create: merchantActionDataFromRecommendation(recommendation),
        update: merchantActionUpdateFromRecommendation(recommendation),
        select: { id: true },
      });
      const execution = currentExecutionFromRecommendation(recommendation);
      if (execution?.runId) {
        await prisma.actionExecution.updateMany({
          where: {
            runId: execution.runId,
            merchantId: input.merchantId,
            shopId: input.shopId,
            merchantActionId: null,
          },
          data: { merchantActionId: action.id },
        });
      }
    }

    const orphanExecutions = await prisma.actionExecution.findMany({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        merchantActionId: null,
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 100,
    });
    for (const execution of orphanExecutions) {
      const existing = await prisma.merchantAction.findFirst({
        where: {
          merchantId: input.merchantId,
          shopId: input.shopId,
          currentActionRunId: execution.runId,
        },
        select: { id: true },
      });
      const action =
        existing ??
        (await prisma.merchantAction.create({
          data: merchantActionDataFromExecution(execution),
          select: { id: true },
        }));
      await prisma.actionExecution.updateMany({
        where: {
          runId: execution.runId,
          merchantId: input.merchantId,
          shopId: input.shopId,
          merchantActionId: null,
        },
        data: { merchantActionId: action.id },
      });
    }

    return { synced: true, count: recommendations.length + orphanExecutions.length };
  } catch (error) {
    logger.warn("merchant action sync failed", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return { synced: false };
  }
}

/**
 * Called when a new ActionExecution is created so fresh proposals immediately
 * have a focusable MerchantAction identity.
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionRunId: string; sourceRecommendation?: any | null; execution?: any | null }} input
 */
export async function ensureMerchantActionForExecution(prisma, input) {
  if (!prisma?.merchantAction?.upsert || !input.actionRunId) return null;
  const sourceRecommendationId =
    typeof input.sourceRecommendation?.id === "string"
        ? input.sourceRecommendation.id
        : null;
  let action = null;
  if (sourceRecommendationId) {
    const recommendation =
      input.sourceRecommendation ??
      (await prisma.merchantPlanRecommendation.findFirst?.({
        where: {
          id: sourceRecommendationId,
          merchantId: input.merchantId,
          shopId: input.shopId,
        },
      }));
    action = await prisma.merchantAction.upsert({
      where: { sourceRecommendationId },
      create: merchantActionDataFromRecommendation({
        ...recommendation,
        id: sourceRecommendationId,
        merchantId: input.merchantId,
        shopId: input.shopId,
        workflows: input.sourceRecommendation?.workflows ?? [],
        currentActionRunId: input.actionRunId,
      }),
      update: {
        title: safeText(recommendation?.title, 180) || "Review Jefe's next move",
        summary: safeText(recommendation?.summary, 600),
        status: deriveMerchantActionStatus({
          recommendation,
          execution: input.execution ?? { runId: input.actionRunId, status: "proposed" },
        }),
        currentActionRunId: input.actionRunId,
        progress: progressFromRecommendation(recommendation),
      },
      select: { id: true },
    });
  } else {
    action = await prisma.merchantAction.create({
      data: merchantActionDataFromExecution({
        ...(input.execution ?? {}),
        runId: input.actionRunId,
        merchantId: input.merchantId,
        shopId: input.shopId,
      }),
      select: { id: true },
    });
  }
  await prisma.actionExecution.updateMany({
    where: {
      runId: input.actionRunId,
      merchantId: input.merchantId,
      shopId: input.shopId,
      merchantActionId: null,
    },
    data: { merchantActionId: action.id },
  });
  return action;
}

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; includeInactive?: boolean; sync?: boolean }} input
 */
export async function listMerchantActions(prisma, input) {
  if (input.sync !== false) await syncMerchantActionsForShop(prisma, input);
  if (!prisma?.merchantAction?.findMany) return [];
  const rows = await prisma.merchantAction.findMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      ...(input.includeInactive ? {} : { status: { in: [...ACTIVE_STATUSES] } }),
    },
    include: {
      sourceRecommendation: recommendationWorkflowInclude(),
      currentExecution: true,
      executions: {
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 3,
      },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 40,
  });
  return rows.map(serializeMerchantAction);
}

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId?: string | null }} input
 */
export async function getMerchantAction(prisma, input) {
  if (!input.actionId || !prisma?.merchantAction?.findFirst) return null;
  const row = await prisma.merchantAction.findFirst({
    where: {
      id: input.actionId,
      merchantId: input.merchantId,
      shopId: input.shopId,
    },
    include: {
      sourceRecommendation: recommendationWorkflowInclude(),
      currentExecution: true,
      executions: {
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 5,
      },
    },
  });
  return row ? serializeMerchantAction(row) : null;
}

/**
 * @param {any} row
 */
export function serializeMerchantAction(row) {
  const source = row.sourceRecommendation ?? null;
  const execution = row.currentExecution ?? row.executions?.[0] ?? null;
  const status = deriveMerchantActionStatus({ recommendation: source, execution });
  const summary = safeText(row.summary || source?.summary, 700);
  const progress = jsonObject(row.progress);
  const executionSummary = jsonObject(execution?.proposalSummary);
  return {
    id: row.id,
    title: safeText(row.title || source?.title, 180) || "Review Jefe's next move",
    summary,
    status,
    statusLabel: statusLabel(status, execution),
    statusTone: status === MERCHANT_ACTION_STATUS.inProgress ? "green" : status === MERCHANT_ACTION_STATUS.proposed ? "yellow" : "neutral",
    sourceRecommendationId: row.sourceRecommendationId ?? source?.id ?? null,
    sourceRecommendation: source ? sourceRecommendationView(source) : sourceRecommendationFromSummary(executionSummary),
    actionRunId: row.currentActionRunId ?? execution?.runId ?? null,
    actionType: execution?.actionType ?? null,
    executable:
      execution?.actionType && execution?.resolvedMode !== "recommend"
        ? isActionExecuteEnabled(execution.actionType)
      : false,
    raise: buildActionRaise(execution?.eligibility),
    executionStatus: execution?.status ?? null,
    outcomeStatus: execution?.outcomeStatus ?? null,
    progress,
    displaySteps: displaySteps(progress, source),
    successText: successText(progress, source),
    baselineSignal: baselineSignal(executionSummary),
    currentSignal: currentSignal(execution, executionSummary),
    updatedAt: row.updatedAt?.toISOString?.() ?? null,
    createdAt: row.createdAt?.toISOString?.() ?? null,
  };
}

/**
 * Derive the one thing the merchant should pay attention to on the Daily Home.
 * This is intentionally pure and read-only: callers pass the already-serialized
 * MerchantAction rows, and this layer adds home-priority metadata without creating
 * a second "home focus" record.
 *
 * @param {{ merchantActions?: any[]; actions?: any[] }} input
 */
export function getMerchantCurrentFocus(input = {}) {
  return getMerchantCurrentFocuses(input)[0];
}

/**
 * Return every attention-worthy Daily Home focus, in the same deterministic
 * priority order used for the default hero. Quiet progress remains a fallback
 * only: it is not mixed into the carousel when there are real things to act on.
 *
 * @param {{ merchantActions?: any[]; actions?: any[] }} input
 */
export function getMerchantCurrentFocuses(input = {}) {
  /** @type {any[]} */
  const attention = getMerchantAttentionItems(input).map(focusFromAttentionItem);
  const actions = Array.isArray(input.merchantActions)
    ? input.merchantActions
    : Array.isArray(input.actions)
      ? input.actions
      : [];
  const working = actions.filter(isWorkingActionForFocus);
  const proposed = getMerchantProposedActions(input);

  for (const action of proposed) {
    attention.push(focusFromAction(action, {
      kind: MERCHANT_CURRENT_FOCUS_KIND.recommendation,
      priority: 4,
      headline: "Here's what I'd do next.",
      eyebrow: "Recommended",
      reason: action.summary || "This is the next useful move Jefe has found.",
      ctaLabel: "Talk this through",
      ctaIntent: "chat.focus.start",
    }));
  }

  if (attention.length > 0) return attention;

  const progress = working.find((action) => action.status === MERCHANT_ACTION_STATUS.inProgress) ?? working[0] ?? null;
  if (progress) {
    return [focusFromAction(progress, {
      kind: MERCHANT_CURRENT_FOCUS_KIND.progress,
      priority: 5,
      headline: "Nothing needs your attention right now.",
      eyebrow: "In progress",
      reason: progress.currentSignal || progress.successText || "Jefe is working on this and will report back when there is an outcome.",
      ctaLabel: "Talk this through",
      ctaIntent: "chat.focus.start",
    })];
  }

  return [{
    kind: MERCHANT_CURRENT_FOCUS_KIND.empty,
    priority: 99,
    headline: "Nothing needs your attention right now.",
    eyebrow: "All clear",
    reason: "When there is a grounded action to review, start, or fix, it will appear here.",
    actionId: null,
    actionRunId: null,
    ctaLabel: null,
    ctaIntent: null,
    action: null,
  }];
}

/**
 * A queue of merchant handoffs for the Daily Home attention area. This is a
 * view over existing MerchantAction/workflow state; it deliberately creates no
 * homepage lifecycle state that could drift from the action system.
 *
 * @param {{ merchantActions?: any[]; actions?: any[] }} input
 */
export function getMerchantAttentionItems(input = {}) {
  const actions = actionsFromInput(input);
  const working = actions.filter(isWorkingActionForFocus);
  /** @type {any[]} */
  const items = [];
  const seen = new Set();
  const pushItem = (/** @type {any} */ action, /** @type {any} */ attention) => {
    const item = attentionItemFromAction(action, attention);
    const key = focusKey(item);
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  for (const action of working.filter(actionHasProblem)) {
    pushItem(action, {
      attentionType: MERCHANT_ATTENTION_TYPE.needsAttention,
      priority: 1,
      explanation: problemReason(action),
      ctaLabel: "Review issue",
      ctaIntent: "chat.focus.start",
    });
  }

  for (const action of working.filter(actionNeedsMerchantInput)) {
    pushItem(action, {
      attentionType: MERCHANT_ATTENTION_TYPE.merchantInputRequired,
      priority: 2,
      explanation: merchantInputReason(action),
      ctaLabel: "Review next step",
      ctaIntent: "chat.focus.start",
    });
  }

  for (const action of working.filter(actionHasReadyExecutableStep)) {
    pushItem(action, {
      attentionType: MERCHANT_ATTENTION_TYPE.stepReady,
      priority: 3,
      explanation: readyReason(action),
      ctaLabel: "Start next step",
      ctaIntent: "action.approve",
    });
  }

  return items;
}

/** @param {{ merchantActions?: any[]; actions?: any[] }} input */
export function getMerchantProposedActions(input = {}) {
  return actionsFromInput(input).filter(
    (action) => action?.status === MERCHANT_ACTION_STATUS.proposed,
  );
}

/** @param {{ merchantActions?: any[]; actions?: any[] }} input */
export function getMerchantInProgressActions(input = {}) {
  return actionsFromInput(input).filter(isWorkingActionForFocus);
}

/** @param {{ merchantActions?: any[]; actions?: any[] }} input */
export function getMerchantCompletedActions(input = {}) {
  return actionsFromInput(input).filter(
    (action) => action?.status === MERCHANT_ACTION_STATUS.completed,
  );
}

/**
 * @param {any} recommendation
 */
function merchantActionDataFromRecommendation(recommendation) {
  const execution = currentExecutionFromRecommendation(recommendation);
  const currentActionRunId = execution?.runId ?? recommendation.currentActionRunId ?? null;
  return {
    merchantId: recommendation.merchantId,
    shopId: recommendation.shopId,
    title: safeText(recommendation.title, 180) || "Review Jefe's next move",
    summary: safeText(recommendation.summary, 700),
    status: deriveMerchantActionStatus({ recommendation, execution }),
    sourceRecommendationId: recommendation.id,
    currentActionRunId,
    progress: progressFromRecommendation(recommendation),
    outcome: jsonObject(execution?.outcome ?? recommendation?.outcome),
    createdAt: recommendation.createdAt ?? new Date(),
    updatedAt: recommendation.updatedAt ?? new Date(),
  };
}

/**
 * @param {any} recommendation
 */
function merchantActionUpdateFromRecommendation(recommendation) {
  const execution = currentExecutionFromRecommendation(recommendation);
  const currentActionRunId = execution?.runId ?? recommendation.currentActionRunId ?? null;
  return {
    title: safeText(recommendation.title, 180) || "Review Jefe's next move",
    summary: safeText(recommendation.summary, 700),
    status: deriveMerchantActionStatus({ recommendation, execution }),
    currentActionRunId,
    progress: progressFromRecommendation(recommendation),
    outcome: jsonObject(execution?.outcome ?? recommendation?.outcome),
  };
}

/**
 * @param {any} execution
 */
function merchantActionDataFromExecution(execution) {
  const summary = jsonObject(execution?.proposalSummary);
  const source = sourceRecommendationFromSummary(summary);
  return {
    merchantId: execution.merchantId,
    shopId: execution.shopId,
    title:
      safeText(source?.title, 180) ||
      safeText(execution.actionKind, 120) ||
      safeText(execution.actionType, 120) ||
      "Review Jefe's next move",
    summary: safeText(source?.summary, 700),
    status: deriveMerchantActionStatus({ execution }),
    currentActionRunId: execution.runId,
    progress: {
      actionType: execution.actionType ?? null,
      actionKind: execution.actionKind ?? null,
      preview: jsonObject(execution.preview),
    },
    outcome: jsonObject(execution.outcome),
    createdAt: execution.createdAt ?? new Date(),
    updatedAt: execution.updatedAt ?? new Date(),
  };
}

/**
 * @param {any} recommendation
 */
function progressFromRecommendation(recommendation) {
  const workflow = workflowFromRecommendation(recommendation);
  return {
    workflow: workflowView(workflow),
    successSignal: jsonObject(recommendation?.successSignal),
    reviewStatus: recommendation?.reviewStatus ?? null,
  };
}

/** @returns {any} */
function recommendationWorkflowInclude() {
  return {
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
  };
}

/** @param {any} recommendation */
function workflowFromRecommendation(recommendation) {
  return Array.isArray(recommendation?.workflows) ? recommendation.workflows[0] ?? null : null;
}

/** @param {any} recommendation */
function recommendationHasStartedWorkflowStep(recommendation) {
  const workflow = workflowFromRecommendation(recommendation);
  const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
  return steps.some((/** @type {any} */ step) =>
    ["blocked", "completed", "failed", "in_progress", "needs_attention", "needs_merchant", "running"].includes(
      normalizeToken(step?.status),
    ),
  );
}

/** @param {any} recommendation */
function currentExecutionFromRecommendation(recommendation) {
  const workflow = workflowFromRecommendation(recommendation);
  const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
  return steps.map((/** @type {any} */ step) => step.actionExecutions?.[0]).find(Boolean) ?? null;
}

/** @param {any} workflow */
function workflowView(workflow) {
  if (!workflow) return null;
  return {
    id: workflow.id ?? null,
    version: workflow.version ?? null,
    status: workflow.status ?? null,
    source: workflow.source ?? null,
    steps: Array.isArray(workflow.steps)
      ? workflow.steps.map((/** @type {any} */ step) => ({
          id: step.id ?? null,
          orderIndex: Number.isFinite(Number(step.orderIndex)) ? Number(step.orderIndex) : 0,
          title: safeText(step.title, 120),
          description: safeText(step.description, 260),
          completionCriteria: safeText(step.completionCriteria, 220) || null,
          status: step.status ?? null,
          mode: step.mode ?? null,
          capabilityRef: step.capabilityRef ?? null,
          dependsOnStepIds: Array.isArray(step.dependsOnStepIds) ? step.dependsOnStepIds : [],
          evidenceIds: Array.isArray(step.evidenceIds) ? step.evidenceIds : [],
        }))
      : [],
  };
}

/**
 * @param {any} progress
 * @param {any} source
 */
function displaySteps(progress, source) {
  /** @type {any[]} */
  const raw = Array.isArray(source?.workflows?.[0]?.steps)
    ? source.workflows[0].steps
    : Array.isArray(progress?.workflow?.steps)
      ? progress.workflow.steps
      : [];
  return raw.slice(0, 4).map((/** @type {any} */ step, index) => ({
    id: step?.id ?? null,
    label:
      safeText(step?.title || step?.label || step?.description, 160) ||
      `Step ${index + 1}`,
    description: safeText(step?.description, 260) || null,
    completionCriteria: safeText(step?.completionCriteria, 220) || null,
    status: safeText(step?.status, 40) || null,
    mode: safeText(step?.mode, 40) || null,
    capabilityRef: safeText(step?.capabilityRef, 120) || null,
    done: step?.status === "completed" || Boolean(step?.done),
  }));
}

/**
 * @param {any} progress
 * @param {any} source
 */
function successText(progress, source) {
  const signal = jsonObject(progress?.successSignal ?? source?.successSignal);
  return (
    safeText(signal.description, 220) ||
    safeText(signal.target, 220) ||
    safeText(source?.expectedBenefit, 220) ||
    ""
  );
}

/**
 * @param {string} status
 * @param {any} execution
 */
function statusLabel(status, execution) {
  if (status === MERCHANT_ACTION_STATUS.proposed) return "Proposed";
  if (status === MERCHANT_ACTION_STATUS.accepted) return "Accepted";
  if (status === MERCHANT_ACTION_STATUS.inProgress) {
    const approved = execution?.approvedAt ?? execution?.appliedAt;
    return approved ? `Approved ${shortDate(approved)}` : "In progress";
  }
  if (status === MERCHANT_ACTION_STATUS.deferred) return "Deferred";
  if (status === MERCHANT_ACTION_STATUS.declined) return "Declined";
  if (status === MERCHANT_ACTION_STATUS.completed) return "Complete";
  return "Superseded";
}

/** @param {any} action */
function isWorkingActionForFocus(action) {
  return (
    action?.status === MERCHANT_ACTION_STATUS.accepted ||
    action?.status === MERCHANT_ACTION_STATUS.inProgress
  );
}

/** @param {any} action */
function actionNeedsMerchantInput(action) {
  const step = currentWorkflowStep(action);
  if (!step) return false;
  const mode = normalizeToken(step.mode);
  const status = normalizeToken(step.status);
  return (
    (["merchant_action", "evidence_required"].includes(mode) ||
      ["evidence_required", "needs_merchant"].includes(status)) &&
    !["blocked", "completed", "skipped", "superseded"].includes(status)
  );
}

/** @param {any} action */
function actionHasProblem(action) {
  if (normalizeToken(action?.executionStatus) === "failed") return true;
  return workflowStepsForFocus(action).some(
    (/** @type {any} */ step) =>
      ["blocked", "needs_attention"].includes(normalizeToken(step.status)),
  );
}

/** @param {any} action */
function actionHasReadyExecutableStep(action) {
  const step = currentWorkflowStep(action);
  if (!step) return false;
  const status = normalizeToken(step.status);
  return (
    action?.status === MERCHANT_ACTION_STATUS.accepted &&
    Boolean(action?.actionRunId) &&
    action?.executable !== false &&
    normalizeToken(action?.executionStatus) === "proposed" &&
    normalizeToken(step.mode) === "execute" &&
    ["", "draft", "pending", "proposed", "ready"].includes(status)
  );
}

/** @param {any} action */
function currentWorkflowStep(action) {
  return workflowStepsForFocus(action).find((/** @type {any} */ step) => {
    const status = normalizeToken(step.status);
    return !["completed", "skipped", "superseded"].includes(status);
  }) ?? null;
}

/** @param {any} action */
function workflowStepsForFocus(action) {
  if (Array.isArray(action?.displaySteps)) {
    return action.displaySteps.filter((/** @type {any} */ step) => step && typeof step === "object");
  }
  const steps = action?.progress?.workflow?.steps;
  return Array.isArray(steps) ? steps.filter((/** @type {any} */ step) => step && typeof step === "object") : [];
}

/** @param {any} action */
function merchantInputReason(action) {
  const step = currentWorkflowStep(action);
  return (
    safeText(step?.description, 240) ||
    "Jefe needs your input before this can move forward."
  );
}

/** @param {any} action */
function problemReason(action) {
  if (normalizeToken(action?.executionStatus) === "failed") {
    return "Jefe hit a problem while executing this action.";
  }
  const blocked = workflowStepsForFocus(action).find(
    (/** @type {any} */ step) => normalizeToken(step.status) === "blocked",
  );
  return (
    safeText(blocked?.description, 240) ||
    "The next step is blocked and needs review."
  );
}

/** @param {any} action */
function readyReason(action) {
  const step = currentWorkflowStep(action);
  return (
    safeText(step?.description, 240) ||
    "The plan is accepted and the next step is ready."
  );
}

/**
 * @param {any} action
 * @param {{ kind: string; priority: number; headline: string; eyebrow: string; reason: string; ctaLabel: string; ctaIntent: string }} focus
 */
function focusFromAction(action, focus) {
  return {
    kind: focus.kind,
    priority: focus.priority,
    headline: focus.headline,
    eyebrow: focus.eyebrow,
    reason: focus.reason,
    actionId: action?.id ?? null,
    actionRunId: action?.actionRunId ?? null,
    ctaLabel: focus.ctaLabel,
    ctaIntent: focus.ctaIntent,
    action,
  };
}

/** @param {any} focus */
function focusKey(focus) {
  return (
    focus.actionId ??
    focus.actionRunId ??
    focus.action?.title ??
    focus.kind
  );
}

/**
 * @param {any} action
 * @param {{ attentionType: string; priority: number; explanation: string; ctaLabel: string; ctaIntent: string }} attention
 */
function attentionItemFromAction(action, attention) {
  const step = currentWorkflowStep(action);
  return {
    attentionType: attention.attentionType,
    priority: attention.priority,
    title: action?.title ?? "Review Jefe's next move",
    explanation: attention.explanation,
    actionId: action?.id ?? null,
    actionRunId: action?.actionRunId ?? null,
    stepId: step?.id ?? null,
    ctaLabel: attention.ctaLabel,
    ctaIntent: attention.ctaIntent,
    waitingSince: action?.updatedAt ?? action?.createdAt ?? null,
    action,
  };
}

/** @param {any} item */
function focusFromAttentionItem(item) {
  const kind =
    item.attentionType === MERCHANT_ATTENTION_TYPE.needsAttention
      ? MERCHANT_CURRENT_FOCUS_KIND.actionProblem
      : item.attentionType === MERCHANT_ATTENTION_TYPE.stepReady
        ? MERCHANT_CURRENT_FOCUS_KIND.actionReady
        : MERCHANT_CURRENT_FOCUS_KIND.merchantInput;
  return {
    kind,
    priority: item.priority,
    headline:
      kind === MERCHANT_CURRENT_FOCUS_KIND.actionProblem
        ? "This needs your attention."
        : "Needs your attention",
    eyebrow:
      item.attentionType === MERCHANT_ATTENTION_TYPE.stepReady
        ? "Ready to start"
        : "Needs attention",
    reason: item.explanation,
    actionId: item.actionId,
    actionRunId: item.actionRunId,
    ctaLabel: item.ctaLabel,
    ctaIntent: item.ctaIntent,
    action: item.action,
  };
}

/** @param {{ merchantActions?: any[]; actions?: any[] }} input */
function actionsFromInput(input = {}) {
  return Array.isArray(input.merchantActions)
    ? input.merchantActions
    : Array.isArray(input.actions)
      ? input.actions
      : [];
}

/** @param {unknown} value */
function normalizeToken(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * @param {any} source
 */
function sourceRecommendationView(source) {
  return {
    id: source.id ?? null,
    runId: source.runId ?? null,
    title: safeText(source.title, 180),
    summary: safeText(source.summary, 700),
    whyThisAction: safeText(source.whyThisAction, 700),
    whyNow: safeText(source.whyNow, 500),
    successSignal: jsonObject(source.successSignal),
    primaryGoalId: source.primaryGoalId ?? null,
    workflow: workflowView(workflowFromRecommendation(source)),
  };
}

/**
 * @param {any} summary
 */
function sourceRecommendationFromSummary(summary) {
  const source = jsonObject(summary?.sourceRecommendation);
  if (!source.title && !source.id) return null;
  return sourceRecommendationView(source);
}

/**
 * @param {any} summary
 */
function baselineSignal(summary) {
  const variantCount = Number(summary?.variantCount ?? summary?.productCount);
  if (variantCount > 0 && Number.isFinite(variantCount)) {
    return `${variantCount} product${variantCount === 1 ? "" : "s"}`;
  }
  return null;
}

/**
 * @param {any} execution
 * @param {any} summary
 */
function currentSignal(execution, summary) {
  const outcome = jsonObject(execution?.outcome);
  if (execution?.outcomeStatus === "measured" && Number(outcome?.variantsSold) > 0) {
    return `${Number(outcome.variantsSold)} sold since the move`;
  }
  return baselineSignal(summary);
}

/**
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/**
 * @param {unknown} value
 * @param {number} max
 */
function safeText(value, max = 500) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * @param {Date | string | null | undefined} value
 */
function shortDate(value) {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(date);
}
