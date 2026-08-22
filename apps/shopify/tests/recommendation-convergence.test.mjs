import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInvestigationState,
  buildRecommendationContext,
  normalizeSemanticRecommendation,
  validateSemanticRecommendation,
} from "../app/lib/shopify/agentic-runtime/recommendation-agent.server.js";
import { SHOPIFY_AGENT_TOOL } from "../app/lib/shopify/agentic-runtime/tools.server.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_BELIEF = { id: "b-valid-1", key: "inventory.available", category: "inventory", label: "Test", val: null, value: null, type: "string", status: "inferred", authority: "deterministic", confidence: 0.9, evidence: [] };
const VALID_BELIEF_2 = { id: "b-valid-2", key: "products.revenue", category: "products", label: "Revenue", val: null, value: null, type: "string", status: "inferred", authority: "deterministic", confidence: 0.9, evidence: [] };
const VALID_INSIGHT = { id: "ins-valid-1", title: "Test insight", generatedBy: "jefe_llm", authority: "jefe_interpretation" };

function makeContext(overrides = {}) {
  return buildRecommendationContext({
    beliefs: overrides.beliefs ?? [VALID_BELIEF, VALID_BELIEF_2],
    goals: [{ id: "goal-1", title: "Grow revenue", generatedBy: "jefe_llm", authority: "jefe_interpretation" }],
    insights: overrides.insights ?? [VALID_INSIGHT],
    goalCoaching: [],
    merchantContext: [],
    previousRecommendations: [],
    privacy: {},
    beliefCount: (overrides.beliefs ?? [VALID_BELIEF, VALID_BELIEF_2]).length,
  });
}

function makeRec(overrides = {}) {
  return normalizeSemanticRecommendation({
    title: overrides.title ?? "Test action",
    summary: overrides.summary ?? "A test recommendation.",
    outcome: overrides.outcome ?? "Improved outcome.",
    scope: overrides.scope ?? "All products",
    constraints: [],
    materialExpectedEffects: overrides.materialExpectedEffects ?? ["Increase visibility"],
    diagnosedProblem: overrides.diagnosedProblem ?? "A specific gap in current Shopify state",
    mechanism: overrides.mechanism ?? "The proposed change directly addresses that gap",
    whyThisAction: "Evidence supports this.",
    whyNow: "Problem is current.",
    supportingBeliefIds: overrides.supportingBeliefIds ?? [],
    supportingInsightIds: overrides.supportingInsightIds ?? [],
    feasibleWriteOperations: overrides.feasibleWriteOperations ?? ["collectionCreate"],
    verificationPlan: "Verify after execution.",
    confidence: "reasonable",
    assumption: null,
    caveat: null,
  });
}

function makeRetrieveResult() {
  return {
    tool: SHOPIFY_AGENT_TOOL.retrieveOperations,
    ok: true,
    message: "Retrieved 3 Shopify operation stubs.",
    facts: { query: "products", results: [{ operation: "products" }, { operation: "collections" }] },
    error: null,
  };
}

function makeReadResult(operation = "products") {
  return {
    tool: SHOPIFY_AGENT_TOOL.callOperation,
    ok: true,
    message: `${operation} completed.`,
    facts: { operation, status: "SUCCESS", data: {} },
    error: null,
  };
}

function makeAlreadyAvailableResult(operation = "products") {
  return {
    tool: SHOPIFY_AGENT_TOOL.callOperation,
    ok: true,
    message: `ALREADY_AVAILABLE: ${operation} was already read.`,
    facts: { operation, status: "ALREADY_AVAILABLE" },
    error: null,
  };
}

function makeValidationError(code, overrides = {}) {
  return {
    tool: "recommendation_validation",
    ok: false,
    message: `Validation failed: ${code}`,
    facts: { errorCode: code, ...overrides },
    error: { code, message: `Validation failed: ${code}` },
  };
}

// ---------------------------------------------------------------------------
// Test A — Successful investigation persists after validation failure
// ---------------------------------------------------------------------------

test("Test A: investigationState.investigationComplete remains true after validation failure", () => {
  const toolResults = [
    makeRetrieveResult(),
    makeReadResult("products"),
    makeValidationError("UNSUPPORTED_BELIEF_ID", { field: "supportingBeliefIds", invalidValues: ["bad-id"], allowedValues: ["b-valid-1"] }),
  ];
  const state = buildInvestigationState(toolResults);
  assert.equal(state.investigationComplete, true, "Investigation should remain complete after validation failure");
  assert.ok(state.doNotRepeat, "doNotRepeat should be present when investigation is complete");
  assert.ok(state.satisfiedRequirements.some((r) => r.includes("retrieved")), "Should show operations retrieved");
  assert.ok(state.satisfiedRequirements.some((r) => r.includes("products")), "Should show products read");
});

test("Test A: validation error does not reset satisfied requirements", () => {
  const toolResults = [
    makeRetrieveResult(),
    makeReadResult("products"),
    makeReadResult("collections"),
    makeValidationError("INVALID_RECOMMENDATION"),
  ];
  const state = buildInvestigationState(toolResults);
  assert.equal(state.successfulReads.length, 2);
  assert.equal(state.investigationComplete, true);
  assert.equal(state.satisfiedRequirements.filter((r) => r.includes("✓")).length, 3); // retrieve + 2 reads
});

// ---------------------------------------------------------------------------
// Test B — Invalid belief ID repair
// ---------------------------------------------------------------------------

test("Test B: validateSemanticRecommendation identifies exact invalid belief id", () => {
  const ctx = makeContext();
  const rec = makeRec({ supportingBeliefIds: ["b-valid-1", "bad-belief-id"] });
  const result = validateSemanticRecommendation(rec, ctx);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "UNSUPPORTED_BELIEF_ID");
  assert.equal(result.field, "supportingBeliefIds");
  assert.deepEqual(result.invalidValues, ["bad-belief-id"]);
  assert.ok(Array.isArray(result.allowedValues), "allowedValues should be present");
  assert.ok(result.allowedValues.includes("b-valid-1"), "allowedValues should include valid id");
  assert.ok(result.allowedValues.includes("b-valid-2"), "allowedValues should include all valid ids");
  assert.ok(result.repairInstruction, "repairInstruction should be present");
  assert.ok(result.repairInstruction.includes("b-valid-1") || result.repairInstruction.includes("allowedValues"), "repairInstruction should reference the fix");
});

test("Test B: valid belief ids pass after repair", () => {
  const ctx = makeContext();
  const rec = makeRec({ supportingBeliefIds: ["b-valid-1"] });
  const result = validateSemanticRecommendation(rec, ctx);
  assert.equal(result.ok, true, "Valid id should pass");
});

// ---------------------------------------------------------------------------
// Test C — Invalid insight ID repair
// ---------------------------------------------------------------------------

test("Test C: validateSemanticRecommendation identifies exact invalid insight id", () => {
  const ctx = makeContext();
  const rec = makeRec({ supportingInsightIds: ["bad-insight-id"] });
  const result = validateSemanticRecommendation(rec, ctx);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "UNSUPPORTED_INSIGHT_ID");
  assert.equal(result.field, "supportingInsightIds");
  assert.deepEqual(result.invalidValues, ["bad-insight-id"]);
  assert.ok(result.allowedValues.includes("ins-valid-1"), "allowedValues should contain valid insight id");
  assert.ok(result.repairInstruction, "repairInstruction should be present");
});

test("Test C: valid insight id passes", () => {
  const ctx = makeContext();
  const rec = makeRec({ supportingInsightIds: ["ins-valid-1"] });
  assert.deepEqual(validateSemanticRecommendation(rec, ctx), { ok: true });
});

// ---------------------------------------------------------------------------
// Test D — Duplicate read detection via buildInvestigationState
// ---------------------------------------------------------------------------

test("Test D: duplicate read is recorded as ALREADY_AVAILABLE in investigation state", () => {
  const toolResults = [
    makeRetrieveResult(),
    makeReadResult("products"),
    makeAlreadyAvailableResult("products"),
  ];
  const state = buildInvestigationState(toolResults);
  assert.equal(state.successfulReads.length, 1, "Only one real read");
  assert.equal(state.investigationComplete, true, "Still complete");
  assert.ok(state.satisfiedRequirements.some((r) => r.includes("already available")), "Should mention already-available");
});

test("Test D: ALREADY_AVAILABLE read does not count toward validateInvestigation successful reads", () => {
  // Only duplicate reads with status ALREADY_AVAILABLE — no real reads
  const toolResults = [
    makeRetrieveResult(),
    makeAlreadyAvailableResult("products"),
  ];
  const state = buildInvestigationState(toolResults);
  assert.equal(state.successfulReads.length, 0, "No real successful reads");
  assert.equal(state.investigationComplete, false, "Not complete — only dup reads");
});

// ---------------------------------------------------------------------------
// Test E — Genuine new read is allowed
// ---------------------------------------------------------------------------

test("Test E: buildInvestigationState records different operations separately", () => {
  const toolResults = [
    makeRetrieveResult(),
    makeReadResult("products"),
    makeReadResult("collections"),
  ];
  const state = buildInvestigationState(toolResults);
  assert.equal(state.successfulReads.length, 2);
  assert.ok(state.successfulReads.some((r) => r.operation === "products"));
  assert.ok(state.successfulReads.some((r) => r.operation === "collections"));
  assert.equal(state.investigationComplete, true);
});

// ---------------------------------------------------------------------------
// Test F — Investigation requirement persistence after semantic failure
// ---------------------------------------------------------------------------

test("Test F: investigation remains satisfied through multiple validation errors", () => {
  const toolResults = [
    makeRetrieveResult(),
    makeReadResult("products"),
    makeValidationError("UNSUPPORTED_BELIEF_ID"),
    makeValidationError("UNSUPPORTED_BELIEF_ID"),
    makeValidationError("MISSING_FIELD", { field: "mechanism" }),
  ];
  const state = buildInvestigationState(toolResults);
  assert.equal(state.investigationComplete, true);
  assert.equal(state.successfulReads.length, 1);
  // Validation errors don't appear in satisfiedRequirements
  assert.ok(!state.satisfiedRequirements.some((r) => r.includes("validation")));
});

// ---------------------------------------------------------------------------
// Test G — Valid mechanism preserved through belief ID repair
// ---------------------------------------------------------------------------

test("Test G: error on supportingBeliefIds does not corrupt diagnosedProblem or mechanism", () => {
  const ctx = makeContext();
  const rec = makeRec({
    diagnosedProblem: "Shopify has zero collections despite 22 products across 5 wine types",
    mechanism: "Creating type-specific collections gives each wine style a direct browse path",
    supportingBeliefIds: ["bad-belief-99"],
  });
  const result = validateSemanticRecommendation(rec, ctx);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "UNSUPPORTED_BELIEF_ID");
  // diagnosedProblem and mechanism are not mentioned in the error
  assert.ok(!result.error.includes("diagnosedProblem"), "diagnosedProblem is not the problem");
  assert.ok(!result.error.includes("mechanism"), "mechanism is not the problem");
  // After repair (replace belief id), the rest of the rec is unchanged
  const repaired = makeRec({
    diagnosedProblem: "Shopify has zero collections despite 22 products across 5 wine types",
    mechanism: "Creating type-specific collections gives each wine style a direct browse path",
    supportingBeliefIds: ["b-valid-1"],
  });
  assert.deepEqual(validateSemanticRecommendation(repaired, ctx), { ok: true });
});

// ---------------------------------------------------------------------------
// Test H — Genuine blocker terminates without iteration limit
// ---------------------------------------------------------------------------

test("Test H: buildInvestigationState reflects complete investigation even when concluding BLOCKED", () => {
  // Simulate: retrieve → read → investigation satisfied → conclude BLOCKED
  const toolResults = [
    makeRetrieveResult(),
    makeReadResult("products"),
  ];
  const state = buildInvestigationState(toolResults);
  assert.equal(state.investigationComplete, true, "BLOCKED can be returned once investigation is complete");
  assert.equal(state.satisfiedRequirements.length, 2); // retrieve + products read
});

// ---------------------------------------------------------------------------
// Test I — No validation weakening: missing mechanism still fails
// ---------------------------------------------------------------------------

test("Test I: recommendation without mechanism still fails validation", () => {
  const ctx = makeContext();
  const rec = makeRec({ mechanism: "" });
  const result = validateSemanticRecommendation(rec, ctx);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "MISSING_FIELD");
  assert.equal(result.field, "mechanism");
});

test("Test I: recommendation without diagnosedProblem still fails validation", () => {
  const ctx = makeContext();
  const rec = makeRec({ diagnosedProblem: "" });
  const result = validateSemanticRecommendation(rec, ctx);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "MISSING_FIELD");
  assert.equal(result.field, "diagnosedProblem");
});

// ---------------------------------------------------------------------------
// buildInvestigationState — edge cases
// ---------------------------------------------------------------------------

test("buildInvestigationState: empty toolResults returns incomplete state", () => {
  const state = buildInvestigationState([]);
  assert.equal(state.investigationComplete, false);
  assert.equal(state.satisfiedRequirements.length, 0);
  assert.equal(state.doNotRepeat, null);
});

test("buildInvestigationState: retrieve only (no read) is not complete", () => {
  const state = buildInvestigationState([makeRetrieveResult()]);
  assert.equal(state.investigationComplete, false);
  assert.ok(state.satisfiedRequirements.some((r) => r.includes("retrieved")));
});

test("buildInvestigationState: read only (no retrieve) is not complete", () => {
  const state = buildInvestigationState([makeReadResult("products")]);
  assert.equal(state.investigationComplete, false);
  assert.ok(state.successfulReads.some((r) => r.operation === "products"));
});
