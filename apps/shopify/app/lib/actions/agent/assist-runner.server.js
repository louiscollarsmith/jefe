// @ts-check

/**
 * Goal-oriented assist execution, driven by derived dependencies.
 *
 * The old path nudged a persisted "current step" cursor until the step it
 * wanted happened to be focused, then called the cursor-bound start function.
 * That is why completed steps left dependents `waiting`, why "Start this"
 * refused work whose prerequisites were already done, and why safe Jefe-owned
 * work needed step ceremony.
 *
 * Here, availability is derived from the canonical action-state projection
 * (dependencies satisfied + artifact not stale) and steps run **by id** with a
 * compare-and-swap claim. The cursor is written afterwards as a projection for
 * the existing UI; nothing reads it to decide what may run.
 */

import { logger as baseLogger } from "../../observability/logger.server.js";
import {
  ACTION_STEP_STATUS,
  ACTION_STEP_RUN_STATUS,
  acceptMerchantActionPlan,
} from "../action-step-lifecycle.server.js";
import { executeStartedAssistStepRun } from "../assist-steps/run.server.js";
import { resolveActionContext } from "../resolved-action-context.server.js";
import { snapshotFromResolvedContext } from "../resolved-action-context.server.js";
import { getMerchantAction } from "../merchant-action.server.js";
import { resolveActionState, workNeedsExecution } from "../action-state.server.js";

const log = baseLogger.child({ component: "assist-runner" });

/** Statuses a step may be claimed from for a Jefe-owned assist run. */
const CLAIMABLE_STATUSES = new Set([
  ACTION_STEP_STATUS.draft,
  ACTION_STEP_STATUS.waiting,
  ACTION_STEP_STATUS.ready,
  ACTION_STEP_STATUS.needsMerchant,
  ACTION_STEP_STATUS.needsAttention,
  ACTION_STEP_STATUS.needsUpdating,
  ACTION_STEP_STATUS.completed,
  "pending",
]);

/**
 * Dependency-ordered chain of work rows that must run before (and including)
 * the target. Derived — never a hand-maintained prerequisite table.
 *
 * @param {any} state canonical action state
 * @param {string} targetStepId
 * @returns {{ ok: true; chain: any[] } | { ok: false; code: string; message: string }}
 */
export function resolveWorkChain(state, targetStepId) {
  const rows = Array.isArray(state?.work) ? state.work : [];
  const byId = new Map(rows.map((/** @type {any} */ row) => [String(row.step.id), row]));
  const target = byId.get(String(targetStepId));
  if (!target) {
    return { ok: false, code: "STEP_NOT_FOUND", message: "I couldn't find that piece of work." };
  }

  /** @type {Map<string, any>} */
  const collected = new Map();
  /** @type {Set<string>} */
  const seen = new Set();

  /** @param {string} id */
  const visit = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    const row = byId.get(id);
    if (!row) return;
    // Walk the declared dependency graph, not just the current blocker list:
    // a prerequisite can be complete-but-stale, which is not a blocker yet
    // still has to be rebuilt before this step's result means anything.
    for (const dependencyId of row.dependsOn ?? []) visit(String(dependencyId));
    for (const blocker of row.blockers ?? []) {
      if (blocker.stepId) visit(String(blocker.stepId));
    }
    if (workNeedsExecution(row)) collected.set(id, row);
  };

  visit(String(targetStepId));

  const chain = [...collected.values()].sort(
    (/** @type {any} */ left, /** @type {any} */ right) => Number(left.step.orderIndex ?? 0) - Number(right.step.orderIndex ?? 0),
  );
  return { ok: true, chain };
}

/**
 * Run one assist step by id. Availability is checked against derived state,
 * the claim is a compare-and-swap, and the run is keyed by the resolved input
 * hash so the same work with the same inputs never executes twice.
 *
 * @param {any} prisma
 * @param {{
 *   merchantId: string;
 *   shopId: string;
 *   actionId: string;
 *   stepId: string;
 *   provider?: any;
 *   actor?: string | null;
 *   conversationId?: string | null;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 * }} input
 */
export async function runAssistStepById(prisma, input) {
  const logger = input.logger ?? log;
  const state = await resolveActionState(prisma, input);
  const work = (state?.work ?? []).find(
    (/** @type {any} */ row) => String(row.step.id) === String(input.stepId),
  );
  if (!work) {
    return { ok: false, code: "STEP_NOT_FOUND", message: "I couldn't find that piece of work." };
  }

  if (!workNeedsExecution(work)) {
    return {
      ok: true,
      alreadyCurrent: true,
      stepId: input.stepId,
      title: work.step.title ?? null,
      artifact: work.validResult ?? null,
    };
  }

  if (work.state === "needs_input") {
    return {
      ok: false,
      code: "MERCHANT_INPUT_REQUIRED",
      stepId: input.stepId,
      title: work.step.title ?? null,
      message:
        work.blockers?.[0]?.reason ??
        `"${work.step.title ?? "That step"}" needs something from you before I can run it.`,
      blockers: work.blockers ?? [],
    };
  }

  if (work.state === "blocked") {
    return {
      ok: false,
      code: "BLOCKED_BY_PREREQUISITE",
      stepId: input.stepId,
      title: work.step.title ?? null,
      message:
        (work.blockers ?? []).map((/** @type {any} */ row) => row.reason).filter(Boolean).join(" ") ||
        `"${work.step.title ?? "That step"}" is waiting on earlier work.`,
      blockers: work.blockers ?? [],
    };
  }

  const action = await getMerchantAction(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.actionId,
    skipWorkProjection: true,
  });
  const step = findStep(action, input.stepId);
  if (!step) {
    return { ok: false, code: "STEP_NOT_FOUND", message: "I couldn't find that piece of work." };
  }
  if (step.mode !== "assist") {
    return {
      ok: false,
      code: "NOT_JEFE_OWNED",
      stepId: step.id,
      title: step.title ?? null,
      message: `"${step.title ?? "That step"}" isn't mine to run — it needs you.`,
    };
  }

  const resolved = await resolveActionContext(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.actionId,
    conversationId: input.conversationId ?? null,
    logger,
  });
  const inputHash = resolved?.inputHash ?? "no-input-hash";
  const idempotencyKey = `assist:${input.actionId}:${step.id}:${inputHash}`;

  const existing = await findRunByKey(prisma, idempotencyKey);
  if (existing?.status === ACTION_STEP_RUN_STATUS.succeeded) {
    logger.info("assist run deduplicated", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.actionId,
      stepId: step.id,
      idempotencyKey,
    });
    return {
      ok: true,
      deduplicated: true,
      stepId: step.id,
      title: step.title ?? null,
      artifact: existing.result ?? null,
    };
  }

  const claimFrom = String(step.status ?? "");
  if (!CLAIMABLE_STATUSES.has(claimFrom)) {
    return {
      ok: false,
      code: "STEP_NOT_CLAIMABLE",
      stepId: step.id,
      title: step.title ?? null,
      message: `"${step.title ?? "That step"}" is ${claimFrom || "in an unexpected state"} — I didn't start it again.`,
    };
  }

  const claimed = await prisma.merchantRecommendationStep.updateMany({
    where: {
      id: step.id,
      merchantId: input.merchantId,
      shopId: input.shopId,
      status: claimFrom,
    },
    data: {
      status: ACTION_STEP_STATUS.running,
      startedAt: step.startedAt ?? new Date(),
      statusReason: "Jefe is running this.",
    },
  });
  if (claimed?.count !== 1) {
    return {
      ok: false,
      code: "CLAIM_CONFLICT",
      stepId: step.id,
      title: step.title ?? null,
      message: `"${step.title ?? "That step"}" is already running — I didn't start a second copy.`,
    };
  }

  await unlockActionForWork(prisma, input);

  let stepRun = null;
  try {
    stepRun = await prisma.merchantRecommendationStepRun.create({
      data: {
        stepId: step.id,
        merchantId: input.merchantId,
        shopId: input.shopId,
        actor: input.actor ?? input.merchantId,
        status: ACTION_STEP_RUN_STATUS.queued,
        idempotencyKey,
        inputSnapshot: resolved ? snapshotFromResolvedContext(resolved) : {},
      },
    });
  } catch (error) {
    stepRun = await findRunByKey(prisma, idempotencyKey);
    if (!stepRun) {
      await restoreStatus(prisma, input, step.id, claimFrom);
      throw error;
    }
  }

  let executed;
  try {
    executed = await executeStartedAssistStepRun(prisma, {
      stepRunId: stepRun.id,
      actionId: input.actionId,
      conversationId: input.conversationId ?? null,
      resolvedContext: resolved,
      provider: input.provider ?? null,
      logger,
    });
  } catch (error) {
    // A throw mid-run must not leave the step wedged on `running`, or the
    // merchant can never ask for it again.
    await restoreStatus(prisma, input, step.id, claimFrom);
    logger.error?.("assist run threw", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.actionId,
      stepId: step.id,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return {
      ok: false,
      code: "ASSIST_FAILED",
      retryable: true,
      stepId: step.id,
      title: step.title ?? null,
      message: `I couldn't finish "${step.title ?? "that step"}" just now — nothing was saved from it.`,
    };
  }

  if (!executed.ok) {
    await restoreStatus(prisma, input, step.id, claimFrom);
    logger.warn("assist run failed", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.actionId,
      stepId: step.id,
      reason: executed.reason ?? "assist_failed",
    });
    return {
      ok: false,
      code: "ASSIST_FAILED",
      retryable: true,
      stepId: step.id,
      title: step.title ?? null,
      message: `I couldn't finish "${step.title ?? "that step"}" just now.`,
      reason: executed.reason ?? "assist_failed",
    };
  }

  return {
    ok: true,
    stepId: step.id,
    title: step.title ?? null,
    artifact: executed.progress ?? null,
    chatReply: executed.chatReply ?? null,
    resolvedContext: resolved ?? null,
  };
}

/**
 * Reach a desired outcome: run every derived prerequisite that is missing or
 * stale, then the target itself. Stops at real merchant boundaries.
 *
 * @param {any} prisma
 * @param {{
 *   merchantId: string;
 *   shopId: string;
 *   actionId: string;
 *   capabilityRef: string;
 *   actor?: string | null;
 *   conversationId?: string | null;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 * }} input
 */
export async function reachCapability(prisma, input) {
  const logger = input.logger ?? log;

  let state = await resolveActionState(prisma, input);
  if (!state) {
    return { ok: false, code: "ACTION_NOT_FOUND", message: "I couldn't find that action.", ran: [] };
  }

  if (state.lifecycle === "proposed") {
    const accepted = await acceptMerchantActionPlan(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.actionId,
      actor: input.actor ?? input.merchantId,
      logger,
    });
    if (!accepted.ok) {
      return {
        ok: false,
        code: "PLAN_NOT_ACCEPTED",
        message: "I need you to accept this plan before I can start the work.",
        ran: [],
      };
    }
    state = await resolveActionState(prisma, input);
  }

  const target = (state?.work ?? []).find(
    (/** @type {any} */ row) => row.step.capabilityRef === input.capabilityRef,
  );
  if (!target) {
    return {
      ok: false,
      code: "CAPABILITY_UNAVAILABLE",
      message: "This action doesn't include that piece of work.",
      ran: [],
    };
  }

  if (!workNeedsExecution(target)) {
    return {
      ok: true,
      alreadyCurrent: true,
      stepId: target.step.id,
      title: target.step.title ?? null,
      artifact: target.validResult ?? null,
      ran: [],
    };
  }

  /** @type {any[]} */
  const ran = /** @type {any[]} */ ([]);
  // Re-derive between runs: completing one step changes what the next needs.
  for (let pass = 0; pass < 8; pass += 1) {
    state = await resolveActionState(prisma, input);
    const chain = resolveWorkChain(state, target.step.id);
    if (!chain.ok) return { ...chain, ran };
    if (chain.chain.length === 0) break;

    const next = chain.chain[0];
    const result = await runAssistStepById(prisma, {
      ...input,
      stepId: next.step.id,
      logger,
    });
    ran.push(result);
    if (!result.ok) {
      return { ...result, ran, partial: ran.filter((row) => row.ok) };
    }
    if (result.alreadyCurrent || result.deduplicated) {
      // Nothing changed; avoid spinning on a row we cannot advance.
      const stillNeeded = resolveWorkChain(
        await resolveActionState(prisma, input),
        target.step.id,
      );
      if (stillNeeded.ok && stillNeeded.chain.some((/** @type {any} */ row) => row.step.id === next.step.id)) {
        return {
          ok: false,
          code: "NO_PROGRESS",
          message: `I couldn't move "${next.step.title ?? "that step"}" forward.`,
          ran,
        };
      }
    }
  }

  const finalState = await resolveActionState(prisma, input);
  const finalRow = (finalState?.work ?? []).find(
    (/** @type {any} */ row) => row.step.capabilityRef === input.capabilityRef,
  );
  if (!finalRow || workNeedsExecution(finalRow)) {
    return {
      ok: false,
      code: "OUTCOME_NOT_REACHED",
      message:
        (finalRow?.blockers ?? []).map((/** @type {any} */ row) => row.reason).filter(Boolean).join(" ") ||
        "I couldn't get that finished.",
      ran,
      blockers: finalRow?.blockers ?? [],
    };
  }

  return {
    ok: true,
    stepId: finalRow.step.id,
    title: finalRow.step.title ?? null,
    artifact: finalRow.validResult ?? null,
    ran,
  };
}

/** @param {any} prisma @param {string} idempotencyKey */
async function findRunByKey(prisma, idempotencyKey) {
  if (!prisma?.merchantRecommendationStepRun?.findFirst) return null;
  try {
    return await prisma.merchantRecommendationStepRun.findFirst({
      where: { idempotencyKey },
    });
  } catch {
    return null;
  }
}

/** @param {any} prisma @param {any} input @param {string} stepId @param {string} status */
async function restoreStatus(prisma, input, stepId, status) {
  await prisma.merchantRecommendationStep.updateMany({
    where: {
      id: stepId,
      merchantId: input.merchantId,
      shopId: input.shopId,
      status: ACTION_STEP_STATUS.running,
    },
    data: { status, statusReason: "Jefe could not complete this run." },
  });
}

/**
 * The lifecycle guard only lets steps run on an accepted/in-progress action.
 * Accepting already happened above; this just moves `accepted` → `in_progress`.
 *
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string }} input
 */
async function unlockActionForWork(prisma, input) {
  if (!prisma?.merchantAction?.updateMany) return;
  await prisma.merchantAction.updateMany({
    where: { id: input.actionId, merchantId: input.merchantId, shopId: input.shopId },
    data: { status: "in_progress" },
  });
}

/** @param {any} action @param {string} stepId */
function findStep(action, stepId) {
  const steps = [
    ...(Array.isArray(action?.workflow?.steps) ? action.workflow.steps : []),
    ...(Array.isArray(action?.displaySteps) ? action.displaySteps : []),
  ];
  return steps.find((step) => String(step?.id ?? "") === String(stepId)) ?? null;
}
