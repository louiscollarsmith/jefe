// @ts-check

/**
 * Server-side focused-action replanning.
 *
 * The conversation model decides that the merchant changed how the action
 * should be carried out. This module decides the complete revised workflow,
 * validates it against available capabilities, and reconciles it with existing
 * workflow rows. The merchant never has to provide implementation metadata
 * such as titles, modes, dependency IDs, or capability references.
 */

import { randomUUID } from "node:crypto";
import { Type } from "@google/genai";
import {
  logger as baseLogger,
  serializeError,
} from "../observability/logger.server.js";
import {
  listStepCapabilities,
  resolveWorkflowStepCapability,
} from "../merchant-plan/step-capabilities.server.js";
import { getMerchantAction } from "./merchant-action.server.js";
import { resolveActionState } from "./action-state.server.js";

const log = baseLogger.child({ component: "action-replanner" });

export const ACTION_REPLANNER_VERSION = "1";
const ACTION_REPLANNER_TIMEOUT_MS = 15_000;

const REPLAN_SCHEMA = {
  type: Type.OBJECT,
  required: ["plan"],
  properties: {
    plan: {
      type: Type.OBJECT,
      required: ["goal", "steps"],
      properties: {
        goal: { type: Type.STRING },
        steps: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              semanticKey: { type: Type.STRING },
              title: { type: Type.STRING },
              description: { type: Type.STRING, nullable: true },
              order: { type: Type.NUMBER, nullable: true },
              mode: { type: Type.STRING, nullable: true },
              capabilityRef: { type: Type.STRING, nullable: true },
              dependsOn: {
                type: Type.ARRAY,
                nullable: true,
                items: { type: Type.STRING },
              },
            },
          },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = [
  "You are Jefe's bounded action replanner.",
  "Return schema-constrained JSON only.",
  "",
  "Your job:",
  "- Given the current action, current canonical plan, current workflow, and a merchant instruction, produce the complete revised workflow plan.",
  "- The merchant instruction is semantic context. Generate every step title, mode, capabilityRef, semanticKey and dependency yourself.",
  "- Preserve existing merchant decisions in currentPlanValues. Do not reset coverDays, markdownPercent, scope, or quantities to defaults.",
  "- Preserve semantically equivalent existing steps unless the merchant changes or removes them.",
  "- Add, remove, or replace steps when the instruction changes how the work should be carried out.",
  "- Only use capabilityRef values that appear in availableCapabilities. If no executable/assist capability fits, leave capabilityRef null and use mode merchant_action.",
  "- Purchase orders are not Shopify transfers. If no purchase-order execution capability is listed, model purchase orders as merchant_action or a listed merchant_action capability.",
  "- Missing execution inputs do not block planning. Add the step if we know WHAT should happen; runtime can ask for exact inputs later.",
  "",
  "Ordering rules:",
  "- Return plan.steps in the exact user-visible workflow order.",
  "- Display order and dependency graph are separate. Do not move a step earlier just because its dependencies are satisfied.",
  "- If the merchant says final, last, at the end, or before we're finished, the affected step must be the last item in plan.steps.",
  "- If the merchant says first, before, after, move, or step N, resolve it against currentWorkflow.position and return the complete reordered plan.",
  "",
  "Correction and removal rules:",
  "- Use recentConversation to resolve references such as that, this, last one, I meant, actually, undo that, scrap it, remove step 4.",
  "- A correction like 'I meant purchase orders sorry' normally replaces the recently discussed transfer workflow with a purchase-order workflow.",
  "- A removal like 'remove step 4' removes the step currently displayed at position 4, unless the merchant's wording clearly points elsewhere.",
  "- Undoing runtime input is not the same as removing a workflow step; keep unchanged workflow semantics when the merchant only withdraws an execution parameter.",
  "",
  "Dependency rules:",
  "- dependsOn contains semanticKey values, never database IDs.",
  "- Keep dependencies minimal and meaningful.",
  "- A final execution step usually depends on the proposal or the final preceding workflow step.",
].join("\n");

/**
 * @param {any} prisma
 * @param {{
 *   merchantId: string;
 *   shopId: string;
 *   actionId: string;
 *   merchantInstruction: string;
 *   actor?: string | null;
 *   conversationId?: string | null;
 *   recentMessages?: Array<{ role?: string; content?: string }>;
 *   provider?: { enabled?: boolean; generateStructuredJson?: Function; model?: string; provider?: string } | null;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 * }} input
 */
export async function replanAction(prisma, input) {
  const logger = input.logger ?? log;
  const [action, state] = await Promise.all([
    getMerchantAction(prisma, input),
    resolveActionState(prisma, input),
  ]);
  if (!action || !state) {
    return {
      ok: false,
      reason: "action_not_found",
      reply: "I couldn't find that action. Open it again from home.",
    };
  }

  const provider = input.provider;
  if (
    !provider?.enabled ||
    typeof provider.generateStructuredJson !== "function"
  ) {
    return {
      ok: false,
      reason: "planner_unavailable",
      reply:
        "I couldn't safely revise the workflow right now. Try again in a moment and I'll rebuild the plan from the current action.",
    };
  }
  const planner =
    /** @type {{ enabled?: boolean; generateStructuredJson: Function; model?: string; provider?: string }} */ (
      provider
    );

  const before = workflowSnapshot(action);
  /** @type {any} */
  let generation;
  const startedAt = Date.now();
  try {
    generation = await generatePlanWithRepair(planner, {
      merchantInstruction: input.merchantInstruction,
      state,
      before,
      recentMessages: input.recentMessages ?? [],
      logger,
      actionId: input.actionId,
    });
  } catch (error) {
    logger.warn("action replanner inference failed", {
      actionId: input.actionId,
      provider: planner.provider ?? null,
      model: planner.model ?? null,
      error: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : String(error),
    });
    const fallback = fallbackPlanFromInstruction(before, input.merchantInstruction);
    if (fallback) {
      generation = {
        generated: null,
        normalized: { ok: true, plan: fallback },
        request: buildReplanRequest({
          merchantInstruction: input.merchantInstruction,
          state,
          before,
          recentMessages: input.recentMessages ?? [],
        }),
        rawPlan: {
          source: "server_fallback",
          reason: "planner_call_failed",
          plan: fallback,
        },
        repairAttempted: false,
        serverFallback: true,
      };
    } else {
      logger.warn("action replanner model call failed", {
        actionId: input.actionId,
        provider: planner.provider ?? null,
        model: planner.model ?? null,
        error: error instanceof Error ? error.name : "UnknownError",
      });
      return {
        ok: false,
        reason: "planner_failed",
        reply:
          "I couldn't safely revise the workflow right now. Nothing has changed, so try that instruction again in a moment.",
      };
    }
  }

  if (!generation.normalized.ok) {
    const fallback = fallbackPlanFromInstruction(before, input.merchantInstruction);
    if (fallback) {
      generation = {
        ...generation,
        normalized: { ok: true, plan: fallback },
        rawPlan: {
          source: "server_fallback",
          reason: generation.normalized.reason,
          plan: fallback,
        },
        serverFallback: true,
      };
    }
  }

  if (!generation.normalized.ok) {
    logger.warn("action replanner produced invalid plan", {
      actionId: input.actionId,
      provider: generation.generated?.provider ?? planner.provider ?? null,
      model: generation.generated?.model ?? planner.model ?? null,
      reason: generation.normalized.reason,
      repairAttempted: generation.repairAttempted,
    });
    return {
      ok: false,
      reason: "invalid_replan",
      reply:
        "I couldn't safely revise the workflow from that instruction. Nothing has changed.",
      result: {
        validation: generation.normalized,
        repairAttempted: generation.repairAttempted,
      },
    };
  }
  const normalized = generation.normalized;
  const generated = generation.generated;
  const explicitPlan = applyExplicitInstructionOverrides(
    normalized.plan,
    before,
    input.merchantInstruction,
  );
  const stablePlan = preserveExistingStepIdentity(explicitPlan, before);
  const planForApply = preserveOmittedSteps(
    stablePlan,
    before,
    input.merchantInstruction,
  );

  let applied;
  try {
    applied = await applyReplannedWorkflow(prisma, {
      ...input,
      action,
      plan: planForApply,
    });
  } catch (error) {
    logger.error("action replanner failed to apply workflow", {
      actionId: input.actionId,
      error: serializeError(error),
    });
    return {
      ok: false,
      reason: "apply_failed",
      reply:
        "I couldn't safely revise the workflow right now. Nothing has changed, so try that instruction again in a moment.",
    };
  }
  const fresh = await getMerchantAction(prisma, input);
  await persistWorkspaceSnapshot(prisma, input, fresh);
  const after = workflowSnapshot(fresh);
  const changes = diffWorkflow(before.steps, after.steps);

  logger.info("action replanned", {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.actionId,
    provider: generated?.provider ?? planner.provider ?? null,
    model: generated?.model ?? planner.model ?? null,
    durationMs: generated?.durationMs ?? Date.now() - startedAt,
    added: changes.filter((row) => row.field === "plan_step_added").length,
    removed: changes.filter((row) => row.field === "plan_step_removed").length,
    changed: changes.filter((row) => row.field === "plan_step_changed").length,
  });

  return {
    ok: true,
    reason: null,
    reply: changes.length
      ? `Rebuilt the workflow from the current plan. ${describeWorkflowChanges(changes)}.`
      : "The workflow already matches that instruction.",
    result: {
      planner: {
        provider: generated?.provider ?? planner.provider ?? null,
        model: generated?.model ?? planner.model ?? null,
        fallback: generated?.fallback ?? null,
        durationMs: generated?.durationMs ?? Date.now() - startedAt,
      },
      validation: { ok: true, repairAttempted: generation.repairAttempted },
      serverFallback: generation.serverFallback === true,
      replanRequest: generation.request,
      rawStructuredPlan: generation.rawPlan,
      plan: planForApply,
      applied,
      before,
      after,
    },
    changes,
  };
}

/** @param {any} prisma @param {any} input @param {any} action */
async function persistWorkspaceSnapshot(prisma, input, action) {
  const workspace = action?.workspace ?? null;
  if (!workspace || !prisma?.merchantAction?.update) return;
  const progress =
    action.progress && typeof action.progress === "object" && !Array.isArray(action.progress)
      ? action.progress
      : {};
  await prisma.merchantAction.update({
    where: { id: input.actionId },
    data: { progress: { ...progress, workspace } },
  });
}

/** @returns {Array<Record<string, any>>} */
function availableCapabilityView() {
  return listStepCapabilities().map((capability) => ({
    ref: capability.ref,
    mode: capability.mode,
    label: capability.label,
    description: capability.description,
    actionType: /** @type {any} */ (capability).actionType ?? null,
    targetKind: /** @type {any} */ (capability).targetKind ?? null,
  }));
}

/** @param {any} state */
function currentProposalView(state) {
  const scope = Array.isArray(state?.scope?.items) ? state.scope.items : [];
  return scope.map((/** @type {any} */ item) => ({
    title: item.title ?? item.productTitle ?? null,
    recommendedUnits: item.recommendedUnits ?? null,
  }));
}

/**
 * @param {{ generateStructuredJson: Function; provider?: string | null; model?: string | null }} provider
 * @param {{
 *   merchantInstruction: string;
 *   state: any;
 *   before: { steps: any[] };
 *   recentMessages: Array<{ role?: string; content?: string }>;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 *   actionId?: string | null;
 * }} input
 */
async function generatePlanWithRepair(provider, input) {
  const request = buildReplanRequest(input);
  input.logger?.info?.("action replanner inference starting", {
    actionId: input.actionId ?? null,
    provider: provider.provider ?? null,
    model: provider.model ?? null,
    phase: "initial",
    timeoutMs: ACTION_REPLANNER_TIMEOUT_MS,
    currentStepCount: input.before.steps.length,
  });
  const generated = await provider.generateStructuredJson({
    systemPrompt: SYSTEM_PROMPT,
    prompt: JSON.stringify(request),
    schema: REPLAN_SCHEMA,
    maxOutputTokens: 1600,
    timeoutMs: ACTION_REPLANNER_TIMEOUT_MS,
  });
  let normalized = normalizeGeneratedPlan(generated?.json?.plan);
  input.logger?.info?.("action replanner inference finished", {
    actionId: input.actionId ?? null,
    provider: generated?.provider ?? provider.provider ?? null,
    model: generated?.model ?? provider.model ?? null,
    phase: "initial",
    durationMs: generated?.durationMs ?? null,
    normalized: normalized.ok ? "ok" : normalized.reason,
  });
  if (normalized.ok) {
    return {
      generated,
      normalized,
      request,
      rawPlan: generated?.json?.plan ?? null,
      repairAttempted: false,
    };
  }

  const repairRequest = {
    ...request,
    task: "action_replan_repair",
    validationError: normalized,
    invalidPlan: generated?.json?.plan ?? null,
    instruction:
      "Return a complete repaired plan. Fix the validation error without changing unrelated current plan decisions or unrelated workflow semantics.",
  };
  input.logger?.info?.("action replanner inference starting", {
    actionId: input.actionId ?? null,
    provider: provider.provider ?? null,
    model: provider.model ?? null,
    phase: "repair",
    timeoutMs: ACTION_REPLANNER_TIMEOUT_MS,
    validationError: normalized.reason,
  });
  const repaired = await provider.generateStructuredJson({
    systemPrompt: SYSTEM_PROMPT,
    prompt: JSON.stringify(repairRequest),
    schema: REPLAN_SCHEMA,
    maxOutputTokens: 1600,
    timeoutMs: ACTION_REPLANNER_TIMEOUT_MS,
  });
  normalized = normalizeGeneratedPlan(repaired?.json?.plan);
  input.logger?.info?.("action replanner inference finished", {
    actionId: input.actionId ?? null,
    provider: repaired?.provider ?? provider.provider ?? null,
    model: repaired?.model ?? provider.model ?? null,
    phase: "repair",
    durationMs: repaired?.durationMs ?? null,
    normalized: normalized.ok ? "ok" : normalized.reason,
  });
  return {
    generated: repaired,
    normalized,
    request,
    rawPlan: repaired?.json?.plan ?? null,
    repairAttempted: true,
    invalidPlan: generated?.json?.plan ?? null,
  };
}

/**
 * @param {{
 *   merchantInstruction: string;
 *   state: any;
 *   before: { steps: any[] };
 *   recentMessages: Array<{ role?: string; content?: string }>;
 * }} input
 */
function buildReplanRequest(input) {
  return {
    task: "action_replan",
    version: ACTION_REPLANNER_VERSION,
    merchantInstruction: input.merchantInstruction,
    recentConversation: recentConversationView(input.recentMessages),
    action: input.state.action,
    currentPlanValues: input.state.plan?.values ?? {},
    currentWorkflow: input.before.steps.map((step, index) => ({
      ...step,
      position: index + 1,
    })),
    currentArtifacts: input.state.artifacts ?? [],
    currentProposal: currentProposalView(input.state),
    availableCapabilities: availableCapabilityView(),
  };
}

/** @param {Array<{ role?: string; content?: string }>} messages */
function recentConversationView(messages) {
  return (Array.isArray(messages) ? messages : []).slice(-10).map((message) => ({
    role: safeText(message?.role, 24) || "unknown",
    content: safeText(message?.content, 500),
  }));
}

/**
 * @param {any} rawPlan
 * @returns {{ ok: true; plan: { goal: string; steps: any[] } } | { ok: false; reason: string; [key: string]: any }}
 */
function normalizeGeneratedPlan(rawPlan) {
  const rawSteps = Array.isArray(rawPlan?.steps) ? rawPlan.steps : [];
  if (!rawSteps.length) return { ok: false, reason: "missing_steps" };

  /** @type {any[]} */
  const steps = [];
  const seen = new Set();
  const capabilities = new Set(availableCapabilityView().map((row) => row.ref));
  for (const raw of rawSteps.slice(0, 12)) {
    const title = safeText(raw?.title, 120);
    if (!title) return { ok: false, reason: "missing_step_title" };
    const capabilityRef = safeText(raw?.capabilityRef, 140) || null;
    if (capabilityRef && !capabilities.has(capabilityRef)) {
      return {
        ok: false,
        reason: "invalid_capability_ref",
        capabilityRef,
      };
    }
    const capability = resolveWorkflowStepCapability(
      capabilityRef,
      safeText(raw?.mode, 40) || null,
    );
    const semantic = canonicalSemanticKey({
      semanticKey: raw?.semanticKey,
      title,
      capabilityRef: capability.capabilityRef,
    });
    if (!semantic) return { ok: false, reason: "missing_semantic_key" };
    if (seen.has(semantic)) {
      return { ok: false, reason: "duplicate_semantic_key", semanticKey: semantic };
    }
    seen.add(semantic);
    const normalizedStep = normalizeCapabilityBackedStep({
      semanticKey: semantic,
      title,
      description: safeText(raw?.description, 260) || title,
      mode: capability.mode,
      capabilityRef: capability.capabilityRef,
      dependsOn: Array.isArray(raw?.dependsOn)
        ? raw.dependsOn.map((/** @type {any} */ item) => semanticKey(item)).filter(Boolean)
        : [],
    });
    steps.push(normalizedStep);
  }
  if (!steps.length) return { ok: false, reason: "no_valid_steps" };
  const semanticKeys = new Set(steps.map((step) => step.semanticKey));
  for (const step of steps) {
    const missing = step.dependsOn.filter((/** @type {string} */ key) => !semanticKeys.has(key));
    if (missing.length) {
      return {
        ok: false,
        reason: "broken_dependency",
        semanticKey: step.semanticKey,
        dependsOn: missing,
      };
    }
  }
  return {
    ok: true,
    plan: {
      goal: safeText(rawPlan?.goal, 220) || "Carry out this action.",
      steps,
    },
  };
}

/** @param {any} step */
function normalizeCapabilityBackedStep(step) {
  if (step.capabilityRef === "execute:shopify_inventory_transfer:restock") {
    return {
      ...step,
      title: transferStep().title,
      description: transferStep().description,
    };
  }
  if (step.capabilityRef === "merchant_action:external_purchase_order") {
    return {
      ...step,
      title: purchaseOrderStep().title,
      description: purchaseOrderStep().description,
    };
  }
  if (
    step.capabilityRef === "assist:merchant_checklist" &&
    step.semanticKey === "check_supplier_lead_time"
  ) {
    return {
      ...step,
      title: supplierLeadTimeStep().title,
      description: supplierLeadTimeStep().description,
    };
  }
  return step;
}

/**
 * The model proposes the desired semantic plan, but it can occasionally omit
 * an unrelated surviving step while handling a correction. Preserve omitted
 * existing steps unless the instruction points at that step for removal or
 * replacement.
 *
 * @param {{ goal: string; steps: any[] }} plan
 * @param {{ steps: any[] }} before
 * @param {string} merchantInstruction
 */
function preserveOmittedSteps(plan, before, merchantInstruction) {
  const desiredKeys = new Set(plan.steps.map((step) => step.semanticKey));
  const omitted = before.steps.filter((step) => !desiredKeys.has(step.semanticKey));
  const preserved = omitted.filter((step) =>
    shouldPreserveOmittedStep(step, before.steps, plan.steps, merchantInstruction),
  );
  if (!preserved.length) return plan;

  const idToSemantic = new Map(before.steps.map((step) => [step.id, step.semanticKey]));
  const steps = [...plan.steps];
  for (const step of preserved) {
    const restored = {
      semanticKey: step.semanticKey,
      title: step.title,
      description: step.description || step.title,
      mode: step.mode,
      capabilityRef: step.capabilityRef,
      dependsOn: Array.isArray(step.dependsOn)
        ? step.dependsOn.map((/** @type {string} */ id) => idToSemantic.get(id)).filter(Boolean)
        : [],
    };
    const insertAt = insertionIndexForPreservedStep(step, before.steps, steps);
    steps.splice(insertAt, 0, restored);
  }

  return { ...plan, steps };
}

/**
 * If a generated plan keeps an existing semantic step, keep the row's stable
 * execution identity unless the semantic key itself changed. This lets the LLM
 * choose the desired structure and display text without letting it accidentally
 * rewrite canonical assist steps into merchant actions.
 *
 * @param {{ goal: string; steps: any[] }} plan
 * @param {{ steps: any[] }} before
 */
function preserveExistingStepIdentity(plan, before) {
  const existingByKey = new Map(before.steps.map((step) => [step.semanticKey, step]));
  return {
    ...plan,
    steps: plan.steps.map((step) => {
      const existing = existingByKey.get(step.semanticKey);
      if (!existing) return step;
      const keepExistingText = step.semanticKey === "build_replenishment_proposal";
      return {
        ...step,
        title: keepExistingText ? existing.title || step.title : step.title || existing.title,
        description: keepExistingText
          ? existing.description || step.description || existing.title || step.title
          : step.description || existing.description || step.title || existing.title,
        mode: existing.mode || step.mode,
        capabilityRef: existing.capabilityRef || step.capabilityRef,
      };
    }),
  };
}

/**
 * Keep common high-signal merchant corrections deterministic after the model has
 * produced a complete plan. The model still handles open-ended structure, but
 * explicit replacements/removals should not depend on a particular phrasing.
 *
 * @param {{ goal: string; steps: any[] }} plan
 * @param {{ steps: any[] }} before
 * @param {string} merchantInstruction
 */
function applyExplicitInstructionOverrides(plan, before, merchantInstruction) {
  const instruction = normalizeTitle(merchantInstruction);
  if (!instruction) return plan;

  let steps = plan.steps.map((step) => ({ ...step }));
  const wantsPurchaseOrder = /\b(purchase order|purchase orders|po|pos)\b/.test(
    instruction,
  );
  const rejectsSupplierEmail = rejectsSupplierCommunication(instruction);
  const wantsTransfer = /\b(shopify transfer|stock transfer|inventory transfer|transfer)\b/.test(
    instruction,
  );
  const wantsSupplierCall =
    /\b(call|phone|telephone)\b/.test(instruction) &&
    /\bsupplier\b/.test(instruction);
  const wantsLeadTime =
    /\blead\s*time\b/.test(instruction) &&
    /\b(supplier|before|order|ordering)\b/.test(instruction);
  const removeIntent =
    /\b(remove|delete|scrap|forget|drop|dont need|do not need|not useful|unnecessary)\b/.test(
      instruction,
    );

  if (removeIntent) {
    const removeIndex = removalIndexFromInstruction(instruction, before.steps);
    const removeKey =
      removeIndex != null ? before.steps[removeIndex]?.semanticKey : null;
    if (removeKey) {
      steps = steps.filter((step) => step.semanticKey !== removeKey);
    } else if (/\bsupplier\b/.test(instruction)) {
      steps = steps.filter(
        (step) => !String(step.semanticKey ?? "").includes("supplier"),
      );
    }
  }

  if (wantsSupplierCall) {
    const existingIndex = firstSemanticIndex(steps, "draft_supplier_communication");
    steps = steps.filter(
      (step) => step.semanticKey !== "draft_supplier_communication",
    );
    steps = insertOrReplaceStep(
      steps,
      callSupplierStep(),
      existingIndex >= 0 ? existingIndex : supplierInsertionIndex(steps),
    );
  }

  if (wantsLeadTime) {
    steps = insertOrReplaceStep(
      steps,
      supplierLeadTimeStep(),
      leadTimeInsertionIndex(steps),
    );
  }

  if (wantsPurchaseOrder && !removeIntent) {
    steps = steps.filter((step) => step.semanticKey !== "create_shopify_transfer");
    if (rejectsSupplierEmail) {
      steps = steps.filter(
        (step) => step.semanticKey !== "draft_supplier_communication",
      );
    }
    steps = upsertFinalStep(steps, purchaseOrderStep());
  }

  if (wantsTransfer && !wantsPurchaseOrder && !removeIntent) {
    steps = steps.filter((step) => step.semanticKey !== "create_purchase_order");
    steps = upsertFinalStep(steps, transferStep());
  }

  return { ...plan, steps: rebuildLinearDependencies(steps) };
}

/** @param {any[]} steps @param {string} semanticKey */
function firstSemanticIndex(steps, semanticKey) {
  return steps.findIndex((step) => step.semanticKey === semanticKey);
}

/** @param {any[]} steps @param {any} step @param {number} index */
function insertOrReplaceStep(steps, step, index) {
  const withoutExisting = steps.filter(
    (row) => row.semanticKey !== step.semanticKey,
  );
  const insertion = Math.max(0, Math.min(index, withoutExisting.length));
  withoutExisting.splice(insertion, 0, step);
  return withoutExisting;
}

/** @param {any[]} steps */
function supplierInsertionIndex(steps) {
  const proposalIndex = firstSemanticIndex(steps, "build_replenishment_proposal");
  if (proposalIndex >= 0) return proposalIndex + 1;
  return steps.length;
}

/** @param {any[]} steps */
function leadTimeInsertionIndex(steps) {
  const orderIndex = steps.findIndex((step) =>
    /supplier|purchase_order|shopify_transfer/.test(String(step.semanticKey ?? "")),
  );
  if (orderIndex >= 0) return orderIndex;
  const proposalIndex = firstSemanticIndex(steps, "build_replenishment_proposal");
  if (proposalIndex >= 0) return proposalIndex + 1;
  return steps.length;
}

/** @param {any[]} steps */
function rebuildLinearDependencies(steps) {
  const keys = new Set(steps.map((step) => step.semanticKey));
  return steps.map((step, index) => {
    const dependencies = Array.isArray(step.dependsOn)
      ? step.dependsOn.filter((/** @type {string} */ key) => keys.has(key) && key !== step.semanticKey)
      : [];
    if (index > 0 && dependencies.length === 0) {
      dependencies.push(steps[index - 1].semanticKey);
    }
    return { ...step, dependsOn: dependencies };
  });
}

/**
 * @param {any} step
 * @param {any[]} existing
 * @param {any[]} desired
 * @param {string} merchantInstruction
 */
function shouldPreserveOmittedStep(step, existing, desired, merchantInstruction) {
  const instruction = normalizeTitle(merchantInstruction);
  const title = normalizeTitle(step.title);
  const semantic = String(step.semanticKey ?? "");
  const lastStep = existing.at(-1);
  const desiredKeys = new Set(desired.map((row) => row.semanticKey));

  if (
    semantic === "create_shopify_transfer" &&
    desiredKeys.has("create_purchase_order") &&
    /\b(purchase order|purchase orders|po|pos)\b/.test(instruction)
  ) {
    return false;
  }
  if (
    semantic === "draft_supplier_communication" &&
    desiredKeys.has("create_purchase_order") &&
    /\b(purchase order|purchase orders|po|pos)\b/.test(instruction) &&
    rejectsSupplierCommunication(instruction)
  ) {
    return false;
  }

  const removeIntent =
    /\b(remove|delete|scrap|forget|drop|dont need|do not need|not useful|wrong)\b/.test(
      instruction,
    );
  if (!removeIntent) return true;

  const stepNumber = instruction.match(/\bstep\s+(\d+)\b/);
  if (stepNumber && Number(stepNumber[1]) === Number(step.position)) {
    return false;
  }
  if (/\b(final|last|end)\b/.test(instruction) && step.id === lastStep?.id) {
    return false;
  }
  if (title && instruction.includes(title)) return false;
  if (semantic.includes("transfer") && /\btransfer\b/.test(instruction)) return false;
  if (semantic.includes("purchase_order") && /\b(purchase order|po)\b/.test(instruction)) {
    return false;
  }
  if (semantic.includes("supplier") && /\bsupplier\b/.test(instruction)) return false;
  return true;
}

/**
 * @param {any} step
 * @param {any[]} existing
 * @param {any[]} desired
 */
function insertionIndexForPreservedStep(step, existing, desired) {
  const existingIndex = existing.findIndex((row) => row.id === step.id);
  for (let index = existingIndex - 1; index >= 0; index -= 1) {
    const key = existing[index]?.semanticKey;
    const desiredIndex = desired.findIndex((row) => row.semanticKey === key);
    if (desiredIndex >= 0) return desiredIndex + 1;
  }
  for (let index = existingIndex + 1; index < existing.length; index += 1) {
    const key = existing[index]?.semanticKey;
    const desiredIndex = desired.findIndex((row) => row.semanticKey === key);
    if (desiredIndex >= 0) return desiredIndex;
  }
  return Math.min(existingIndex, desired.length);
}

/**
 * Last-resort deterministic plan builder for cases where the structured model
 * call fails before application validation can repair it. It only handles
 * explicit capability/position concepts already present in the workflow model.
 *
 * @param {{ steps: any[] }} before
 * @param {string} merchantInstruction
 * @returns {{ goal: string; steps: any[] } | null}
 */
function fallbackPlanFromInstruction(before, merchantInstruction) {
  const instruction = normalizeTitle(merchantInstruction);
  if (!instruction) return null;
  let steps = before.steps.map((step) => desiredStepFromExisting(step, before.steps));

  const wantsPurchaseOrder = /\b(purchase order|purchase orders|po|pos)\b/.test(
    instruction,
  );
  const rejectsSupplierEmail = rejectsSupplierCommunication(instruction);
  const wantsTransfer = /\b(shopify transfer|stock transfer|inventory transfer|transfer)\b/.test(
    instruction,
  );
  const wantsSupplierCall =
    /\b(call|phone|telephone)\b/.test(instruction) &&
    /\bsupplier\b/.test(instruction);
  const wantsLeadTime =
    /\blead\s*time\b/.test(instruction) &&
    /\b(supplier|before|order|ordering)\b/.test(instruction);
  const removeIntent =
    /\b(remove|delete|scrap|forget|drop|dont need|do not need|not useful|wrong)\b/.test(
      instruction,
    );

  if (removeIntent) {
    const removeIndex = removalIndexFromInstruction(instruction, before.steps);
    if (removeIndex != null && removeIndex >= 0 && removeIndex < steps.length) {
      steps = steps.filter((_, index) => index !== removeIndex);
      return { goal: "Carry out the current workflow.", steps };
    }
  }

  if (wantsSupplierCall) {
    const existingIndex = firstSemanticIndex(steps, "draft_supplier_communication");
    steps = steps.filter(
      (step) => step.semanticKey !== "draft_supplier_communication",
    );
    steps = insertOrReplaceStep(
      steps,
      callSupplierStep(),
      existingIndex >= 0 ? existingIndex : supplierInsertionIndex(steps),
    );
    return {
      goal: "Prepare the replenishment and call the supplier.",
      steps: rebuildLinearDependencies(steps),
    };
  }

  if (wantsLeadTime) {
    steps = insertOrReplaceStep(
      steps,
      supplierLeadTimeStep(),
      leadTimeInsertionIndex(steps),
    );
    return {
      goal: "Prepare the replenishment after checking supplier lead time.",
      steps: rebuildLinearDependencies(steps),
    };
  }

  if (wantsPurchaseOrder) {
    steps = steps.filter((step) => step.semanticKey !== "create_shopify_transfer");
    if (rejectsSupplierEmail) {
      steps = steps.filter(
        (step) => step.semanticKey !== "draft_supplier_communication",
      );
    }
    steps = upsertFinalStep(steps, purchaseOrderStep());
    return {
      goal: "Prepare the replenishment and raise a purchase order.",
      steps,
    };
  }

  if (wantsTransfer) {
    steps = steps.filter((step) => step.semanticKey !== "create_purchase_order");
    steps = upsertFinalStep(steps, transferStep());
    return {
      goal: "Prepare the replenishment and create the Shopify stock transfer.",
      steps,
    };
  }

  return null;
}

/** @param {string} instruction */
function rejectsSupplierCommunication(instruction) {
  return (
    /\b(dont|don t|do not|skip|rather than|instead of|not|no|without)\b.{0,60}\b(email|supplier communication|supplier email|email supplier)\b/.test(
      instruction,
    ) ||
    /\b(email|supplier communication|supplier email|email supplier)\b.{0,60}\b(dont|don t|do not|skip|rather than|instead of|not|no|without)\b/.test(
      instruction,
    ) ||
    /\b(replace|swap|change)\b.{0,40}\b(supplier email|supplier communication|email step|email)\b.{0,80}\b(purchase order|po|pos)\b/.test(
      instruction,
    ) ||
    /\b(purchase order|po|pos)\b.{0,80}\b(replace|instead of|rather than)\b.{0,40}\b(supplier email|supplier communication|email step|email)\b/.test(
      instruction,
    )
  );
}

/**
 * @param {any} step
 * @param {any[]} allSteps
 */
function desiredStepFromExisting(step, allSteps) {
  const idToSemantic = new Map(allSteps.map((row) => [row.id, row.semanticKey]));
  return {
    semanticKey: step.semanticKey,
    title: step.title,
    description: step.description || step.title,
    mode: step.mode,
    capabilityRef: step.capabilityRef,
    dependsOn: Array.isArray(step.dependsOn)
      ? step.dependsOn.map((/** @type {string} */ id) => idToSemantic.get(id)).filter(Boolean)
      : [],
  };
}

/** @param {any[]} steps @param {any} step */
function upsertFinalStep(steps, step) {
  return [
    ...steps.filter((row) => row.semanticKey !== step.semanticKey),
    {
      ...step,
      dependsOn: steps.some((row) => row.semanticKey === "draft_supplier_communication")
        ? ["draft_supplier_communication"]
        : steps.some((row) => row.semanticKey === "build_replenishment_proposal")
          ? ["build_replenishment_proposal"]
          : [],
    },
  ];
}

function purchaseOrderStep() {
  return {
    semanticKey: "create_purchase_order",
    title: "Create purchase order",
    description: "Raise the purchase order outside Jefe for the replenishment.",
    mode: "merchant_action",
    capabilityRef: "merchant_action:external_purchase_order",
    dependsOn: [],
  };
}

function callSupplierStep() {
  return {
    semanticKey: "call_supplier",
    title: "Call supplier",
    description:
      "Prepare the questions and call the supplier about the replenishment.",
    mode: "assist",
    capabilityRef: "assist:supplier_phone_script",
    dependsOn: [],
  };
}

function supplierLeadTimeStep() {
  return {
    semanticKey: "check_supplier_lead_time",
    title: "Check supplier lead time",
    description:
      "Confirm supplier lead time before placing or preparing the replenishment order.",
    mode: "assist",
    capabilityRef: "assist:merchant_checklist",
    dependsOn: [],
  };
}

function transferStep() {
  return {
    semanticKey: "create_shopify_transfer",
    title: "Create Shopify inventory transfer",
    description:
      "Create the Shopify inventory transfer for the approved replenishment quantities.",
    mode: "execute",
    capabilityRef: "execute:shopify_inventory_transfer:restock",
    dependsOn: [],
  };
}

/** @param {string} instruction @param {any[]} steps */
function removalIndexFromInstruction(instruction, steps) {
  const numbered = instruction.match(/\bstep\s+(\d+)\b/);
  if (numbered) return Number(numbered[1]) - 1;
  if (/\b(final|last|end)\b/.test(instruction)) return steps.length - 1;
  const explicit = steps.findIndex((step) => {
    const title = normalizeTitle(step.title);
    const semantic = String(step.semanticKey ?? "");
    return (
      (title && instruction.includes(title)) ||
      (semantic.includes("transfer") && /\btransfer\b/.test(instruction)) ||
      (semantic.includes("purchase_order") &&
        /\b(purchase order|po)\b/.test(instruction)) ||
      (semantic.includes("supplier") && /\bsupplier\b/.test(instruction))
    );
  });
  return explicit >= 0 ? explicit : null;
}

/**
 * @param {any} prisma
 * @param {any} input
 */
async function applyReplannedWorkflow(prisma, input) {
  return prisma.$transaction(async (/** @type {any} */ tx) =>
    applyReplannedWorkflowTx(tx, input),
  );
}

/**
 * @param {any} prisma
 * @param {any} input
 */
async function applyReplannedWorkflowTx(prisma, input) {
  const existing = activeWorkflowSteps(input.action);
  const workflowId =
    input.action?.workflow?.id ?? existing[0]?.workflowId ?? null;
  const recommendationId =
    input.action?.sourceRecommendationId ??
    existing[0]?.recommendationId ??
    null;
  if (!workflowId || !recommendationId) {
    throw new Error("Cannot replan an action without a workflow.");
  }

  const existingByKey = new Map();
  for (const step of existing) existingByKey.set(stepSemanticKey(step), step);

  const assignments = input.plan.steps.map((/** @type {any} */ step, /** @type {number} */ index) => {
    const matched =
      existingByKey.get(step.semanticKey) ??
      existing.find(
        (row) => row.capabilityRef && row.capabilityRef === step.capabilityRef,
      ) ??
      existing.find(
        (row) => normalizeTitle(row.title) === normalizeTitle(step.title),
      ) ??
      null;
    return {
      ...step,
      index,
      id: matched?.id ?? randomUUID(),
      existing: matched,
    };
  });

  const idBySemantic = new Map(
    assignments.map((/** @type {any} */ row) => [row.semanticKey, row.id]),
  );
  const assignmentIds = new Set(assignments.map((/** @type {any} */ row) => row.id));

  const workflowRows = await prisma.merchantRecommendationStep.findMany({
    where: {
      workflowId,
      merchantId: input.merchantId,
      shopId: input.shopId,
    },
  });
  const maxOrderIndex = workflowRows.reduce(
    (/** @type {number} */ max, /** @type {any} */ row) => Math.max(max, Number(row?.orderIndex ?? 0)),
    0,
  );
  const temporaryOffset = maxOrderIndex + workflowRows.length + 1000;

  for (const [index, row] of workflowRows.entries()) {
    await prisma.merchantRecommendationStep.updateMany({
      where: { id: row.id, merchantId: input.merchantId, shopId: input.shopId },
      data: { orderIndex: temporaryOffset + index },
    });
  }

  for (const row of assignments) {
    const dependsOnStepIds = row.dependsOn
      .map((/** @type {string} */ key) => idBySemantic.get(key))
      .filter((/** @type {string | undefined} */ id) => id && id !== row.id);
    const data = {
      workflowId,
      recommendationId,
      merchantId: input.merchantId,
      shopId: input.shopId,
      orderIndex: row.index,
      title: row.title,
      description: row.description,
      status:
        row.existing?.status && row.existing.status !== "superseded"
          ? row.existing.status
          : "waiting",
      mode: row.mode,
      capabilityRef: row.capabilityRef,
      dependsOnStepIds,
      evidenceIds: Array.isArray(row.existing?.evidenceIds)
        ? row.existing.evidenceIds
        : [],
      progress: row.existing?.progress ?? {},
      attention: row.existing?.attention ?? {},
    };
    if (row.existing) {
      await prisma.merchantRecommendationStep.updateMany({
        where: {
          id: row.id,
          merchantId: input.merchantId,
          shopId: input.shopId,
        },
        data,
      });
    } else {
      await prisma.merchantRecommendationStep.create({
        data: { id: row.id, ...data },
      });
    }
  }

  for (const old of existing.filter((step) => !assignmentIds.has(step.id))) {
    await prisma.merchantRecommendationStep.updateMany({
      where: { id: old.id, merchantId: input.merchantId, shopId: input.shopId },
      data: {
        status: "superseded",
        statusReason: "Replaced by action replanning.",
      },
    });
  }

  await prisma.merchantRecommendationWorkflow?.updateMany?.({
    where: {
      id: workflowId,
      merchantId: input.merchantId,
      shopId: input.shopId,
    },
    data: { source: "action_replan" },
  });

  return {
    preserved: assignments.filter((/** @type {any} */ row) => row.existing).map((/** @type {any} */ row) => row.id),
    created: assignments.filter((/** @type {any} */ row) => !row.existing).map((/** @type {any} */ row) => row.id),
    superseded: existing
      .filter((step) => !assignmentIds.has(step.id))
      .map((step) => step.id),
  };
}

/** @param {any} action */
function workflowSnapshot(action) {
  const steps = activeWorkflowSteps(action).map((step, index) => ({
    id: step.id ?? null,
    semanticKey: stepSemanticKey(step),
    position: index + 1,
    title: step.title ?? null,
    description: step.description ?? null,
    mode: step.mode ?? null,
    capabilityRef: step.capabilityRef ?? null,
    status: step.status ?? null,
    orderIndex: Number(step.orderIndex ?? 0),
    dependsOn: Array.isArray(step.dependsOnStepIds)
      ? step.dependsOnStepIds.map((/** @type {string} */ id) => String(id))
      : [],
  }));
  return { steps };
}

/** @param {any} action */
function activeWorkflowSteps(action) {
  return [
    ...(Array.isArray(action?.workflow?.steps) ? action.workflow.steps : []),
    ...(Array.isArray(action?.displaySteps) ? action.displaySteps : []),
  ]
    .filter((step, index, all) => {
      if (!step?.id) return false;
      if (String(step.status ?? "") === "superseded") return false;
      return all.findIndex((candidate) => candidate?.id === step.id) === index;
    })
    .sort((a, b) => Number(a.orderIndex ?? 0) - Number(b.orderIndex ?? 0));
}

/** @param {any[]} before @param {any[]} after */
function diffWorkflow(before, after) {
  const beforeById = new Map(before.map((row) => [row.id, row]));
  const afterById = new Map(after.map((row) => [row.id, row]));
  /** @type {Array<Record<string, any>>} */
  const changes = [];
  for (const row of after) {
    const old = beforeById.get(row.id);
    if (!old) {
      changes.push({ field: "plan_step_added", added: row.title });
    } else if (
      old.title !== row.title ||
      old.capabilityRef !== row.capabilityRef ||
      old.mode !== row.mode ||
      old.orderIndex !== row.orderIndex ||
      JSON.stringify(old.dependsOn) !== JSON.stringify(row.dependsOn)
    ) {
      changes.push({
        field: "plan_step_changed",
        from: old.title,
        to: row.title,
        fromPosition: old.position,
        toPosition: row.position,
      });
    }
  }
  for (const row of before) {
    if (!afterById.has(row.id))
      changes.push({ field: "plan_step_removed", removed: row.title });
  }
  return changes;
}

/** @param {Array<Record<string, any>>} changes */
function describeWorkflowChanges(changes) {
  return changes
    .map((change) => {
      if (change.field === "plan_step_added") return `added "${change.added}"`;
      if (change.field === "plan_step_removed")
        return `removed "${change.removed}"`;
      if (change.field === "plan_step_changed") return `updated "${change.to}"`;
      return null;
    })
    .filter(Boolean)
    .join(", ");
}

/** @param {any} step */
function stepSemanticKey(step) {
  return canonicalSemanticKey({
    semanticKey: step?.semanticKey,
    title: step?.title,
    capabilityRef: step?.capabilityRef,
  });
}

/** @param {{ semanticKey?: unknown; title?: unknown; capabilityRef?: unknown }} step */
function canonicalSemanticKey(step) {
  const capability = String(step?.capabilityRef ?? "");
  const title = normalizeTitle(step?.title);
  if (capability === "assist:inventory_review")
    return "review_low_cover_inventory";
  if (capability === "assist:replenishment_proposal")
    return "build_replenishment_proposal";
  if (capability === "assist:supplier_email_draft")
    return "draft_supplier_communication";
  if (capability === "assist:supplier_phone_script") return "call_supplier";
  if (capability === "assist:merchant_checklist" && /\blead time\b/.test(title))
    return "check_supplier_lead_time";
  if (capability === "assist:merchant_checklist") return "prepare_checklist";
  if (capability === "merchant_action:external_purchase_order")
    return "create_purchase_order";
  if (capability === "execute:shopify_inventory_transfer:restock")
    return "create_shopify_transfer";
  return semanticKey(step?.semanticKey || step?.title);
}

/** @param {unknown} value */
function semanticKey(value) {
  return safeText(value, 100)
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** @param {unknown} value */
function normalizeTitle(value) {
  return safeText(value, 120)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** @param {unknown} value @param {number} max */
function safeText(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
