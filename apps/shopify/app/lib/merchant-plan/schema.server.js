// @ts-nocheck

import { Type } from "@google/genai";
import { numericTextIsGrounded } from "../llm/numeric-grounding.server.js";
import { PLAN_CONFIDENCE } from "./constants.server.js";
import {
  hasJefeExecutableWriteStep,
  resolveWorkflowStepCapability,
} from "./step-capabilities.server.js";

export const MERCHANT_PLAN_OUTPUT_SCHEMA = {
  type: Type.OBJECT,
  required: ["candidates", "selectedRecommendation"],
  properties: {
    candidates: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: [
          "id",
          "opportunityId",
          "action",
          "goalAlignment",
          "whyRelevant",
          "supportingBeliefIds",
          "supportingInsightIds",
          "expectedEffort",
          "timeToUsefulSignal",
        ],
        properties: {
          id: { type: Type.STRING },
          opportunityId: { type: Type.STRING },
          action: { type: Type.STRING },
          goalAlignment: { type: Type.STRING },
          whyRelevant: { type: Type.STRING },
          supportingBeliefIds: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          supportingInsightIds: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          expectedEffort: { type: Type.STRING },
          timeToUsefulSignal: { type: Type.STRING },
          assumption: { type: Type.STRING, nullable: true },
          respectedConstraints: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            nullable: true,
          },
        },
      },
    },
    selectedRecommendation: {
      type: Type.OBJECT,
      required: [
        "candidateId",
        "opportunityId",
        "title",
        "summary",
        "primaryGoalId",
        "supportingGoalIds",
        "whyThisAction",
        "whyNow",
        "startToday",
        "workflow",
        "successSignal",
        "expectedBenefit",
        "supportingBeliefIds",
        "supportingInsightIds",
        "confidence",
      ],
      properties: {
        candidateId: { type: Type.STRING },
        opportunityId: { type: Type.STRING },
        title: { type: Type.STRING },
        summary: { type: Type.STRING },
        primaryGoalId: { type: Type.STRING },
        supportingGoalIds: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
        whyThisAction: { type: Type.STRING },
        whyNow: { type: Type.STRING },
        startToday: { type: Type.STRING },
        workflow: {
          type: Type.OBJECT,
          required: ["steps"],
          properties: {
            steps: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                required: ["id", "title", "description", "completionCriteria", "mode"],
                properties: {
                  id: { type: Type.STRING },
                  title: { type: Type.STRING },
                  description: { type: Type.STRING },
                  completionCriteria: { type: Type.STRING },
                  mode: {
                    type: Type.STRING,
                    enum: ["execute", "assist", "merchant_action", "evidence_required"],
                  },
                  capabilityRef: { type: Type.STRING, nullable: true },
                  dependsOnStepIds: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    nullable: true,
                  },
                },
              },
            },
          },
        },
        successSignal: {
          type: Type.OBJECT,
          required: ["description", "timeframe"],
          properties: {
            description: { type: Type.STRING },
            timeframe: { type: Type.STRING },
            target: { type: Type.STRING, nullable: true },
          },
        },
        expectedBenefit: { type: Type.STRING },
        supportingBeliefIds: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
        supportingInsightIds: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
        confidence: { type: Type.STRING, enum: PLAN_CONFIDENCE },
        assumption: { type: Type.STRING, nullable: true },
        caveat: { type: Type.STRING, nullable: true },
      },
    },
  },
};

/**
 * @param {unknown} raw
 * @param {{ allowedBeliefIds: Set<string>; allowedInsightIds: Set<string>; allowedGoalIds: Set<string>; allowedOpportunityIds?: Set<string>; suppliedBeliefs?: any[]; suppliedInsights?: any[]; suppliedGoals?: any[]; previousRecommendations?: any[] }} context
 */
export function parseAndValidateMerchantPlanOutput(raw, context) {
  const parsed = typeof raw === "string" ? parseJson(raw) : raw;
  const object = asRecord(parsed);
  if (!object) return invalid("Model output must be a JSON object.");
  if (!Array.isArray(object.candidates)) return invalid("Model output must include candidates.");
  const minimumCandidates = Math.min(
    3,
    Math.max(1, context.allowedOpportunityIds?.size ?? 3),
  );
  if (object.candidates.length < minimumCandidates || object.candidates.length > 5) {
    return invalid(
      `Plan generation must include ${minimumCandidates} to five supplied opportunity candidates.`,
    );
  }

  const candidates = [];
  const candidateIds = new Set();
  const candidateActions = new Set();
  for (const item of object.candidates) {
    const result = normalizeCandidate(item, context);
    if (!result.ok) return result;
    const duplicateKey = normalizeText(result.candidate.action);
    if (candidateIds.has(result.candidate.id)) return invalid("Candidate IDs must be unique.");
    if (candidateActions.has(duplicateKey)) return invalid("Candidates must be materially different.");
    candidateIds.add(result.candidate.id);
    candidateActions.add(duplicateKey);
    candidates.push(result.candidate);
  }

  const recommendation = normalizeRecommendation(object.selectedRecommendation, context);
  if (!recommendation.ok) return recommendation;
  if (!candidateIds.has(recommendation.recommendation.candidateId)) {
    return invalid("Selected recommendation must reference one supplied candidate.");
  }
  const selectedCandidate = candidates.find(
    (candidate) => candidate.id === recommendation.recommendation.candidateId,
  );
  if (
    selectedCandidate &&
    recommendation.recommendation.opportunityId !== selectedCandidate.opportunityId
  ) {
    return invalid("Selected recommendation must use the selected candidate's opportunity.");
  }
  if (looksGeneric(recommendation.recommendation)) {
    return invalid("Recommendation is too generic.");
  }
  if (containsMultipleActions(recommendation.recommendation)) {
    return invalid("Recommendation appears to combine multiple unrelated actions.");
  }
  if (!numericClaimsAreGrounded(recommendation.recommendation, context)) {
    return invalid("Recommendation contains unsupported numerical claims.");
  }
  if (duplicatesPriorRecommendation(recommendation.recommendation, context.previousRecommendations ?? [])) {
    return invalid("Recommendation duplicates a previous accepted, rejected or completed Plan.");
  }

  return {
    ok: true,
    candidates,
    recommendation: recommendation.recommendation,
  };
}

function normalizeCandidate(value, context) {
  const item = asRecord(value);
  if (!item) return invalid("Every candidate must be an object.");
  const candidate = {
    id: cleanText(item.id, 50),
    opportunityId: cleanText(item.opportunityId, 120),
    action: cleanText(item.action, 180),
    goalAlignment: cleanText(item.goalAlignment, 220),
    whyRelevant: cleanText(item.whyRelevant, 260),
    supportingBeliefIds: uniqueStrings(item.supportingBeliefIds),
    supportingInsightIds: uniqueStrings(item.supportingInsightIds),
    expectedEffort: cleanText(item.expectedEffort, 80),
    timeToUsefulSignal: cleanText(item.timeToUsefulSignal, 80),
    assumption: cleanText(item.assumption, 180, true),
    respectedConstraints: uniqueStrings(item.respectedConstraints).slice(0, 5),
  };
  if (!candidate.id || !candidate.opportunityId || !candidate.action || !candidate.goalAlignment || !candidate.whyRelevant) {
    return invalid("Every candidate needs an id, opportunity id, action, goal alignment and relevance.");
  }
  if (
    context.allowedOpportunityIds instanceof Set &&
    !context.allowedOpportunityIds.has(candidate.opportunityId)
  ) {
    return invalid("Candidate referenced an opportunity that was not supplied to the model.");
  }
  if (!candidate.expectedEffort || !candidate.timeToUsefulSignal) {
    return invalid("Every candidate needs effort and time to useful signal.");
  }
  if (candidate.supportingBeliefIds.length === 0) {
    return invalid("Every candidate must cite at least one belief.");
  }
  const ids = [...candidate.supportingBeliefIds, ...candidate.supportingInsightIds];
  const unsupportedBelief = candidate.supportingBeliefIds.find((id) => !context.allowedBeliefIds.has(id));
  if (unsupportedBelief) return invalid("Candidate cited a belief that was not supplied to the model.");
  const unsupportedInsight = candidate.supportingInsightIds.find((id) => !context.allowedInsightIds.has(id));
  if (unsupportedInsight) return invalid("Candidate cited an insight that was not supplied to the model.");
  if (ids.length === 0) return invalid("Candidate must cite support.");
  return { ok: true, candidate };
}

function normalizeRecommendation(value, context) {
  const item = asRecord(value);
  if (!item) return invalid("selectedRecommendation must be an object.");
  const workflowSteps = normalizeWorkflowSteps(item.workflow);
  const successSignal = normalizeSuccessSignal(item.successSignal);
  const recommendation = {
    candidateId: cleanText(item.candidateId, 50),
    opportunityId: cleanText(item.opportunityId, 120),
    title: cleanText(item.title, 90),
    summary: cleanText(item.summary, 320),
    primaryGoalId: cleanText(item.primaryGoalId, 80),
    supportingGoalIds: uniqueStrings(item.supportingGoalIds),
    whyThisAction: cleanText(item.whyThisAction, 420),
    whyNow: cleanText(item.whyNow, 320),
    startToday: cleanText(item.startToday, 320),
    workflow: { steps: workflowSteps },
    successSignal,
    expectedBenefit: cleanText(item.expectedBenefit, 320),
    supportingBeliefIds: uniqueStrings(item.supportingBeliefIds),
    supportingInsightIds: uniqueStrings(item.supportingInsightIds),
    confidence: typeof item.confidence === "string" ? item.confidence : "",
    assumption: cleanText(item.assumption, 220, true),
    caveat: cleanText(item.caveat, 220, true),
  };
  for (const field of [
    "candidateId",
    "opportunityId",
    "title",
    "summary",
    "primaryGoalId",
    "whyThisAction",
    "whyNow",
    "startToday",
    "expectedBenefit",
  ]) {
    if (!recommendation[field]) return invalid(`Recommendation needs ${field}.`);
  }
  if (
    context.allowedOpportunityIds instanceof Set &&
    !context.allowedOpportunityIds.has(recommendation.opportunityId)
  ) {
    return invalid("Recommendation referenced an opportunity that was not supplied to the model.");
  }
  if (!context.allowedGoalIds.has(recommendation.primaryGoalId)) {
    return invalid("Recommendation cited a goal that was not supplied to the model.");
  }
  for (const goalId of recommendation.supportingGoalIds) {
    if (!context.allowedGoalIds.has(goalId)) return invalid("Recommendation cited a supporting goal that was not supplied to the model.");
  }
  if (recommendation.workflow.steps.length === 0) {
    return invalid("Recommendation needs workflow steps.");
  }
  if (!recommendation.successSignal) return invalid("Recommendation needs a success signal.");
  if (recommendation.supportingBeliefIds.length === 0) {
    return invalid("Recommendation must cite at least one belief.");
  }
  if (!hasJefeExecutableWriteStep(recommendation.workflow.steps)) {
    return invalid(
      "Recommendation must include at least one valid Jefe-owned Shopify execute capability.",
    );
  }
  const workflowInvariant = validateWorkflowExecutionInvariants(
    recommendation.workflow.steps,
  );
  if (!workflowInvariant.ok) return invalid(workflowInvariant.reason);
  for (const beliefId of recommendation.supportingBeliefIds) {
    if (!context.allowedBeliefIds.has(beliefId)) {
      return invalid("Recommendation cited a belief that was not supplied to the model.");
    }
  }
  for (const insightId of recommendation.supportingInsightIds) {
    if (!context.allowedInsightIds.has(insightId)) {
      return invalid("Recommendation cited an insight that was not supplied to the model.");
    }
  }
  if (!PLAN_CONFIDENCE.includes(recommendation.confidence)) {
    return invalid("Recommendation used an unsupported confidence label.");
  }
  return { ok: true, recommendation };
}

function validateWorkflowExecutionInvariants(steps) {
  if (hasDependencyCycle(steps)) {
    return { ok: false, reason: "Recommendation workflow cannot contain dependency cycles." };
  }
  const hasInventoryTransfer = steps.some(isInventoryTransferExecuteStep);
  if (!hasInventoryTransfer) return { ok: true };
  const purchaseOrderStep = steps.find(
    (step) => step.capabilityRef === "merchant_action:external_purchase_order",
  );
  if (purchaseOrderStep) {
    return {
      ok: false,
      reason:
        "Merchant approval is not merchant work; inventory-transfer recommendations must not add a merchant purchase-order prerequisite.",
    };
  }
  const approvalAsMerchantWork = steps.find(
    (step) =>
      step.mode === "merchant_action" &&
      /\b(approve|approval|confirm|permission)\b/i.test(
        `${step.title ?? ""} ${step.description ?? ""}`,
      ),
  );
  if (approvalAsMerchantWork) {
    return {
      ok: false,
      reason:
        "Merchant approval must remain attached to the Jefe-owned execute step, not become a merchant_action step.",
    };
  }
  return { ok: true };
}

function isInventoryTransferExecuteStep(step) {
  return (
    step?.mode === "execute" &&
    step?.capabilityRef === "execute:shopify_inventory_transfer:restock"
  );
}

function hasDependencyCycle(steps) {
  const byId = new Map(
    (Array.isArray(steps) ? steps : [])
      .filter((step) => step?.id)
      .map((step) => [String(step.id), step]),
  );
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const step = byId.get(id);
    const deps = Array.isArray(step?.dependsOnStepIds)
      ? step.dependsOnStepIds
      : [];
    for (const dep of deps) {
      const depId = String(dep);
      if (byId.has(depId) && visit(depId)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return [...byId.keys()].some((id) => visit(id));
}

function normalizeWorkflowSteps(workflow) {
  const source = asRecord(workflow);
  const rawSteps = Array.isArray(source?.steps) ? source.steps : [];
  const normalized = [];
  const seenIds = new Set();
  for (const rawStep of rawSteps) {
    const step = normalizeStep(rawStep, normalized.length);
    if (!step) continue;
    if (seenIds.has(step.id)) step.id = `step_${normalized.length + 1}`;
    seenIds.add(step.id);
    normalized.push(step);
    if (normalized.length >= 8) break;
  }
  return normalized;
}

function normalizeStep(value, index = 0) {
  const item = asRecord(value);
  if (!item) return null;
  const title = cleanText(item.title, 90);
  const description = cleanText(item.description, 220);
  const capability = resolveWorkflowStepCapability(
    item.capabilityRef,
    item.mode,
  );
  const id = cleanText(item.id, 50, true);
  const dependsOnStepIds = uniqueStrings(item.dependsOnStepIds).slice(0, 5);
  return title && description
    ? {
        id: id || `step_${index + 1}`,
        title,
        description,
        completionCriteria: cleanText(item.completionCriteria, 220, true),
        mode: capability.mode,
        capabilityRef: capability.capabilityRef,
        dependsOnStepIds,
      }
    : null;
}

function normalizeSuccessSignal(value) {
  const item = asRecord(value);
  if (!item) return null;
  const description = cleanText(item.description, 220);
  const timeframe = cleanText(item.timeframe, 90);
  const target = cleanText(item.target, 120, true);
  return description && timeframe ? { description, timeframe, target } : null;
}

function uniqueStrings(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))]
    : [];
}

function looksGeneric(recommendation) {
  const text = normalizeText(`${recommendation.title} ${recommendation.summary} ${recommendation.startToday}`);
  return [
    "increase revenue",
    "grow revenue",
    "improve retention",
    "increase sales",
    "improve customer experience",
    "optimize marketing",
    "fix inventory",
    "business plan",
  ].some((phrase) => text === phrase || text.startsWith(`${phrase} `));
}

function containsMultipleActions(recommendation) {
  const text = normalizeText(`${recommendation.title} ${recommendation.summary} ${recommendation.startToday}`);
  const broadJoiners = [" and launch ", " and build ", " and renegotiate ", " and redesign ", " and create "];
  return broadJoiners.some((joiner) => text.includes(joiner.trim()));
}

function numericClaimsAreGrounded(recommendation, context) {
  const text = [
    recommendation.title,
    recommendation.summary,
    recommendation.whyThisAction,
    recommendation.whyNow,
    recommendation.expectedBenefit,
    recommendation.startToday,
    ...recommendation.workflow.steps.flatMap((step) => [
      step.title,
      step.description,
      step.completionCriteria,
    ]),
    recommendation.successSignal?.description,
    recommendation.successSignal?.target,
  ]
    .filter(Boolean)
    .join(" ");
  const citedGoals = [
    recommendation.primaryGoalId,
    ...recommendation.supportingGoalIds,
  ];
  // Ground a number against the VALUES of the beliefs, insights and goals the
  // recommendation cites. The shared guard excludes ids/confidence and keeps
  // distinct numbers and units apart.
  const supportObjects = [
    ...recommendation.supportingBeliefIds.map((id) =>
      (context.suppliedBeliefs ?? []).find((belief) => belief.id === id),
    ),
    ...recommendation.supportingInsightIds.map((id) =>
      (context.suppliedInsights ?? []).find((insight) => insight.id === id),
    ),
    ...citedGoals.map((id) =>
      (context.suppliedGoals ?? []).find((goal) => goal.id === id),
    ),
  ].filter(Boolean);
  if (supportObjects.some(isBoundedCoverageMetric)) {
    supportObjects.push({ value: { percentage: 100, ratio: 1 } });
  }
  return numericTextIsGrounded(text, supportObjects);
}

function isBoundedCoverageMetric(item) {
  const key = String(item?.key ?? "").toLowerCase();
  const value =
    item?.val && typeof item.val === "object" && !Array.isArray(item.val)
      ? item.val
      : item?.value && typeof item.value === "object" && !Array.isArray(item.value)
        ? item.value
        : null;
  return (
    key.includes("coverage") &&
    value &&
    ("percentage" in value || "ratio" in value) &&
    ("denominator" in value || "activeVariants" in value)
  );
}

function duplicatesPriorRecommendation(recommendation, previousRecommendations) {
  const current = normalizeDuplicateKey(`${recommendation.title} ${recommendation.summary}`);
  return previousRecommendations
    .filter((item) =>
      ["accepted", "rejected", "refinement_requested", "completed"].includes(item.reviewStatus),
    )
    .some((item) => {
      const prior = normalizeDuplicateKey(`${item.title ?? ""} ${item.summary ?? ""}`);
      return prior && (prior === current || current.includes(prior) || prior.includes(current));
    });
}

function normalizeDuplicateKey(value) {
  return normalizeText(value).split(" ").filter((word) => !["the", "a", "an", "to", "for", "with", "and"].includes(word)).join(" ");
}

function normalizeText(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function cleanText(value, max, optional = false) {
  if (typeof value !== "string") return optional ? null : "";
  const text = value.replace(/\s+/g, " ").trim().slice(0, max);
  return text || (optional ? null : "");
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : null;
}

function invalid(error) {
  return { ok: false, error };
}
