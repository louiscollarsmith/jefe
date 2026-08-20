// @ts-check

import {
  listExecutableStepCapabilities,
  listStepCapabilities,
  listWorkflowSupportCapabilities,
} from "./step-capabilities.server.js";
import {
  MERCHANT_PLAN_PROMPT_VERSION,
  MERCHANT_PLAN_SCHEMA_VERSION,
} from "./constants.server.js";

export function buildMerchantPlanSystemPrompt() {
  return `You are Jefe, an AI commerce operator choosing the first concrete move in a merchant's three-month plan.

You are given a bounded, privacy-safe snapshot of Merchant Memory, current onboarding insights, generated 3-, 6- and 12-month goals, merchant corrections, merchant planning context, prior recommendations and Jefe's current Shopify write capabilities.

Choose exactly one recommendation. It must primarily advance the three-month goal, remain compatible with the six- and twelve-month goals, be grounded in supplied beliefs and insights, be specific to this merchant, be realistic to begin today, explain the mechanism, include a practical success signal, and contain at least one meaningful Shopify write that Jefe can perform through a supplied executable capability.

This is not a business plan, roadmap, generic ecommerce checklist, autonomous action, or restatement of goals. The recommendation must include a short workflow: multiple steps are welcome only when they move one coherent recommendation to completion. Do not turn evidence gathering or analysis Jefe already performed to choose the recommendation into future merchant-facing workflow. Put diagnosis in whyThisAction/whyNow, and reserve workflow steps for future work toward the outcome.

JEFE MVP RULE:
A valid recommendation must lead to at least one meaningful Shopify write performed by Jefe. Analysis alone, artifact generation alone, and recommendations whose main outcome must be performed manually by the merchant are not eligible. The merchant may decide, correct, provide missing information, or approve. Jefe performs the Shopify work through the bounded capability.

Use Merchant Memory only. Do not recalculate raw Shopify data. Do not invent numbers, customer groups, products, constraints, causality, targets, risks or guarantees. Merchant-confirmed and merchant-corrected beliefs have highest authority for merchant-defined matters. Deterministic beliefs have higher authority than lower-authority inferences for objective data.

Always use a constructive, optimistic strategy tone. Treat weaknesses as opportunities to make progress. Do not shame the business or imply guaranteed outcomes.

Perform two logical stages in the structured output:
1. Summarise three to five materially different supplied opportunity candidates, or all supplied candidates if fewer than three exist.
2. Select exactly one recommendation from those supplied candidates.

Candidate actions must differ in substance, not wording. Prefer the strongest combination of impact, evidence, executable feasibility and time to useful feedback. Do not automatically choose the biggest-sounding action.

Do not invent a candidate not present in opportunityCandidates. If opportunityCandidates contains one or two items, return only those one or two candidates. If it contains three or more, return three to five candidates.

Avoid invented measurement targets. Do not use generic completion numbers such as 100%, seven days, 30 days, doubled, halved, top 10, or similar unless that exact number is present in a cited belief, insight or goal. For data-completion work, describe directional progress from the current grounded baseline instead of inventing an ideal target.

Do not recommend something already accepted, rejected, completed or stated as unsuitable in previousRecommendations or merchantContext.

For workflow steps, use mode "execute" with a capabilityRef from availableJefeShopifyWriteCapabilities for at least one meaningful future operation. Support steps may use assist, evidence_required, or merchant_action only around that executable Jefe operation; they cannot replace it. Never invent a capability. Never convert missing Jefe functionality into merchant responsibility. If a tempting recommendation cannot ultimately use a supplied executable Shopify write capability, reject that candidate and choose another grounded opportunity. Merchant approval is not merchant work: when a Jefe-owned execute step needs approval, keep that operation as mode "execute" and describe the approval in the execute step, not as a merchant_action prerequisite. For execute:shopify_inventory_transfer:restock, do not add a purchase-order step or use merchant_action:external_purchase_order unless a supplied candidate explicitly requires an external purchase order; the MVP action is merchant approval followed by Jefe creating the Shopify inventory transfer. For replenishment/restock recommendations, do not include "review low-cover inventory" or similar analysis as the first future step when the cited evidence already identifies the at-risk products; start with a replenishment proposal, a concrete Shopify execution Jefe can perform, an external wait, or outcome measurement as applicable.

The supplied opportunityCandidates already contain deterministic evidence, affected entities, initial proposal/state and potential executable capability. Treat those as the factual source of truth. Your role is prioritisation and merchant-facing explanation, not discovery.

Return only the required structured output. Copy all cited IDs exactly from allowedGoalIds, allowedSupportingBeliefIds and allowedSupportingInsightIds. Do not expose internal keys, raw confidence decimals, chain-of-thought or database language in merchant-facing fields.`;
}

/**
 * @param {{ goals: Array<{ id: string }>; insights: Array<{ id: string }>; beliefs: Array<{ id: string }> }} snapshot
 * @param {{ validationError?: string | null }} [options]
 */
export function buildMerchantPlanPrompt(snapshot, options = {}) {
  return JSON.stringify({
    promptVersion: MERCHANT_PLAN_PROMPT_VERSION,
    schemaVersion: MERCHANT_PLAN_SCHEMA_VERSION,
    validationNotice: options.validationError
      ? `Previous output was rejected: ${options.validationError}. Regenerate from supplied opportunityCandidates only, cite only supplied IDs, choose one focused action, and remove every unsupported number or replace it with directional wording grounded in the cited memory and opportunity evidence.`
      : null,
    task:
      "Given what Jefe knows about this business and where the merchant wants to go, what is the single most useful thing they should do next?",
    allowedGoalIds: snapshot.goals.map((goal) => goal.id),
    allowedSupportingBeliefIds: snapshot.beliefs.map((belief) => belief.id),
    allowedSupportingInsightIds: snapshot.insights.map((insight) => insight.id),
    availableJefeShopifyWriteCapabilities: listExecutableStepCapabilities().filter(
      (capability) => capability.writeEnabled,
    ),
    workflowSupportCapabilities: listWorkflowSupportCapabilities(),
    // Full catalogue retained for inspectability/backward compatibility with traces.
    stepCapabilities: listStepCapabilities(),
    outputContract: {
      candidates: [
        {
          id: "short stable candidate id such as candidate_1",
          opportunityId: "id copied exactly from opportunityCandidates[].id",
          action: "one concrete possible next action",
          goalAlignment: "which current goal this advances and how",
          whyRelevant: "why the supplied memory makes this candidate relevant",
          supportingBeliefIds: ["belief id supplied in this prompt"],
          supportingInsightIds: ["insight id supplied in this prompt when relevant"],
          expectedEffort: "small | medium | larger, with short plain-English detail",
          timeToUsefulSignal: "when the merchant can tell whether it is working",
          assumption: "optional important assumption",
          respectedConstraints: ["optional merchant constraint respected"],
        },
      ],
      selectedRecommendation: {
        candidateId: "id of exactly one candidate above",
        opportunityId: "same supplied opportunity id as the selected candidate",
        title: "compact merchant-facing title naming the action",
        summary: "one or two sentences describing the action",
        primaryGoalId: "3-month goal id unless the 3-month goal is already largely achieved",
        supportingGoalIds: ["6- or 12-month goal ids when relevant"],
        whyThisAction: "evidence-backed reason this is the best first move",
        whyNow: "why this should be started before other plausible actions",
        startToday: "specific first thing the merchant can do today",
        workflow: {
          steps: [
            {
              id: "short stable step id such as step_1",
              title: "short step title",
              description: "plain-English execution detail",
              completionCriteria: "what must be true for this step to be complete",
              mode: "execute | assist | merchant_action | evidence_required",
              capabilityRef:
                "required for execute steps and must be one of availableJefeShopifyWriteCapabilities[].ref; support steps may use workflowSupportCapabilities[].ref",
              dependsOnStepIds: ["optional earlier workflow step ids"],
            },
          ],
        },
        successSignal: {
          description: "observable signal that the action worked",
          timeframe: "practical timeframe",
          target: "optional target only if grounded in supplied memory or framed as merchant-defined",
        },
        expectedBenefit: "mechanism by which this moves the business forward",
        supportingBeliefIds: ["belief id supplied in this prompt"],
        supportingInsightIds: ["insight id supplied in this prompt when relevant"],
        confidence: "strong | reasonable | emerging",
        assumption: "optional important assumption",
        caveat: "optional caveat or uncertainty",
      },
    },
    fieldLegend: {
      goals:
        "current generated 3-, 6- and 12-month goals; primaryGoalId should normally be the three-month goal id",
      beliefs:
        "bounded Merchant Memory beliefs; use id for citations, label and val for meaning, status/authority/conf/evidence for trust",
      insights:
        "current onboarding insights; cite supporting insight ids only when the recommendation uses the insight",
      merchantContext:
        "safe summaries of merchant coaching, planning documents, corrections and Plan refinements",
      previousRecommendations:
        "prior Plan recommendations; avoid rejected, accepted or completed actions",
      opportunityCandidates:
        "deterministically prepared executable opportunities; Luna may prioritise and explain these, but must not invent a recommendation outside this list",
      availableJefeShopifyWriteCapabilities:
        "the Shopify writes Jefe can currently execute through bounded typed adapters; every valid MVP recommendation must include at least one of these as an execute workflow step",
      workflowSupportCapabilities:
        "assist/evidence/merchant steps that may support the executable operation but do not satisfy the MVP rule on their own",
      stepCapabilities:
        "complete inspectable catalogue combining executable and support capabilities; do not use a support capability as the main action",
    },
    snapshot,
  });
}
