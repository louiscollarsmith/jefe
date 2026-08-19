// @ts-check

import { logger as baseLogger } from "../observability/logger.server.js";
import { executeApprovedAction } from "./execute-approved-action.server.js";
import { getMerchantAction } from "./merchant-action.server.js";
import {
  actionRuntimeKind,
  isRestockAction,
  resolveActionContext,
  snapshotFromResolvedContext,
} from "./resolved-action-context.server.js";

const log = baseLogger.child({ component: "action-changeset" });

export const CHANGE_SET_STATUS = Object.freeze({
  ready: "ready",
  approved: "approved",
  applying: "applying",
  applied: "applied",
  partial: "partial",
  stale: "stale",
  needsAttention: "needs_attention",
  cancelled: "cancelled",
});

const LIVE_CHANGE_SET_STATUSES = new Set([
  CHANGE_SET_STATUS.ready,
  CHANGE_SET_STATUS.approved,
]);

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string }} input
 */
export async function getCurrentChangeSet(prisma, input) {
  if (!prisma?.actionChangeSet?.findFirst) return null;
  return prisma.actionChangeSet.findFirst({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      merchantActionId: input.actionId,
      status: { in: [...LIVE_CHANGE_SET_STATUSES, CHANGE_SET_STATUS.applying] },
    },
    orderBy: [{ generatedAt: "desc" }, { id: "desc" }],
  });
}

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string }} input
 */
export async function getLatestChangeSet(prisma, input) {
  if (!prisma?.actionChangeSet?.findFirst) return null;
  return prisma.actionChangeSet.findFirst({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      merchantActionId: input.actionId,
    },
    orderBy: [{ generatedAt: "desc" }, { id: "desc" }],
  });
}

/**
 * Build a reviewable Change Set from the current plan, constraints, and
 * (for execute actions) the ActionExecution preview.
 *
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; actor?: string | null; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 * @returns {Promise<{ ok: true, changeSet: any, action?: any } | { ok: false, reason: string }>}
 */
export async function createActionChangeSet(prisma, input) {
  const logger = input.logger ?? log;
  const resolved = await resolveActionContext(prisma, input);
  if (!resolved) return { ok: false, reason: "not_found" };
  const action = resolved.action;
  if (!prisma?.actionChangeSet?.create) {
    return { ok: false, reason: "changeset_unavailable" };
  }

  const serializedConstraints = resolved.constraints;
  await staleLiveChangeSets(prisma, input);

  const built = buildChangeSetFromResolved(resolved);
  if (!built.ok || !Array.isArray(built.items)) {
    return { ok: false, reason: built.reason ?? "no_preview" };
  }

  const snapshot = snapshotFromResolvedContext(resolved);
  const row = await prisma.actionChangeSet.create({
    data: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      merchantActionId: input.actionId,
      workflowStepId: action.currentStep?.id ?? null,
      actionExecutionId: built.actionExecutionId ?? null,
      actionType: built.actionType,
      status: CHANGE_SET_STATUS.ready,
      items: built.items,
      excluded: built.excluded ?? [],
      constraintSnapshot: serializedConstraints,
      planSnapshot: snapshot.plan,
      inputHash: resolved.inputHash,
      result: {},
    },
  });
  logger.info("action change set created", {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.actionId,
    changeSetId: row.id,
    itemCount: built.items.length,
    excludedCount: (built.excluded ?? []).length,
    actionType: built.actionType,
  });
  return {
    ok: true,
    changeSet: serializeChangeSet(row),
    action,
  };
}

/**
 * Scope the linked ActionExecution preview to this Change Set so the typed
 * adapter writes exactly these items. Idempotent.
 *
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; changeSetId?: string | null; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function prepareExecutionChangeSet(prisma, input) {
  const current =
    (input.changeSetId
      ? await prisma.actionChangeSet?.findFirst?.({
          where: {
            id: input.changeSetId,
            merchantId: input.merchantId,
            shopId: input.shopId,
            merchantActionId: input.actionId,
          },
        })
      : null) ?? (await getCurrentChangeSet(prisma, input));
  const created = current ? null : await createActionChangeSet(prisma, input);
  const changeSet = current
    ? serializeChangeSet(current)
    : created?.ok
      ? created.changeSet
      : null;
  if (!changeSet) return { ok: false, reason: "changeset_unavailable" };
  if (
    changeSet.status === CHANGE_SET_STATUS.applied ||
    changeSet.status === CHANGE_SET_STATUS.partial
  ) {
    return { ok: true, changeSet, alreadyApplied: true };
  }

  const resolved = await resolveActionContext(prisma, input);
  if (
    resolved &&
    changeSet.inputHash &&
    changeSet.inputHash !== resolved.inputHash
  ) {
    await staleLiveChangeSets(prisma, input);
    return { ok: false, reason: "stale_changeset" };
  }

  const action = await getMerchantAction(prisma, input);
  const runId = action?.actionRunId ?? null;
  if (runId && prisma?.actionExecution?.findUnique) {
    const execution = await prisma.actionExecution.findUnique({
      where: { runId },
      select: { id: true, runId: true, preview: true, status: true },
    });
    if (execution && execution.status !== "applied" && execution.status !== "partially_applied") {
      const preview = jsonObject(execution.preview);
      const unconstrained = Array.isArray(preview.unconstrainedChanges)
        ? preview.unconstrainedChanges
        : Array.isArray(preview.changes)
          ? preview.changes
          : [];
      await prisma.actionExecution.update({
        where: { runId: execution.runId },
        data: {
          preview: {
            ...preview,
            unconstrainedChanges: unconstrained,
            changes: changeSet.items.map(changeFromItem),
            excludedByConstraints: changeSet.excluded,
            changeSetId: changeSet.id,
          },
        },
      });
    }
  }
  return { ok: true, changeSet, alreadyApplied: false };
}

/**
 * Apply an existing Change Set through the typed adapter. Restock artifacts are
 * recorded as applied without a Shopify write.
 *
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; changeSetId?: string | null; actor?: string | null; session?: { shop: string } | null; executeDeps?: any; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function applyActionChangeSet(prisma, input) {
  const logger = input.logger ?? log;
  const prepared = await prepareExecutionChangeSet(prisma, input);
  if (!prepared.ok || !prepared.changeSet) return { ok: false, reason: prepared.reason ?? "not_found" };
  const changeSet = prepared.changeSet;
  if (prepared.alreadyApplied) {
    return { ok: true, changeSet, alreadyApplied: true, executed: false };
  }

  if (changeSet.actionType === "restock") {
    const applied = await markChangeSetApplied(prisma, {
      changeSetId: changeSet.id,
      result: {
        kind: "assist",
        note: "Merchant remains responsible for the supplier order.",
        itemCount: changeSet.items.length,
      },
    });
    return { ok: true, changeSet: applied, executed: false, assistOnly: true };
  }

  const action = await getMerchantAction(prisma, input);
  if (!action?.actionRunId) {
    return { ok: false, reason: "no_execution", changeSet };
  }

  await prisma.actionChangeSet?.updateMany?.({
    where: { id: changeSet.id, status: { in: [...LIVE_CHANGE_SET_STATUSES] } },
    data: {
      status: CHANGE_SET_STATUS.applying,
      approvedAt: new Date(),
    },
  });

  if (!input.session?.shop) {
    return { ok: true, changeSet, pendingExecution: true, executed: false };
  }

  const result = await executeApprovedAction(
    prisma,
    input.session,
    {
      merchantId: input.merchantId,
      actionRunId: action.actionRunId,
      mode: "approve",
    },
    input.executeDeps ?? {},
  );
  const recorded = await recordChangeSetExecution(prisma, {
    changeSetId: changeSet.id,
    actionRunId: action.actionRunId,
    result,
    logger,
  });
  return {
    ok: Boolean(result?.ok),
    changeSet: recorded,
    executed: Boolean(result?.executed),
    result,
  };
}

/**
 * After a typed adapter run, copy per-target write results onto the Change Set.
 *
 * @param {any} prisma
 * @param {{ changeSetId: string; actionRunId: string; result?: any; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function recordChangeSetExecution(prisma, input) {
  const execution = prisma.actionExecution?.findUnique
    ? await prisma.actionExecution.findUnique({
        where: { runId: input.actionRunId },
        include: { writes: true },
      })
    : null;
  const writes = Array.isArray(execution?.writes) ? execution.writes : [];
  const changeSet = await prisma.actionChangeSet?.findFirst?.({
    where: { id: input.changeSetId },
  });
  const items = Array.isArray(changeSet?.items) ? changeSet.items : [];
  const itemsWithResult = items.map((/** @type {any} */ item) => {
    const write = writes.find(
      (/** @type {any} */ row) =>
        row.targetRef === item.variantId ||
        row.targetRef === item.productId ||
        row.targetRef === item.targetRef,
    );
    return {
      ...item,
      executionResult: write
        ? {
            status: write.status,
            appliedAt: write.appliedAt ?? null,
          }
        : {
            status: input.result?.ok ? "unknown" : "failed",
          },
    };
  });
  const failed = itemsWithResult.filter((/** @type {any} */ item) =>
    ["failed", "skipped_drift"].includes(String(item.executionResult?.status)),
  );
  const appliedWrites = writes.filter((/** @type {any} */ row) => row.status === "applied");
  const executionStatus = String(execution?.status ?? input.result?.status ?? "");
  const needsAttention =
    !input.result?.ok ||
    executionStatus === "partially_applied" ||
    executionStatus === "failed" ||
    failed.length > 0;
  const status = needsAttention
    ? CHANGE_SET_STATUS.needsAttention
    : appliedWrites.length > 0 || executionStatus === "applied"
      ? CHANGE_SET_STATUS.applied
      : CHANGE_SET_STATUS.ready;
  const updated = await prisma.actionChangeSet?.update?.({
    where: { id: input.changeSetId },
    data: {
      status,
      items: itemsWithResult,
      appliedAt: status === CHANGE_SET_STATUS.applied || status === CHANGE_SET_STATUS.needsAttention
        ? new Date()
        : changeSet?.appliedAt ?? null,
      result: {
        ok: Boolean(input.result?.ok),
        executed: Boolean(input.result?.executed),
        executionStatus,
        appliedCount: appliedWrites.length,
        failedCount: failed.length,
        reason: input.result?.reason ?? null,
      },
    },
  });
  return serializeChangeSet(updated ?? { ...changeSet, status, items: itemsWithResult });
}

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string }} input
 */
export async function staleLiveChangeSets(prisma, input) {
  if (!prisma?.actionChangeSet?.updateMany) return { count: 0 };
  const result = await prisma.actionChangeSet.updateMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      merchantActionId: input.actionId,
      status: { in: [...LIVE_CHANGE_SET_STATUSES, CHANGE_SET_STATUS.applying] },
    },
    data: { status: CHANGE_SET_STATUS.stale },
  });
  return { count: result.count ?? 0 };
}

/** @param {any} row */
export function serializeChangeSet(row) {
  if (!row) return null;
  const items = Array.isArray(row.items) ? row.items : [];
  const excluded = Array.isArray(row.excluded) ? row.excluded : [];
  return {
    id: row.id,
    actionType: row.actionType,
    status: row.status,
    items,
    excluded,
    constraintSnapshot: Array.isArray(row.constraintSnapshot) ? row.constraintSnapshot : [],
    planSnapshot: jsonObject(row.planSnapshot),
    inputHash: row.inputHash ?? "",
    result: jsonObject(row.result),
    generatedAt: row.generatedAt?.toISOString?.() ?? row.generatedAt ?? null,
    approvedAt: row.approvedAt?.toISOString?.() ?? row.approvedAt ?? null,
    appliedAt: row.appliedAt?.toISOString?.() ?? row.appliedAt ?? null,
    workflowStepId: row.workflowStepId ?? null,
    actionExecutionId: row.actionExecutionId ?? null,
  };
}

/** @param {any} changeSet @param {any} [action] */
export function formatChangeSetReply(changeSet, action = null) {
  if (!changeSet) return "I don't have a replenishment proposal for this action yet.";
  const items = Array.isArray(changeSet.items) ? changeSet.items : [];
  const excluded = Array.isArray(changeSet.excluded) ? changeSet.excluded : [];
  if (items.length === 0 && excluded.length === 0) {
    return "After applying the current constraints, there is nothing left to include in this action.";
  }
  const lines = items.slice(0, 12).map((/** @type {any} */ item) => formatChangeSetItem(item, changeSet.actionType));
  const extra = items.length > 12 ? `\n• +${items.length - 12} more` : "";
  const excludedLines = summarizeExcluded(excluded);
  const restock = changeSet.actionType === "restock" || isRestockAction(action ?? changeSet);
  const header = restock
    ? `Recommended replenishment (${items.length}):`
    : changeSet.actionType === "listing_copy"
      ? `I'll set a product type on ${items.length} item${items.length === 1 ? "" : "s"}:`
      : `I'll change ${items.length} item${items.length === 1 ? "" : "s"}:`;
  return [header, ...lines, extra, excludedLines].filter(Boolean).join("\n");
}

/** @param {any} changeSet */
export function formatExecutionResultReply(changeSet) {
  if (!changeSet) return "I don’t have an execution result for this action yet.";
  const items = Array.isArray(changeSet.items) ? changeSet.items : [];
  const result = jsonObject(changeSet.result);
  if (changeSet.actionType === "restock") {
    return "Nothing was written to Shopify. The recommended quantities are still for you to order with the supplier.";
  }
  if (changeSet.status === CHANGE_SET_STATUS.ready) {
    return "Nothing has been written yet. Say go ahead when you want me to apply this exact set.";
  }
  const applied = items.filter((/** @type {any} */ item) => item.executionResult?.status === "applied");
  const skipped = items.filter((/** @type {any} */ item) => item.executionResult?.status === "skipped_drift");
  const failed = items.filter((/** @type {any} */ item) => item.executionResult?.status === "failed");
  const parts = [];
  if (applied.length) {
    parts.push(
      `Changed ${applied.length} item${applied.length === 1 ? "" : "s"}: ${applied
        .slice(0, 8)
        .map((/** @type {any} */ item) => item.title)
        .filter(Boolean)
        .join(", ")}.`,
    );
  }
  if (skipped.length) {
    parts.push(
      `${skipped.length} skipped because the live Shopify value had changed since this set was built.`,
    );
  }
  if (failed.length) {
    parts.push(`${failed.length} failed and need attention.`);
  }
  if (!parts.length) {
    if (result.executed === false) {
      return "The run was recorded but nothing was written to Shopify.";
    }
    return "I don’t have per-item execution results yet.";
  }
  if (changeSet.status === CHANGE_SET_STATUS.needsAttention) {
    parts.push("This action needs attention — it is not a full success.");
  }
  return parts.join(" ");
}

/**
 * @param {import("./resolved-action-context.server.js").ResolvedActionContext} resolved
 */
function buildChangeSetFromResolved(resolved) {
  const kind = resolved.evidence.kind;
  if (kind === "restock") {
    return {
      ok: true,
      actionType: "restock",
      actionExecutionId: null,
      items: resolved.scope.items.map((item) => ({
        title: item.title,
        productId: item.productId ?? null,
        before: item.available ?? null,
        after: item.recommendedUnits,
        reason: item.reason,
        dailyVelocity: item.dailyVelocity ?? null,
      })),
      excluded: resolved.scope.excluded,
    };
  }
  if (resolved.scope.candidateCount === 0 && resolved.scope.items.length === 0) {
    return { ok: false, reason: "no_preview" };
  }
  const actionType =
    kind === "markdown"
      ? "price_markdown"
      : kind === "listing_copy"
        ? "listing_copy"
        : resolved.action.actionType || "price_markdown";
  return {
    ok: true,
    actionType,
    actionExecutionId: null,
    items: resolved.scope.items.map((item) => itemFromResolved(item, actionType)),
    excluded: resolved.scope.excluded,
  };
}

/** @param {any} item @param {string} actionType */
function itemFromResolved(item, actionType) {
  return {
    title: item.title,
    productId: item.productId ?? null,
    variantId: item.variantId ?? null,
    targetRef: item.targetRef ?? item.variantId ?? item.productId ?? null,
    before:
      actionType === "listing_copy"
        ? item.fromType ?? ""
        : item.fromPrice ?? item.available ?? null,
    after:
      actionType === "listing_copy"
        ? item.toType ?? null
        : item.toPrice ?? item.recommendedUnits ?? null,
    reason: item.reason ?? null,
    fromPrice: item.fromPrice ?? null,
    toPrice: item.toPrice ?? null,
    fromType: item.fromType ?? null,
    toType: item.toType ?? null,
    discountPercent: item.discountPercent ?? null,
  };
}

/** @param {any} prisma @param {{ changeSetId: string; result: any }} input */
async function markChangeSetApplied(prisma, input) {
  const row = await prisma.actionChangeSet.update({
    where: { id: input.changeSetId },
    data: {
      status: CHANGE_SET_STATUS.applied,
      approvedAt: new Date(),
      appliedAt: new Date(),
      result: input.result,
    },
  });
  return serializeChangeSet(row);
}


/** @param {any} item */
function changeFromItem(item) {
  return {
    title: item.title,
    productId: item.productId,
    variantId: item.variantId,
    fromPrice: item.fromPrice ?? (typeof item.before === "number" ? item.before : null),
    toPrice: item.toPrice ?? (typeof item.after === "number" ? item.after : null),
    fromType: item.fromType ?? (typeof item.before === "string" ? item.before : null),
    toType: item.toType ?? (typeof item.after === "string" ? item.after : null),
    discountPercent: item.discountPercent ?? null,
  };
}

/** @param {any} item @param {string} actionType */
function formatChangeSetItem(item, actionType) {
  if (actionType === "restock") {
    return `• ${item.title} — on hand ${item.before ?? "?"} → order ${item.after ?? "?"}`;
  }
  if (actionType === "listing_copy" || item.toType) {
    return `• ${item.title} — type → ${item.after ?? item.toType}`;
  }
  if (item.fromPrice != null && item.toPrice != null) {
    return `• ${item.title} — £${formatMoney(item.fromPrice)} → £${formatMoney(item.toPrice)}`;
  }
  return `• ${item.title}`;
}

/** @param {any[]} excluded */
function summarizeExcluded(excluded) {
  if (!Array.isArray(excluded) || excluded.length === 0) return "";
  /** @type {Record<string, number>} */
  const counts = {};
  for (const item of excluded) {
    const key = String(item.reason ?? item.constraintKind ?? "excluded");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const parts = Object.entries(counts).map(([reason, count]) => `${count} ${reason}`);
  return `Excluded: ${parts.join("; ")}.`;
}

export { actionRuntimeKind, isRestockAction };

/** @param {unknown} value */
function formatMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? "");
  return Number.isInteger(number) ? String(number) : number.toFixed(2);
}

/** @param {unknown} value */
function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}
