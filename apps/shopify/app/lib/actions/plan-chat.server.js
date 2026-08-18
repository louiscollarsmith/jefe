// @ts-check

import {
  isActionStepStartCommand,
  isPrimarilyQuestion,
} from "./action-step-lifecycle.server.js";

export const PLAN_CHAT_INTENT = Object.freeze({
  accept: "accept",
  start: "start",
  status: "status",
  scope: "scope",
  recap: "recap",
  stop: "stop",
  complete: "complete",
  skip: "skip",
  decline: "decline",
  retry: "retry",
  question: "question",
});

/** Intents that must not go through the generic recap fallback.
 * @type {Set<string>}
 */
export const PLAN_CHAT_COMMANDS = new Set([
  PLAN_CHAT_INTENT.accept,
  PLAN_CHAT_INTENT.start,
  PLAN_CHAT_INTENT.status,
  PLAN_CHAT_INTENT.scope,
  PLAN_CHAT_INTENT.recap,
  PLAN_CHAT_INTENT.stop,
  PLAN_CHAT_INTENT.complete,
  PLAN_CHAT_INTENT.skip,
  PLAN_CHAT_INTENT.decline,
  PLAN_CHAT_INTENT.retry,
]);

/**
 * Classify a merchant message against the focused plan. Deterministic on purpose:
 * the LLM path was restating the plan for every turn, including "start" and
 * "what are the unassigned products?". Commands are routed to the lifecycle
 * service; only leftover questions hit the model.
 *
 * @param {string} message
 * @returns {string}
 */
export function classifyPlanChatIntent(message) {
  const text = String(message ?? "").trim();
  if (!text) return PLAN_CHAT_INTENT.question;

  if (isRecapAsk(text)) return PLAN_CHAT_INTENT.recap;
  if (isScopeAsk(text)) return PLAN_CHAT_INTENT.scope;
  if (isStatusAsk(text)) return PLAN_CHAT_INTENT.status;

  if (!isPrimarilyQuestion(text)) {
    if (isStopCommand(text)) return PLAN_CHAT_INTENT.stop;
    if (isDeclineCommand(text)) return PLAN_CHAT_INTENT.decline;
    if (isSkipCommand(text)) return PLAN_CHAT_INTENT.skip;
    if (isCompleteCommand(text)) return PLAN_CHAT_INTENT.complete;
    if (isAcceptCommand(text)) return PLAN_CHAT_INTENT.accept;
    if (isRetryCommand(text)) return PLAN_CHAT_INTENT.retry;
    if (isActionStepStartCommand(text) || isContinueCommand(text)) {
      return PLAN_CHAT_INTENT.start;
    }
  }

  return PLAN_CHAT_INTENT.question;
}

/** @param {any} action */
export function buildPlanRecapReply(action) {
  if (!action?.title) {
    return "I don't have a plan open in this chat. Pick a move from home and we can talk it through.";
  }
  const parts = [`We’re working on “${action.title}”.`];
  if (action.summary) parts.push(String(action.summary).trim());
  const steps = planSteps(action);
  if (steps.length > 0) {
    const stepSummary = steps
      .slice(0, 6)
      .map((/** @type {any} */ step, /** @type {number} */ index) => {
        const status = step.status ? ` (${step.status.replaceAll("_", " ")})` : "";
        return `${index + 1}. ${step.title}${status}`;
      })
      .join(" ");
    parts.push(`The plan: ${stepSummary}.`);
  }
  const current = currentPlanStep(action);
  if (current?.title) {
    parts.push(`Right now: ${current.title} is ${String(current.status ?? "waiting").replaceAll("_", " ")}.`);
  }
  return parts.join(" ");
}

/** @param {any} action */
export function buildPlanStatusReply(action) {
  if (!action?.title) {
    return "There’s no plan in this chat to update you on.";
  }
  if (action.status === "proposed") {
    return `“${action.title}” is still a proposal. Accept the plan, or tell me to start and I’ll accept it and begin the first step.`;
  }
  if (action.status === "completed") {
    return `“${action.title}” is done. ${action.successText || action.currentSignal || "I finished the steps on this plan."}`;
  }
  if (action.status === "declined") {
    return `“${action.title}” was declined. Nothing further will run on this plan.`;
  }
  const current = currentPlanStep(action);
  if (!current?.title) {
    return `“${action.title}” is ${String(action.status ?? "in progress").replaceAll("_", " ")}. Tell me if you want to start, stop, or skip a step.`;
  }
  const status = String(current.status ?? "waiting").replaceAll("_", " ");
  if (current.status === "running") {
    return `I’m working on “${current.title}” now. Say stop if you want me to pause, or ask for an update in a moment.`;
  }
  if (current.status === "ready") {
    return `“${current.title}” is ready. Tell me to start and I’ll do it, or ask what I’ll change first.`;
  }
  if (current.status === "needs_merchant") {
    return `“${current.title}” needs you. Tell me when it’s done, or skip it if you want to move on.`;
  }
  if (current.status === "needs_attention") {
    return `“${current.title}” needs attention before I can continue. Ask what went wrong, or tell me to try again.`;
  }
  return `On “${action.title}”, the current step is “${current.title}” (${status}).`;
}

/** @param {any} action */
export function buildPlanScopeReply(action) {
  const items = extractPlanScopeItems(action);
  if (items.length === 0) {
    return "I don’t have the product list for this plan in front of me yet. If this is a catalogue or stock move, start the step and I’ll work from the live proposal — or open it from Review proposals.";
  }
  const lines = items.slice(0, 8).map((item) => {
    if (item.change) return `• ${item.title} — ${item.change}`;
    return `• ${item.title}`;
  });
  const extra = items.length > 8 ? `\n• +${items.length - 8} more` : "";
  const verb = action.actionType === "listing_copy"
    ? "I’ll set a product type on"
    : action.actionType === "tidy_up"
      ? "I’ll archive"
      : action.actionType === "price_markdown"
        ? "I’ll markdown"
        : "I’ll work on";
  return `${verb} ${items.length} item${items.length === 1 ? "" : "s"}:\n${lines.join("\n")}${extra}`;
}

/** @param {any} action @param {{ ok?: boolean; reason?: string; currentStep?: any; completed?: boolean }} result */
export function buildPlanAcceptReply(action, result) {
  if (!result?.ok) {
    if (String(result?.reason ?? "").startsWith("not_acceptable:")) {
      return "This plan isn’t waiting for acceptance — say start if you want me to run the next step.";
    }
    return "I couldn’t accept that plan just now. Try Accept on the card above.";
  }
  const next = result.currentStep?.title ?? currentPlanStep(action)?.title;
  return next
    ? `Plan accepted. “${next}” is ready — tell me to start and I’ll do it.`
    : "Plan accepted. Tell me to start when you want me to begin.";
}

/** @param {any} action @param {{ ok?: boolean; reason?: string }} result */
export function buildPlanStopReply(action, result) {
  if (!result?.ok) {
    if (result?.reason === "nothing_running") {
      return "Nothing is running on this plan right now. The current step is waiting — say start when you want me to go, or decline if you want to drop the plan.";
    }
    return "I couldn’t pause that step just now. Try Pause on the card above.";
  }
  const step = currentPlanStep(action);
  const title = step?.title ?? "that step";
  return `Paused “${title}”. Nothing further will run until you tell me to start again.`;
}

/** @param {any} action @param {{ ok?: boolean; reason?: string; completed?: boolean; currentStep?: any }} result */
export function buildPlanCompleteReply(action, result) {
  if (!result?.ok) {
    if (result?.reason === "jefe_step_still_running") {
      return "I’m still working on that step. Say stop if you want me to pause, or wait and I’ll report back.";
    }
    if (result?.reason === "not_merchant_completable") {
      return "That step is mine to run. Tell me to start it, or skip it if you want to move on.";
    }
    return "I couldn’t mark that step complete. If it’s a step you own, tell me you’ve done it; if it’s mine, tell me to start.";
  }
  if (result.completed) {
    return `That’s the last step — “${action?.title ?? "this plan"}” is complete.`;
  }
  const next = result.currentStep?.title;
  return next
    ? `Marked that step done. Next up: “${next}”.`
    : "Marked that step done.";
}

/** @param {any} action @param {{ ok?: boolean; reason?: string; completed?: boolean; currentStep?: any }} result */
export function buildPlanSkipReply(action, result) {
  if (!result?.ok) {
    return "I couldn’t skip that step just now.";
  }
  if (result.completed) {
    return `Skipped the last step — “${action?.title ?? "this plan"}” is complete.`;
  }
  const next = result.currentStep?.title;
  return next
    ? `Skipped that step. Next up: “${next}”.`
    : "Skipped that step.";
}

/** @param {{ status?: string; ok?: boolean }} result */
export function buildPlanDeclineReply(result) {
  if (result?.status === "rejected" || result?.ok) {
    return "Okay — I won’t do this plan. Nothing was written to the store.";
  }
  if (result?.status === "not_proposable") {
    return "This plan already left the proposal stage, so I can’t decline it as a draft. Say stop to pause what’s running.";
  }
  return "I couldn’t decline that plan just now.";
}

/** @param {any} action */
export function extractPlanScopeItems(action) {
  const seen = new Set();
  /** @type {Array<{ title: string; change?: string | null }>} */
  const items = [];
  const push = (/** @type {string} */ title, /** @type {string | null | undefined} */ change) => {
    const label = String(title ?? "").trim();
    if (!label) return;
    const key = label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ title: label, change: change ?? null });
  };

  const preview = action?.progress?.preview ?? action?.preview ?? {};
  const changes = Array.isArray(preview.changes) ? preview.changes : [];
  for (const change of changes) {
    const title = change?.title ?? change?.productTitle ?? change?.variantId ?? "";
    const toType = change?.toType ?? change?.proposedType ?? null;
    const toPrice = change?.toPrice ?? null;
    const discount = change?.discountPercent ?? null;
    let delta = null;
    if (toType) delta = `set type to ${toType}`;
    else if (discount) delta = `${discount}% off`;
    else if (toPrice) delta = `to ${toPrice}`;
    push(title, delta);
  }

  const listed = Array.isArray(action?.previewItems) ? action.previewItems : [];
  for (const item of listed) {
    const title = item?.title ?? item?.productTitle ?? "";
    const change =
      item?.change ??
      (item?.toType ? `set type to ${item.toType}` : null) ??
      (item?.proposedType ? `set type to ${item.proposedType}` : null);
    push(title, change);
  }

  return items;
}

/** @param {any} action */
export function planSteps(action) {
  const raw =
    (Array.isArray(action?.workflow?.steps) && action.workflow.steps) ||
    (Array.isArray(action?.proposedSteps) && action.proposedSteps) ||
    (Array.isArray(action?.displaySteps) && action.displaySteps) ||
    [];
  return raw
    .map((/** @type {any} */ step) => {
      if (typeof step === "string") return { title: step, status: null };
      return {
        title: step?.title ?? step?.label ?? "",
        status: step?.status ?? null,
        id: step?.id ?? null,
        mode: step?.mode ?? null,
      };
    })
    .filter((/** @type {any} */ step) => step.title);
}

/** @param {any} action */
export function currentPlanStep(action) {
  if (action?.currentStep && typeof action.currentStep === "object") {
    return {
      title: action.currentStep.title ?? action.currentStep.label ?? "",
      status: action.currentStep.status ?? null,
      mode: action.currentStep.mode ?? null,
      id: action.currentStep.id ?? null,
    };
  }
  const steps = planSteps(action);
  return (
    steps.find((/** @type {any} */ step) =>
      ["ready", "running", "needs_merchant", "needs_attention"].includes(
        String(step.status ?? ""),
      ),
    ) ?? null
  );
}

/** @param {string} text */
function isRecapAsk(text) {
  return /\b(tell me more about (this|the) plan|what(?:'s| is) (this|the) plan|explain (this|the) plan|walk me through (this|the) plan|show me the plan)\b/i.test(
    text,
  ) || /^(what is this|what's this)\??$/i.test(text);
}

/** @param {string} text */
function isScopeAsk(text) {
  return (
    /\b(unassigned|untyped|without a (product )?type)\b/i.test(text) ||
    /\bwhat will you change\b/i.test(text) ||
    /\bwhich products\b/i.test(text) ||
    /\bwhat are (the )?(unassigned|untyped) products\b/i.test(text) ||
    /\bwhat (are you|will you) (do|change|update|categor|touch)\b/i.test(text)
  );
}

/** @param {string} text */
function isStatusAsk(text) {
  return (
    /\b(how'?s it going|any update|what'?s the status|where are we|is it working|update me)\b/i.test(
      text,
    ) || /^(status|update|progress)\??$/i.test(text)
  );
}

/** @param {string} text */
function isStopCommand(text) {
  return (
    /^(stop|pause|hold|wait|cancel)(?:\s+(this|that|it|the step|the plan))?\.?$/i.test(
      text,
    ) ||
    /\b(stop|pause|hold on|cancel) (this|that|it|the step|the plan)\b/i.test(text)
  );
}

/** @param {string} text */
function isDeclineCommand(text) {
  return (
    /\b(decline|reject) (this|the plan|it)\b/i.test(text) ||
    /^(no thanks|don'?t do this|drop this|forget this plan)\.?$/i.test(text)
  );
}

/** @param {string} text */
function isSkipCommand(text) {
  return /\bskip (this|that|the) step\b/i.test(text) || /^skip(?: this)?\.?$/i.test(text);
}

/** @param {string} text */
function isCompleteCommand(text) {
  return (
    /\b(that'?s done|i'?ve done (that|this|it)|mark (this|it|that) (as )?complete|complete (this|the) step|finished (that|this))\b/i.test(
      text,
    ) || /^(done|complete|finished)\.?$/i.test(text)
  );
}

/** @param {string} text */
function isAcceptCommand(text) {
  return (
    /\baccept (the |this )?plan\b/i.test(text) ||
    /^(looks good|approve the plan|accept)\.?$/i.test(text)
  );
}

/** @param {string} text */
function isRetryCommand(text) {
  return /^(try again|retry|fix it)\.?$/i.test(text) || /\btry again\b/i.test(text);
}

/** @param {string} text */
function isContinueCommand(text) {
  return /^(next|continue|keep going|go on)\.?$/i.test(text);
}
