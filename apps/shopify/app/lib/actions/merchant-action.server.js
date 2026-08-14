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
  const executionStatus = String(execution?.status ?? "");
  const reviewStatus = String(recommendation?.reviewStatus ?? "");
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
        : { title: safeText(recommendation.title, 180) || "Review Jefe's next move" }),
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
          ...(execution.merchantActionId ? [{ id: execution.merchantActionId }] : []),
        ],
      },
      data: {
        status: deriveMerchantActionStatus({ execution }),
        currentActionRunId: input.actionRunId,
        ...(execution.outcome == null ? {} : { outcome: jsonObject(execution.outcome) }),
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
 * Read-only application query. Reconciliation belongs on creation/status-write
 * paths or in the bounded repair worker, never in a merchant request.
 * @param {{ merchantId: string; shopId: string; includeInactive?: boolean }} input
 */
export async function listMerchantActions(prisma, input) {
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
