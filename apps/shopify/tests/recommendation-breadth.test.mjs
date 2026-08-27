import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpportunitySurface,
  buildInvestigationState,
  generateAgenticShopifyRecommendation,
  initCoverageLedger,
  mergeCoverageUpdates,
  OPPORTUNITY_COVERAGE_STATUS,
  validateInvestigation,
} from "../app/lib/shopify/agentic-runtime/recommendation-agent.server.js";
import { SHOPIFY_GATEWAY_TOOL } from "../app/lib/shopify/gateway/tools.server.js";

// makeRetrieveResult/makeReadResult below build raw toolResults rows for direct
// validateInvestigation/buildInvestigationState unit tests — generic bookkeeping functions over an
// opaque toolResults array, not a dependency on the (removed) catalog dispatcher. Kept as literal
// catalog-era tool-name strings for backward compatibility with those functions' defaults.
const SHOPIFY_AGENT_TOOL = Object.freeze({
  retrieveOperations: "retrieve_shopify_operations",
  callOperation: "call_shopify_operation",
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCatalog(overrides = {}) {
  const defaults = {
    schemaVersion: "1",
    catalogId: "test-catalog",
    provider: "SHOPIFY",
    apiSurface: "admin_graphql",
    apiVersion: "2026-07",
    generatedAt: "2026-01-01T00:00:00.000Z",
    generatedFrom: {},
    operations: [
      {
        id: "op-products-q",
        operation: "products",
        operationKind: "QUERY",
        domain: "products",
        description: "Read products",
        requiredScopes: ["read_products"],
        arguments: [],
        inputObjects: {},
        enumTypes: {},
        returnType: "ProductConnection",
        deprecation: { deprecated: false, reason: null },
        document: "{ products { edges { node { id } } } }",
        tags: ["product", "catalogue"],
      },
      {
        id: "op-product-update",
        operation: "productUpdate",
        operationKind: "MUTATION",
        domain: "products",
        description: "Update a product",
        requiredScopes: ["write_products"],
        scopeConfidence: "high",
        safety: { riskTier: "NORMAL", reversibility: "REVERSIBLE", interaction: "APPROVAL_REQUIRED" },
        execution: { status: "EXECUTABLE", classificationSource: "EXPLICIT_KNOWN_GOOD", reason: "test fixture" },
        arguments: [],
        inputObjects: {},
        enumTypes: {},
        returnType: "ProductUpdatePayload",
        deprecation: { deprecated: false, reason: null },
        document: "mutation { productUpdate(input: {}) { product { id } } }",
        tags: ["product", "update"],
      },
      {
        id: "op-collections-q",
        operation: "collections",
        operationKind: "QUERY",
        domain: "collections",
        description: "Read collections",
        requiredScopes: ["read_products"],
        arguments: [],
        inputObjects: {},
        enumTypes: {},
        returnType: "CollectionConnection",
        deprecation: { deprecated: false, reason: null },
        document: "{ collections { edges { node { id } } } }",
        tags: ["collection", "merchandising"],
      },
      {
        id: "op-collection-create",
        operation: "collectionCreate",
        operationKind: "MUTATION",
        domain: "collections",
        description: "Create a collection",
        requiredScopes: ["write_products"],
        scopeConfidence: "high",
        safety: { riskTier: "NORMAL", reversibility: "REVERSIBLE", interaction: "APPROVAL_REQUIRED" },
        execution: { status: "EXECUTABLE_WITH_CONFIRMATION", classificationSource: "EXPLICIT_OPERATION_OVERRIDE", reason: "test fixture" },
        arguments: [],
        inputObjects: {},
        enumTypes: {},
        returnType: "CollectionCreatePayload",
        deprecation: { deprecated: false, reason: null },
        document: "mutation { collectionCreate(input: {}) { collection { id } } }",
        tags: ["collection", "create"],
      },
      {
        id: "op-inventory-q",
        operation: "inventoryLevels",
        operationKind: "QUERY",
        domain: "inventory",
        description: "Read inventory levels",
        requiredScopes: ["read_inventory"],
        arguments: [],
        inputObjects: {},
        enumTypes: {},
        returnType: "InventoryLevelConnection",
        deprecation: { deprecated: false, reason: null },
        document: "{ inventoryLevels { edges { node { id } } } }",
        tags: ["inventory"],
      },
      {
        id: "op-inventory-adjust",
        operation: "inventoryAdjustQuantities",
        operationKind: "MUTATION",
        domain: "inventory",
        description: "Adjust inventory quantities",
        requiredScopes: ["write_inventory"],
        scopeConfidence: "high",
        safety: { riskTier: "NORMAL", reversibility: "REVERSIBLE", interaction: "APPROVAL_REQUIRED" },
        execution: { status: "EXECUTABLE_WITH_CONFIRMATION", classificationSource: "REVIEWED_OPERATION_FAMILY_POLICY", reason: "test fixture" },
        arguments: [],
        inputObjects: {},
        enumTypes: {},
        returnType: "InventoryAdjustQuantitiesPayload",
        deprecation: { deprecated: false, reason: null },
        document: "mutation { inventoryAdjustQuantities(input: []) { userErrors { field message } } }",
        tags: ["inventory", "adjust"],
      },
    ],
  };
  return { ...defaults, ...overrides };
}

function makeGrantedScopes(...scopes) {
  return scopes;
}

function makeRetrieveResult() {
  return {
    tool: SHOPIFY_AGENT_TOOL.retrieveOperations,
    ok: true,
    message: "Retrieved 2 stubs.",
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

const BASE_SNAPSHOT = {
  beliefs: [
    { id: "b-1", key: "catalog.active_product_count", label: "Active products", authority: "deterministic", val: { count: 17 } },
    { id: "b-2", key: "products.cost_coverage", label: "Cost coverage", authority: "deterministic", val: { percentage: 0 } },
  ],
  goals: [],
  insights: [],
  goalCoaching: [],
  merchantContext: [],
  previousRecommendations: [],
  activeWork: [],
  privacy: {},
  beliefCount: 2,
};

function scriptedProvider(script) {
  const calls = [];
  return {
    enabled: true,
    provider: "test",
    model: "scripted",
    calls,
    async generateStructuredJson({ prompt }) {
      const payload = JSON.parse(prompt);
      calls.push(payload);
      return { json: script(payload, calls.length - 1), usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 };
    },
  };
}

function fakeClient() {
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
// surface, always on) — these build real GraphQL documents, matched by fakeClient's
// document.includes(...) checks above.
function readCall(operation = "products") {
  const document =
    operation === "collections"
      ? "query { collections(first: 5) { edges { node { id title } } } }"
      : "query { products(first: 5) { edges { node { id title } } } }";
  return { tool: SHOPIFY_GATEWAY_TOOL.query, arguments: { document } };
}

function coverageUpdate(familyId, status, reason = "Test reason.", evidenceRefs = []) {
  return { familyId, status, reason, evidenceRefs };
}

function validRec(overrides = {}) {
  return {
    title: "Improve product descriptions",
    summary: "Update product copy to improve discoverability.",
    outcome: "Products have complete descriptions.",
    scope: "Active products with empty descriptions.",
    constraints: [],
    materialExpectedEffects: ["Improve product copy"],
    diagnosedProblem: "Product descriptions are missing for active catalogue items.",
    mechanism: "Updating product body_html adds missing content that improves organic discoverability.",
    whyThisAction: "Products read showed empty description fields.",
    whyNow: "The gap is confirmed by current Shopify state.",
    supportingBeliefIds: [],
    supportingInsightIds: [],
    feasibleWriteOperations: ["productUpdate"],
    verificationPlan: "Read products back to verify description fields.",
    reversalStrategy: "Fixture reversal strategy.",
    confidence: "reasonable",
    ...overrides,
  };
}

async function runLoop(catalog, grantedScopes, script, overrides = {}) {
  const provider = scriptedProvider(script);
  const result = await generateAgenticShopifyRecommendation({
    provider,
    prisma: {
      shopifyOperationCall: { create: async () => ({}) },
      session: { findFirst: async () => ({ scope: grantedScopes.join(",") }) },
    },
    client: fakeClient(),
    merchantId: "00000000-0000-0000-0000-000000000031",
    shopId: "00000000-0000-0000-0000-000000000032",
    shopDomain: "jefe-test.myshopify.com",
    snapshot: BASE_SNAPSHOT,
    grantedScopes,
    catalog,
    logger: { info() {}, warn() {}, error() {} },
    ...overrides,
  });
  return { provider, result };
}

// ---------------------------------------------------------------------------
// Unit: buildOpportunitySurface
// ---------------------------------------------------------------------------

test("buildOpportunitySurface: derives families from catalog domains", () => {
  const catalog = makeCatalog();
  const surface = buildOpportunitySurface(catalog, ["read_products", "write_products", "read_inventory", "write_inventory"]);
  assert.equal(surface.families.length, 3, "3 domains with mutations");
  const ids = surface.families.map((f) => f.id).sort();
  assert.deepEqual(ids, ["collections", "inventory", "products"]);
});

test("buildOpportunitySurface: families with no mutations excluded", () => {
  const catalog = makeCatalog();
  // Add a query-only domain
  catalog.operations.push({
    id: "op-auth-q",
    operation: "currentAppInstallation",
    operationKind: "QUERY",
    domain: "authorization",
    description: "Check auth",
    requiredScopes: [],
    arguments: [],
    inputObjects: {},
    enumTypes: {},
    returnType: "AppInstallation",
    deprecation: { deprecated: false, reason: null },
    document: "{ currentAppInstallation { id } }",
    tags: [],
  });
  const surface = buildOpportunitySurface(catalog, ["read_products", "write_products"]);
  assert.ok(!surface.families.some((f) => f.id === "authorization"), "authorization excluded — no mutations");
});

test("buildOpportunitySurface: scope_missing when write scopes absent", () => {
  const catalog = makeCatalog();
  const surface = buildOpportunitySurface(catalog, ["read_products"]);
  // write_products not granted — products and collections mutations need it
  const products = surface.families.find((f) => f.id === "products");
  assert.equal(products?.capabilityState, "scope_missing");
  const collections = surface.families.find((f) => f.id === "collections");
  assert.equal(collections?.capabilityState, "scope_missing");
});

test("buildOpportunitySurface: available when write scope granted", () => {
  const catalog = makeCatalog();
  const surface = buildOpportunitySurface(catalog, ["read_products", "write_products"]);
  const products = surface.families.find((f) => f.id === "products");
  assert.equal(products?.capabilityState, "available");
});

test("buildOpportunitySurface: handles undefined catalog gracefully", () => {
  const surface = buildOpportunitySurface(undefined, ["write_products"]);
  assert.deepEqual(surface.families, []);
});

test("buildOpportunitySurface: comma-separated scope strings normalized", () => {
  const catalog = makeCatalog();
  const surface = buildOpportunitySurface(catalog, ["read_products,write_products"]);
  const products = surface.families.find((f) => f.id === "products");
  assert.equal(products?.capabilityState, "available");
});

test("buildOpportunitySurface: each family has writeOperations and readOperations", () => {
  const catalog = makeCatalog();
  const surface = buildOpportunitySurface(catalog, ["write_products"]);
  for (const family of surface.families) {
    assert.ok(Array.isArray(family.writeOperations), `${family.id} has writeOperations`);
    assert.ok(family.writeOperations.length > 0, `${family.id} has at least one write`);
    assert.ok(Array.isArray(family.readOperations), `${family.id} has readOperations`);
  }
});

// ---------------------------------------------------------------------------
// Unit: initCoverageLedger
// ---------------------------------------------------------------------------

test("initCoverageLedger: available families start UNASSESSED", () => {
  const surface = buildOpportunitySurface(makeCatalog(), ["write_products"]);
  const ledger = initCoverageLedger(surface);
  const available = ledger.filter((e) => e.status === OPPORTUNITY_COVERAGE_STATUS.unassessed);
  assert.ok(available.length > 0, "some families start UNASSESSED");
});

test("initCoverageLedger: scope_missing families start NON_EXECUTABLE", () => {
  const surface = buildOpportunitySurface(makeCatalog(), []);
  const ledger = initCoverageLedger(surface);
  assert.ok(ledger.every((e) => e.status === OPPORTUNITY_COVERAGE_STATUS.nonExecutable), "all NON_EXECUTABLE when no scopes");
});

test("initCoverageLedger: empty surface returns empty ledger", () => {
  const ledger = initCoverageLedger({ families: [] });
  assert.deepEqual(ledger, []);
});

// ---------------------------------------------------------------------------
// Unit: mergeCoverageUpdates
// ---------------------------------------------------------------------------

test("mergeCoverageUpdates: advances family to terminal status", () => {
  const surface = buildOpportunitySurface(makeCatalog(), ["write_products"]);
  const ledger = initCoverageLedger(surface);
  mergeCoverageUpdates(ledger, [coverageUpdate("products", OPPORTUNITY_COVERAGE_STATUS.notApplicable, "0 OOS products")]);
  const entry = ledger.find((e) => e.familyId === "products");
  assert.equal(entry?.status, OPPORTUNITY_COVERAGE_STATUS.notApplicable);
  assert.equal(entry?.reason, "0 OOS products");
});

test("mergeCoverageUpdates: does not regress from terminal status", () => {
  const surface = buildOpportunitySurface(makeCatalog(), ["write_products"]);
  const ledger = initCoverageLedger(surface);
  mergeCoverageUpdates(ledger, [coverageUpdate("products", OPPORTUNITY_COVERAGE_STATUS.rejected, "No gap found.")]);
  mergeCoverageUpdates(ledger, [coverageUpdate("products", OPPORTUNITY_COVERAGE_STATUS.unassessed, "Going back.")]);
  assert.equal(ledger.find((e) => e.familyId === "products")?.status, OPPORTUNITY_COVERAGE_STATUS.rejected);
});

test("mergeCoverageUpdates: ignores unknown familyId", () => {
  const ledger = [{ familyId: "products", label: "Products", status: OPPORTUNITY_COVERAGE_STATUS.unassessed, reason: null, evidenceRefs: [] }];
  mergeCoverageUpdates(ledger, [coverageUpdate("nonexistent", OPPORTUNITY_COVERAGE_STATUS.rejected)]);
  assert.equal(ledger[0].status, OPPORTUNITY_COVERAGE_STATUS.unassessed);
});

test("mergeCoverageUpdates: ignores invalid status values", () => {
  const ledger = [{ familyId: "products", label: "Products", status: OPPORTUNITY_COVERAGE_STATUS.unassessed, reason: null, evidenceRefs: [] }];
  mergeCoverageUpdates(ledger, [{ familyId: "products", status: "INVENTED_STATUS" }]);
  assert.equal(ledger[0].status, OPPORTUNITY_COVERAGE_STATUS.unassessed);
});

// ---------------------------------------------------------------------------
// Test 1 — First candidate blocked: investigation cannot terminate with second family unresolved
// ---------------------------------------------------------------------------

test("Test 1: BLOCKED rejected when second family is UNASSESSED", () => {
  const surface = buildOpportunitySurface(makeCatalog(), ["write_products"]);
  const ledger = initCoverageLedger(surface);
  // Resolve products only
  mergeCoverageUpdates(ledger, [coverageUpdate("products", OPPORTUNITY_COVERAGE_STATUS.blocked, "No cost data.")]);
  const toolResults = [makeRetrieveResult(), makeReadResult("products")];
  const result = validateInvestigation(toolResults, surface, ledger);
  assert.equal(result.ok, false);
  assert.equal(result.unresolved?.some((e) => e.familyId === "collections"), true, "collections still unresolved");
});

test("Test 1: BLOCKED allowed when all families resolved", () => {
  const surface = buildOpportunitySurface(makeCatalog(), ["write_products"]);
  const ledger = initCoverageLedger(surface);
  for (const family of surface.families) {
    mergeCoverageUpdates(ledger, [coverageUpdate(family.id, OPPORTUNITY_COVERAGE_STATUS.blocked, "No evidence.")]);
  }
  const toolResults = [makeRetrieveResult(), makeReadResult("products")];
  const result = validateInvestigation(toolResults, surface, ledger);
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// Test 2 — First candidate already satisfied: investigation must pivot
// ---------------------------------------------------------------------------

test("Test 2: BLOCKED rejected when collection-like candidate resolved but other families remain", () => {
  const surface = buildOpportunitySurface(makeCatalog(), ["write_products"]);
  const ledger = initCoverageLedger(surface);
  mergeCoverageUpdates(ledger, [coverageUpdate("collections", OPPORTUNITY_COVERAGE_STATUS.alreadySatisfied, "Collection already exists.")]);
  const toolResults = [makeRetrieveResult(), makeReadResult("collections")];
  const result = validateInvestigation(toolResults, surface, ledger);
  assert.equal(result.ok, false, "cannot conclude — products still UNASSESSED");
  assert.ok(result.unresolved?.some((e) => e.familyId === "products"), "products flagged as unresolved");
});

// ---------------------------------------------------------------------------
// Test 3 — Evidence resolves family without read
// ---------------------------------------------------------------------------

test("Test 3: NOT_APPLICABLE without reads is a valid disposition", () => {
  const surface = buildOpportunitySurface(makeCatalog(), ["write_products", "write_inventory"]);
  const ledger = initCoverageLedger(surface);
  // Mark inventory NOT_APPLICABLE from evidence — no read required
  mergeCoverageUpdates(ledger, [coverageUpdate("inventory", OPPORTUNITY_COVERAGE_STATUS.notApplicable, "0 OOS products, 0 at-risk stockouts.", ["catalog.out_of_stock_product_count"])]);
  mergeCoverageUpdates(ledger, [coverageUpdate("products", OPPORTUNITY_COVERAGE_STATUS.rejected, "No gap found.")]);
  mergeCoverageUpdates(ledger, [coverageUpdate("collections", OPPORTUNITY_COVERAGE_STATUS.rejected, "Collections adequate.")]);
  const toolResults = [makeRetrieveResult(), makeReadResult("products")];
  const result = validateInvestigation(toolResults, surface, ledger);
  // All families resolved — even though inventory had no read
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// Test 4 — NO_ACTIONABLE_OPPORTUNITY rejected with PLAUSIBLE family
// ---------------------------------------------------------------------------

test("Test 4: NO_ACTIONABLE_OPPORTUNITY rejected while PLAUSIBLE family exists", () => {
  const surface = buildOpportunitySurface(makeCatalog(), ["write_products"]);
  const ledger = initCoverageLedger(surface);
  mergeCoverageUpdates(ledger, [coverageUpdate("products", OPPORTUNITY_COVERAGE_STATUS.plausible, "Investigating...")]);
  const toolResults = [makeRetrieveResult(), makeReadResult("products")];
  const result = validateInvestigation(toolResults, surface, ledger);
  assert.equal(result.ok, false);
  assert.ok(result.unresolved?.some((e) => e.familyId === "products"), "PLAUSIBLE family in unresolved list");
});

// ---------------------------------------------------------------------------
// Test 5 — BLOCKED rejected with INVESTIGATING family
// ---------------------------------------------------------------------------

test("Test 5: BLOCKED rejected while INVESTIGATING family exists", () => {
  const surface = buildOpportunitySurface(makeCatalog(), ["write_products"]);
  const ledger = initCoverageLedger(surface);
  mergeCoverageUpdates(ledger, [coverageUpdate("products", OPPORTUNITY_COVERAGE_STATUS.blocked, "No cost data.")]);
  mergeCoverageUpdates(ledger, [coverageUpdate("collections", OPPORTUNITY_COVERAGE_STATUS.investigating, "Reading collections...")]);
  const toolResults = [makeRetrieveResult(), makeReadResult("products")];
  const result = validateInvestigation(toolResults, surface, ledger);
  assert.equal(result.ok, false);
  assert.ok(result.unresolved?.some((e) => e.familyId === "collections"), "INVESTIGATING family in unresolved");
});

// ---------------------------------------------------------------------------
// Test 6 — Fully resolved surface allows no_actionable_opportunity
// ---------------------------------------------------------------------------

test("Test 6: fully resolved surface passes validation", () => {
  const surface = buildOpportunitySurface(makeCatalog(), ["write_products"]);
  const ledger = initCoverageLedger(surface);
  const terminal = [OPPORTUNITY_COVERAGE_STATUS.rejected, OPPORTUNITY_COVERAGE_STATUS.blocked, OPPORTUNITY_COVERAGE_STATUS.alreadySatisfied];
  surface.families.forEach((f, i) =>
    mergeCoverageUpdates(ledger, [coverageUpdate(f.id, terminal[i % terminal.length], "Evidence-grounded.")]),
  );
  const toolResults = [makeRetrieveResult(), makeReadResult("products")];
  assert.equal(validateInvestigation(toolResults, surface, ledger).ok, true);
});

// ---------------------------------------------------------------------------
// Test 7 — Merchant preference ranks families, does not remove them
// ---------------------------------------------------------------------------

test("Test 7: opportunity surface includes all capability families regardless of merchant preference", () => {
  const catalog = makeCatalog();
  // Simulated merchant preference: revenue only
  const surface = buildOpportunitySurface(catalog, ["write_products", "write_inventory"]);
  // All 3 families present despite hypothetical revenue-only preference
  const ids = surface.families.map((f) => f.id);
  assert.ok(ids.includes("products"), "products family present");
  assert.ok(ids.includes("collections"), "collections family present");
  assert.ok(ids.includes("inventory"), "inventory family present");
});

// ---------------------------------------------------------------------------
// Test 8 — Dynamic capability removal
// ---------------------------------------------------------------------------

test("Test 8: removing a catalog operation removes corresponding family", () => {
  const catalog = makeCatalog();
  // Remove all inventory operations
  catalog.operations = catalog.operations.filter((op) => op.domain !== "inventory");
  const surface = buildOpportunitySurface(catalog, ["write_products", "write_inventory"]);
  assert.ok(!surface.families.some((f) => f.id === "inventory"), "inventory family absent when removed from catalog");
});

// ---------------------------------------------------------------------------
// Test 9 — Dynamic capability addition
// ---------------------------------------------------------------------------

test("Test 9: adding a new catalog mutation creates a new family automatically", () => {
  const catalog = makeCatalog();
  catalog.operations.push({
    id: "op-discount-create",
    operation: "discountCodeBasicCreate",
    operationKind: "MUTATION",
    domain: "discounts",
    description: "Create a discount code",
    requiredScopes: ["write_discounts"],
    scopeConfidence: "high",
    safety: { riskTier: "SENSITIVE", reversibility: "REVERSIBLE", interaction: "EXPLICIT_HIGH_RISK_CONFIRMATION_REQUIRED" },
    execution: { status: "EXECUTABLE_WITH_CONFIRMATION", classificationSource: "EXPLICIT_OPERATION_OVERRIDE", reason: "test fixture" },
    arguments: [],
    inputObjects: {},
    enumTypes: {},
    returnType: "DiscountCodeBasicCreatePayload",
    deprecation: { deprecated: false, reason: null },
    document: "mutation { discountCodeBasicCreate(basicCodeDiscount: {}) { codeDiscountNode { id } } }",
    tags: ["discount"],
  });
  const surface = buildOpportunitySurface(catalog, ["write_products", "write_discounts"]);
  assert.ok(surface.families.some((f) => f.id === "discounts"), "discounts family added automatically");
});

// ---------------------------------------------------------------------------
// Test 10 — Candidate-specific blocker doesn't contaminate other families
// ---------------------------------------------------------------------------

test("Test 10: cost blocker on products does not resolve collections family", () => {
  const surface = buildOpportunitySurface(makeCatalog(), ["write_products"]);
  const ledger = initCoverageLedger(surface);
  mergeCoverageUpdates(ledger, [coverageUpdate("products", OPPORTUNITY_COVERAGE_STATUS.blocked, "No authoritative cost data.")]);
  const collectionsEntry = ledger.find((e) => e.familyId === "collections");
  assert.equal(collectionsEntry?.status, OPPORTUNITY_COVERAGE_STATUS.unassessed, "collections still UNASSESSED after products blocked");
  const toolResults = [makeRetrieveResult(), makeReadResult("products")];
  const result = validateInvestigation(toolResults, surface, ledger);
  assert.equal(result.ok, false, "cannot conclude — collections still needs disposition");
});

// ---------------------------------------------------------------------------
// Test 11 — Turn budget exhausted with unresolved families → INVESTIGATION_INCOMPLETE
// ---------------------------------------------------------------------------

test("Test 11: budget exhaustion with unresolved families returns INVESTIGATION_INCOMPLETE, not no_actionable_opportunity", async () => {
  const catalog = makeCatalog();
  const grantedScopes = ["read_products", "write_products"];
  const { result } = await runLoop(
    catalog,
    grantedScopes,
    (payload, callIndex) => {
      if (callIndex === 0) {
        return {
          status: "CONTINUE",
          toolCalls: [readCall("products")],
          opportunityCoverage: [],
        };
      }
      // Never dispose of collections or inventory — keep returning CONTINUE with no progress
      return { status: "CONTINUE", toolCalls: [], opportunityCoverage: [] };
    },
    { maxIterations: 3 },
  );
  assert.equal(result.status, "INVESTIGATION_INCOMPLETE", "budget exhaustion with unresolved families is INVESTIGATION_INCOMPLETE");
  assert.ok(result.ok === false);
  assert.ok(typeof result.blocker === "string" && result.blocker.includes("unresolved"), "blocker identifies unresolved families");
});

// ---------------------------------------------------------------------------
// Test 12 — Existing Action coverage: ALREADY_COVERED for one family, others unaffected
// ---------------------------------------------------------------------------

test("Test 12: ALREADY_COVERED on one family does not resolve others", () => {
  const surface = buildOpportunitySurface(makeCatalog(), ["write_products"]);
  const ledger = initCoverageLedger(surface);
  mergeCoverageUpdates(ledger, [coverageUpdate("products", OPPORTUNITY_COVERAGE_STATUS.alreadyCovered, "Active productUpdate Action exists.")]);
  const collectionsEntry = ledger.find((e) => e.familyId === "collections");
  assert.equal(collectionsEntry?.status, OPPORTUNITY_COVERAGE_STATUS.unassessed, "collections unaffected");
  const toolResults = [makeRetrieveResult(), makeReadResult("products")];
  assert.equal(validateInvestigation(toolResults, surface, ledger).ok, false, "still unresolved");
});

// ---------------------------------------------------------------------------
// Test: buildInvestigationState.opportunityCoverage — ledger flows through state
// ---------------------------------------------------------------------------

test("buildInvestigationState: opportunityCoverage included when coverageLedger passed", () => {
  const surface = buildOpportunitySurface(makeCatalog(), ["write_products"]);
  const ledger = initCoverageLedger(surface);
  const state = buildInvestigationState([makeRetrieveResult(), makeReadResult("products")], { coverageLedger: ledger });
  assert.ok(Array.isArray(state.opportunityCoverage), "opportunityCoverage present");
  assert.ok(state.opportunityCoverage?.some((e) => e.familyId === "products"), "products entry present");
});

test("buildInvestigationState: investigationComplete false when unresolved families remain", () => {
  const surface = buildOpportunitySurface(makeCatalog(), ["write_products"]);
  const ledger = initCoverageLedger(surface);
  const state = buildInvestigationState([makeRetrieveResult(), makeReadResult("products")], { coverageLedger: ledger });
  assert.equal(state.investigationComplete, false, "not complete while UNASSESSED families remain");
  assert.equal(state.doNotRepeat, null, "doNotRepeat absent when not complete");
});

test("buildInvestigationState: investigationComplete true when all families resolved", () => {
  const surface = buildOpportunitySurface(makeCatalog(), ["write_products"]);
  const ledger = initCoverageLedger(surface);
  for (const entry of ledger) {
    entry.status = OPPORTUNITY_COVERAGE_STATUS.rejected;
  }
  const state = buildInvestigationState([makeRetrieveResult(), makeReadResult("products")], { coverageLedger: ledger });
  assert.equal(state.investigationComplete, true);
  assert.ok(state.doNotRepeat, "doNotRepeat present when complete");
});

test("buildInvestigationState: no coverageLedger — backward compatible investigationComplete", () => {
  const state = buildInvestigationState([makeRetrieveResult(), makeReadResult("products")]);
  assert.equal(state.investigationComplete, true, "legacy: complete after retrieve + read");
  assert.equal(state.opportunityCoverage, null, "no coverage when not provided");
});

// ---------------------------------------------------------------------------
// Loop: BLOCKED emits INSUFFICIENT_COVERAGE when unresolved families remain
// ---------------------------------------------------------------------------

test("Loop: BLOCKED with unresolved families triggers INSUFFICIENT_COVERAGE error and continues", async () => {
  const catalog = makeCatalog();
  const grantedScopes = ["read_products", "write_products"];
  let blockedAttempts = 0;

  const { result, provider } = await runLoop(
    catalog,
    grantedScopes,
    (payload, callIndex) => {
      const coverage = payload.investigationState?.opportunityCoverage ?? [];
      const unresolved = coverage.filter((e) =>
        [OPPORTUNITY_COVERAGE_STATUS.unassessed, OPPORTUNITY_COVERAGE_STATUS.plausible, OPPORTUNITY_COVERAGE_STATUS.investigating].includes(e?.status),
      );

      if (callIndex === 0) {
        return {
          status: "CONTINUE",
          toolCalls: [readCall("products")],
          opportunityCoverage: [],
        };
      }
      if (unresolved.length > 0 && blockedAttempts < 1) {
        blockedAttempts++;
        // Premature BLOCKED — unresolved families still remain
        return {
          status: "BLOCKED",
          blocker: "No cost data.",
          opportunityCoverage: [coverageUpdate("products", OPPORTUNITY_COVERAGE_STATUS.blocked, "No costs.")],
        };
      }
      // Now resolve remaining families and return a valid recommendation
      const allFamilies = coverage.map((e) => e.familyId);
      return {
        status: "RECOMMEND_ACTION",
        opportunityCoverage: allFamilies.map((id) => coverageUpdate(id, OPPORTUNITY_COVERAGE_STATUS.rejected, "No gap found.")),
        recommendation: validRec(),
      };
    },
    { maxIterations: 6 },
  );

  assert.ok(blockedAttempts >= 1, "BLOCKED was attempted at least once");
  // The loop should have pushed past the premature BLOCKED via INSUFFICIENT_COVERAGE repair
  const validationErrors = provider.calls.some((c) =>
    (c.toolResults ?? []).some((t) => t?.facts?.errorCode === "INSUFFICIENT_COVERAGE"),
  );
  assert.ok(validationErrors, "INSUFFICIENT_COVERAGE error injected after premature BLOCKED");
});

// ---------------------------------------------------------------------------
// Loop: successful recommendation with coverage carried through
// ---------------------------------------------------------------------------

test("Loop: successful recommendation includes opportunityCoverage in diagnostics", async () => {
  const catalog = makeCatalog();
  const grantedScopes = ["read_products", "write_products"];

  const { result } = await runLoop(
    catalog,
    grantedScopes,
    (payload, callIndex) => {
      if (callIndex === 0) {
        return {
          status: "CONTINUE",
          toolCalls: [readCall("products")],
          opportunityCoverage: [
            coverageUpdate("inventory", OPPORTUNITY_COVERAGE_STATUS.notApplicable, "0 OOS."),
          ],
        };
      }
      return {
        status: "RECOMMEND_ACTION",
        opportunityCoverage: [
          coverageUpdate("products", OPPORTUNITY_COVERAGE_STATUS.candidate, "Found gap in descriptions."),
          coverageUpdate("collections", OPPORTUNITY_COVERAGE_STATUS.rejected, "Collections adequate."),
        ],
        recommendation: validRec(),
      };
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, "RECOMMEND_ACTION");
  assert.ok(Array.isArray(result.diagnostics?.opportunityCoverage), "coverage in diagnostics");
  const productsCoverage = result.diagnostics.opportunityCoverage.find((e) => e.familyId === "products");
  assert.equal(productsCoverage?.status, OPPORTUNITY_COVERAGE_STATUS.candidate, "products coverage persisted");
});
