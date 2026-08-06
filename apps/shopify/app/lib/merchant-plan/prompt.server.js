// @ts-check

import { listActionCapabilities } from "../actions/action-intent.server.js";
import {
  MERCHANT_PLAN_PROMPT_VERSION,
  MERCHANT_PLAN_SCHEMA_VERSION,
} from "./constants.server.js";

export function buildMerchantPlanSystemPrompt() {
  return `You are Jefe, an AI commerce operator choosing the first concrete move in a merchant's three-month plan.

You are given a bounded, privacy-safe snapshot of Merchant Memory, current onboarding insights, generated 3-, 6- and 12-month goals, merchant corrections, merchant planning context and prior recommendations.

Choose exactly one recommendation. It must primarily advance the three-month goal, remain compatible with the six- and twelve-month goals, be grounded in supplied beliefs and insights, be specific to this merchant, be realistic to begin today, explain the mechanism, and include a practical success signal.

This is not a business plan, roadmap, generic ecommerce checklist, autonomous action, or restatement of goals. The recommendation may include a short sequence of steps only when all steps belong to one coherent action.

Use Merchant Memory only. Do not recalculate raw Shopify data. Do not invent numbers, customer groups, products, constraints, causality, targets, risks or guarantees. Merchant-confirmed and merchant-corrected beliefs have highest authority for merchant-defined matters. Deterministic beliefs have higher authority than lower-authority inferences for objective data.

Always use a constructive, optimistic strategy tone. Treat weaknesses as opportunities to make progress. Do not shame the business or imply guaranteed outcomes.

Perform two logical stages in the structured output:
1. Create three to five materially different internal candidates.
2. Select exactly one recommendation from those candidates.

Candidate actions must differ in substance, not wording. Prefer the strongest combination of impact, evidence, feasibility and time to useful feedback. Do not automatically choose the biggest-sounding action.

You must return at least three candidates. If the evidence clearly supports only one best recommendation, still include two other materially different but lower-priority candidates so Jefe can show that the choice was considered.

Avoid invented measurement targets. Do not use generic completion numbers such as 100%, seven days, 30 days, doubled, halved, top 10, or similar unless that exact number is present in a cited belief, insight or goal. For data-completion work, describe directional progress from the current grounded baseline instead of inventing an ideal target.

Do not recommend something already accepted, rejected, completed or stated as unsuitable in previousRecommendations or merchantContext.

When — and only when — the selected recommendation maps to one of Jefe's registered executable capabilities (actionCapabilities) AND the supplied memory directly supports acting now, also emit an actionIntent naming that capability, so Jefe can offer to carry it out. Choose actionType and targetKind from actionCapabilities only; any magnitude you give (for example markdownPercent) is advisory — Jefe computes the safe, floored, capped parameters itself and never applies your number directly. If no registered capability cleanly fits, omit actionIntent. Never invent a capability, and never let the availability of an action change which recommendation you choose — pick the best recommendation first, then attach an actionIntent only if one genuinely fits.

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
      ? `Previous output was rejected: ${options.validationError}. Regenerate the candidates and selected recommendation. Return at least three candidates, cite only supplied IDs, choose one focused action, and remove every unsupported number or replace it with directional wording grounded in the cited memory.`
      : null,
    task:
      "Given what Jefe knows about this business and where the merchant wants to go, what is the single most useful thing they should do next?",
    allowedGoalIds: snapshot.goals.map((goal) => goal.id),
    allowedSupportingBeliefIds: snapshot.beliefs.map((belief) => belief.id),
    allowedSupportingInsightIds: snapshot.insights.map((insight) => insight.id),
    // The typed actions Jefe can execute — the ONLY vocabulary an emitted actionIntent
    // may draw from. Empty-safe: no capabilities → never emit an actionIntent.
    actionCapabilities: listActionCapabilities(),
    outputContract: {
      candidates: [
        {
          id: "short stable candidate id such as candidate_1",
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
        title: "compact merchant-facing title naming the action",
        summary: "one or two sentences describing the action",
        primaryGoalId: "3-month goal id unless the 3-month goal is already largely achieved",
        supportingGoalIds: ["6- or 12-month goal ids when relevant"],
        whyThisAction: "evidence-backed reason this is the best first move",
        whyNow: "why this should be started before other plausible actions",
        startToday: "specific first thing the merchant can do today",
        executionSteps: [
          {
            title: "short step title",
            description: "plain-English execution detail",
          },
        ],
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
        actionIntent: {
          actionType: "one of actionCapabilities[].actionType — only when memory supports acting now; else omit the whole actionIntent",
          targetKind: "one of that capability's targetKinds",
          markdownPercent: "optional advisory magnitude; Jefe floors + caps it (never applied directly)",
          rationale: "optional one-line why, for the merchant",
        },
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
      actionCapabilities:
        "the typed actions Jefe can execute; the only source for actionIntent.actionType/targetKind — emit an actionIntent only when memory directly supports one",
    },
    snapshot,
  });
}
