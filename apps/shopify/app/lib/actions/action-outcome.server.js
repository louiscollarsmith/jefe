// @ts-check

/**
 * Goal-oriented execution: reach a desired outcome by safely performing
 * Jefe-owned prerequisite work. Merchants should not need to know step order.
 */

import { logger as baseLogger } from "../observability/logger.server.js";
import { getMerchantAction } from "./merchant-action.server.js";
import {
  acceptMerchantActionPlan,
  startActionStep,
} from "./action-step-lifecycle.server.js";
import { executeStartedAssistStepRun } from "./assist-steps/run.server.js";
import { goToActionStep } from "./action-workflow-navigation.server.js";
import {
  findStepForOutcome,
  outcomeCapabilityRef,
  refreshWorkflowState,
  resolveActionState,
  workNeedsExecution,
} from "./action-state.server.js";
import { ACTION_STEP_STATUS } from "./action-step-lifecycle.server.js";

const log = baseLogger.child({ component: "action-outcome" });

/** @type {Record<string, string[]>} */
const OUTCOME_PREREQUISITES = Object.freeze({
  supplier_draft: ["assist:inventory_review", "assist:replenishment_proposal"],
  supplier_communication: ["assist:inventory_review", "assist:replenishment_proposal"],
  supplier_email: ["assist:inventory_review", "assist:replenishment_proposal"],
  replenishment_proposal: ["assist:inventory_review"],
  proposal: ["assist:inventory_review"],
  inventory_review: [],
});

/**
 * @param {any} prisma
 * @param {{
 *   merchantId: string;
 *   shopId: string;
 *   actionId: string;
 *   outcome: string;
 *   actor?: string | null;
 *   conversationId?: string | null;
 *   session?: { shop: string } | null;
 *   executeDeps?: any;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 * }} input
 */
export async function achieveOutcome(prisma, input) {
  const logger = input.logger ?? log;
  const outcome = normalizeOutcome(input.outcome);
  const capabilityRef = outcomeCapabilityRef(outcome);
  if (!capabilityRef) {
    return {
      ok: false,
      reason: "unknown_outcome",
      reply: "I understood what you want, but I can't map that to work on this action yet.",
    };
  }

  let action = await refreshWorkflowState(prisma, input);
  if (!action) {
    return { ok: false, reason: "not_found", reply: "I couldn't find that action." };
  }

  if (action.status === "proposed") {
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
        reason: accepted.reason,
        reply: "Accept the plan first, then I can carry on with that for you.",
      };
    }
    action = await refreshWorkflowState(prisma, input);
  }

  const chain = buildAssistChain(action, capabilityRef, outcome);
  if (chain.length === 0) {
    return {
      ok: false,
      reason: "no_matching_step",
      reply: "I couldn't find the right step for that on this action.",
    };
  }

  logger.info("achieving outcome", {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.actionId,
    outcome,
    chain: chain.map((step) => step.id),
  });

  /** @type {string | null} */
  let lastReply = null;
  /** @type {any} */
  let lastArtifact = null;

  for (const step of chain) {
    const result = await ensureAssistStep(prisma, {
      ...input,
      stepId: step.id,
      logger,
    });
    if (!result.ok) {
      return result;
    }
    if (result.reply) lastReply = result.reply;
    if (result.artifact) lastArtifact = result.artifact;
  }

  const finalState = await resolveActionState(prisma, input);
  const targetStep = findStepForOutcome(finalState, outcome);
  const targetWork = targetStep
    ? (finalState?.work ?? []).find((row) => row.step.id === targetStep.id)
    : null;
  if (targetWork && workNeedsExecution(targetWork)) {
    return {
      ok: false,
      reason: "outcome_not_reached",
      reply: formatBlockedReply(targetStep, targetWork.blockers),
      blockers: targetWork.blockers ?? [],
      chain: chain.map((step) => step.id),
    };
  }

  return {
    ok: true,
    outcome,
    reply:
      lastReply ??
      (lastArtifact?.summary
        ? String(lastArtifact.summary)
        : "Done — the latest result is ready for you."),
    artifact: lastArtifact,
    chain: chain.map((step) => step.id),
  };
}

/**
 * @param {any} prisma
 * @param {{
 *   merchantId: string;
 *   shopId: string;
 *   actionId: string;
 *   stepId: string;
 *   actor?: string | null;
 *   conversationId?: string | null;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 * }} input
 */
async function ensureAssistStep(prisma, input) {
  const logger = input.logger ?? log;
  let action = await refreshWorkflowState(prisma, input);
  if (!action) return { ok: false, reason: "not_found", reply: "I couldn't find that action." };

  const state = await resolveActionState(prisma, input);
  const work = (state?.work ?? []).find((row) => row.step.id === input.stepId);
  if (!work) {
    return { ok: false, reason: "step_not_found", reply: "I couldn't find that workflow step." };
  }

  if (work.state === "blocked" && Array.isArray(work.blockers) && work.blockers.length > 0) {
    const stepRow = findStepOnAction(action, input.stepId);
    const blockedByMerchant = work.blockers.some((/** @type {any} */ row) => {
      const dep = orderedSteps(action).find((s) => s.id === row.stepId);
      return dep && (dep.mode === "evidence_required" || dep.mode === "merchant_action");
    });
    if (blockedByMerchant) {
      return {
        ok: false,
        reason: "merchant_input_required",
        reply:
          "I can continue once I have the supplier evidence. Upload an invoice, price sheet or CSV and I'll pick up from there.",
        blockers: work.blockers,
      };
    }
  }

  if (work.state === "needs_input") {
    return {
      ok: false,
      reason: "merchant_input_required",
      reply:
        work.blockers[0]?.reason ??
        "I need something from you before I can finish this part.",
      blockers: work.blockers,
    };
  }

  if (!workNeedsExecution(work)) {
    return {
      ok: true,
      skipped: true,
      artifact: work.validResult,
      reply: work.validResult?.summary ?? null,
    };
  }

  if (work.state === "blocked" && work.blockers?.length) {
    const prereqBlocker = work.blockers.find((/** @type {any} */ row) => row.stepId);
    if (prereqBlocker?.stepId) {
      const prereq = await ensureAssistStep(prisma, {
        ...input,
        stepId: prereqBlocker.stepId,
        logger,
      });
      if (!prereq.ok) return prereq;
    }
  }

  const step = findStepOnAction(action, input.stepId);
  if (!step || step.mode !== "assist") {
    return {
      ok: false,
      reason: "not_assist",
      reply: "That part needs a different kind of handling — I'll stop here rather than guess.",
    };
  }

  action = await focusStepAsCurrent(prisma, input, step.id, logger);
  if (!action) {
    return { ok: false, reason: "focus_failed", reply: formatBlockedReply(step, []) };
  }

  const started = await startActionStep(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.actionId,
    actor: input.actor ?? input.merchantId,
    logger,
  });

  if (!started.ok) {
    // One reconciliation retry — stale waiting flags are a common cause.
    await refreshWorkflowState(prisma, input);
    await focusStepAsCurrent(prisma, input, step.id, logger);
    const retry = await startActionStep(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.actionId,
      actor: input.actor ?? input.merchantId,
      logger,
    });
    if (!retry.ok) {
      const blockers = (await resolveActionState(prisma, input))?.work?.find(
        (row) => row.step.id === input.stepId,
      )?.blockers;
      return {
        ok: false,
        reason: retry.reason ?? started.reason,
        reply: formatBlockedReply(step, blockers),
        blockers: blockers ?? [],
      };
    }
    Object.assign(started, retry);
  }

  const assist = await executeStartedAssistStepRun(prisma, {
    stepRunId: started.stepRunId,
    actionId: input.actionId,
    conversationId: input.conversationId ?? null,
    resolvedContext: started.resolvedContext ?? null,
    logger,
  });

  if (!assist.ok) {
    return {
      ok: false,
      reason: assist.reason ?? "assist_failed",
      reply: assist.chatReply ?? "I couldn't finish that assist step just now.",
    };
  }

  return {
    ok: true,
    artifact: assist.progress,
    reply: assist.chatReply ?? assist.progress?.summary ?? null,
  };
}

/** @param {any} action @param {string} capabilityRef @param {string} outcome */
function buildAssistChain(action, capabilityRef, outcome) {
  const steps = orderedSteps(action).filter((step) => step.mode === "assist");
  const target = steps.find((step) => step.capabilityRef === capabilityRef);
  if (!target) return [];
  const targetIndex = steps.findIndex((step) => step.id === target.id);
  const prereqRefs = OUTCOME_PREREQUISITES[outcome] ?? [];
  const chain = steps.slice(0, targetIndex + 1);
  return chain.filter(
    (step) =>
      step.id === target.id ||
      prereqRefs.includes(String(step.capabilityRef ?? "")) ||
      chain.indexOf(step) < targetIndex,
  );
}

/** @param {string} outcome */
function normalizeOutcome(outcome) {
  const text = String(outcome ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (/supplier|email|message|communication|draft/.test(text)) {
    if (/proposal|replenish/.test(text)) return "replenishment_proposal";
    return "supplier_draft";
  }
  if (/proposal|replenish/.test(text)) return "replenishment_proposal";
  if (/inventory|review|cover|calculation/.test(text)) return "inventory_review";
  return text;
}

/** @param {any} action */
function orderedSteps(action) {
  const steps = [
    ...(Array.isArray(action?.workflow?.steps) ? action.workflow.steps : []),
    ...(Array.isArray(action?.displaySteps) ? action.displaySteps : []),
  ];
  const seen = new Set();
  return steps
    .filter((step) => {
      const id = String(step?.id ?? "");
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => Number(a.orderIndex ?? 0) - Number(b.orderIndex ?? 0));
}

/** @param {any} action @param {string} stepId */
function findStepOnAction(action, stepId) {
  return orderedSteps(action).find((step) => step.id === stepId) ?? null;
}

/** @param {any} action */
function pickActiveStepId(action) {
  const active = orderedSteps(action).find((step) =>
    ["ready", "running", "needs_merchant", "needs_attention", "needs_updating"].includes(
      String(step.status ?? ""),
    ),
  );
  return active?.id ?? null;
}

/**
 * Run prerequisite assist steps until targetStepId is the workflow focus, then
 * promote stale needs_updating / waiting rows to startable state.
 *
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; actor?: string | null }} input
 * @param {string} targetStepId
 * @param {Pick<Console, "info" | "warn" | "error">} logger
 */
async function focusStepAsCurrent(prisma, input, targetStepId, logger) {
  const maxPasses = 6;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    let action = await refreshWorkflowState(prisma, input);
    if (!action) return null;
    const ordered = orderedSteps(action);
    const targetIndex = ordered.findIndex((row) => row.id === targetStepId);
    if (targetIndex < 0) return action;

    const state = await resolveActionState(prisma, input);
    const workByStepId = new Map((state?.work ?? []).map((row) => [row.step.id, row]));

    const currentId = action.currentStep?.id ?? pickActiveStepId(action);
    if (currentId === targetStepId) return action;

    // Run any incomplete or stale assist prerequisite before the target.
    for (let index = 0; index < targetIndex; index += 1) {
      const row = ordered[index];
      const work = workByStepId.get(row.id);
      if (!workNeedsExecution(work)) continue;
      if (row.mode !== "assist") continue;
      const prereq = await ensureAssistStep(prisma, { ...input, stepId: row.id, logger });
      if (!prereq.ok && !prereq.skipped) return null;
      action = await refreshWorkflowState(prisma, input);
    }

    const target = ordered[targetIndex];
    const targetWork = workByStepId.get(target.id);
    if (
      target &&
      (workNeedsExecution(targetWork) ||
        String(target.status) === ACTION_STEP_STATUS.waiting ||
        String(target.status) === ACTION_STEP_STATUS.needsUpdating)
    ) {
      await goToActionStep(prisma, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        actionId: input.actionId,
        targetStepId: target.id,
        actor: input.actor ?? input.merchantId,
        logger,
      });
      await refreshWorkflowState(prisma, input);
    }

    action = await refreshWorkflowState(prisma, input);
    const focusedId = action.currentStep?.id ?? pickActiveStepId(action);
    if (focusedId === targetStepId) return action;
  }
  return refreshWorkflowState(prisma, input);
}

/** @param {any} step @param {any[] | undefined} blockers */
function formatBlockedReply(step, blockers) {
  if (Array.isArray(blockers) && blockers.length > 0) {
    return blockers.map((row) => row.reason).filter(Boolean).join(" ");
  }
  const title = step?.title ?? "That step";
  return `${title} isn't ready yet. I'll need to finish the earlier work first.`;
}

/**
 * Map the current or next useful workflow step to an achieve_outcome key.
 *
 * @param {any} snapshot
 * @param {"current" | "next"} which
 */
export function outcomeHintFromSnapshot(snapshot, which = "current") {
  const work =
    which === "next"
      ? snapshot?.actionState?.nextUsefulWork ??
        (snapshot?.actionState?.work ?? []).find(
          (/** @type {any} */ row) => row.state === "available" || row.state === "needs_updating",
        )
      : null;
  const step =
    which === "current"
      ? snapshot?.currentStep ??
        snapshot?.actionState?.nextUsefulWork?.step ??
        null
      : work?.step ?? null;
  const ref = String(step?.capabilityRef ?? "");
  if (ref.includes("supplier")) return "supplier_draft";
  if (ref.includes("replenishment") || ref.includes("proposal")) return "replenishment_proposal";
  if (ref.includes("inventory")) return "inventory_review";
  const title = String(step?.title ?? "").toLowerCase();
  if (/supplier|email|message|communication/.test(title)) return "supplier_draft";
  if (/proposal|replenish/.test(title)) return "replenishment_proposal";
  if (/inventory|review|cover/.test(title)) return "inventory_review";
  return which === "next" ? "replenishment_proposal" : null;
}

export { findStepForOutcome, normalizeOutcome };
