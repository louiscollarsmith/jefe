import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInvestigationState,
  buildRecommendationContext,
  findExistingRead,
  generateAgenticShopifyRecommendation,
  normalizeSemanticRecommendation,
  validateInvestigation,
  validateSemanticRecommendation,
} from "../app/lib/shopify/agentic-runtime/recommendation-agent.server.js";
import { SHOPIFY_GATEWAY_TOOL } from "../app/lib/shopify/gateway/tools.server.js";

// findExistingRead/validateInvestigation/buildInvestigationState are generic bookkeeping
// functions over an opaque `toolResults` array — they accept discoveryToolName/readToolName as
// options and default to these literal catalog-era tool-name strings for backward compatibility.
// Using them here is not a dependency on the (removed) catalog dispatcher: nothing below routes a
// tool call through it — see gatewayQueryCall/readCall further down for the tests that exercise
// real dispatch, which are gateway-shaped.
const SHOPIFY_AGENT_TOOL = Object.freeze({
  retrieveOperations: "retrieve_shopify_operations",
  callOperation: "call_shopify_operation",
});

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

test("buildInvestigationState: lastCandidate and lastValidationError survive a repair turn", () => {
  const candidate = makeRec({ supportingBeliefIds: ["bad-belief-id"] });
  const toolResults = [
    makeRetrieveResult(),
    makeReadResult("products"),
    makeValidationError("UNSUPPORTED_BELIEF_ID", {
      field: "supportingBeliefIds",
      invalidValues: ["bad-belief-id"],
      allowedValues: ["b-valid-1"],
      repairInstruction: "Replace only the invalid id.",
    }),
  ];
  const state = buildInvestigationState(toolResults, { lastCandidate: candidate });
  assert.equal(state.investigationComplete, true);
  assert.equal(state.lastCandidate.diagnosedProblem, candidate.diagnosedProblem);
  assert.equal(state.lastCandidate.mechanism, candidate.mechanism);
  assert.equal(state.lastValidationError.errorCode, "UNSUPPORTED_BELIEF_ID");
  assert.equal(state.lastValidationError.field, "supportingBeliefIds");
  assert.deepEqual(state.lastValidationError.invalidValues, ["bad-belief-id"]);
  assert.ok(state.lastValidationError.allowedValues.includes("b-valid-1"));
});

// ---------------------------------------------------------------------------
// findExistingRead — duplicate vs genuine new read
// ---------------------------------------------------------------------------

test("Test D: findExistingRead matches identical successful operation+variables", () => {
  const existing = findExistingRead(
    [makeReadResult("products")],
    { tool: SHOPIFY_AGENT_TOOL.callOperation, arguments: { operation: "products", variables: {} } },
  );
  assert.ok(existing);
  assert.equal(existing.facts.operation, "products");
});

test("Test D: findExistingRead ignores ALREADY_AVAILABLE rows when looking for a source read", () => {
  const existing = findExistingRead(
    [makeAlreadyAvailableResult("products")],
    { tool: SHOPIFY_AGENT_TOOL.callOperation, arguments: { operation: "products" } },
  );
  assert.equal(existing, null);
});

test("Test E: findExistingRead allows a different operation", () => {
  const existing = findExistingRead(
    [makeReadResult("products")],
    { tool: SHOPIFY_AGENT_TOOL.callOperation, arguments: { operation: "collections", variables: {} } },
  );
  assert.equal(existing, null);
});

test("Test E: findExistingRead allows the same operation with different variables", () => {
  const prior = {
    ...makeReadResult("products"),
    facts: { operation: "products", status: "SUCCESS", variables: { first: 5 }, data: {} },
  };
  const existing = findExistingRead(
    [prior],
    { tool: SHOPIFY_AGENT_TOOL.callOperation, arguments: { operation: "products", variables: { first: 50, query: "tag:organic" } } },
  );
  assert.equal(existing, null);
});

test("findExistingRead does not reuse a failed first read", () => {
  const failed = {
    tool: SHOPIFY_AGENT_TOOL.callOperation,
    ok: false,
    message: "products failed",
    facts: { operation: "products", status: "DENIED", variables: { first: 5 } },
    error: { code: "DENIED", message: "denied" },
  };
  const existing = findExistingRead(
    [failed],
    { tool: SHOPIFY_AGENT_TOOL.callOperation, arguments: { operation: "products", variables: { first: 5 } } },
  );
  assert.equal(existing, null);
});

test("Test D: validateInvestigation requires a real successful read, not ALREADY_AVAILABLE", () => {
  assert.equal(validateInvestigation([makeRetrieveResult(), makeAlreadyAvailableResult("products")]).ok, false);
  assert.equal(validateInvestigation([makeRetrieveResult(), makeReadResult("products")]).ok, true);
});

// ---------------------------------------------------------------------------
// Loop-level Tests A, D, F, G, H
// ---------------------------------------------------------------------------

const LOOP_SNAPSHOT = {
  beliefs: [VALID_BELIEF, VALID_BELIEF_2],
  goals: [{ id: "goal-1", title: "Grow revenue", generatedBy: "jefe_llm", authority: "jefe_interpretation" }],
  insights: [VALID_INSIGHT],
  goalCoaching: [],
  merchantContext: [],
  previousRecommendations: [],
  privacy: {},
  beliefCount: 2,
};

function scriptedProvider(script) {
  const calls = [];
  return {
    enabled: true,
    provider: "test",
    model: "scripted-luna",
    calls,
    async generateStructuredJson({ prompt }) {
      const payload = JSON.parse(prompt);
      calls.push(payload);
      return { json: script(payload), usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 };
    },
  };
}

function fakeShopifyClient() {
  return {
    async request(document) {
      if (document.includes("currentAppInstallation")) {
        return { currentAppInstallation: { accessScopes: [{ handle: "read_products" }, { handle: "write_products" }] } };
      }
      if (document.includes("products(")) {
        return { products: { edges: [{ node: { id: "gid://shopify/Product/1", title: "Test Wine" } }], pageInfo: { hasNextPage: false } } };
      }
      if (document.includes("collections(")) {
        return { collections: { edges: [], pageInfo: { hasNextPage: false } } };
      }
      return {};
    },
  };
}

// Loop tests below exercise real dispatch through generateAgenticShopifyRecommendation (gateway
// surface, always on) — these build real GraphQL documents, matched by fakeShopifyClient's
// document.includes(...) checks above.
function readCall(operation = "products") {
  const document =
    operation === "collections"
      ? "query { collections(first: 5) { edges { node { id title } } } }"
      : "query { products(first: 5) { edges { node { id title } } } }";
  return { tool: SHOPIFY_GATEWAY_TOOL.query, arguments: { document } };
}

function validLoopRec(overrides = {}) {
  return {
    title: "Create a type collection",
    summary: "Group products that currently have no collection.",
    outcome: "Shoppers can browse by type.",
    scope: "Active catalogue products.",
    constraints: [],
    materialExpectedEffects: ["Create a collection"],
    diagnosedProblem: "Shopify has zero collections for a 22-product catalogue.",
    mechanism: "Creating type collections adds browse paths that do not exist.",
    whyThisAction: "The collections read confirmed the gap.",
    whyNow: "The gap is current.",
    supportingBeliefIds: ["b-valid-1"],
    supportingInsightIds: [],
    feasibleWriteOperations: ["collectionCreate"],
    verificationPlan: "Read the collection back.",
    confidence: "reasonable",
    ...overrides,
  };
}

async function runLoop(script, overrides = {}) {
  const provider = scriptedProvider(script);
  const result = await generateAgenticShopifyRecommendation({
    provider,
    prisma: {
      shopifyOperationCall: { create: async () => ({}) },
      session: { findFirst: async () => ({ scope: "read_products,write_products" }) },
    },
    client: fakeShopifyClient(),
    merchantId: "00000000-0000-0000-0000-000000000021",
    shopId: "00000000-0000-0000-0000-000000000022",
    shopDomain: "jefe-local-store.myshopify.com",
    snapshot: LOOP_SNAPSHOT,
    grantedScopes: ["read_products", "write_products"],
    logger: { info() {}, warn() {}, error() {} },
    ...overrides,
  });
  return { provider, result };
}

test("Test A: repair after invalid candidate does not require another products read", async () => {
  const { provider, result } = await runLoop((payload) => {
    if (payload.iteration === 0) {
      return { status: "CONTINUE", toolCalls: [readCall("products")] };
    }
    if (payload.iteration === 1) {
      assert.equal(payload.investigationState.investigationComplete, true);
      return { status: "RECOMMEND_ACTION", recommendation: validLoopRec({ supportingBeliefIds: ["invented-belief"] }) };
    }
    assert.equal(payload.investigationState.investigationComplete, true);
    assert.equal(payload.investigationState.lastValidationError.errorCode, "UNSUPPORTED_BELIEF_ID");
    assert.equal(payload.investigationState.lastCandidate.diagnosedProblem, "Shopify has zero collections for a 22-product catalogue.");
    assert.ok(!payload.investigationState.lastValidationError.repairInstruction.toLowerCase().includes("retrieve"));
    return { status: "RECOMMEND_ACTION", recommendation: validLoopRec() };
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "RECOMMEND_ACTION");
  assert.equal(provider.calls.length, 3);
  const realProductReads = result.diagnostics.shopifyReads.filter((row) => row.operation === "products" && row.status !== "ALREADY_AVAILABLE" && row.ok);
  assert.equal(realProductReads.length, 1);
});

test("Test D: identical Shopify read is returned as ALREADY_AVAILABLE and not re-executed", async () => {
  let productReads = 0;
  const client = {
    async request(document) {
      if (document.includes("currentAppInstallation")) {
        return { currentAppInstallation: { accessScopes: [{ handle: "read_products" }] } };
      }
      if (document.includes("products(")) {
        productReads += 1;
        return { products: { edges: [], pageInfo: { hasNextPage: false } } };
      }
      return {};
    },
  };
  const { result } = await runLoop(
    (payload) => {
      if (payload.iteration === 0) return { status: "CONTINUE", toolCalls: [readCall("products")] };
      if (payload.iteration === 1) return { status: "CONTINUE", toolCalls: [readCall("products")] };
      return { status: "RECOMMEND_ACTION", recommendation: validLoopRec() };
    },
    { client },
  );

  assert.equal(result.ok, true);
  assert.equal(productReads, 1);
  assert.ok(result.diagnostics.shopifyReads.some((row) => row.status === "ALREADY_AVAILABLE"));
});

test("Test E: a different operation is executed as a genuine new read", async () => {
  const operations = [];
  const client = {
    async request(document) {
      if (document.includes("currentAppInstallation")) {
        return { currentAppInstallation: { accessScopes: [{ handle: "read_products" }] } };
      }
      if (document.includes("products(")) {
        operations.push("products");
        return { products: { edges: [], pageInfo: { hasNextPage: false } } };
      }
      if (document.includes("collections(")) {
        operations.push("collections");
        return { collections: { edges: [], pageInfo: { hasNextPage: false } } };
      }
      return {};
    },
  };
  const { result } = await runLoop(
    (payload) => {
      if (payload.iteration === 0) return { status: "CONTINUE", toolCalls: [readCall("products")] };
      if (payload.iteration === 1) return { status: "CONTINUE", toolCalls: [readCall("collections")] };
      return { status: "RECOMMEND_ACTION", recommendation: validLoopRec() };
    },
    { client },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(operations, ["products", "collections"]);
  assert.equal(result.diagnostics.shopifyReads.filter((row) => row.status === "ALREADY_AVAILABLE").length, 0);
});

test("Test F: later semantic validation failure does not reset investigationComplete", async () => {
  const { provider, result } = await runLoop((payload) => {
    if (payload.iteration === 0) return { status: "CONTINUE", toolCalls: [readCall("products")] };
    if (payload.iteration === 1) {
      assert.equal(payload.investigationState.investigationComplete, true);
      return { status: "RECOMMEND_ACTION", recommendation: validLoopRec({ supportingBeliefIds: ["nope"] }) };
    }
    assert.equal(payload.investigationState.investigationComplete, true);
    assert.equal(payload.investigationState.lastValidationError.errorCode, "UNSUPPORTED_BELIEF_ID");
    return { status: "RECOMMEND_ACTION", recommendation: validLoopRec({ supportingInsightIds: ["nope-insight"] }) };
  }, { maxIterations: 3 });

  assert.equal(result.ok, false);
  assert.equal(result.status, "VALIDATION_FAILED");
  assert.equal(provider.calls.at(-1).investigationState.investigationComplete, true);
});

test("Test G: lastCandidate keeps diagnosedProblem and mechanism during an evidence-id repair", async () => {
  const { provider } = await runLoop((payload) => {
    if (payload.iteration === 0) return { status: "CONTINUE", toolCalls: [readCall("products")] };
    if (payload.iteration === 1) {
      return {
        status: "RECOMMEND_ACTION",
        recommendation: validLoopRec({
          diagnosedProblem: "Zero collections exist for 22 products",
          mechanism: "A collection creates the missing browse path",
          supportingBeliefIds: ["invented"],
        }),
      };
    }
    assert.equal(payload.investigationState.lastCandidate.diagnosedProblem, "Zero collections exist for 22 products");
    assert.equal(payload.investigationState.lastCandidate.mechanism, "A collection creates the missing browse path");
    assert.equal(payload.investigationState.lastValidationError.field, "supportingBeliefIds");
    return {
      status: "RECOMMEND_ACTION",
      recommendation: validLoopRec({
        diagnosedProblem: "Zero collections exist for 22 products",
        mechanism: "A collection creates the missing browse path",
      }),
    };
  });
  assert.equal(provider.calls.length, 3);
});

test("Test H: explicit BLOCKED terminates after investigation instead of hitting the iteration limit", async () => {
  const { result } = await runLoop((payload) => {
    if (payload.iteration === 0) return { status: "CONTINUE", toolCalls: [readCall("products")] };
    return {
      status: "BLOCKED",
      blocker: "Investigated inventory and collections. No safe reversible Shopify Action is justified until warehouse counts are confirmed.",
    };
  }, { maxIterations: 6 });

  assert.equal(result.ok, false);
  assert.equal(result.status, "BLOCKED");
  assert.match(result.blocker, /warehouse counts/);
  assert.ok(result.diagnostics.shopifyReads.some((row) => row.operation === "products" && row.ok));
});
