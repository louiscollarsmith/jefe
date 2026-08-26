// @ts-check

/**
 * The one canonical merchant-facing Action state projection.
 *
 * Home and Action Chat consume `ActionDisplayContract` exclusively — they must
 * not branch on `MerchantAction.status`, `workspace`, `currentFocus`, or step
 * statuses directly. This module is the single place that translates the
 * durable, two-runtime execution state machine (legacy relational
 * workflow-step model + agentic-Shopify JSON model) into the seven
 * merchant-facing states.
 *
 * Deliberately separate from `resolveWorkspaceActionState()` in
 * action-workspace.server.js, which answers a different question (the one
 * internal-priority "focus" item across ten tiers) and must keep doing so
 * without being pulled into merchant-facing semantics.
 */

export const ACTION_DISPLAY_STATE = Object.freeze({
  proposed: "proposed",
  ready: "ready",
  working: "working",
  needsYou: "needs_you",
  done: "done",
  stopped: "stopped",
  couldntComplete: "couldnt_complete",
});

const LIFECYCLE_EVENT_LABELS = Object.freeze({
  action_plan_accepted: "PLAN ACCEPTED",
  action_plan_revised: "PLAN UPDATED",
  action_execution_started: "JEFE STARTED MAKING THE CHANGES",
  action_execution_completed: "CHANGES VERIFIED",
  action_execution_stopped: "STOPPED",
  action_execution_failed: "COULDN'T COMPLETE",
  action_needs_merchant_input: "JEFE NEEDS YOUR INPUT",
});

/**
 * @param {{ action?: any; recommendation?: any; execution?: any; workflow?: any; events?: any[] }} input
 * @returns {ActionDisplayContract}
 */
export function deriveActionDisplayState(input) {
  const action = input.action ?? null;
  const recommendation = input.recommendation ?? null;
  const execution = input.execution ?? null;
  /** @type {any[]} */
  const steps = Array.isArray(input.workflow?.steps) ? input.workflow.steps : [];

  const actionStatus = normalizeToken(action?.status);
  const executionStatus = normalizeToken(execution?.status);
  const reviewStatus = normalizeToken(recommendation?.reviewStatus);
  const progress = jsonObject(action?.progress);
  const agentic = jsonObject(progress.agentic);
  const executionJob = jsonObject(agentic.executionJob);
  const executionPhase = normalizeToken(executionJob.phase);
  const outcome = jsonObject(action?.outcome);
  const isAgentic = isAgenticShopifyAction(action);
  const hasIncompleteSteps = steps.some(
    (step) => !["completed", "skipped", "superseded"].includes(normalizeToken(step?.status)),
  );

  const displayState = resolveDisplayState({
    actionStatus,
    executionStatus,
    reviewStatus,
    executionPhase,
    executionJob,
    outcome,
    steps,
    hasIncompleteSteps,
    isAgentic,
  });

  const events = normalizeLifecycleEvents(input.events);
  const latestBlockingQuestion = blockingQuestionFrom(outcome, events);
  const planStepTitles = steps
    .filter((step) => !["completed", "skipped", "superseded"].includes(normalizeToken(step?.status)))
    .map((step) => safeText(step?.title, 80))
    .filter(Boolean);

  const chips = composerChipsFor({
    displayState,
    latestBlockingQuestion,
    isAgentic,
    planStepTitles,
  });

  return {
    displayState,
    title: safeText(action?.title || recommendation?.title, 180) || "Review Jefe's next move",
    subtitle: subtitleFor({ displayState, action, execution, outcome, steps, latestBlockingQuestion }),
    requiresMerchantInput: displayState === ACTION_DISPLAY_STATE.needsYou,
    canExecute: displayState === ACTION_DISPLAY_STATE.ready,
    canStop: displayState === ACTION_DISPLAY_STATE.working,
    startedAt: startedAtFor({ execution, executionJob, steps }),
    completedAt: completedAtFor({ displayState, execution, recommendation, steps }),
    lifecycleEvents: events,
    // No genuine business-stage source is wired yet (Phase 1 scope decision) — a
    // future pass can populate this from real per-action temporal data without
    // changing this contract's shape.
    realWorldProgress: [],
    chips,
    ctaLabel: ctaLabelFor(displayState),
    ctaIntent: "chat.focus.start",
  };
}

/**
 * @param {{
 *   actionStatus: string; executionStatus: string; reviewStatus: string;
 *   executionPhase: string; executionJob: Record<string, any>; outcome: Record<string, any>;
 *   steps: any[]; hasIncompleteSteps: boolean; isAgentic: boolean;
 * }} input
 */
function resolveDisplayState(input) {
  const {
    actionStatus,
    executionStatus,
    reviewStatus,
    executionPhase,
    executionJob,
    outcome,
    steps,
    hasIncompleteSteps,
    isAgentic,
  } = input;

  // 1. Merchant explicitly interrupted this action (mid-flight or pre-execution).
  if (actionStatus === "stopped") return ACTION_DISPLAY_STATE.stopped;

  // 2. Agentic runtime raised a genuine blocking question mid-execution.
  if (executionPhase === "needs_merchant_input") return ACTION_DISPLAY_STATE.needsYou;

  // 3. Verification found a specific, answerable discrepancy.
  if (outcome.verificationMismatch === true) return ACTION_DISPLAY_STATE.needsYou;

  // 4. Legacy runtime: a step is explicitly waiting on a merchant decision.
  if (steps.some((step) => normalizeToken(step?.status) === "needs_merchant")) {
    return ACTION_DISPLAY_STATE.needsYou;
  }

  // 5. Agentic verification retries exhausted — writes happened, nothing left to
  //    auto-retry, but there's no answerable question, only a fact to report.
  if (executionJob.verificationExhausted === true || outcome.verificationExhausted === true) {
    return ACTION_DISPLAY_STATE.couldntComplete;
  }

  // 6. Legacy runtime: Jefe attempted the change, hit an error mid-run, and
  //    cleanly auto-reverted its own partial writes. Distinct from a merchant
  //    declining a proposal — an attempt genuinely happened and didn't stick.
  if (executionStatus === "reverted") return ACTION_DISPLAY_STATE.couldntComplete;

  // 7. Plain execution failure (legacy, zero writes applied) or agentic mutation
  //    failure with nothing to revert.
  if (executionStatus === "failed") return ACTION_DISPLAY_STATE.couldntComplete;
  if (executionPhase === "failed") return ACTION_DISPLAY_STATE.couldntComplete;

  // 7b. Legacy runtime: a step is blocked or flagged needs_attention without a
  //     specific merchant question attached (no chip-answerable ask — same
  //     "system gave up, no question to offer" shape as verification-exhausted).
  if (steps.some((step) => ["blocked", "needs_attention"].includes(normalizeToken(step?.status)))) {
    return ACTION_DISPLAY_STATE.couldntComplete;
  }

  // 7c. Agentic runtime: any other non-recoverable mutation-loop stop (BLOCKED,
  //     PROVIDER_ERROR, NEEDS_ACTION_REPLAN) lands on the generic "needs_attention"
  //     phase today — same "no specific question to offer" shape as 7/7b.
  if (isAgentic && executionPhase === "needs_attention") {
    return ACTION_DISPLAY_STATE.couldntComplete;
  }

  // 8. Execution + verification complete.
  if (
    !hasIncompleteSteps &&
    (actionStatus === "completed" ||
      executionPhase === "completed" ||
      (["applied", "partially_applied"].includes(executionStatus) && !isAgentic))
  ) {
    return ACTION_DISPLAY_STATE.done;
  }

  // 9. Actively executing/verifying.
  if (["executing", "verifying", "verification_incomplete"].includes(executionPhase)) {
    return ACTION_DISPLAY_STATE.working;
  }
  if (
    steps.some((step) => ["running", "in_progress"].includes(normalizeToken(step?.status))) ||
    actionStatus === "in_progress" ||
    ["applied", "partially_applied", "approved"].includes(executionStatus)
  ) {
    return ACTION_DISPLAY_STATE.working;
  }

  // 10. Accepted, not yet started.
  if (actionStatus === "accepted" || reviewStatus === "accepted") {
    return ACTION_DISPLAY_STATE.ready;
  }

  // 11. Merchant said no / not-now before Jefe ever touched Shopify — shown
  //     quietly under Recent, not in the active ordering (founder decision).
  if (["rejected", "declined"].includes(actionStatus) || ["rejected", "declined"].includes(executionStatus)) {
    return ACTION_DISPLAY_STATE.stopped;
  }
  if (actionStatus === "deferred" || reviewStatus === "deferred") {
    return ACTION_DISPLAY_STATE.stopped;
  }
  if (reviewStatus === "rejected") return ACTION_DISPLAY_STATE.stopped;

  // 12. Fallthrough.
  return ACTION_DISPLAY_STATE.proposed;
}

/**
 * @param {{ displayState: string; latestBlockingQuestion: { text: string; options?: string[] } | null; isAgentic: boolean; planStepTitles: string[] }} input
 * @returns {ComposerChip[]}
 */
export function composerChipsFor(input) {
  const { displayState, latestBlockingQuestion, isAgentic, planStepTitles } = input;
  /** @type {ComposerChip[]} */
  const chips = [];
  switch (displayState) {
    case ACTION_DISPLAY_STATE.proposed:
    case ACTION_DISPLAY_STATE.ready: {
      chips.push({
        id: "run_changes",
        label: "Run changes",
        kind: "command",
        intent: "action.accept_plan",
        prefillText: null,
      });
      chips.push({
        id: "change_plan",
        label: "Change something in the plan",
        kind: "prefill",
        intent: null,
        prefillText: "Change something in the plan",
      });
      if (planStepTitles[0]) {
        chips.push({
          id: "leave_out",
          label: `Leave ${planStepTitles[0]} out`,
          kind: "prefill",
          intent: null,
          prefillText: `Leave ${planStepTitles[0]} out`,
        });
      }
      break;
    }
    case ACTION_DISPLAY_STATE.working: {
      chips.push({ id: "whats_left", label: "What's left?", kind: "prefill", intent: null, prefillText: "What's left?" });
      chips.push({
        id: "stop_after_page",
        label: "Stop after this page",
        kind: "command",
        intent: "action.stop_action",
        prefillText: null,
      });
      chips.push({
        id: "stop_now",
        label: "Stop now",
        kind: "command",
        intent: "action.stop_action",
        prefillText: null,
      });
      break;
    }
    case ACTION_DISPLAY_STATE.needsYou: {
      if (isAgentic && Array.isArray(latestBlockingQuestion?.options) && latestBlockingQuestion.options.length) {
        for (const option of latestBlockingQuestion.options) {
          chips.push({
            id: `answer_${slugify(option)}`,
            label: option,
            kind: "answer",
            intent: null,
            prefillText: option,
          });
        }
        chips.push({ id: "why", label: "Why do you need this?", kind: "prefill", intent: null, prefillText: "Why do you need this?" });
      } else {
        chips.push({ id: "answer_jefe", label: "Answer Jefe →", kind: "prefill", intent: null, prefillText: "" });
      }
      break;
    }
    case ACTION_DISPLAY_STATE.done: {
      break;
    }
    case ACTION_DISPLAY_STATE.stopped:
    case ACTION_DISPLAY_STATE.couldntComplete: {
      chips.push({ id: "try_again", label: "Try again", kind: "prefill", intent: null, prefillText: "Try this again" });
      chips.push({ id: "talk_to_jefe", label: "Talk to Jefe about it", kind: "prefill", intent: null, prefillText: "" });
      break;
    }
    default:
      break;
  }
  return chips;
}

/** @param {string} displayState */
function ctaLabelFor(displayState) {
  switch (displayState) {
    case ACTION_DISPLAY_STATE.needsYou:
      return "Answer Jefe →";
    case ACTION_DISPLAY_STATE.ready:
    case ACTION_DISPLAY_STATE.proposed:
      // Home has no separate "Proposed" shelf (per the supplied mockups) —
      // proposed and ready share the same "come look and run it" position,
      // one tier below Needs you. The pill still shows the true per-action
      // displayState; only the CTA/position are shared.
      return "Review & run →";
    case ACTION_DISPLAY_STATE.working:
      return "See progress →";
    case ACTION_DISPLAY_STATE.done:
      return "See what changed →";
    case ACTION_DISPLAY_STATE.stopped:
    case ACTION_DISPLAY_STATE.couldntComplete:
      return "See what changed →";
    default:
      return null;
  }
}

/**
 * @param {{ displayState: string; action: any; execution: any; outcome: Record<string, any>; steps: any[]; latestBlockingQuestion: { text: string } | null }} input
 */
function subtitleFor(input) {
  const { displayState, execution, outcome, latestBlockingQuestion } = input;
  const summary = jsonObject(execution?.proposalSummary);
  const itemCount = Number.isFinite(Number(summary.itemCount ?? summary.count))
    ? Number(summary.itemCount ?? summary.count)
    : null;
  switch (displayState) {
    case ACTION_DISPLAY_STATE.ready:
      return itemCount
        ? `Jefe has prepared changes to ${itemCount} product page${itemCount === 1 ? "" : "s"}.`
        : "Jefe has prepared changes and is ready to run them.";
    case ACTION_DISPLAY_STATE.working:
      return itemCount
        ? `Jefe is updating ${itemCount} product page${itemCount === 1 ? "" : "s"}. Nothing is needed from you.`
        : "Jefe is making the changes. Nothing is needed from you.";
    case ACTION_DISPLAY_STATE.needsYou:
      return safeText(latestBlockingQuestion?.text, 200) || "Jefe needs your input before it can continue.";
    case ACTION_DISPLAY_STATE.done:
      return itemCount
        ? `${itemCount} product page${itemCount === 1 ? "" : "s"} updated and checked.`
        : "The changes are complete and checked.";
    case ACTION_DISPLAY_STATE.stopped:
      return outcome.stoppedAt ? "Stopped partway through, at your request." : "You said no to this.";
    case ACTION_DISPLAY_STATE.couldntComplete:
      return "Jefe couldn't complete this. Take a look when you get a chance.";
    default:
      return "Jefe has a suggestion ready to review.";
  }
}

/** @param {{ execution: any; executionJob: Record<string, any>; steps: any[] }} input */
function startedAtFor(input) {
  const { execution, executionJob, steps } = input;
  const stepStart = steps
    .map((step) => step?.startedAt)
    .filter(Boolean)
    .sort()[0];
  return executionJob.startedAt ?? stepStart ?? execution?.approvedAt ?? null;
}

/** @param {{ displayState: string; execution: any; recommendation: any; steps: any[] }} input */
function completedAtFor(input) {
  const { displayState, execution, recommendation, steps } = input;
  if (displayState !== ACTION_DISPLAY_STATE.done) return null;
  const stepCompletion = steps
    .map((step) => step?.completedAt)
    .filter(Boolean)
    .sort()
    .pop();
  return execution?.appliedAt ?? recommendation?.completedAt ?? stepCompletion ?? null;
}

/** @param {any[] | undefined} rawEvents */
export function normalizeLifecycleEvents(rawEvents) {
  if (!Array.isArray(rawEvents)) return [];
  return rawEvents
    .map((row) => ({
      id: row?.id ?? null,
      type: row?.eventType ?? null,
      label:
        LIFECYCLE_EVENT_LABELS[/** @type {keyof typeof LIFECYCLE_EVENT_LABELS} */ (row?.eventType)] ??
        String(row?.eventType ?? "").replace(/_/g, " ").toUpperCase(),
      occurredAt: row?.createdAt?.toISOString?.() ?? row?.createdAt ?? null,
      detail: safeText(jsonObject(row?.metadata).detail, 240) || null,
    }))
    .filter((event) => event.type && event.occurredAt)
    .sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)));
}

/**
 * @param {Record<string, any>} outcome
 * @param {LifecycleEvent[]} events
 */
function blockingQuestionFrom(outcome, events) {
  const text = safeText(outcome.merchantMessage, 400);
  const options = Array.isArray(outcome.answerOptions)
    ? outcome.answerOptions.map((option) => safeText(option, 80)).filter(Boolean)
    : [];
  if (text) return { text, options };
  const latestQuestionEvent = [...events].reverse().find((event) => event.type === "action_needs_merchant_input");
  if (latestQuestionEvent?.detail) return { text: latestQuestionEvent.detail, options: [] };
  return null;
}

/** @param {any} action */
export function isAgenticShopifyAction(action) {
  const progress = jsonObject(action?.progress);
  const plan = jsonObject(action?.plan);
  const progressAgentic = jsonObject(progress.agentic);
  const planAgentic = jsonObject(plan.agentic);
  return (
    progressAgentic.runtime === "shopify_admin_api" ||
    planAgentic.runtime === "shopify_admin_api" ||
    Boolean(progressAgentic.semanticAction) ||
    Boolean(planAgentic.semanticAction)
  );
}

/**
 * Batched read of chat-visible lifecycle events for a set of MerchantAction
 * ids. Grouped in-memory rather than queried per-action to avoid N+1s on the
 * Home shelf (which already loads up to 40 actions per render).
 * @param {any} prisma
 * @param {{ merchantActionIds: string[]; take?: number }} input
 * @returns {Promise<Record<string, any[]>>}
 */
export async function listActionLifecycleEvents(prisma, input) {
  const ids = Array.isArray(input.merchantActionIds) ? input.merchantActionIds.filter(Boolean) : [];
  if (!ids.length || !prisma?.merchantActionEvent?.findMany) return {};
  const rows = await prisma.merchantActionEvent.findMany({
    where: { merchantActionId: { in: ids } },
    orderBy: [{ createdAt: "asc" }],
  });
  /** @type {Record<string, any[]>} */
  const grouped = {};
  const take = input.take ?? 10;
  for (const row of rows) {
    const key = row.merchantActionId;
    if (!grouped[key]) grouped[key] = [];
    if (grouped[key].length >= take) continue;
    grouped[key].push(row);
  }
  return grouped;
}

/**
 * Record one merchant-facing lifecycle event (chat-visible, via
 * MerchantActionEvent). Best-effort: a failed write must never fail the
 * action/execution flow that triggered it.
 * @param {any} prisma
 * @param {{ actionId?: string; merchantActionId?: string; merchantId: string; shopId: string; conversationId?: string|null; messageId?: string|null }} input
 * @param {string} eventType one of the keys documented at the top of this module
 * @param {{ detail?: string|null; options?: string[]|null }} [metadata]
 */
export async function recordActionEvent(prisma, input, eventType, metadata = {}) {
  const merchantActionId = input.merchantActionId ?? input.actionId ?? null;
  if (!merchantActionId || !prisma?.merchantActionEvent?.create) return;
  try {
    await prisma.merchantActionEvent.create({
      data: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        merchantActionId,
        conversationId: input.conversationId ?? null,
        messageId: input.messageId ?? null,
        eventType,
        metadata: {
          ...(metadata.detail ? { detail: metadata.detail } : {}),
          ...(metadata.options ? { options: metadata.options } : {}),
        },
      },
    });
  } catch {
    // Best-effort — a lifecycle-event write must never fail the action flow.
  }
}

/** @param {string} value */
function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "option";
}

/** @param {unknown} value */
function normalizeToken(value) {
  return String(value ?? "").trim().toLowerCase();
}

/** @param {unknown} value @returns {Record<string, any>} */
function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/** @param {unknown} value @param {number} [max] */
function safeText(value, max = 500) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * @typedef {"proposed"|"ready"|"working"|"needs_you"|"done"|"stopped"|"couldnt_complete"} ActionDisplayStateValue
 * @typedef {{ id: string|null; type: string|null; label: string; occurredAt: string|null; detail: string|null }} LifecycleEvent
 * @typedef {{ id: string; label: string; status: "done"|"current"|"upcoming"; occurredAt?: string|null }} RealWorldProgressStage
 * @typedef {{ id: string; label: string; kind: "command"|"prefill"|"answer"; intent: string|null; prefillText: string|null }} ComposerChip
 * @typedef {{
 *   displayState: ActionDisplayStateValue;
 *   title: string;
 *   subtitle: string;
 *   requiresMerchantInput: boolean;
 *   canExecute: boolean;
 *   canStop: boolean;
 *   startedAt: string|null;
 *   completedAt: string|null;
 *   lifecycleEvents: LifecycleEvent[];
 *   realWorldProgress: RealWorldProgressStage[];
 *   chips: ComposerChip[];
 *   ctaLabel: string|null;
 *   ctaIntent: string|null;
 * }} ActionDisplayContract
 */
