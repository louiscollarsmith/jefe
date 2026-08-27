// Sequential exhaustion test (Task 3 §7 follow-on): simulates a merchant clicking "generate
// another recommendation" 6 times in a row against a store that genuinely has only 5
// independent, materially distinct opportunities. Calls 1-5 must each surface a different real
// domain opportunity; call 6 — once the store is genuinely exhausted — must return
// NO_ACTIONABLE_OPPORTUNITY with a rejection funnel that balances (every remaining candidate has
// a deterministic blocker, nothing silently vanishes).
//
// This is a mechanics test, not a discovery-quality test: we script discovery directly (a
// closure counting how many times discovery has already been called) rather than asking an LLM
// to genuinely invent 5 distinct ideas — the point is to prove runCandidateDrivenRecommendation
// keeps investigating until nothing grounded remains, and then stops honestly, not to prove Luna
// can generate 5 ideas unaided.

import assert from "node:assert/strict";
import test from "node:test";

import { runCandidateDrivenRecommendation } from "../app/lib/shopify/agentic-runtime/candidate-pipeline.server.js";
import {
  scriptedProvider,
  fakeShopifyClient,
  baseInput,
  candidateFixture,
  validRec,
  investigate,
  readCall,
} from "./helpers/agentic-recommendation-fixtures.mjs";

const ALL_GRANTED_SCOPES = [
  "read_products",
  "write_products",
  "read_customers",
  "write_customers",
  "read_inventory",
  "write_inventory",
  "read_discounts",
  "write_discounts",
  "read_online_store_navigation",
  "write_online_store_navigation",
];

const SNAPSHOT = {
  beliefs: [
    { id: "b-catalog", key: "catalog.draft_product_count", category: "catalog", authority: "deterministic", value: { count: 1 } },
    { id: "b-customer", key: "customers.rfm_segment_mix.all_time", category: "customers", authority: "deterministic", value: { atRisk: { count: 9 } } },
    { id: "b-discount", key: "business.discount_concentration.trailing_90d", category: "business", authority: "deterministic", value: { topDiscountedProduct: { productId: "gid://shopify/Product/501" } } },
    { id: "b-inventory", key: "inventory.low_cover_products.trailing_30d", category: "inventory", authority: "deterministic", value: { items: [{ productId: "gid://shopify/Product/701" }] } },
    { id: "b-navigation", key: "products.bestseller_by_revenue.trailing_90d", category: "products", authority: "deterministic", value: { productId: "gid://shopify/Product/301" } },
  ],
  goals: [],
  insights: [],
  goalCoaching: [],
  merchantContext: [],
  previousRecommendations: [],
  privacy: {},
  beliefCount: 5,
};

const CLIENT = fakeShopifyClient(
  {
    "products(": { products: { edges: [{ node: { id: "gid://shopify/Product/1", title: "Test Wine", status: "DRAFT" } }] }, pageInfo: { hasNextPage: false } },
    "customers(": { customers: { edges: [{ node: { id: "gid://shopify/Customer/1", displayName: "At Risk One" } }] }, pageInfo: { hasNextPage: false } },
    "codeDiscountNodes(": { codeDiscountNodes: { edges: [{ node: { id: "gid://shopify/DiscountCodeNode/1" } }] }, pageInfo: { hasNextPage: false } },
    "locations(": { locations: { edges: [{ node: { id: "gid://shopify/Location/2", name: "Downtown Pop-up", isActive: true } }] }, pageInfo: { hasNextPage: false } },
    "menus(": { menus: { edges: [{ node: { id: "gid://shopify/Menu/1", handle: "main-menu", items: [] } }] }, pageInfo: { hasNextPage: false } },
  },
  { grantedScopes: ALL_GRANTED_SCOPES },
);

// 5 independent, materially distinct, real-domain opportunities. Each targets a different
// operation and a different explicit resource so their action fingerprints (see
// action-fingerprint.server.js) could never collide, even though this test doesn't itself wire
// novelty checking.
const ROUNDS = [
  {
    candidateId: "round-1-activate-draft-product",
    diagnosedProblem: "A stocked product is DRAFT and invisible to customers.",
    relevantFamilyId: "products",
    businessEvidenceRefs: ["b-catalog"],
    readOp: "products",
    op: "productUpdate",
    targetId: "gid://shopify/Product/1",
  },
  {
    candidateId: "round-2-winback-at-risk-customers",
    diagnosedProblem: "9 champion-tier customers have gone quiet (RFM at-risk segment).",
    relevantFamilyId: "customers",
    businessEvidenceRefs: ["b-customer"],
    readOp: "customers",
    op: "customerUpdate",
    targetId: "gid://shopify/Customer/1",
  },
  {
    candidateId: "round-3-replace-blanket-discount",
    diagnosedProblem: "The blanket discount code is concentrated on one already-strong product.",
    relevantFamilyId: "discounts_promotions",
    businessEvidenceRefs: ["b-discount"],
    readOp: "codeDiscountNodes",
    op: "discountCodeBasicCreate",
    targetId: "gid://shopify/DiscountCodeNode/1",
  },
  {
    candidateId: "round-4-activate-second-location-stock",
    diagnosedProblem: "A low-cover product has unactivated on-hand stock at a second location.",
    relevantFamilyId: "inventory",
    businessEvidenceRefs: ["b-inventory"],
    readOp: "locations",
    op: "inventoryActivate",
    targetId: "gid://shopify/InventoryItem/9101",
  },
  {
    candidateId: "round-5-add-collection-to-nav",
    diagnosedProblem: "The flagship product's collection has no link in the primary navigation menu.",
    relevantFamilyId: "navigation",
    businessEvidenceRefs: ["b-navigation"],
    readOp: "menus",
    op: "menuUpdate",
    targetId: "gid://shopify/Menu/1",
  },
];

// Round 6: the store is genuinely exhausted. Every candidate offered has a distinct, real,
// deterministic terminal disposition — none of them recommend anything.
const ROUND_6_DOOMED = [
  { candidateId: "doomed-already-satisfied", diagnosedProblem: "The draft product was already published by the merchant.", disposition: "ALREADY_SATISFIED", status: "NO_ACTIONABLE_OPPORTUNITY" },
  { candidateId: "doomed-non-executable", diagnosedProblem: "Store-wide loyalty-tier redesign has no safe single Shopify write.", disposition: "NON_EXECUTABLE", status: "BLOCKED" },
  { candidateId: "doomed-rejected", diagnosedProblem: "Suspected duplicate product listing did not hold up against a Shopify read.", disposition: "REJECTED", status: "NO_ACTIONABLE_OPPORTUNITY" },
];

test("Sequential exhaustion: 5 distinct recommendations then honest NO_ACTIONABLE_OPPORTUNITY on the 6th", async () => {
  const provider = scriptedProvider((payload, calls) => {
    if (payload.mode === "candidate_discovery") {
      const round = calls.filter((c) => c.mode === "candidate_discovery").length; // 1-indexed, includes this call
      const winner = ROUNDS[round - 1];
      if (winner) {
        // The winner is always priority 1, so filler candidates from other, not-yet-used rounds
        // are never actually investigated (the pipeline stops at the first RECOMMEND_ACTION) —
        // they exist only to prove a single-candidate queue isn't a precondition for winning.
        const fillers = ROUNDS.filter((r) => r.candidateId !== winner.candidateId).slice(0, 2);
        return {
          candidates: [
            candidateFixture(winner.candidateId, winner.diagnosedProblem, 1, {
              businessEvidenceRefs: winner.businessEvidenceRefs,
              relevantFamilyId: winner.relevantFamilyId,
            }),
            ...fillers.map((f, i) =>
              candidateFixture(`filler-${round}-${f.candidateId}`, f.diagnosedProblem, i + 2, {
                businessEvidenceRefs: f.businessEvidenceRefs,
                relevantFamilyId: f.relevantFamilyId,
              }),
            ),
          ],
        };
      }
      // Round 6: genuinely exhausted. Every candidate offered is doomed.
      return {
        candidates: ROUND_6_DOOMED.map((d, i) => candidateFixture(d.candidateId, d.diagnosedProblem, i + 1, { relevantFamilyId: null })),
      };
    }
    if (payload.mode === "rescue_discovery") {
      return { candidates: [] };
    }
    // candidate_investigation
    const candidateId = payload.focusCandidate?.candidateId;
    const winner = ROUNDS.find((r) => r.candidateId === candidateId);
    if (winner) {
      return investigate(
        {
          status: "RECOMMEND_ACTION",
          recommendation: validRec({
            title: `Act on ${winner.candidateId}`,
            diagnosedProblem: winner.diagnosedProblem,
            mechanism: `${winner.op} implements this.`,
            supportingBeliefIds: winner.businessEvidenceRefs,
            feasibleWriteOperations: [winner.op],
            eligibilityCriteria: [{ resourceType: "Resource", field: "id", operator: "eq", value: winner.targetId }],
          }),
        },
        { toolCalls: [readCall(winner.readOp)] },
      )(payload);
    }
    if (String(candidateId).startsWith("filler-")) {
      throw new Error(`unexpected candidate investigated: ${candidateId} — the pipeline should stop at the priority-1 winner`);
    }
    const doomed = ROUND_6_DOOMED.find((d) => d.candidateId === candidateId);
    if (doomed) {
      return investigate({ status: doomed.status, blocker: doomed.diagnosedProblem, candidateDisposition: doomed.disposition })(payload);
    }
    throw new Error(`unexpected candidate investigated: ${candidateId}`);
  });

  const seenOperations = [];
  for (let call = 1; call <= 5; call += 1) {
    const result = await runCandidateDrivenRecommendation(
      baseInput({ provider, snapshot: SNAPSHOT, client: CLIENT, grantedScopes: ALL_GRANTED_SCOPES }),
    );
    assert.equal(result.status, "RECOMMEND_ACTION", `call ${call} should recommend an action`);
    const op = result.recommendation.feasibleWriteOperations[0];
    assert.ok(op, `call ${call} should have a feasibleWriteOperations entry`);
    seenOperations.push(op);
  }

  assert.deepEqual(
    seenOperations,
    ["productUpdate", "customerUpdate", "discountCodeBasicCreate", "inventoryActivate", "menuUpdate"],
    "each of the 5 sequential calls should surface a distinct domain's write operation",
  );
  assert.equal(new Set(seenOperations).size, 5, "all 5 operations must be distinct");

  // Call 6: the store is genuinely exhausted.
  const finalResult = await runCandidateDrivenRecommendation(
    baseInput({ provider, snapshot: SNAPSHOT, client: CLIENT, grantedScopes: ALL_GRANTED_SCOPES }),
  );
  assert.equal(finalResult.status, "NO_ACTIONABLE_OPPORTUNITY");
  assert.equal(finalResult.ok, true);
  const funnel = finalResult.diagnostics.rejectionFunnel;
  assert.equal(funnel.recommended, 0);
  assert.equal(funnel.total, funnel.rejected, "the reconciliation must balance: every remaining candidate has a deterministic blocker");
  assert.equal(funnel.total, ROUND_6_DOOMED.length);
});
