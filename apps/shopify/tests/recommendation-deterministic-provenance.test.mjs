import assert from "node:assert/strict";
import test from "node:test";

import { buildRecommendationContext } from "../app/lib/shopify/agentic-runtime/recommendation-agent.server.js";
import { authorityLevel } from "../app/lib/merchant-insights/candidates.server.js";
import { BELIEF_PRECEDENCE, BELIEF_STATUS } from "../app/lib/merchant-memory/constants.server.js";

// ---------------------------------------------------------------------------
// authorityLevel — evidence-based reclassification (historical rows)
// ---------------------------------------------------------------------------

const deterministicEvidence = [{ evidenceType: "deterministic_calculation", sourceType: "system_derivation" }];
const llmEvidence = [{ evidenceType: "model_goal_generation", sourceType: "store_understanding" }];
const noEvidence = [];

test("authorityLevel: historical systemInference row with deterministic_calculation evidence → deterministic", () => {
  assert.equal(
    authorityLevel(BELIEF_PRECEDENCE.systemInference, BELIEF_STATUS.inferred, deterministicEvidence),
    "deterministic",
  );
});

test("authorityLevel: new directObservation row (no evidence needed) → deterministic", () => {
  assert.equal(
    authorityLevel(BELIEF_PRECEDENCE.directObservation, BELIEF_STATUS.inferred, noEvidence),
    "deterministic",
  );
});

test("authorityLevel: systemInference row with no evidence → system_inference (unchanged)", () => {
  assert.equal(
    authorityLevel(BELIEF_PRECEDENCE.systemInference, BELIEF_STATUS.inferred, noEvidence),
    "system_inference",
  );
});

test("authorityLevel: llmInference row with LLM evidence → lower_authority_inference (unchanged)", () => {
  assert.equal(
    authorityLevel(BELIEF_PRECEDENCE.llmInference, BELIEF_STATUS.inferred, llmEvidence),
    "lower_authority_inference",
  );
});

test("authorityLevel: merchant_confirmed overrides evidence (high authority preserved)", () => {
  assert.equal(
    authorityLevel(BELIEF_PRECEDENCE.merchantConfirmation, BELIEF_STATUS.merchantConfirmed, deterministicEvidence),
    "merchant_confirmed",
  );
});

test("authorityLevel: merchant_corrected overrides evidence (highest authority preserved)", () => {
  assert.equal(
    authorityLevel(BELIEF_PRECEDENCE.merchantCorrection, BELIEF_STATUS.merchantCorrected, deterministicEvidence),
    "merchant_corrected",
  );
});

// ---------------------------------------------------------------------------
// buildRecommendationContext — bucket placement by authority
// ---------------------------------------------------------------------------

function makeBelief(overrides) {
  return {
    id: overrides.id ?? "belief-1",
    key: overrides.key ?? "test.key",
    category: overrides.category ?? "test",
    label: overrides.label ?? "Test",
    val: overrides.val ?? null,
    value: overrides.value ?? null,
    type: "string",
    status: overrides.status ?? BELIEF_STATUS.inferred,
    authority: overrides.authority,
    confidence: 0.8,
    evidence: overrides.evidence ?? [],
  };
}

function buildSnapshot(overrides = {}) {
  return {
    beliefs: overrides.beliefs ?? [],
    goals: overrides.goals ?? [],
    insights: overrides.insights ?? [],
    goalCoaching: overrides.goalCoaching ?? [],
    merchantContext: [],
    previousRecommendations: [],
    privacy: {},
    beliefCount: (overrides.beliefs ?? []).length,
  };
}

// Test A — Direct Shopify observation (inventory available=0, directObservation precedence)
test("Test A: direct observation belief lands in storeEvidence", () => {
  const belief = makeBelief({
    id: "inv-1",
    key: "inventory.available",
    authority: "deterministic",
  });
  const ctx = buildRecommendationContext(buildSnapshot({ beliefs: [belief] }));
  assert.ok(ctx.merchantMemory.storeEvidence.beliefs.some((b) => b.id === "inv-1"), "should be in storeEvidence");
  assert.ok(!ctx.merchantMemory.jefeHypotheses.inferredBeliefs.some((b) => b.id === "inv-1"), "must not be in jefeHypotheses");
});

// Test B — Deterministic revenue calculation (historical row, system_inference precedence + deterministic_calculation evidence)
test("Test B: historical systemInference row with deterministic_calculation evidence → storeEvidence", () => {
  const belief = makeBelief({
    id: "rev-1",
    key: "products.bundle_revenue_share.trailing_90d",
    authority: "deterministic",
    evidence: deterministicEvidence,
  });
  const ctx = buildRecommendationContext(buildSnapshot({ beliefs: [belief] }));
  assert.ok(ctx.merchantMemory.storeEvidence.beliefs.some((b) => b.id === "rev-1"), "should be in storeEvidence");
  assert.ok(!ctx.merchantMemory.jefeHypotheses.inferredBeliefs.some((b) => b.id === "rev-1"), "must not be in jefeHypotheses");
});

// Test C — Deterministic trend metric
test("Test C: deterministic trend metric lands in storeEvidence", () => {
  const belief = makeBelief({
    id: "trend-1",
    key: "revenue.trend.trailing_30d_vs_prior",
    authority: "deterministic",
    evidence: deterministicEvidence,
  });
  const ctx = buildRecommendationContext(buildSnapshot({ beliefs: [belief] }));
  assert.ok(ctx.merchantMemory.storeEvidence.beliefs.some((b) => b.id === "trend-1"), "should be in storeEvidence");
  assert.ok(!ctx.merchantMemory.jefeHypotheses.inferredBeliefs.some((b) => b.id === "trend-1"), "must not be in jefeHypotheses");
});

// Test D — System inference remains in jefeHypotheses
test("Test D: system_inference belief (no deterministic evidence) → jefeHypotheses", () => {
  const belief = makeBelief({
    id: "sys-1",
    key: "business.demand_pattern",
    authority: "system_inference",
    evidence: [{ evidenceType: "heuristic_rule", sourceType: "rule_engine" }],
  });
  const ctx = buildRecommendationContext(buildSnapshot({ beliefs: [belief] }));
  assert.ok(ctx.merchantMemory.jefeHypotheses.inferredBeliefs.some((b) => b.id === "sys-1"), "should be in jefeHypotheses");
  assert.ok(!ctx.merchantMemory.storeEvidence.beliefs.some((b) => b.id === "sys-1"), "must not be in storeEvidence");
});

// Test E — LLM inference remains in jefeHypotheses with lower authority
test("Test E: LLM inference belief → jefeHypotheses.inferredBeliefs", () => {
  const belief = makeBelief({
    id: "llm-1",
    key: "business.strategic_opportunity",
    authority: "lower_authority_inference",
    evidence: [{ evidenceType: "model_goal_generation", sourceType: "store_understanding" }],
  });
  const ctx = buildRecommendationContext(buildSnapshot({ beliefs: [belief] }));
  assert.ok(ctx.merchantMemory.jefeHypotheses.inferredBeliefs.some((b) => b.id === "llm-1"), "should be in jefeHypotheses");
  assert.ok(!ctx.merchantMemory.storeEvidence.beliefs.some((b) => b.id === "llm-1"), "must not be in storeEvidence");
});

// Test F — Merchant-confirmed belief preserves its authority and lands in merchantIntent
test("Test F: merchant_confirmed belief → merchantIntent.confirmedBeliefs", () => {
  const belief = makeBelief({
    id: "conf-1",
    key: "business.priority",
    authority: "merchant_confirmed",
    status: BELIEF_STATUS.merchantConfirmed,
    evidence: deterministicEvidence,
  });
  const ctx = buildRecommendationContext(buildSnapshot({ beliefs: [belief] }));
  assert.ok(ctx.merchantMemory.merchantIntent.confirmedBeliefs.some((b) => b.id === "conf-1"), "should be in merchantIntent.confirmedBeliefs");
  assert.ok(!ctx.merchantMemory.storeEvidence.beliefs.some((b) => b.id === "conf-1"), "must not be in storeEvidence");
  assert.ok(!ctx.merchantMemory.jefeHypotheses.inferredBeliefs.some((b) => b.id === "conf-1"), "must not be in jefeHypotheses");
});

// Test G — Mixed snapshot: correct bucket assignment for each belief type
test("Test G: mixed snapshot assigns each belief to the correct layer", () => {
  const beliefs = [
    makeBelief({ id: "direct-1", key: "inventory.available", authority: "deterministic" }),
    makeBelief({ id: "hist-1", key: "products.revenue_share", authority: "deterministic", evidence: deterministicEvidence }),
    makeBelief({ id: "sys-2", key: "business.demand", authority: "system_inference" }),
    makeBelief({ id: "llm-2", key: "strategy.opportunity", authority: "lower_authority_inference" }),
    makeBelief({ id: "conf-2", key: "goal.priority", authority: "merchant_confirmed", status: BELIEF_STATUS.merchantConfirmed }),
  ];
  const goals = [{ id: "goal-1", title: "Grow revenue", generatedBy: "jefe_llm", authority: "jefe_interpretation" }];
  const insights = [{ id: "insight-1", title: "Cases are commercially salient", generatedBy: "jefe_llm", authority: "jefe_interpretation" }];
  const goalCoaching = [{ id: "coaching-1", summary: "Grow revenue", authority: "merchant_stated" }];

  const ctx = buildRecommendationContext(buildSnapshot({ beliefs, goals, insights, goalCoaching }));

  const { merchantIntent, storeEvidence, jefeHypotheses } = ctx.merchantMemory;

  // Deterministic → storeEvidence
  assert.ok(storeEvidence.beliefs.some((b) => b.id === "direct-1"), "direct observation → storeEvidence");
  assert.ok(storeEvidence.beliefs.some((b) => b.id === "hist-1"), "historical deterministic → storeEvidence");

  // Inference → jefeHypotheses
  assert.ok(jefeHypotheses.inferredBeliefs.some((b) => b.id === "sys-2"), "system_inference → jefeHypotheses");
  assert.ok(jefeHypotheses.inferredBeliefs.some((b) => b.id === "llm-2"), "llm_inference → jefeHypotheses");

  // Merchant-confirmed → merchantIntent
  assert.ok(merchantIntent.confirmedBeliefs.some((b) => b.id === "conf-2"), "merchant_confirmed → merchantIntent");

  // Goals and insights → jefeHypotheses
  assert.ok(jefeHypotheses.goals.some((g) => g.id === "goal-1"), "generated goals → jefeHypotheses");
  assert.ok(jefeHypotheses.insights.some((i) => i.id === "insight-1"), "generated insights → jefeHypotheses");

  // GoalCoaching → merchantIntent
  assert.ok(merchantIntent.goalCoaching.some((c) => c.id === "coaching-1"), "goalCoaching → merchantIntent");
});
