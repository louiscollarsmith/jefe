import assert from "node:assert/strict";
import test from "node:test";

import { buildRecommendationContext } from "../app/lib/shopify/agentic-runtime/recommendation-agent.server.js";
import { authorityLevel } from "../app/lib/merchant-insights/candidates.server.js";
import { BELIEF_PRECEDENCE, BELIEF_STATUS } from "../app/lib/merchant-memory/constants.server.js";

// ---------------------------------------------------------------------------
// authorityLevel helper (unit)
// ---------------------------------------------------------------------------

test("authorityLevel returns merchant_corrected for corrected beliefs", () => {
  assert.equal(authorityLevel(BELIEF_PRECEDENCE.merchantCorrection, BELIEF_STATUS.merchantCorrected), "merchant_corrected");
});

test("authorityLevel returns merchant_confirmed for confirmed beliefs", () => {
  assert.equal(authorityLevel(BELIEF_PRECEDENCE.merchantConfirmation, BELIEF_STATUS.merchantConfirmed), "merchant_confirmed");
});

test("authorityLevel returns deterministic for directObservation beliefs", () => {
  assert.equal(authorityLevel(BELIEF_PRECEDENCE.directObservation, BELIEF_STATUS.inferred), "deterministic");
});

test("authorityLevel returns lower_authority_inference for llmInference beliefs", () => {
  assert.equal(authorityLevel(BELIEF_PRECEDENCE.llmInference, BELIEF_STATUS.inferred), "lower_authority_inference");
});

test("authorityLevel returns system_inference for systemInference beliefs", () => {
  assert.equal(authorityLevel(BELIEF_PRECEDENCE.systemInference, BELIEF_STATUS.inferred), "system_inference");
});

// ---------------------------------------------------------------------------
// Test A — broad merchant goal stays as merchantIntent, Jefe strategies stay separate
// ---------------------------------------------------------------------------

test("Test A: broad merchant goal stays in merchantIntent; Jefe-generated goals land in jefeHypotheses", () => {
  const snapshot = buildSnapshotWith({
    goalCoaching: [
      {
        id: "coaching-1",
        sourceType: "merchant_goals",
        evidenceType: "merchant_goal_coaching",
        summary: "Grow revenue",
        observedAt: new Date().toISOString(),
        authority: "merchant_stated",
      },
    ],
    goals: [
      {
        id: "goal-1",
        horizon: "near",
        title: "Cases and bundles strategy",
        description: "Make bundles more prominent in the buying journey.",
        supportingBeliefIds: [],
        generatedBy: "jefe_llm",
        authority: "jefe_interpretation",
      },
    ],
    beliefs: [],
    insights: [],
  });

  const context = buildRecommendationContext(snapshot, undefined);

  // Merchant raw statement goes to merchantIntent
  assert.equal(context.merchantMemory.merchantIntent.goalCoaching.length, 1);
  assert.equal(context.merchantMemory.merchantIntent.goalCoaching[0].summary, "Grow revenue");
  assert.equal(context.merchantMemory.merchantIntent.goalCoaching[0].authority, "merchant_stated");

  // Jefe-generated strategy stays in jefeHypotheses, not merchantIntent
  assert.equal(context.merchantMemory.jefeHypotheses.goals.length, 1);
  assert.equal(context.merchantMemory.jefeHypotheses.goals[0].authority, "jefe_interpretation");
  assert.equal(context.merchantMemory.jefeHypotheses.goals[0].generatedBy, "jefe_llm");

  // merchantIntent.confirmedBeliefs has no Jefe-generated goals
  assert.equal(context.merchantMemory.merchantIntent.confirmedBeliefs.length, 0);
});

// ---------------------------------------------------------------------------
// Test B — explicit merchant strategy is merchant intent
// ---------------------------------------------------------------------------

test("Test B: explicit merchant strategy stated in goalCoaching is treated as merchant intent", () => {
  const snapshot = buildSnapshotWith({
    goalCoaching: [
      {
        id: "coaching-2",
        sourceType: "merchant_goals",
        evidenceType: "merchant_goal_coaching",
        summary: "I want customers buying more cases and bundles.",
        observedAt: new Date().toISOString(),
        authority: "merchant_stated",
      },
    ],
    goals: [],
    beliefs: [],
    insights: [],
  });

  const context = buildRecommendationContext(snapshot, undefined);

  assert.equal(context.merchantMemory.merchantIntent.goalCoaching.length, 1);
  assert.match(context.merchantMemory.merchantIntent.goalCoaching[0].summary, /cases and bundles/i);
  assert.equal(context.merchantMemory.merchantIntent.goalCoaching[0].authority, "merchant_stated");
});

// ---------------------------------------------------------------------------
// Test C — merchant confirms Jefe hypothesis → belief promoted to merchant_confirmed
// ---------------------------------------------------------------------------

test("Test C: merchant-confirmed belief appears in merchantIntent.confirmedBeliefs, not only in inferredBeliefs", () => {
  const snapshot = buildSnapshotWith({
    goalCoaching: [],
    goals: [],
    insights: [],
    beliefs: [
      {
        id: "belief-confirmed",
        key: "strategy.bundles",
        label: "Bundle strategy",
        val: "Increase bundle orders",
        status: BELIEF_STATUS.merchantConfirmed,
        authority: "merchant_confirmed",
        confidence: 0.9,
        evidence: [],
      },
    ],
  });

  const context = buildRecommendationContext(snapshot, undefined);

  const confirmed = context.merchantMemory.merchantIntent.confirmedBeliefs;
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].id, "belief-confirmed");
  assert.equal(confirmed[0].authority, "merchant_confirmed");

  // Must NOT appear in jefeHypotheses.inferredBeliefs
  const inferred = context.merchantMemory.jefeHypotheses.inferredBeliefs;
  assert.equal(inferred.some((b) => b.id === "belief-confirmed"), false);
});

// ---------------------------------------------------------------------------
// Test D — merchant-corrected belief (rejection) prevents it returning as merchant intent
// ---------------------------------------------------------------------------

test("Test D: merchant-corrected belief is in merchantIntent.confirmedBeliefs (merchant override), not jefeHypotheses", () => {
  const snapshot = buildSnapshotWith({
    goalCoaching: [],
    goals: [
      {
        id: "goal-rejected",
        horizon: "near",
        title: "Rejected bundle strategy",
        description: "Rejected by merchant.",
        supportingBeliefIds: [],
        generatedBy: "jefe_llm",
        authority: "jefe_interpretation",
      },
    ],
    insights: [],
    beliefs: [
      {
        id: "belief-corrected",
        key: "strategy.bundles",
        label: "Bundle strategy override",
        val: "Merchant said this is wrong",
        status: BELIEF_STATUS.merchantCorrected,
        authority: "merchant_corrected",
        confidence: 1.0,
        evidence: [],
      },
    ],
  });

  const context = buildRecommendationContext(snapshot, undefined);

  // Corrected belief is in confirmedBeliefs as merchant authority
  assert.equal(context.merchantMemory.merchantIntent.confirmedBeliefs.some((b) => b.id === "belief-corrected"), true);

  // Jefe-generated goal stays in jefeHypotheses
  assert.equal(context.merchantMemory.jefeHypotheses.goals.some((g) => g.id === "goal-rejected"), true);
  assert.equal(context.merchantMemory.jefeHypotheses.goals[0].authority, "jefe_interpretation");
});

// ---------------------------------------------------------------------------
// Test E — repeated LLM interpretation visible as jefe_interpretation throughout
// ---------------------------------------------------------------------------

test("Test E: same hypothesis in goal, insight, and inferred belief — all carry jefe_interpretation authority", () => {
  const snapshot = buildSnapshotWith({
    goalCoaching: [],
    goals: [
      {
        id: "goal-bundle",
        horizon: "near",
        title: "Bundle strategy",
        description: "Jefe inferred this.",
        supportingBeliefIds: [],
        generatedBy: "jefe_llm",
        authority: "jefe_interpretation",
      },
    ],
    insights: [
      {
        id: "insight-bundle",
        title: "Bundle revenue",
        finding: "Bundles produce revenue.",
        whyItMatters: "Opportunity.",
        category: "revenue",
        confidence: "high",
        supportingBeliefIds: [],
        generatedBy: "jefe_llm",
        authority: "jefe_interpretation",
      },
    ],
    beliefs: [
      {
        id: "belief-bundle",
        key: "strategy.bundles.inferred",
        label: "Bundle opportunity",
        val: "Jefe inferred bundles matter",
        status: BELIEF_STATUS.inferred,
        authority: "system_inference",
        confidence: 0.5,
        evidence: [{ id: "ev-1", summary: "Store Understanding inferred this", sourceType: "llm_store_analysis", evidenceType: "model_inference", observedAt: null }],
      },
    ],
  });

  const context = buildRecommendationContext(snapshot, undefined);

  // All three representations are in jefeHypotheses
  assert.equal(context.merchantMemory.jefeHypotheses.goals.length, 1);
  assert.equal(context.merchantMemory.jefeHypotheses.goals[0].authority, "jefe_interpretation");
  assert.equal(context.merchantMemory.jefeHypotheses.insights.length, 1);
  assert.equal(context.merchantMemory.jefeHypotheses.insights[0].authority, "jefe_interpretation");
  assert.equal(context.merchantMemory.jefeHypotheses.inferredBeliefs.length, 1);
  assert.equal(context.merchantMemory.jefeHypotheses.inferredBeliefs[0].authority, "system_inference");

  // None appear in merchantIntent
  assert.equal(context.merchantMemory.merchantIntent.goalCoaching.length, 0);
  assert.equal(context.merchantMemory.merchantIntent.confirmedBeliefs.length, 0);
});

// ---------------------------------------------------------------------------
// Store evidence stays in storeEvidence, not merchantIntent or jefeHypotheses
// ---------------------------------------------------------------------------

test("deterministic Shopify beliefs land in storeEvidence only", () => {
  const snapshot = buildSnapshotWith({
    goalCoaching: [],
    goals: [],
    insights: [],
    beliefs: [
      {
        id: "belief-revenue",
        key: "revenue.total.trailing_90d",
        label: "Trailing 90-day revenue",
        val: 48000,
        status: BELIEF_STATUS.inferred,
        authority: "deterministic",
        confidence: 1.0,
        evidence: [{ id: "ev-2", summary: "Shopify order data", sourceType: "shopify_derivation", evidenceType: "shopify_order_data", observedAt: null }],
      },
    ],
  });

  const context = buildRecommendationContext(snapshot, undefined);

  assert.equal(context.merchantMemory.storeEvidence.beliefs.length, 1);
  assert.equal(context.merchantMemory.storeEvidence.beliefs[0].id, "belief-revenue");

  assert.equal(context.merchantMemory.merchantIntent.confirmedBeliefs.length, 0);
  assert.equal(context.merchantMemory.jefeHypotheses.inferredBeliefs.length, 0);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSnapshotWith({ goalCoaching = [], goals = [], insights = [], beliefs = [] } = {}) {
  return {
    privacy: { excludesCredentialsAndTokens: true },
    goalCoaching,
    goals,
    insights,
    beliefs,
    beliefCount: beliefs.length,
    merchantContext: [],
    previousRecommendations: [],
  };
}
