// @ts-check

/**
 * Conversational workflow navigation: forward, back, jump, skip, reopen, and
 * dependency-aware downstream invalidation. Chat and UI buttons both route here
 * through action-command → lifecycle.
 *
 * Phrase helpers below are optional Stage B / LLM-down aids. Focused chat
 * routing does not depend on them matching a merchant's exact wording.
 */

import { logger as baseLogger } from "../observability/logger.server.js";
import { staleLiveChangeSets } from "./action-changeset.server.js";
import {
  ACTION_STEP_RUN_STATUS,
  ACTION_STEP_STATUS,
} from "./action-step-lifecycle.server.js";

const log = baseLogger.child({ component: "action-workflow-navigation" });

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

/** Semantic tags used to resolve natural-language step references. */
export const STEP_SEMANTIC_TAGS = Object.freeze({
  inventory: ["inventory", "review", "low-cover", "low cover", "cover period", "cover days"],
  proposal: ["proposal", "quantities", "replenishment", "restock", "order quantities"],
  supplier: ["supplier", "email", "draft", "communication", "message"],
});

/**
 * @param {string} message
 * @returns {boolean}
 */
export function isAdvanceStepCommand(message) {
  const text = String(message ?? "").trim();
  if (!text) return false;
  return (
    /\b(let'?s|okay,?)\s+(?:move on|carry on|continue|keep going)\b/i.test(text) ||
    /\b(?:ok(?:ay)?[, ]*)?(?:let'?s|we should)?\s*move to (?:the )?next\b/i.test(text) ||
    /\b(?:proceed|continue|go) to (?:the )?next step\b/i.test(text) ||
    /\b(move on|carry on|move forward|onto the next)\b/i.test(text) ||
    /^(next|continue|keep going|go on|move on|carry on)\.?$/i.test(text) ||
    /\bwhat(?:'s| is) next\b.*\b(let'?s|do that|go)\b/i.test(text)
  );
}

/**
 * @param {string} message
 * @returns {{ steps: number } | { targetHint: string } | null}
 */
export function parseGoBackCommand(message) {
  const text = String(message ?? "").trim();
  if (!text) return null;

  const multi = text.match(/\b(?:go back|back up|take us back|return)\s+(?:two|2|three|3|\d+)\s+steps?\b/i);
  if (multi) {
    const word = multi[0].match(/\b(two|2|three|3|\d+)\b/i)?.[1] ?? "1";
    const steps = wordToNumber(word);
    if (steps > 0) return { steps };
  }

  if (
    /\b(?:go back|back up|return)\s+(?:to\s+)?(?:the\s+)?(?:first|beginning|start)\b/i.test(text) ||
    /\breturn to the beginning\b/i.test(text)
  ) {
    return { steps: Number.MAX_SAFE_INTEGER };
  }

  const semantic =
    text.match(/\b(?:go back|return|revisit|take me back)\s+(?:to\s+)?(.+)/i) ??
    text.match(/\b(?:let'?s|i want to)\s+(?:revisit|redo)\s+(?:the\s+)?(.+)/i);
  if (semantic?.[1]) {
    const hint = String(semantic[1]).replace(/[.?]+$/, "").trim();
    if (hint && !/^(?:one|1|two|2)\s+steps?$/i.test(hint) && !/^again$/i.test(hint)) {
      return { targetHint: hint };
    }
  }

  if (
    /\b(?:go back|back up|back again|previous step|the step before)\b/i.test(text) ||
    /^back\.?$/i.test(text) ||
    /\bback again\b/i.test(text)
  ) {
    return { steps: 1 };
  }

  return null;
}

/**
 * @param {string} message
 * @returns {{ targetHint: string } | null}
 */
export function parseGoToStepCommand(message) {
  const text = String(message ?? "").trim();
  if (!text) return null;
  const match =
    text.match(/\b(?:go(?: straight)? to|jump to|take me to|open)\s+(?:the\s+)?(.+)/i) ??
    text.match(/\bi (?:just )?want (?:the\s+)?(.+)/i);
  if (!match?.[1]) return null;
  const hint = String(match[1]).replace(/[.?]+$/, "").trim();
  if (!hint || /^(?:next|it|that|this)$/i.test(hint)) return null;
  return { targetHint: hint };
}

/**
 * @param {string} message
 * @returns {boolean}
 */
export function isExtendedSkipCommand(message) {
  const text = String(message ?? "").trim();
  if (!text) return false;
  if (/\b(?:leave this until|defer this|not right now|next month|later)\b/i.test(text)) {
    return false;
  }
  return (
    /\bskip (?:this|that|the)\b/i.test(text) ||
    /\b(?:don'?t|do not) need (?:this|a|the)\b/i.test(text) ||
    /\bi(?:'ll| will) (?:handle|do|message|contact).*(?:myself|supplier)\b/i.test(text) ||
    /\bleave (?:this|that) (?:out|step)\b/i.test(text) ||
    /^skip(?: this)?[—-].+/i.test(text)
  );
}

/**
 * Resolve a merchant phrase to one or more candidate steps.
 * @param {any[]} steps
 * @param {string} hint
 * @returns {{ step: any; score: number; label: string }[]}
 */
export function resolveStepCandidates(steps, hint) {
  const ordered = orderedSteps(steps);
  const normalized = String(hint ?? "").trim().toLowerCase();
  if (!normalized) return [];

  /** @type {{ step: any; score: number; label: string }[]} */
  const candidates = [];

  for (const step of ordered) {
    const title = String(step.title ?? "").toLowerCase();
    let score = 0;
    if (title.includes(normalized) || normalized.includes(title)) score += 10;
    if (/\bstep\s+(\d+)\b/i.test(normalized)) {
      const num = Number(normalized.match(/\bstep\s+(\d+)\b/i)?.[1]);
      if (Number.isFinite(num) && Number(step.orderIndex) + 1 === num) score += 20;
    }
    if (/^(first|1|one)\b/.test(normalized) && Number(step.orderIndex) === 0) score += 15;
    if (/^(final|last)\b/.test(normalized) && step.id === ordered[ordered.length - 1]?.id) {
      score += 15;
    }
    for (const [tag, keywords] of Object.entries(STEP_SEMANTIC_TAGS)) {
      if (!keywords.some((word) => normalized.includes(word))) continue;
      if (title.includes(tag) || keywords.some((word) => title.includes(word))) score += 8;
    }
    if (/cover|calculated|calculation|assumptions|products?|scope|selected/.test(normalized)) {
      if (/inventory|review|cover/.test(title)) score += 6;
      if (/proposal|quantities|replenishment/.test(title)) score += 4;
    }
    if (/quantities|proposal|final/.test(normalized)) {
      if (/proposal|replenishment/.test(title)) score += 6;
      if (/inventory|review/.test(title)) score += 4;
    }
    if (/supplier|message|draft|email|communication/.test(normalized)) {
      if (/supplier|communication|draft|email/.test(title)) score += 10;
    }
    if (score > 0) {
      candidates.push({ step, score, label: step.title ?? "step" });
    }
  }

  return candidates.sort((left, right) => right.score - left.score);
}

/**
 * @param {any[]} steps
 * @param {string} hint
 * @returns {any | null}
 */
export function resolveStepTarget(steps, hint) {
  const candidates = resolveStepCandidates(steps, hint);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].step;
  if (candidates[0].score > candidates[1].score) return candidates[0].step;
  return null;
}

/**
 * @param {any[]} steps
 * @param {string} hint
 * @returns {{ ambiguous: true; question: string; candidates: { stepId: string; label: string }[] } | { ambiguous: false; step: any }}
 */
export function resolveStepTargetOrClarify(steps, hint) {
  const ranked = resolveStepCandidates(steps, hint);
  if (ranked.length === 0) {
    return { ambiguous: false, step: null };
  }
  const quantitiesHint = /^\s*(?:the\s+)?quantities?\s*$/i.test(String(hint ?? ""));
  if (quantitiesHint && ranked.length >= 2) {
    const top = ranked.slice(0, 2);
    return {
      ambiguous: true,
      question:
        "Do you want to revisit how I calculated the quantities, or the final replenishment proposal?",
      candidates: top.map((item) => ({
        stepId: item.step.id,
        label: item.label,
        hint: /inventory|review|cover|calculat/.test(String(item.label ?? "").toLowerCase())
          ? "cover calculation inventory review"
          : "proposal quantities",
      })),
    };
  }
  if (ranked.length === 1 || ranked[0].score > ranked[1].score + 2) {
    return { ambiguous: false, step: ranked[0].step };
  }
  const top = ranked.slice(0, 2);
  const question =
    /quantit/.test(hint)
      ? "Do you want to revisit how I calculated the quantities, or the final replenishment proposal?"
      : `Did you mean "${top[0].label}" or "${top[1].label}"?`;
  return {
    ambiguous: true,
    question,
    candidates: top.map((item) => ({ stepId: item.step.id, label: item.label })),
  };
}

/**
 * Mark downstream steps stale after a material change on an upstream step.
 *
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; workflowId: string; fromStepId: string; reason?: string; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function invalidateDownstreamSteps(prisma, input) {
  const logger = input.logger ?? log;
  const steps = orderedSteps(
    await prisma.merchantRecommendationStep.findMany({
      where: {
        workflowId: input.workflowId,
        merchantId: input.merchantId,
        shopId: input.shopId,
      },
      orderBy: { orderIndex: "asc" },
    }),
  );
  const fromIndex = steps.findIndex((step) => step.id === input.fromStepId);
  if (fromIndex < 0) return { invalidated: [] };

  const reason =
    input.reason ??
    "Upstream inputs changed — this step needs to be rebuilt before you can rely on it.";
  /** @type {string[]} */
  const invalidated = [];
  for (let index = fromIndex + 1; index < steps.length; index += 1) {
    const step = steps[index];
    const status = String(step.status ?? "");
    if (
      status === ACTION_STEP_STATUS.completed ||
      status === ACTION_STEP_STATUS.skipped ||
      ACTIVE_STEP_STATUSES.has(status) ||
      status === ACTION_STEP_STATUS.needsUpdating
    ) {
      await prisma.merchantRecommendationStep.updateMany({
        where: {
          id: step.id,
          merchantId: input.merchantId,
          shopId: input.shopId,
        },
        data: {
          status: ACTION_STEP_STATUS.needsUpdating,
          statusReason: reason,
          completedAt: null,
        },
      });
      invalidated.push(step.id);
    }
  }

  await staleLiveChangeSets(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.actionId,
  });

  if (invalidated.length > 0) {
    logger.info("invalidated downstream workflow steps", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.actionId,
      fromStepId: input.fromStepId,
      invalidatedStepIds: invalidated,
    });
  }
  return { invalidated };
}

/**
 * Complete the current step conversationally and unlock the next one.
 *
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; actor?: string | null; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function advanceCurrentActionStep(prisma, input) {
  const logger = input.logger ?? log;
  const now = new Date();
  const run = async (/** @type {any} */ tx) => {
    const action = await loadAction(tx, input);
    if (!action) return { ok: false, reason: "not_found" };
    const workflow = latestWorkflow(action);
    if (!workflow) return { ok: false, reason: "no_workflow" };
    const steps = orderedSteps(workflow.steps);
    let current = pickCurrentStep(steps);
    if (!current) {
      const hasUnlockable = steps.some((step) =>
        ["pending", "draft", ACTION_STEP_STATUS.waiting].includes(String(step.status ?? "")),
      );
      if (hasUnlockable) {
        const unlocked = await advanceWorkflow(tx, {
          merchantId: input.merchantId,
          shopId: input.shopId,
          actionId: action.id,
          workflowId: workflow.id,
          now,
        });
        const refreshed = orderedSteps(
          await tx.merchantRecommendationStep.findMany({
            where: {
              workflowId: workflow.id,
              merchantId: input.merchantId,
              shopId: input.shopId,
            },
            orderBy: { orderIndex: "asc" },
          }),
        );
        current =
          pickCurrentStep(refreshed) ??
          (unlocked.currentStep?.id
            ? refreshed.find((step) => step.id === unlocked.currentStep.id) ?? null
            : null);
      }
    }
    if (!current) return { ok: false, reason: "no_current_step" };
    const status = String(current.status ?? "");
    if (status === ACTION_STEP_STATUS.running) {
      return {
        ok: false,
        reason: "step_still_running",
        currentStepId: current.id,
        blocker: `I'm still working on "${current.title}". Say stop if you want me to pause first.`,
      };
    }
    if (status === ACTION_STEP_STATUS.needsAttention) {
      return {
        ok: false,
        reason: "needs_attention",
        currentStepId: current.id,
        blocker: `"${current.title}" needs attention before we can move on.`,
      };
    }
    if (status === ACTION_STEP_STATUS.needsUpdating) {
      return {
        ok: false,
        reason: "needs_rebuild",
        currentStepId: current.id,
        blocker: `"${current.title}" needs to be rebuilt before we can move on. Tell me to start it and I'll refresh it.`,
      };
    }
    if (isUnstartedStep(current)) {
      return {
        ok: true,
        reason: "step_not_started",
        currentStepId: current.id,
        currentStep: serializeStep(current),
        blocker: `"${current.title}" hasn't started yet — I can't skip past it. Tell me to start it, or tap Review proposals.`,
      };
    }
    if (!ACTIVE_STEP_STATUSES.has(status) && status !== ACTION_STEP_STATUS.waiting) {
      return { ok: false, reason: "not_advanceable", currentStepId: current.id };
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
        statusReason: "Marked complete to move forward.",
      },
    });

    const advance = await advanceWorkflow(tx, {
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
          eventType: "action_step_advanced",
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
    logger.info("merchant advanced action step", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.actionId,
      stepId: result.stepId,
    });
  }
  return result;
}

/**
 * Move workflow focus back one or more steps.
 *
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; steps?: number; actor?: string | null; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function goBackActionSteps(prisma, input) {
  const logger = input.logger ?? log;
  const stepsBack = Math.max(1, input.steps ?? 1);
  const run = async (/** @type {any} */ tx) => {
    const action = await loadAction(tx, input);
    if (!action) return { ok: false, reason: "not_found" };
    const workflow = latestWorkflow(action);
    if (!workflow) return { ok: false, reason: "no_workflow" };
    const steps = orderedSteps(workflow.steps);
    const current = pickCurrentStep(steps);
    const currentIndex = current
      ? steps.findIndex((step) => step.id === current.id)
      : steps.findIndex((step) => !TERMINAL_STEP_STATUSES.has(String(step.status ?? "")));
    if (currentIndex <= 0) {
      return { ok: false, reason: "already_at_start", currentStepId: current?.id ?? null };
    }
    const targetIndex =
      input.steps === Number.MAX_SAFE_INTEGER
        ? 0
        : Math.max(0, currentIndex - stepsBack);
    const target = steps[targetIndex];
    if (!target) return { ok: false, reason: "invalid_target" };

    const focus = await setWorkflowFocus(tx, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: action.id,
      workflowId: workflow.id,
      targetStepId: target.id,
      steps,
    });

    if (tx.merchantActionEvent?.create) {
      await tx.merchantActionEvent.create({
        data: {
          merchantId: input.merchantId,
          shopId: input.shopId,
          merchantActionId: action.id,
          eventType: "action_step_navigated_back",
          metadata: {
            targetStepId: target.id,
            stepsBack,
            actor: input.actor ?? input.merchantId,
          },
        },
      });
    }

    return {
      ok: true,
      actionId: action.id,
      stepId: target.id,
      currentStep: focus.currentStep,
    };
  };

  const result = prisma.$transaction ? await prisma.$transaction(run) : await run(prisma);
  if (result.ok) {
    logger.info("merchant navigated back in workflow", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.actionId,
      stepId: result.stepId,
    });
  }
  return result;
}

/**
 * Jump to a specific workflow step, validating prerequisites when jumping forward.
 *
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; targetStepId: string; actor?: string | null; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function goToActionStep(prisma, input) {
  const logger = input.logger ?? log;
  const run = async (/** @type {any} */ tx) => {
    const action = await loadAction(tx, input);
    if (!action) return { ok: false, reason: "not_found" };
    const workflow = latestWorkflow(action);
    if (!workflow) return { ok: false, reason: "no_workflow" };
    const steps = orderedSteps(workflow.steps);
    const target = steps.find((step) => step.id === input.targetStepId);
    if (!target) return { ok: false, reason: "step_not_found" };

    const targetIndex = steps.findIndex((step) => step.id === target.id);
    const current = pickCurrentStep(steps);
    const currentIndex = current
      ? steps.findIndex((step) => step.id === current.id)
      : steps.findIndex((step) => ACTIVE_STEP_STATUSES.has(String(step.status ?? "")));

    if (targetIndex > currentIndex) {
      const blockers = prerequisiteBlockers(steps, targetIndex);
      if (blockers.length > 0) {
        return {
          ok: false,
          reason: "prerequisites_missing",
          blockers,
          targetStepId: target.id,
          targetTitle: target.title,
          offer: describePrerequisiteOffer(blockers, target.title),
        };
      }
    }

    const focus = await setWorkflowFocus(tx, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: action.id,
      workflowId: workflow.id,
      targetStepId: target.id,
      steps,
    });

    if (tx.merchantActionEvent?.create) {
      await tx.merchantActionEvent.create({
        data: {
          merchantId: input.merchantId,
          shopId: input.shopId,
          merchantActionId: action.id,
          eventType: "action_step_navigated_to",
          metadata: {
            targetStepId: target.id,
            actor: input.actor ?? input.merchantId,
          },
        },
      });
    }

    return {
      ok: true,
      actionId: action.id,
      stepId: target.id,
      currentStep: focus.currentStep,
    };
  };

  const result = prisma.$transaction ? await prisma.$transaction(run) : await run(prisma);
  if (result.ok) {
    logger.info("merchant navigated to workflow step", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.actionId,
      stepId: result.stepId,
    });
  }
  return result;
}

/**
 * @param {any} tx
 * @param {{ merchantId: string; shopId: string; actionId: string; workflowId: string; targetStepId: string; steps: any[]; now?: Date }} input
 */
async function setWorkflowFocus(tx, input) {
  const now = input.now ?? new Date();
  const steps = orderedSteps(input.steps);
  const targetIndex = steps.findIndex((step) => step.id === input.targetStepId);
  if (targetIndex < 0) return { currentStep: null };

  for (let index = targetIndex + 1; index < steps.length; index += 1) {
    const step = steps[index];
    const status = String(step.status ?? "");
    if (status === ACTION_STEP_STATUS.running) {
      await tx.merchantRecommendationStepRun.updateMany({
        where: {
          stepId: step.id,
          merchantId: input.merchantId,
          shopId: input.shopId,
          status: {
            in: [ACTION_STEP_RUN_STATUS.queued, ACTION_STEP_RUN_STATUS.running],
          },
        },
        data: {
          status: ACTION_STEP_RUN_STATUS.cancelled,
          completedAt: now,
          error: { reason: "navigation_cancelled" },
        },
      });
    }
    if (ACTIVE_STEP_STATUSES.has(status)) {
      await tx.merchantRecommendationStep.updateMany({
        where: {
          id: step.id,
          merchantId: input.merchantId,
          shopId: input.shopId,
        },
        data: {
          status: ACTION_STEP_STATUS.waiting,
          statusReason: "Waiting while you revisit an earlier step.",
        },
      });
    }
  }

  const target = steps[targetIndex];
  const reopenedStatus = statusForReopenedStep(target);
  await tx.merchantRecommendationStep.updateMany({
    where: {
      id: target.id,
      merchantId: input.merchantId,
      shopId: input.shopId,
    },
    data: {
      status: reopenedStatus,
      statusReason: "Reopened for review and changes.",
      completedAt: null,
    },
  });

  return {
    currentStep: serializeStep({ ...target, status: reopenedStatus }),
  };
}

/** @param {any[]} steps @param {number} targetIndex */
function prerequisiteBlockers(steps, targetIndex) {
  /** @type {{ title: string; reason: string; stepId: string }[]} */
  const blockers = [];
  for (let index = 0; index < targetIndex; index += 1) {
    const step = steps[index];
    const status = String(step.status ?? "");
    if (status === ACTION_STEP_STATUS.needsUpdating) {
      blockers.push({
        stepId: step.id,
        title: step.title ?? "Earlier step",
        reason: "needs_rebuild",
      });
      continue;
    }
    if (!TERMINAL_STEP_STATUSES.has(status) && status !== ACTION_STEP_STATUS.completed) {
      blockers.push({
        stepId: step.id,
        title: step.title ?? "Earlier step",
        reason: "not_complete",
      });
    }
  }
  return blockers;
}

/** @param {{ title: string; reason: string }[]} blockers @param {string} targetTitle */
function describePrerequisiteOffer(blockers, targetTitle) {
  const rebuild = blockers.find((item) => item.reason === "needs_rebuild");
  if (rebuild) {
    return `I need to rebuild "${rebuild.title}" first because upstream inputs changed. I can do that now, then move to "${targetTitle}".`;
  }
  const pending = blockers[0];
  if (pending) {
    return `"${targetTitle}" depends on "${pending.title}" first. I can work through that and then take you there.`;
  }
  return `I can't jump to "${targetTitle}" yet — earlier steps still need to finish.`;
}

/** @param {any} step */
function statusForReopenedStep(step) {
  const mode = String(step?.mode ?? "");
  if (mode === "merchant_action" || mode === "evidence_required") {
    return ACTION_STEP_STATUS.needsMerchant;
  }
  return ACTION_STEP_STATUS.ready;
}

/**
 * @param {any} tx
 * @param {{ merchantId: string; shopId: string; actionId: string; workflowId: string; now?: Date }} input
 */
async function advanceWorkflow(tx, input) {
  const { advanceActionWorkflow } = await import("./action-step-lifecycle.server.js");
  return advanceActionWorkflow(tx, input);
}

/** @param {any} tx @param {{ merchantId: string; shopId: string; actionId: string }} input */
async function loadAction(tx, input) {
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
              steps: { orderBy: { orderIndex: "asc" } },
            },
          },
        },
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
    steps.find((step) => ACTIVE_STEP_STATUSES.has(String(step.status ?? ""))) ?? null
  );
}

/**
 * Ready / leftover pending steps have not been worked. "Move on" should not
 * complete them — the merchant still needs to start the current step.
 * @param {any} step
 */
function isUnstartedStep(step) {
  const status = String(step?.status ?? "");
  const mode = String(step?.mode ?? "");
  if (
    status === ACTION_STEP_STATUS.running ||
    status === ACTION_STEP_STATUS.needsAttention ||
    status === ACTION_STEP_STATUS.needsUpdating
  ) {
    return false;
  }
  if (status === ACTION_STEP_STATUS.needsMerchant) {
    if (mode === "merchant_action" || mode === "evidence_required") return false;
    const progress = step?.progress && typeof step.progress === "object" ? step.progress : {};
    if (progress.artifactType) return false;
    return true;
  }
  return (
    status === ACTION_STEP_STATUS.ready ||
    status === ACTION_STEP_STATUS.waiting ||
    status === "pending" ||
    status === "draft"
  );
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

/** @param {string} word */
function wordToNumber(word) {
  const map = { one: 1, two: 2, three: 3, four: 4, five: 5 };
  const lower = String(word).toLowerCase();
  if (lower in map) return map[/** @type {keyof typeof map} */ (lower)];
  const parsed = Number(word);
  return Number.isFinite(parsed) ? parsed : 1;
}
