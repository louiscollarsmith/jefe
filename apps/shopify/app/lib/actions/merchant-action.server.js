// @ts-check

import { isActionExecuteEnabled } from "./action-intent.server.js";
import { buildActionRaise } from "./action-raise.server.js";
import { logger as baseLogger } from "../observability/logger.server.js";
import {
  healInconsistentWorkflow,
  unlockActiveWorkflowIfNeeded,
} from "./action-step-lifecycle.server.js";
import {
  resolveActionState,
  applyWorkProjectionToAction,
} from "./action-state.server.js";
import {
  buildActionWorkspace,
  workspacePlanItems,
} from "./action-workspace.server.js";

const log = baseLogger.child({ component: "merchant-action" });

export const MERCHANT_ACTION_STATUS = Object.freeze({
  proposed: "proposed",
  accepted: "accepted",
  inProgress: "in_progress",
  needsAttention: "needs_attention",
  deferred: "deferred",
  declined: "declined",
  completed: "completed",
  superseded: "superseded",
});

export const MERCHANT_CURRENT_FOCUS_KIND = Object.freeze({
  merchantInput: "merchant_input",
  actionProblem: "action_problem",
  actionReady: "action_ready",
  artifactReview: "artifact_review",
  externalWait: "external_wait",
  jefeWorking: "jefe_working",
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
  MERCHANT_ACTION_STATUS.needsAttention,
]);

/**
 * @param {{ action?: any | null; recommendation?: any | null; execution?: any | null }} input
 */
export function deriveMerchantActionStatus(input) {
  const execution = input.execution ?? null;
  const recommendation = input.recommendation ?? null;
  const workflow = workflowFromRecommendation(recommendation);
  const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
  const hasNeedsAttention = steps.some((/** @type {any} */ step) =>
    ["blocked", "failed", "needs_attention"].includes(
      normalizeToken(step?.status),
    ),
  );
  const hasRunningStep = steps.some((/** @type {any} */ step) =>
    ["in_progress", "running"].includes(normalizeToken(step?.status)),
  );
  const actionStatus = normalizeToken(input.action?.status);
  const executionStatus = normalizeToken(execution?.status);
  const reviewStatus = normalizeToken(recommendation?.reviewStatus);
  if (actionStatus === MERCHANT_ACTION_STATUS.deferred)
    return MERCHANT_ACTION_STATUS.deferred;
  if (actionStatus === MERCHANT_ACTION_STATUS.declined)
    return MERCHANT_ACTION_STATUS.declined;
  if (actionStatus === MERCHANT_ACTION_STATUS.superseded)
    return MERCHANT_ACTION_STATUS.superseded;
  const hasIncompleteSteps = steps.some(
    (/** @type {any} */ step) =>
      !["completed", "skipped", "superseded"].includes(
        normalizeToken(step?.status),
      ),
  );
  if (
    actionStatus === MERCHANT_ACTION_STATUS.completed ||
    recommendation?.completedAt ||
    reviewStatus === "completed" ||
    (["applied", "partially_applied"].includes(executionStatus) &&
      execution?.outcomeStatus === "measured")
  ) {
    if (hasIncompleteSteps) {
      if (hasRunningStep) return MERCHANT_ACTION_STATUS.inProgress;
      if (hasNeedsAttention) return MERCHANT_ACTION_STATUS.needsAttention;
      return MERCHANT_ACTION_STATUS.inProgress;
    }
    return MERCHANT_ACTION_STATUS.completed;
  }
  if (
    hasNeedsAttention ||
    actionStatus === MERCHANT_ACTION_STATUS.needsAttention
  ) {
    return MERCHANT_ACTION_STATUS.needsAttention;
  }
  if (
    hasRunningStep ||
    actionStatus === MERCHANT_ACTION_STATUS.inProgress ||
    ["applied", "partially_applied", "approved"].includes(executionStatus)
  ) {
    return MERCHANT_ACTION_STATUS.inProgress;
  }
  if (["rejected", "reverted"].includes(executionStatus)) {
    return MERCHANT_ACTION_STATUS.declined;
  }
  if (
    reviewStatus === "accepted" &&
    recommendationHasStartedWorkflowStep(recommendation)
  ) {
    return MERCHANT_ACTION_STATUS.inProgress;
  }
  if (actionStatus === MERCHANT_ACTION_STATUS.accepted) {
    return MERCHANT_ACTION_STATUS.accepted;
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

    return {
      synced: true,
      count: recommendations.length + orphanExecutions.length,
    };
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
        title:
          safeText(recommendation?.title, 180) || "Review Jefe's next move",
        summary: safeText(recommendation?.summary, 600),
        status: deriveMerchantActionStatus({
          recommendation,
          execution: input.execution ?? {
            runId: input.actionRunId,
            status: "proposed",
          },
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
 * Create/update the MerchantAction read identity at recommendation write time.
 * This is the normal population path; bulk reconciliation is repair-only.
 * @param {any} prisma
 * @param {{ recommendation: any }} input
 */
export async function ensureMerchantActionForRecommendation(prisma, input) {
  const recommendation = input.recommendation;
  if (!prisma?.merchantAction?.upsert || !recommendation?.id) return null;
  const action = await prisma.merchantAction.upsert({
    where: { sourceRecommendationId: recommendation.id },
    create: merchantActionDataFromRecommendation(recommendation),
    update: merchantActionUpdateFromRecommendation(recommendation),
    select: { id: true },
  });
  const execution = currentExecutionFromRecommendation(recommendation);
  if (execution?.runId && prisma.actionExecution?.updateMany) {
    await prisma.actionExecution.updateMany({
      where: {
        runId: execution.runId,
        merchantId: recommendation.merchantId,
        shopId: recommendation.shopId,
        merchantActionId: null,
      },
      data: { merchantActionId: action.id },
    });
  }
  return action;
}

/**
 * Write a recommendation lifecycle change through without flattening a linked
 * execution's stronger applied/reverted state.
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; recommendationId: string; recommendation: any }} input
 */
export async function updateMerchantActionForRecommendation(prisma, input) {
  if (!prisma?.merchantAction?.findFirst || !prisma?.merchantAction?.update) {
    return { updated: false };
  }
  const action = await prisma.merchantAction.findFirst({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      sourceRecommendationId: input.recommendationId,
    },
    select: {
      id: true,
      currentExecution: {
        select: { status: true, outcomeStatus: true, outcome: true },
      },
    },
  });
  if (!action) return { updated: false };
  const recommendation = input.recommendation ?? {};
  await prisma.merchantAction.update({
    where: { id: action.id },
    data: {
      status: deriveMerchantActionStatus({
        recommendation,
        execution: action.currentExecution,
      }),
      ...(recommendation.title == null
        ? {}
        : {
            title:
              safeText(recommendation.title, 180) || "Review Jefe's next move",
          }),
      ...(recommendation.summary == null
        ? {}
        : { summary: safeText(recommendation.summary, 700) }),
      ...(recommendation.outcome == null
        ? {}
        : { outcome: jsonObject(recommendation.outcome) }),
    },
  });
  return { updated: true };
}

/**
 * Write through an execution lifecycle change to its durable MerchantAction.
 * A missed denormalisation never turns a guarded external write into a reported
 * failure; the bounded reconciliation worker remains the repair path.
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionRunId: string; execution: any; logger?: Pick<Console, "warn"> }} input
 */
export async function updateMerchantActionForExecution(prisma, input) {
  if (!prisma?.merchantAction?.updateMany || !input.actionRunId) {
    return { updated: false, count: 0 };
  }
  try {
    const execution = input.execution ?? {};
    const result = await prisma.merchantAction.updateMany({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        OR: [
          { currentActionRunId: input.actionRunId },
          ...(execution.merchantActionId
            ? [{ id: execution.merchantActionId }]
            : []),
        ],
      },
      data: {
        status: deriveMerchantActionStatus({ execution }),
        currentActionRunId: input.actionRunId,
        ...(execution.outcome == null
          ? {}
          : { outcome: jsonObject(execution.outcome) }),
      },
    });
    return { updated: result.count > 0, count: result.count };
  } catch (error) {
    (input.logger ?? log).warn("merchant action write-through failed", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionRunId: input.actionRunId,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return { updated: false, count: 0 };
  }
}

/**
 * @param {any} prisma
 * MerchantAction identity sync stays off this read path. The only write is
 * unlocking legacy `pending`/`draft` steps on an already-accepted workflow so
 * home and chat show the same ready/waiting statuses that live in the DB.
 * @param {{ merchantId: string; shopId: string; includeInactive?: boolean }} input
 */
export async function listMerchantActions(prisma, input) {
  if (!prisma?.merchantAction?.findMany) return [];
  const rows = await prisma.merchantAction.findMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      ...(input.includeInactive
        ? {}
        : { status: { in: [...ACTIVE_STATUSES] } }),
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
  let unlocked = false;
  for (const row of rows) {
    if (!workflowNeedsUnlock(row)) continue;
    const result = await unlockActiveWorkflowIfNeeded(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: row.id,
    });
    if (result.unlocked) unlocked = true;
  }
  if (!unlocked) {
    const serialized = rows.map(serializeMerchantAction);
    return Promise.all(
      serialized.map((/** @type {any} */ row) =>
        attachWorkProjection(prisma, input, row),
      ),
    );
  }
  const refreshed = await prisma.merchantAction.findMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      ...(input.includeInactive
        ? {}
        : { status: { in: [...ACTIVE_STATUSES] } }),
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
  const serialized = refreshed.map(serializeMerchantAction);
  return Promise.all(
    serialized.map((/** @type {any} */ row) =>
      attachWorkProjection(prisma, input, row),
    ),
  );
}

/**
 * Minimal tenant-scoped identity for focused-chat reads. This deliberately
 * avoids recommendation workflows and execution history.
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId?: string | null }} input
 */
export async function getMerchantActionFocus(prisma, input) {
  if (!input.actionId || !prisma?.merchantAction?.findFirst) return null;
  const row = await prisma.merchantAction.findFirst({
    where: {
      id: input.actionId,
      merchantId: input.merchantId,
      shopId: input.shopId,
    },
    select: {
      id: true,
      title: true,
      summary: true,
      status: true,
      sourceRecommendationId: true,
      currentActionRunId: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    title: safeText(row.title, 180) || "Review Jefe's next move",
    summary: safeText(row.summary, 700),
    status: row.status,
    sourceRecommendationId: row.sourceRecommendationId ?? null,
    actionRunId: row.currentActionRunId ?? null,
    createdAt: row.createdAt?.toISOString?.() ?? null,
    updatedAt: row.updatedAt?.toISOString?.() ?? null,
  };
}

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId?: string | null }} input
 */
/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; conversationId?: string | null; skipWorkProjection?: boolean }} input
 * @param {any} row
 */
async function finishMerchantActionLoad(prisma, input, row) {
  const serialized = serializeMerchantAction(row);
  if (input.skipWorkProjection) return serialized;
  return attachWorkProjection(prisma, input, serialized);
}

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; conversationId?: string | null; skipWorkProjection?: boolean }} input
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
      constraints: {
        where: { status: "active" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
      changeSets: {
        orderBy: [{ generatedAt: "desc" }, { id: "desc" }],
        take: 3,
      },
    },
  });
  if (!row) return null;

  // Repair derivable inconsistencies (e.g. "Step 1 completed, Step 2 still waiting")
  // before falling back to the legacy pending/draft unlock path.
  const healed = await healInconsistentWorkflow(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: String(input.actionId),
    logger: log,
  });

  if (workflowNeedsUnlock(row)) {
    const unlocked = await unlockActiveWorkflowIfNeeded(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.actionId,
    });
    if (unlocked.unlocked || healed.healed) {
      const fresh = await prisma.merchantAction.findFirst({
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
          constraints: {
            where: { status: "active" },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          },
          changeSets: {
            orderBy: [{ generatedAt: "desc" }, { id: "desc" }],
            take: 3,
          },
        },
      });
      return finishMerchantActionLoad(prisma, input, fresh ?? row);
    }
  } else if (healed.healed) {
    const fresh = await prisma.merchantAction.findFirst({
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
        constraints: {
          where: { status: "active" },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        },
        changeSets: {
          orderBy: [{ generatedAt: "desc" }, { id: "desc" }],
          take: 3,
        },
      },
    });
    return finishMerchantActionLoad(prisma, input, fresh ?? row);
  }

  return finishMerchantActionLoad(prisma, input, row);
}

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId?: string | null; conversationId?: string | null }} input
 * @param {any} serialized
 */
async function attachWorkProjection(prisma, input, serialized) {
  if (!serialized?.id || !prisma) return serialized;
  try {
    const state = await resolveActionState(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: serialized.id,
      conversationId: input.conversationId ?? null,
    });
    if (state) applyWorkProjectionToAction(serialized, state);
  } catch {
    // Best-effort projection — page load must not fail if reconciliation hiccups.
  }
  return serialized;
}

/**
 * @param {any} row
 */
export function serializeMerchantAction(row) {
  const source = row.sourceRecommendation ?? null;
  const execution = row.currentExecution ?? row.executions?.[0] ?? null;
  const status = deriveMerchantActionStatus({
    action: row,
    recommendation: source,
    execution,
  });
  const summary = safeText(row.summary || source?.summary, 700);
  const progress = jsonObject(row.progress);
  const executionSummary = jsonObject(execution?.proposalSummary);
  const workflow = workflowView(workflowFromRecommendation(source));
  const actionType =
    execution?.actionType ??
    jsonObject(progress).actionType ??
    inferActionTypeFromWorkflow(source) ??
    null;
  const workspace = buildActionWorkspace({
    ...row,
    progress,
    workflow,
    sourceRecommendation: source,
    actionType,
  });
  const display = workspace
    ? workspacePlanItems(workspace)
    : displaySteps(progress, source);
  const currentStep = currentDisplayWorkflowStep(display);
  return {
    id: row.id,
    title:
      safeText(row.title || source?.title, 180) || "Review Jefe's next move",
    summary,
    status,
    statusLabel: statusLabel(status, execution),
    statusTone:
      status === MERCHANT_ACTION_STATUS.inProgress
        ? "green"
        : status === MERCHANT_ACTION_STATUS.needsAttention ||
            status === MERCHANT_ACTION_STATUS.proposed
          ? "yellow"
          : "neutral",
    sourceRecommendationId: row.sourceRecommendationId ?? source?.id ?? null,
    sourceRecommendation: source
      ? sourceRecommendationView(source)
      : sourceRecommendationFromSummary(executionSummary),
    actionRunId: row.currentActionRunId ?? execution?.runId ?? null,
    actionType,
    executable:
      execution?.actionType && execution?.resolvedMode !== "recommend"
        ? isActionExecuteEnabled(execution.actionType)
      : false,
    raise: buildActionRaise(execution?.eligibility),
    executionStatus: execution?.status ?? null,
    outcomeStatus: execution?.outcomeStatus ?? null,
    progress: {
      ...progress,
      preview: jsonObject(progress.preview ?? execution?.preview),
    },
    previewItems: previewItemsFromExecution(execution),
    plan: jsonObject(row.plan),
    workspace,
    currentFocus: workspace?.currentFocus ?? null,
    actionState: workspace?.actionState ?? null,
    constraints: Array.isArray(row.constraints)
      ? row.constraints.map((/** @type {any} */ item) => ({
          id: item.id,
          kind: item.kind,
          params: jsonObject(item.params),
          label: safeText(item.label, 180),
          source: item.source ?? "chat",
          status: item.status ?? "active",
        }))
      : [],
    currentChangeSet: serializeCurrentChangeSet(row.changeSets),
    workflow,
    currentStep,
    displaySteps: display,
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
  const attention = getMerchantAttentionItems(input).map(
    focusFromAttentionItem,
  );
  const actions = Array.isArray(input.merchantActions)
    ? input.merchantActions
    : Array.isArray(input.actions)
      ? input.actions
      : [];
  /** @type {any[]} */
  const workspaceFocuses = actions
    .filter(isWorkingActionForFocus)
    .map(focusFromWorkspaceFocus)
    .filter((focus) => Boolean(focus));
  if (workspaceFocuses.length > 0) {
    return workspaceFocuses.sort((left, right) => left.priority - right.priority);
  }
  const working = actions.filter(isWorkingActionForFocus);
  const proposed = getMerchantProposedActions(input);

  for (const action of proposed) {
    attention.push(
      focusFromAction(action, {
      kind: MERCHANT_CURRENT_FOCUS_KIND.recommendation,
      priority: 4,
      headline: "Here's what I'd do next.",
      eyebrow: "Recommended",
        reason:
          action.summary || "This is the next useful move Jefe has found.",
      ctaLabel: "Talk this through",
      ctaIntent: "chat.focus.start",
      }),
    );
  }

  if (attention.length > 0) return attention;

  const progress =
    working.find(
      (action) => action.status === MERCHANT_ACTION_STATUS.inProgress,
    ) ??
    working[0] ??
    null;
  if (progress) {
    return [
      focusFromAction(progress, {
      kind: MERCHANT_CURRENT_FOCUS_KIND.progress,
      priority: 5,
      headline: "Nothing needs your attention right now.",
      eyebrow: "In progress",
        reason:
          progress.currentSignal ||
          progress.successText ||
          "Jefe is working on this and will report back when there is an outcome.",
      ctaLabel: "Talk this through",
      ctaIntent: "chat.focus.start",
      }),
    ];
  }

  return [
    {
    kind: MERCHANT_CURRENT_FOCUS_KIND.empty,
    priority: 99,
    headline: "Nothing needs your attention right now.",
    eyebrow: "All clear",
      reason:
        "When there is a grounded action to review, start, or fix, it will appear here.",
    actionId: null,
    actionRunId: null,
    ctaLabel: null,
    ctaIntent: null,
    action: null,
    },
  ];
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
  const pushItem = (
    /** @type {any} */ action,
    /** @type {any} */ attention,
  ) => {
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
  const currentActionRunId =
    execution?.runId ?? recommendation.currentActionRunId ?? null;
  const progress = progressFromRecommendation(recommendation);
  const workspace = buildActionWorkspace({
    title: recommendation.title,
    summary: recommendation.summary,
    progress,
    sourceRecommendation: recommendation,
  });
  return {
    merchantId: recommendation.merchantId,
    shopId: recommendation.shopId,
    title: safeText(recommendation.title, 180) || "Review Jefe's next move",
    summary: safeText(recommendation.summary, 700),
    status: deriveMerchantActionStatus({ recommendation, execution }),
    sourceRecommendationId: recommendation.id,
    currentActionRunId,
    progress: workspace ? { ...progress, workspace } : progress,
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
  const currentActionRunId =
    execution?.runId ?? recommendation.currentActionRunId ?? null;
  const progress = progressFromRecommendation(recommendation);
  const workspace = buildActionWorkspace({
    title: recommendation.title,
    summary: recommendation.summary,
    progress,
    sourceRecommendation: recommendation,
  });
  return {
    title: safeText(recommendation.title, 180) || "Review Jefe's next move",
    summary: safeText(recommendation.summary, 700),
    status: deriveMerchantActionStatus({ recommendation, execution }),
    currentActionRunId,
    progress: workspace ? { ...progress, workspace } : progress,
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
  return Array.isArray(recommendation?.workflows)
    ? (recommendation.workflows[0] ?? null)
    : null;
}

/** @param {any} row */
function workflowNeedsUnlock(row) {
  const actionStatus = normalizeToken(row?.status);
  if (!["accepted", "in_progress"].includes(actionStatus)) return false;
  const steps = Array.isArray(row?.sourceRecommendation?.workflows?.[0]?.steps)
    ? row.sourceRecommendation.workflows[0].steps
    : [];
  if (steps.length === 0) return false;
  const hasLive = steps.some((/** @type {any} */ step) =>
    [
      "ready",
      "running",
      "needs_merchant",
      "needs_attention",
      "needs_updating",
    ].includes(normalizeToken(step?.status)),
  );
  if (hasLive) return false;
  return steps.some((/** @type {any} */ step) =>
    ["pending", "draft"].includes(normalizeToken(step?.status)),
  );
}

/** @param {any} recommendation */
function recommendationHasStartedWorkflowStep(recommendation) {
  const workflow = workflowFromRecommendation(recommendation);
  const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
  return steps.some((/** @type {any} */ step) =>
    [
      "blocked",
      "completed",
      "failed",
      "in_progress",
      "needs_attention",
      "needs_merchant",
      "running",
    ].includes(normalizeToken(step?.status)),
  );
}

/** @param {any} recommendation */
function currentExecutionFromRecommendation(recommendation) {
  const workflow = workflowFromRecommendation(recommendation);
  const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
  return (
    steps
      .map((/** @type {any} */ step) => step.actionExecutions?.[0])
      .find(Boolean) ?? null
  );
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
      ? workflow.steps
          .filter(isCurrentWorkflowStep)
          .map((/** @type {any} */ step) => ({
          id: step.id ?? null,
            orderIndex: Number.isFinite(Number(step.orderIndex))
              ? Number(step.orderIndex)
              : 0,
          title: safeText(step.title, 120),
          description: safeText(step.description, 260),
          completionCriteria: safeText(step.completionCriteria, 220) || null,
          status: step.status ?? null,
          mode: step.mode ?? null,
          capabilityRef: step.capabilityRef ?? null,
            dependsOnStepIds: Array.isArray(step.dependsOnStepIds)
              ? step.dependsOnStepIds
              : [],
            evidenceIds: Array.isArray(step.evidenceIds)
              ? step.evidenceIds
              : [],
          statusReason: safeText(step.statusReason, 240) || null,
          progress: jsonObject(step.progress),
          attention: jsonObject(step.attention),
          startedAt: step.startedAt?.toISOString?.() ?? null,
          completedAt: step.completedAt?.toISOString?.() ?? null,
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
  return raw
    .filter(isCurrentWorkflowStep)
    .slice(0, 4)
    .map((/** @type {any} */ step, index) => ({
    id: step?.id ?? null,
    label:
      safeText(step?.title || step?.label || step?.description, 160) ||
      `Step ${index + 1}`,
    description: safeText(step?.description, 260) || null,
    completionCriteria: safeText(step?.completionCriteria, 220) || null,
    status: safeText(step?.status, 40) || null,
    mode: safeText(step?.mode, 40) || null,
    capabilityRef: safeText(step?.capabilityRef, 120) || null,
    statusReason: safeText(step?.statusReason, 240) || null,
    progress: jsonObject(step?.progress),
    attention: jsonObject(step?.attention),
    startedAt: step?.startedAt?.toISOString?.() ?? null,
    completedAt: step?.completedAt?.toISOString?.() ?? null,
    done: step?.status === "completed" || Boolean(step?.done),
  }));
}

/** @param {any} step */
function isCurrentWorkflowStep(step) {
  return normalizeToken(step?.status) !== "superseded";
}

/** @param {any[]} steps */
function currentDisplayWorkflowStep(steps) {
  const active = steps.find((step) =>
    ["ready", "running", "needs_merchant", "needs_attention"].includes(
      normalizeToken(step?.status),
    ),
  );
  return (
    active ??
    steps.find(
      (step) => !step?.done && normalizeToken(step?.status) !== "completed",
    ) ??
    null
  );
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

/** @param {any[]} changeSets */
function serializeCurrentChangeSet(changeSets) {
  const rows = Array.isArray(changeSets) ? changeSets : [];
  const live =
    rows.find((/** @type {any} */ row) =>
    ["ready", "approved", "applying"].includes(String(row?.status ?? "")),
  ) ?? rows[0];
  if (!live) return null;
  return {
    id: live.id,
    status: live.status,
    actionType: live.actionType,
    itemCount: Array.isArray(live.items) ? live.items.length : 0,
    excludedCount: Array.isArray(live.excluded) ? live.excluded.length : 0,
    generatedAt: live.generatedAt?.toISOString?.() ?? live.generatedAt ?? null,
  };
}

/** @param {any} execution */
function previewItemsFromExecution(execution) {
  const preview = jsonObject(execution?.preview);
  const summary = jsonObject(execution?.proposalSummary);
  const changes = Array.isArray(preview.changes) ? preview.changes : [];
  const summaryItems = Array.isArray(summary.topItems) ? summary.topItems : [];
  const rows = changes.length ? changes : summaryItems;
  return rows
    .slice(0, 12)
    .map((/** @type {any} */ item) => ({
      title: safeText(
        item?.title ?? item?.productTitle ?? item?.variantId,
        180,
      ),
    productId: typeof item?.productId === "string" ? item.productId : null,
    toType: typeof item?.toType === "string" ? item.toType : null,
      proposedType:
        typeof item?.proposedType === "string" ? item.proposedType : null,
      fromPrice: Number.isFinite(Number(item?.fromPrice))
        ? Number(item.fromPrice)
        : null,
      toPrice: Number.isFinite(Number(item?.toPrice))
        ? Number(item.toPrice)
        : null,
    discountPercent: Number.isFinite(Number(item?.discountPercent))
      ? Number(item.discountPercent)
      : null,
    }))
    .filter((/** @type {any} */ item) => item.title);
}

/**
 * @param {string} status
 * @param {any} execution
 */
function statusLabel(status, execution) {
  if (status === MERCHANT_ACTION_STATUS.proposed) return "Proposed";
  if (status === MERCHANT_ACTION_STATUS.accepted) return "Accepted";
  if (status === MERCHANT_ACTION_STATUS.needsAttention)
    return "Needs attention";
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
  return workflowStepsForFocus(action).some((/** @type {any} */ step) =>
      ["blocked", "needs_attention"].includes(normalizeToken(step.status)),
  );
}

/** @param {any} action */
function actionHasReadyExecutableStep(action) {
  const step = currentWorkflowStep(action);
  if (!step) return false;
  const workState = normalizeToken(step.workState);
  const status = normalizeToken(step.status);
  return (
    action?.status === MERCHANT_ACTION_STATUS.accepted &&
    Boolean(action?.actionRunId) &&
    action?.executable !== false &&
    normalizeToken(action?.executionStatus) === "proposed" &&
    normalizeToken(step.mode) === "execute" &&
    (workState === "available" ||
      ["", "draft", "pending", "proposed", "ready"].includes(status))
  );
}

/** @param {any} action */
function currentWorkflowStep(action) {
  const projected = action?.workProjection?.nextUsefulWork?.step;
  if (projected?.id) {
    const steps = workflowStepsForFocus(action);
    const match = steps.find(
      (/** @type {any} */ step) => step?.id === projected.id,
    );
    if (match) return match;
  }
  return (
    workflowStepsForFocus(action).find((/** @type {any} */ step) => {
    const workState = normalizeToken(step.workState);
      if (
        workState === "available" ||
        workState === "needs_updating" ||
        workState === "running"
      ) {
      return true;
    }
    const status = normalizeToken(step.status);
    return !["completed", "skipped", "superseded"].includes(status);
    }) ?? null
  );
}

/** @param {any} action */
function workflowStepsForFocus(action) {
  if (Array.isArray(action?.displaySteps)) {
    return action.displaySteps.filter(
      (/** @type {any} */ step) => step && typeof step === "object",
    );
  }
  const steps = action?.progress?.workflow?.steps;
  return Array.isArray(steps)
    ? steps.filter(
        (/** @type {any} */ step) => step && typeof step === "object",
      )
    : [];
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
    focus.actionId ?? focus.actionRunId ?? focus.action?.title ?? focus.kind
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

/** @param {any} action */
function focusFromWorkspaceFocus(action) {
  const source = action?.currentFocus ?? action?.workspace?.currentFocus ?? null;
  if (!source || source.kind === "on_track") return null;
  /** @type {Record<string, string>} */
  const kindMap = {
    failure: MERCHANT_CURRENT_FOCUS_KIND.actionProblem,
    merchant_attention: MERCHANT_CURRENT_FOCUS_KIND.merchantInput,
    artifact_review: MERCHANT_CURRENT_FOCUS_KIND.artifactReview,
    jefe_working: MERCHANT_CURRENT_FOCUS_KIND.jefeWorking,
    external_wait: MERCHANT_CURRENT_FOCUS_KIND.externalWait,
    optional_work: MERCHANT_CURRENT_FOCUS_KIND.progress,
    completed: MERCHANT_CURRENT_FOCUS_KIND.progress,
  };
  const kind = kindMap[source.kind] ?? MERCHANT_CURRENT_FOCUS_KIND.progress;
  return focusFromAction(action, {
    kind,
    priority: Number(source.priority ?? 50),
    headline:
      safeText(source.headline, 180) ||
      safeText(action?.title, 180) ||
      "Review this action",
    eyebrow: safeText(source.eyebrow, 80) || "Current focus",
    reason:
      safeText(source.reason, 260) ||
      safeText(action?.summary, 260) ||
      "This is the current focus for the action.",
    ctaLabel: "Talk this through",
    ctaIntent: "chat.focus.start",
  });
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
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

/**
 * @param {any} source
 */
function inferActionTypeFromWorkflow(source) {
  const steps = Array.isArray(source?.workflows?.[0]?.steps)
    ? source.workflows[0].steps
    : [];
  const haystack = steps
    .map(
      (/** @type {any} */ step) =>
        `${step?.title ?? ""} ${step?.capabilityRef ?? ""}`,
    )
    .join(" ")
    .toLowerCase();
  if (/\blisting_copy\b/.test(haystack)) return "listing_copy";
  if (/\bprice_markdown\b/.test(haystack) || /\bmarkdown\b/.test(haystack))
    return "price_markdown";
  if (/\btidy_up\b/.test(haystack)) return "tidy_up";
  return null;
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
  if (
    execution?.outcomeStatus === "measured" &&
    Number(outcome?.variantsSold) > 0
  ) {
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
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * @param {Date | string | null | undefined} value
 */
function shortDate(value) {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
  }).format(date);
}
