import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveCandidateScope,
  eligibilityEncodingForPrompt,
  evaluateResourceEligibility,
  explainWhyResourceQualifies,
  merchantEligibilityLabels,
  normalizeEligibilityCriteria,
  normalizeWriteProtections,
  revalidateWriteTargets,
  validateEligibilityCriteria,
  validatePromiseConsistency,
  verifyMembersAgainstCriteria,
} from "../app/lib/shopify/agentic-runtime/eligibility.server.js";
import {
  AGENTIC_RECOMMENDATION_SCHEMA,
  AGENTIC_SEMANTIC_REPAIR_SCHEMA,
  buildRecommendationSystemPrompt,
  buildSemanticRepairSystemPrompt,
  generateAgenticShopifyRecommendation,
  normalizeSemanticRecommendation,
  runFocusedSemanticRepair,
  validateSemanticRecommendation,
} from "../app/lib/shopify/agentic-runtime/recommendation-agent.server.js";
import {
  acceptAgenticShopifyAction,
  appendRevisionHistory,
  findRevisionSnapshot,
  materializeAgenticShopifyAction,
  revisionSnapshot,
  semanticActionFromRecommendation,
  semanticActionRevision,
} from "../app/lib/shopify/agentic-runtime/semantic-action.server.js";
import { buildActionWorkspace, workspacePlanItems } from "../app/lib/actions/action-workspace.server.js";
import { SHOPIFY_GATEWAY_TOOL } from "../app/lib/shopify/gateway/tools.server.js";

const merchantId = "00000000-0000-0000-0000-000000000021";
const shopId = "00000000-0000-0000-0000-000000000022";
const shopDomain = "jefe-local-store.myshopify.com";

const ACTIVE_BUNDLE = {
  id: "gid://shopify/Product/10375207780648",
  title: "Borderlands Discovery Four",
  status: "ACTIVE",
  productType: "Wine Bundle",
  available: 61,
};
const NEGATIVE_BUNDLE = {
  id: "gid://shopify/Product/10375207813416",
  title: "Cold Bench Six",
  status: "ACTIVE",
  productType: "Wine Bundle",
  available: -1,
};
const WHITE_WINE = {
  id: "gid://shopify/Product/9",
  title: "Pear Skin Sipon",
  status: "ACTIVE",
  productType: "White Wine",
  available: 12,
};

function activeWineBundleCriteria() {
  return normalizeEligibilityCriteria([
    { resourceType: "Product", field: "status", operator: "eq", value: "ACTIVE" },
    { resourceType: "Product", field: "productType", operator: "eq", value: "Wine Bundle" },
  ]);
}

function inStockWineBundleCriteria() {
  return normalizeEligibilityCriteria([
    ...activeWineBundleCriteria(),
    { resourceType: "Inventory", field: "available", operator: "gt", value: 0 },
  ]);
}

function bundleRecommendation(overrides = {}) {
  return normalizeSemanticRecommendation({
    title: overrides.title ?? "Complete the Cases & Bundles collection",
    summary: overrides.summary ?? "Add missing active Wine Bundle products to the existing collection.",
    outcome:
      overrides.outcome ??
      "Make the Cases & Bundles collection contain all currently active Wine Bundle products.",
    scope: overrides.scope ?? "Active Shopify products whose product type is Wine Bundle.",
    constraints: overrides.constraints ?? ["Do not change product pricing, inventory, product status, or product copy."],
    eligibilityCriteria: overrides.eligibilityCriteria ?? activeWineBundleCriteria(),
    writeProtections: overrides.writeProtections,
    materialExpectedEffects: overrides.materialExpectedEffects ?? ["Add missing Wine Bundle products to the collection"],
    diagnosedProblem: overrides.diagnosedProblem ?? "The collection omits an active Wine Bundle product.",
    mechanism: overrides.mechanism ?? "Adding the omitted product aligns collection membership with product type.",
    whyThisAction: overrides.whyThisAction ?? "This is a reversible merchandising correction.",
    whyNow: overrides.whyNow ?? "Wine Bundle is a commercially meaningful group.",
    supportingBeliefIds: overrides.supportingBeliefIds ?? ["b-1"],
    supportingInsightIds: [],
    feasibleWriteOperations: ["collectionAddProducts"],
    verificationPlan: "Read the collection back and confirm membership.",
    confidence: "reasonable",
  });
}

function buildContext() {
  return {
    merchantMemory: {
      beliefs: [{ id: "b-1", key: "products.revenue", authority: "deterministic" }],
      jefeHypotheses: { insights: [] },
    },
  };
}

function inStockCollectionCandidate() {
  return {
    title: "Create an In Stock collection",
    summary: "Create a storefront collection of currently sellable products.",
    outcome: "Shoppers can browse in-stock products.",
    scope: "Active products that are currently sellable.",
    constraints: ["Do not change prices or inventory."],
    eligibilityCriteria: [{ field: "status", operator: "eq", value: "ACTIVE" }],
    writeProtections: [{ target: "inventory", label: "Do not change inventory" }],
    materialExpectedEffects: ["Create a collection of currently sellable products"],
    diagnosedProblem: "No storefront collection groups the 17 products with positive available inventory.",
    mechanism: "Creating that collection gives shoppers a browse path for currently sellable products.",
    whyThisAction: "Shopify reads found 22 active products, 17 with stock, and no matching collection.",
    whyNow: "The discovery gap is current.",
    supportingBeliefIds: ["b-1"],
    supportingInsightIds: [],
    feasibleWriteOperations: ["collectionCreate", "collectionAddProducts"],
    verificationPlan: "Read the collection back and confirm membership matches current availability.",
    confidence: "reasonable",
  };
}

test("STRUCTURED ELIGIBILITY CRITERIA: predicates evaluate resource facts generically", () => {
  const criteria = inStockWineBundleCriteria();
  assert.equal(evaluateResourceEligibility(ACTIVE_BUNDLE, criteria).eligible, true);
  assert.equal(evaluateResourceEligibility(NEGATIVE_BUNDLE, criteria).eligible, false);
  assert.equal(evaluateResourceEligibility(WHITE_WINE, criteria).eligible, false);
  assert.deepEqual(evaluateResourceEligibility(NEGATIVE_BUNDLE, criteria).failed.map((row) => row.field), ["available"]);
});

test("NO INVENTORY RULE WHEN NOT PROMISED: active Wine Bundles qualify regardless of stock", () => {
  const criteria = activeWineBundleCriteria();
  assert.equal(evaluateResourceEligibility(NEGATIVE_BUNDLE, criteria).eligible, true);
  const scope = deriveCandidateScope({
    resources: [ACTIVE_BUNDLE, NEGATIVE_BUNDLE, WHITE_WINE],
    criteria,
  });
  assert.deepEqual(scope.items.map((row) => row.title), ["Borderlands Discovery Four", "Cold Bench Six"]);
});

test("IN-STOCK QUALIFIER ENCODED WHEN PROMISED: available <= 0 does not qualify", () => {
  const rec = bundleRecommendation({
    title: "Create an in-stock Wine Bundles collection",
    outcome: "A storefront collection of in-stock Wine Bundle products.",
    eligibilityCriteria: inStockWineBundleCriteria(),
  });
  assert.equal(validatePromiseConsistency(rec, rec.eligibilityCriteria).ok, true);
  const scope = deriveCandidateScope({
    resources: [ACTIVE_BUNDLE, NEGATIVE_BUNDLE],
    criteria: rec.eligibilityCriteria,
  });
  assert.deepEqual(scope.items.map((row) => row.title), ["Borderlands Discovery Four"]);
  assert.equal(scope.excluded[0].title, "Cold Bench Six");
});

test("MERCHANT-FACING PROMISE CONSISTENCY: in-stock wording without inventory criterion fails", () => {
  const rec = bundleRecommendation({
    title: "Create an in-stock Wine Bundles collection",
    outcome: "An in-stock Wine Bundles storefront destination.",
    eligibilityCriteria: activeWineBundleCriteria(),
  });
  const result = validateSemanticRecommendation(rec, buildContext());
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "PROMISE_CRITERIA_MISMATCH");
});

test("RECOMMENDATION → ACTION CRITERIA PRESERVED through hydration", () => {
  const semanticAction = semanticActionFromRecommendation(
    bundleRecommendation({
      eligibilityCriteria: inStockWineBundleCriteria(),
      title: "Create an in-stock Wine Bundles collection",
      outcome: "An in-stock Wine Bundles storefront destination.",
    }),
  );
  assert.equal(semanticAction.eligibilityCriteria.length, 3);
  assert.equal(semanticAction.eligibilityCriteria.some((row) => row.field === "available"), true);
  assert.equal(semanticAction.writeProtections.some((row) => row.target === "inventory"), true);
  assert.match(semanticActionRevision(semanticAction), /^sar_/);
});

test("ELIGIBILITY VS WRITE-PROTECTION SEPARATED", () => {
  const protections = normalizeWriteProtections(null, [
    "Do not change product pricing, inventory, product status, or product copy.",
  ]);
  assert.equal(protections.some((row) => row.target === "inventory"), true);
  const criteria = validateEligibilityCriteria([{ field: "available", operator: "gte", valueNumber: 10 }]);
  assert.equal(criteria.ok, true);
  assert.equal(criteria.criteria[0].field, "available");
  assert.equal(criteria.criteria[0].operator, "gte");
  assert.equal(criteria.criteria[0].value, 10);
});

test("ACTION REVISION INCLUDES CRITERIA: inventory threshold changes identity", () => {
  const base = semanticActionFromRecommendation(bundleRecommendation());
  const tighter = semanticActionFromRecommendation(
    bundleRecommendation({
      eligibilityCriteria: [...activeWineBundleCriteria(), { field: "available", operator: "gte", valueNumber: 10 }],
    }),
  );
  assert.notEqual(base.revision, tighter.revision);
});

test("MERCHANT CRITERIA EDITS and ORIGINAL RULE RESTORATION use revision history", () => {
  const original = semanticActionFromRecommendation(bundleRecommendation());
  const edited = semanticActionFromRecommendation(
    bundleRecommendation({
      eligibilityCriteria: [...activeWineBundleCriteria(), { field: "available", operator: "gte", valueNumber: 10 }],
    }),
  );
  const history = appendRevisionHistory([revisionSnapshot(original, "recommendation")], edited, "merchant");
  const restored = findRevisionSnapshot(history, { which: "original" });
  assert.notEqual(edited.revision, original.revision);
  assert.equal(edited.eligibilityCriteria.some((row) => row.field === "available" && row.operator === "gte"), true);
  assert.deepEqual(
    restored.eligibilityCriteria.map((row) => `${row.field}:${row.operator}:${row.value}`),
    ["status:eq:ACTIVE", "productType:eq:Wine Bundle"],
  );
});

test("PRE-WRITE ELIGIBILITY REVALIDATION blocks a now-ineligible product", () => {
  const result = revalidateWriteTargets({
    operation: "collectionAddProducts",
    variables: { productIds: [NEGATIVE_BUNDLE.id] },
    resources: [NEGATIVE_BUNDLE],
    criteria: inStockWineBundleCriteria(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ineligible[0].id, NEGATIVE_BUNDLE.id);
});

test("POST-WRITE CRITERIA VERIFICATION rejects ineligible membership", () => {
  const result = verifyMembersAgainstCriteria({
    members: [ACTIVE_BUNDLE, NEGATIVE_BUNDLE],
    criteria: inStockWineBundleCriteria(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].title, "Cold Bench Six");
});

test("UNRELATED ELIGIBILITY ACTION uses the same predicate mechanism for tags", () => {
  const criteria = normalizeEligibilityCriteria([
    { resourceType: "Product", field: "status", operator: "eq", value: "ACTIVE" },
    { resourceType: "Product", field: "tags", operator: "contains", value: "care-guidance" },
  ]);
  assert.equal(
    evaluateResourceEligibility(
      { id: "gid://shopify/Product/1", status: "ACTIVE", tags: ["care-guidance"], title: "London Jacket" },
      criteria,
    ).eligible,
    true,
  );
  assert.equal(
    evaluateResourceEligibility(
      { id: "gid://shopify/Product/2", status: "ACTIVE", tags: ["london-delivery"], title: "London Tote" },
      criteria,
    ).eligible,
    false,
  );
});

test("Action workspace presents merchant-language eligibility", async () => {
  const { action } = await materializeAgenticShopifyAction(fakePrisma(), {
    merchantId,
    shopId,
    recommendation: bundleRecommendation({
      title: "Create an in-stock Wine Bundles collection",
      outcome: "An in-stock Wine Bundles storefront destination.",
      eligibilityCriteria: inStockWineBundleCriteria(),
    }),
  });
  const workspace = buildActionWorkspace(action);
  const labels = merchantEligibilityLabels(workspace.eligibilityCriteria);
  assert.equal(workspace.eligibilityCriteria.length, 3);
  assert.equal(labels.some((row) => /in stock|available/i.test(row)), true);
  assert.equal(workspacePlanItems(workspace).some((row) => row.title === "Who qualifies"), true);
});

test("malformed eligibility criteria fail deterministic structure validation", () => {
  const result = validateEligibilityCriteria([{ field: "status", operator: "nearby", value: "ACTIVE" }]);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "INVALID_ELIGIBILITY_CRITERIA");
});

test("write-target revalidation requires current evidence before mutating", () => {
  const result = revalidateWriteTargets({
    operation: "collectionAddProducts",
    variables: { productIds: [NEGATIVE_BUNDLE.id] },
    resources: [],
    criteria: inStockWineBundleCriteria(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ineligible[0].id, NEGATIVE_BUNDLE.id);
});

test("eligibility explanation names which predicates passed or failed", () => {
  const why = explainWhyResourceQualifies(NEGATIVE_BUNDLE, inStockWineBundleCriteria());
  assert.equal(why.eligible, false);
  assert.match(why.explanation, /Active products: PASS/);
  assert.match(why.explanation, /Product type is Wine Bundle: PASS/);
  assert.match(why.explanation, /Currently in stock: FAIL/);
});

test("material eligibility change after acceptance makes the accepted revision stale", async () => {
  const prisma = fakePrisma();
  const { action } = await materializeAgenticShopifyAction(prisma, {
    merchantId,
    shopId,
    recommendation: bundleRecommendation(),
  });
  const accepted = await acceptAgenticShopifyAction(prisma, {
    merchantId,
    shopId,
    actionId: action.id,
    actor: "merchant",
  });
  const edited = semanticActionFromRecommendation(
    bundleRecommendation({
      eligibilityCriteria: [...activeWineBundleCriteria(), { field: "available", operator: "gte", valueNumber: 10 }],
    }),
  );
  prisma.actions[0].progress.agentic.semanticAction = edited;
  prisma.actions[0].progress.agentic.currentActionRevision = edited.revision;
  assert.equal(accepted.ok, true);
  assert.notEqual(
    prisma.actions[0].progress.agentic.currentActionRevision,
    prisma.actions[0].progress.agentic.acceptedActionRevision,
  );
});

test("operator aliases and inventory field aliases survive normalization", () => {
  const criteria = normalizeEligibilityCriteria([
    { resourceType: "Inventory", field: "totalInventory", operator: ">", valueNumber: 0 },
  ]);
  assert.equal(criteria[0].field, "available");
  assert.equal(criteria[0].operator, "gt");
  assert.equal(criteria[0].value, 0);
});

test("unrecognized operator is INVALID_ELIGIBILITY_CRITERIA instead of silent drop", () => {
  const rawCriteria = [{ field: "available", operator: "nearby", valueNumber: 0 }];
  const rec = bundleRecommendation({
    title: "Create an In Stock collection",
    outcome: "A collection of currently sellable products.",
    eligibilityCriteria: rawCriteria,
  });
  const result = validateSemanticRecommendation(rec, buildContext(), { eligibilityCriteria: rawCriteria });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "INVALID_ELIGIBILITY_CRITERIA");
});

test("recommendation contract treats structured eligibility as primary", () => {
  const prompt = buildRecommendationSystemPrompt();
  assert.match(prompt, /Structured eligibility is primary/);
  assert.match(prompt, /Merchant-facing title, summary, outcome and scope explain that structured contract/);
  assert.match(prompt, /Do not drop a useful qualifier/);
  assert.match(
    AGENTIC_RECOMMENDATION_SCHEMA.properties.recommendation.properties.eligibilityCriteria.description,
    /structured predicates/i,
  );
  assert.deepEqual(AGENTIC_SEMANTIC_REPAIR_SCHEMA.properties.repairChoice.enum, [
    "add_missing_criteria",
    "remove_unsupported_qualifiers",
  ]);
  assert.match(buildSemanticRepairSystemPrompt(), /two legitimate options/);
  assert.equal(eligibilityEncodingForPrompt().exampleCurrentAvailability.field, "available");
});

test("IMMUTABLE IN-STOCK SNAPSHOT: invalid combo is impossible; A and B remain valid", () => {
  const ctx = buildContext();
  const invalid = bundleRecommendation({
    title: "Create an In Stock collection for currently sellable products",
    summary: "Group currently sellable products into an In Stock storefront collection.",
    outcome: "Shoppers can browse products that are currently in stock.",
    scope: "Active products that are currently sellable.",
    eligibilityCriteria: [{ field: "status", operator: "eq", value: "ACTIVE" }],
  });
  assert.equal(validateSemanticRecommendation(invalid, ctx).errorCode, "PROMISE_CRITERIA_MISMATCH");

  const validA = bundleRecommendation({
    title: "Create an In Stock collection for currently sellable products",
    summary: "Group currently sellable products into an In Stock storefront collection.",
    outcome: "Shoppers can browse products that are currently in stock.",
    scope: "Active products that are currently sellable.",
    eligibilityCriteria: [
      { field: "status", operator: "eq", value: "ACTIVE" },
      { resourceType: "Inventory", field: "available", operator: "gt", valueNumber: 0 },
    ],
  });
  assert.equal(validateSemanticRecommendation(validA, ctx).ok, true);
  assert.equal(validA.eligibilityCriteria.some((row) => row.field === "available"), true);

  const validB = bundleRecommendation({
    title: "Create a collection for currently active products",
    summary: "Group active products into a storefront collection.",
    outcome: "Shoppers can browse active products.",
    scope: "Active products.",
    eligibilityCriteria: [{ field: "status", operator: "eq", value: "ACTIVE" }],
  });
  assert.equal(validateSemanticRecommendation(validB, ctx).ok, true);
  assert.equal(validB.eligibilityCriteria.some((row) => row.field === "available"), false);
});

test("FOCUSED SEMANTIC REPAIR: option A adds available; option B removes In Stock", async () => {
  const candidate = normalizeSemanticRecommendation(inStockCollectionCandidate());
  const validation = validateSemanticRecommendation(candidate, buildContext());
  assert.equal(validation.errorCode, "PROMISE_CRITERIA_MISMATCH");

  const add = await runFocusedSemanticRepair({
    provider: scriptedProvider(() => ({
      repairChoice: "add_missing_criteria",
      recommendation: {
        ...inStockCollectionCandidate(),
        eligibilityCriteria: [
          { field: "status", operator: "eq", value: "ACTIVE" },
          { resourceType: "Inventory", field: "available", operator: "gt", valueNumber: 0 },
        ],
      },
    })),
    candidate,
    rawCandidate: inStockCollectionCandidate(),
    validation,
    investigationState: { successfulReads: [], retrievedOperations: [] },
    toolResults: [],
    context: buildContext(),
  });
  assert.equal(add.repairChoice, "add_missing_criteria");
  assert.equal(add.validation.ok, true);
  assert.equal(add.recommendation.eligibilityCriteria.some((row) => row.field === "available"), true);

  const remove = await runFocusedSemanticRepair({
    provider: scriptedProvider(() => ({
      repairChoice: "remove_unsupported_qualifiers",
      recommendation: {
        ...inStockCollectionCandidate(),
        title: "Create a collection for active products",
        summary: "Group active products into a storefront collection.",
        outcome: "Shoppers can browse active products.",
        scope: "Active products.",
      },
    })),
    candidate,
    rawCandidate: inStockCollectionCandidate(),
    validation,
    investigationState: { successfulReads: [], retrievedOperations: [] },
    toolResults: [],
    context: buildContext(),
  });
  assert.equal(remove.repairChoice, "remove_unsupported_qualifiers");
  assert.equal(remove.validation.ok, true);
  assert.equal(remove.recommendation.eligibilityCriteria.some((row) => row.field === "available"), false);
});

// investigateThenRecommendInvalidInStock: turn 1 investigates (CONTINUE + a shopify_query call,
// satisfying the "at least one successful read" investigation-sufficiency gate), turn 2 proposes
// the (criteria-invalid) recommendation with no further toolCalls. Two turns, not one: since the
// docs/ops/gateway-bad-graphql-root-cause-2026-08-25 fix, a terminal status may never be paired
// with a pending toolCall in the same turn (see "a terminal status paired with a pending toolCall
// is provisional" above) — a real model that wants to both read and decide must do so as two turns.
function investigateThenRecommendInvalidInStock() {
  let calls = 0;
  return () => {
    calls += 1;
    if (calls === 1) {
      return {
        status: "CONTINUE",
        toolCalls: [
          {
            tool: SHOPIFY_GATEWAY_TOOL.query,
            arguments: { document: "query { products(first: 5) { edges { node { id title status } } } }" },
          },
        ],
      };
    }
    return recommendInvalidInStock();
  };
}

test("FOCUSED SEMANTIC REPAIR: one repair then persist or VALIDATION_FAILED, no investigation loop", async () => {
  const investigateThenRecommendSuccess = investigateThenRecommendInvalidInStock();
  const success = await runRecommendationRepairLoop((payload) => {
    if (payload.mode === "semantic_repair") {
      return {
        repairChoice: "add_missing_criteria",
        recommendation: {
          ...payload.candidateRecommendation,
          eligibilityCriteria: [
            { field: "status", operator: "eq", value: "ACTIVE" },
            { resourceType: "Inventory", field: "available", operator: "gt", valueNumber: 0 },
          ],
        },
      };
    }
    return investigateThenRecommendSuccess();
  });
  assert.equal(success.result.ok, true);
  assert.equal(success.provider.calls.filter((row) => row.mode === "candidate_investigation").length, 2);
  assert.equal(success.provider.calls.filter((row) => row.mode === "semantic_repair").length, 1);
  assert.equal(success.result.diagnostics.semanticRepair.ok, true);
  assert.equal(success.result.trace.turns.some((turn) => turn.status === "SEMANTIC_REPAIR" && turn.toolCalls.length === 0), true);

  const investigateThenRecommendFailed = investigateThenRecommendInvalidInStock();
  const failed = await runRecommendationRepairLoop((payload) => {
    if (payload.mode === "semantic_repair") {
      return { repairChoice: "add_missing_criteria", recommendation: payload.candidateRecommendation };
    }
    return investigateThenRecommendFailed();
  });
  assert.equal(failed.result.ok, false);
  assert.equal(failed.result.status, "VALIDATION_FAILED");
  assert.equal(failed.provider.calls.filter((row) => row.mode === "semantic_repair").length, 1);
  assert.equal(failed.provider.calls.filter((row) => row.mode === "candidate_investigation").length, 2);
  assert.equal(failed.result.diagnostics.semanticRepair.errorCode, "PROMISE_CRITERIA_MISMATCH");
});

// Regression for docs/ops/gateway-bad-graphql-root-cause-2026-08-25: a terminal status paired with
// a pending toolCall in the same turn must not be honored immediately. A real run reproduced Luna
// issuing a fallback shopify_query alongside "BLOCKED" (its first read had returned null), the
// fallback query succeeded with the real data, and the old loop discarded that result and returned
// BLOCKED anyway because it only re-consulted the model when status === "CONTINUE". The tool call
// the model itself requested must always be seen before any terminal status is honored.
test("a terminal status paired with a pending toolCall is provisional, not final", async () => {
  let investigationCalls = 0;
  const { provider, result } = await runRecommendationRepairLoop((payload) => {
    if (payload.mode === "semantic_repair") {
      throw new Error("semantic repair should not be reached in this test");
    }
    investigationCalls += 1;
    if (investigationCalls === 1) {
      // First turn: declares BLOCKED but also fires off a read it hasn't seen the result of yet.
      return {
        status: "BLOCKED",
        blocker: "Product existence not yet confirmed.",
        toolCalls: [
          {
            tool: SHOPIFY_GATEWAY_TOOL.query,
            arguments: { document: "query { products(first: 5) { edges { node { id title status } } } }" },
          },
        ],
      };
    }
    // Second turn: now that the model has seen the (successful) read from turn 1, it recommends —
    // a criteria-consistent recommendation, so this reaches RECOMMEND_ACTION with no repair needed.
    return { status: "RECOMMEND_ACTION", recommendation: bundleRecommendation() };
  });
  assert.equal(
    provider.calls.filter((row) => row.mode === "candidate_investigation").length,
    2,
    "the model must be re-consulted with the executed tool result before BLOCKED is honored",
  );
  // The second call's investigation state must show the first turn's shopify_query as a completed,
  // successful read — proving the result reached the model rather than being discarded.
  const secondCallToolResults = provider.calls.filter((row) => row.mode === "candidate_investigation")[1].toolResults;
  assert.ok(
    secondCallToolResults.some((row) => row.tool === SHOPIFY_GATEWAY_TOOL.query && row.ok === true),
    "the fallback read's success must be visible to the model on the next turn",
  );
  assert.equal(result.status, "RECOMMEND_ACTION");
});

function recommendInvalidInStock() {
  // No toolCalls: this simulates a converged turn (the model is done investigating and is only
  // proposing a recommendation). A turn that pairs RECOMMEND_ACTION with a pending toolCall is a
  // different, deliberately-tested case — see "a terminal status paired with a pending toolCall is
  // provisional" below — and must loop back with the tool result rather than being treated as final.
  return {
    status: "RECOMMEND_ACTION",
    recommendation: inStockCollectionCandidate(),
  };
}

async function runRecommendationRepairLoop(script) {
  const provider = scriptedProvider(script);
  const result = await generateAgenticShopifyRecommendation({
    provider,
    prisma: fakePrisma(),
    client: fakeShopifyClient(),
    merchantId,
    shopId,
    shopDomain,
    snapshot: {
      beliefs: [{ id: "b-1", key: "products.revenue", authority: "deterministic" }],
      goals: [],
      insights: [],
      goalCoaching: [],
    },
    grantedScopes: ["read_products", "write_products"],
    focusCandidate: {
      candidateId: "eligibility-repair-1",
      diagnosedProblem: "No storefront collection groups the 17 products with positive available inventory.",
      priority: 1,
      businessEvidenceRefs: ["b-1"],
    },
    catalog: tinyCatalog(),
    maxIterations: 3,
    logger: quietLogger,
  });
  return { provider, result };
}

function tinyCatalog() {
  return {
    schemaVersion: "test",
    catalogId: "tiny-eligibility",
    provider: "SHOPIFY",
    apiSurface: "admin_graphql",
    apiVersion: "2026-07",
    generatedAt: "2026-08-22T00:00:00Z",
    generatedFrom: {},
    operations: [
      {
        id: "products",
        operation: "products",
        operationKind: "QUERY",
        domain: "products",
        description: "List products and inventory.",
        requiredScopes: ["read_products"],
        arguments: [{ name: "first", type: "Int", required: false }],
        inputObjects: {},
        enumTypes: {},
        returnType: "ProductConnection",
        deprecation: { deprecated: false, reason: null },
        document: "query products($first: Int) { products(first: $first) { edges { node { id title } } pageInfo { hasNextPage } } }",
        tags: ["products", "inventory"],
      },
    ],
  };
}

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
        return {
          currentAppInstallation: {
            accessScopes: [{ handle: "read_products" }, { handle: "write_products" }],
          },
        };
      }
      if (document.includes("products(")) {
        return {
          products: {
            edges: [
              { node: { ...ACTIVE_BUNDLE, totalInventory: ACTIVE_BUNDLE.available } },
              { node: { ...NEGATIVE_BUNDLE, totalInventory: NEGATIVE_BUNDLE.available } },
            ],
            pageInfo: { hasNextPage: false },
          },
        };
      }
      return {};
    },
  };
}

function fakePrisma() {
  const prisma = {
    actions: [],
    events: [],
    operationCalls: [],
    $transaction: async (run) => run(prisma),
    merchantAction: {
      create: async ({ data }) => {
        const row = { id: `action-${prisma.actions.length + 1}`, ...data, createdAt: new Date(), updatedAt: new Date() };
        prisma.actions.push(row);
        return row;
      },
      findFirst: async ({ where }) =>
        prisma.actions.find(
          (row) =>
            (!where.id || row.id === where.id) &&
            (!where.merchantId || row.merchantId === where.merchantId) &&
            (!where.shopId || row.shopId === where.shopId),
        ) ?? null,
      update: async ({ where, data }) => {
        const row = prisma.actions.find((item) => item.id === where.id);
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
      updateMany: async ({ where, data }) => {
        for (const row of prisma.actions) {
          if (row.id === where.id) Object.assign(row, data);
        }
        return { count: 1 };
      },
    },
    merchantActionEvent: {
      create: async ({ data }) => {
        prisma.events.push(data);
        return data;
      },
      findMany: async () => prisma.events,
    },
    actionChangeSet: { findFirst: async () => null },
    shopifyOperationCall: {
      create: async ({ data }) => {
        prisma.operationCalls.push(data);
        return data;
      },
      findMany: async () => prisma.operationCalls,
    },
  };
  return prisma;
}

const quietLogger = { info() {}, warn() {}, error() {} };
