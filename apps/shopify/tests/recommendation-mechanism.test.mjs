import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeSemanticRecommendation,
  validateSemanticRecommendation,
} from "../app/lib/shopify/agentic-runtime/recommendation-agent.server.js";
import { buildRecommendationContext } from "../app/lib/shopify/agentic-runtime/recommendation-agent.server.js";

// ---------------------------------------------------------------------------
// Minimal valid recommendation + context for tests
// ---------------------------------------------------------------------------

const BASE_BELIEFS = [{ id: "b-1", key: "products.revenue", category: "products", label: "Revenue", val: null, value: null, type: "string", status: "inferred", authority: "deterministic", confidence: 0.9, evidence: [] }];
const BASE_INSIGHTS = [{ id: "ins-1", title: "Revenue insight", generatedBy: "jefe_llm", authority: "jefe_interpretation" }];

function buildContext(overrides = {}) {
  const snapshot = {
    beliefs: overrides.beliefs ?? BASE_BELIEFS,
    goals: [{ id: "goal-1", title: "Grow revenue", generatedBy: "jefe_llm", authority: "jefe_interpretation" }],
    insights: overrides.insights ?? BASE_INSIGHTS,
    goalCoaching: [],
    merchantContext: [],
    previousRecommendations: [],
    privacy: {},
    beliefCount: (overrides.beliefs ?? BASE_BELIEFS).length,
  };
  return buildRecommendationContext(snapshot);
}

function buildRec(overrides = {}) {
  return normalizeSemanticRecommendation({
    title: overrides.title ?? "Test action",
    summary: overrides.summary ?? "A test recommendation.",
    outcome: overrides.outcome ?? "Improved outcome.",
    scope: overrides.scope ?? "All products",
    constraints: overrides.constraints ?? [],
    materialExpectedEffects: overrides.materialExpectedEffects ?? ["Increase visibility"],
    diagnosedProblem: overrides.diagnosedProblem ?? "A specific gap in the current Shopify state",
    mechanism: overrides.mechanism ?? "The proposed change directly addresses that gap",
    whyThisAction: overrides.whyThisAction ?? "Evidence supports this intervention.",
    whyNow: overrides.whyNow ?? "Problem is current.",
    supportingBeliefIds: overrides.supportingBeliefIds ?? [],
    supportingInsightIds: overrides.supportingInsightIds ?? [],
    feasibleWriteOperations: overrides.feasibleWriteOperations ?? ["collectionCreate"],
    verificationPlan: overrides.verificationPlan ?? "Check result after execution.",
    confidence: overrides.confidence ?? "reasonable",
    assumption: overrides.assumption ?? null,
    caveat: overrides.caveat ?? null,
  });
}

// ---------------------------------------------------------------------------
// normalizeSemanticRecommendation includes new fields
// ---------------------------------------------------------------------------

test("normalizeSemanticRecommendation includes diagnosedProblem and mechanism", () => {
  const rec = buildRec({ diagnosedProblem: "No grouping exists", mechanism: "Collection provides grouping" });
  assert.equal(rec.diagnosedProblem, "No grouping exists");
  assert.equal(rec.mechanism, "Collection provides grouping");
});

test("normalizeSemanticRecommendation clamps diagnosedProblem to 520 chars", () => {
  const long = "x".repeat(600);
  const rec = buildRec({ diagnosedProblem: long });
  assert.equal(rec.diagnosedProblem.length, 520);
});

test("normalizeSemanticRecommendation returns empty string for null mechanism", () => {
  const rec = normalizeSemanticRecommendation({
    title: "t", summary: "s", outcome: "o", scope: "sc",
    constraints: [], materialExpectedEffects: ["e"],
    diagnosedProblem: "p", mechanism: null,
    whyThisAction: "w", whyNow: "n",
    supportingBeliefIds: [], supportingInsightIds: [],
    feasibleWriteOperations: ["x"], verificationPlan: "v", confidence: "emerging",
  });
  assert.equal(rec.mechanism, "");
});

// ---------------------------------------------------------------------------
// validateSemanticRecommendation requires diagnosedProblem and mechanism
// ---------------------------------------------------------------------------

test("validateSemanticRecommendation passes when diagnosedProblem and mechanism are present", () => {
  const ctx = buildContext();
  const rec = buildRec({ diagnosedProblem: "Gap exists", mechanism: "Change fixes gap" });
  assert.deepEqual(validateSemanticRecommendation(rec, ctx), { ok: true });
});

test("validateSemanticRecommendation fails when diagnosedProblem is missing", () => {
  const ctx = buildContext();
  const rec = buildRec({ diagnosedProblem: "" });
  const result = validateSemanticRecommendation(rec, ctx);
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("diagnosedProblem"), `Expected error about diagnosedProblem, got: ${result.error}`);
});

test("validateSemanticRecommendation fails when mechanism is missing", () => {
  const ctx = buildContext();
  const rec = buildRec({ mechanism: "" });
  const result = validateSemanticRecommendation(rec, ctx);
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("mechanism"), `Expected error about mechanism, got: ${result.error}`);
});

// ---------------------------------------------------------------------------
// Test A — Commercial salience alone is not sufficient
// A recommendation explaining only revenue share without a diagnosed problem
// must fail validation (it would have no diagnosedProblem or empty mechanism).
// ---------------------------------------------------------------------------

test("Test A: recommendation without diagnosed problem fails validation", () => {
  const ctx = buildContext();
  // Simulate a recommendation that only cites commercial signal
  const rec = buildRec({
    diagnosedProblem: "",
    mechanism: "collectionCreate is available",
    whyThisAction: "White Wine = 34.78% of revenue",
  });
  const result = validateSemanticRecommendation(rec, ctx);
  assert.equal(result.ok, false, "Should fail: no diagnosed problem");
});

// ---------------------------------------------------------------------------
// Test B — Existing collection adequate: diagnosedProblem must state the gap,
// not just the commercial opportunity. If the problem is "no gap exists" then
// validation should fail because the mechanism cannot be correct.
// (Tests the schema contract — we cannot enforce semantics, but missing problem fails.)
// ---------------------------------------------------------------------------

test("Test B: recommendation must state specific gap even when category is important", () => {
  const ctx = buildContext();
  // A recommendation where diagnosedProblem is empty cannot pass
  const noGapRec = buildRec({ diagnosedProblem: "" });
  assert.equal(validateSemanticRecommendation(noGapRec, ctx).ok, false);
  // A recommendation that correctly states "existing collection is adequate" and
  // therefore selects a different intervention (inventory correction) can pass
  const inventoryRec = buildRec({
    diagnosedProblem: "Two products show zero Shopify availability despite confirmed warehouse stock",
    mechanism: "Correcting inventory quantity restores purchasability immediately",
    feasibleWriteOperations: ["inventorySetQuantities"],
  });
  assert.deepEqual(validateSemanticRecommendation(inventoryRec, ctx), { ok: true });
});

// ---------------------------------------------------------------------------
// Test C — Genuine discovery gap: collection recommendation is valid when
// mechanism describes the specific discoverability fix
// ---------------------------------------------------------------------------

test("Test C: collection recommendation with genuine discovery gap is valid", () => {
  const beliefs = [
    { id: "b-organic-1", key: "catalogue.no_organic_collection", category: "catalogue", label: "No organic collection exists", val: null, value: null, type: "string", status: "inferred", authority: "deterministic", confidence: 0.95, evidence: [] },
  ];
  const ctx = buildContext({ beliefs });
  const rec = buildRec({
    diagnosedProblem: "No dedicated collection groups the 12 organic products together; they are spread across 3 unrelated collections",
    mechanism: "A dedicated organic collection creates a single browseable entry point that does not currently exist",
    feasibleWriteOperations: ["collectionCreate", "collectionAddProducts"],
    supportingBeliefIds: ["b-organic-1"],
  });
  assert.deepEqual(validateSemanticRecommendation(rec, ctx), { ok: true });
});

// ---------------------------------------------------------------------------
// Test D — Inventory mechanism: correct problem → mechanism → action chain
// ---------------------------------------------------------------------------

test("Test D: inventory correction validates because mechanism is evidenced", () => {
  const beliefs = [
    { id: "b-inv-1", key: "inventory.available", category: "inventory", label: "Zero stock despite warehouse availability", val: 0, value: 0, type: "number", status: "inferred", authority: "deterministic", confidence: 0.95, evidence: [] },
  ];
  const ctx = buildContext({ beliefs });
  const rec = buildRec({
    diagnosedProblem: "Product X shows zero available in Shopify but warehouse records confirm stock exists",
    mechanism: "Correcting inventory quantity in Shopify makes the product purchasable again",
    feasibleWriteOperations: ["inventorySetQuantities"],
    supportingBeliefIds: ["b-inv-1"],
  });
  assert.deepEqual(validateSemanticRecommendation(rec, ctx), { ok: true });
});

// ---------------------------------------------------------------------------
// Test E — Discount non-sequitur: revenue decline alone cannot justify discount
// The schema contract: diagnosedProblem must not be empty. If revenue-decline
// is the only evidence and no price-sensitivity mechanism exists, diagnosedProblem
// cannot be filled non-trivially → the recommendation would fail validation.
// ---------------------------------------------------------------------------

test("Test E: recommendation fails when diagnosedProblem is empty (discount without mechanism)", () => {
  const ctx = buildContext();
  const rec = buildRec({
    diagnosedProblem: "",
    mechanism: "discountCodeBasicCreate is available",
    whyThisAction: "Revenue declined 12% this quarter",
    feasibleWriteOperations: ["discountCodeBasicCreate"],
  });
  assert.equal(validateSemanticRecommendation(rec, ctx).ok, false);
});

// ---------------------------------------------------------------------------
// Test F — Product copy non-sequitur: high returns without diagnosed content problem
// Same pattern: if returns are the only signal and there is no diagnosed content
// deficiency, diagnosedProblem cannot be non-empty truthfully.
// ---------------------------------------------------------------------------

test("Test F: recommendation fails when mechanism is empty (copy rewrite without evidence)", () => {
  const ctx = buildContext();
  const rec = buildRec({
    diagnosedProblem: "Product has high returns",
    mechanism: "",
    feasibleWriteOperations: ["productUpdate"],
  });
  assert.equal(validateSemanticRecommendation(rec, ctx).ok, false);
});
