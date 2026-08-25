// Cross-domain competition tests (Task 3 §7 follow-on): proves the candidate-driven pipeline
// mechanism itself is domain-blind and strictly rank-driven when several materially different
// domains compete in a single discovery response.
//
// IMPORTANT — what this test does and does NOT prove: ranking candidates by evidence strength is
// the *real* LLM's (Luna's) judgment call, and that judgment is evaluated live (see
// docs/ops/agentic-shopify-runtime-v1.md and the eval harness), not by a scripted unit test — a
// scripted provider cannot exercise semantic judgment because we are the ones supplying the
// ranking. What this test DOES prove is the pipeline mechanism around that judgment: given a
// discovery response with candidates from different domains and different `priority` values,
// runCandidateDrivenRecommendation (see app/lib/shopify/agentic-runtime/candidate-pipeline.server.js's
// discoverCandidates, which sorts strictly by priority ascending) never re-orders, filters, or
// biases investigation order by domain — it investigates in priority order and stops at the
// first RECOMMEND_ACTION, full stop. So whichever domain the (real) discovery call ranks first is
// exactly the one investigated and won; the pipeline adds no domain-based thumb on the scale in
// either direction. Each test below re-uses the same three candidates and only changes which one
// is assigned priority 1, to isolate that mechanism from any notion of "which domain is
// inherently better."

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
];

const SNAPSHOT = {
  beliefs: [
    { id: "b-customer", key: "customers.rfm_segment_mix.all_time", category: "customers", authority: "deterministic", value: { atRisk: { count: 9, revenueAtStake: 4100 } } },
    { id: "b-catalog", key: "catalog.draft_product_count", category: "catalog", authority: "deterministic", value: { count: 1 } },
    { id: "b-inventory", key: "inventory.low_cover_products.trailing_30d", category: "inventory", authority: "deterministic", value: { items: [{ productId: "gid://shopify/Product/701", daysOfCover: 3 }] } },
    { id: "b-discount", key: "business.discount_concentration.trailing_90d", category: "business", authority: "deterministic", value: { topDiscountedProduct: { productId: "gid://shopify/Product/501", discountSharePercent: 76 } } },
  ],
  goals: [],
  insights: [],
  goalCoaching: [],
  merchantContext: [],
  previousRecommendations: [],
  privacy: {},
  beliefCount: 4,
};

const CLIENT = fakeShopifyClient(
  {
    "customers(": { customers: { edges: [{ node: { id: "gid://shopify/Customer/1", displayName: "At Risk One" } }] }, pageInfo: { hasNextPage: false } },
    "products(": { products: { edges: [{ node: { id: "gid://shopify/Product/1", title: "Test Wine", status: "DRAFT" } }] }, pageInfo: { hasNextPage: false } },
    "locations(": { locations: { edges: [{ node: { id: "gid://shopify/Location/2", name: "Downtown Pop-up", isActive: true } }] }, pageInfo: { hasNextPage: false } },
    "codeDiscountNodes(": { codeDiscountNodes: { edges: [{ node: { id: "gid://shopify/DiscountCodeNode/1" } }] }, pageInfo: { hasNextPage: false } },
  },
  { grantedScopes: ALL_GRANTED_SCOPES },
);

// Each entry: candidateId, diagnosedProblem, relevantFamilyId, the read used to verify it, and
// the recommendation it would legitimately produce if reached. Every one of these would reach
// RECOMMEND_ACTION on its own (each is proven independently in
// tests/recommendation-domain-fixtures.test.mjs) — the only variable under test is `priority`.
const CANDIDATES = {
  customer: {
    candidateId: "winback-at-risk-customers",
    diagnosedProblem: "9 champion-tier customers have gone quiet (RFM at-risk segment), representing £4,100 of repeat revenue at stake.",
    relevantFamilyId: "customers",
    businessEvidenceRefs: ["b-customer"],
    readOp: "customers",
    op: "customerUpdate",
  },
  product: {
    candidateId: "activate-draft-product",
    diagnosedProblem: "A stocked product is DRAFT and invisible to customers.",
    relevantFamilyId: "products",
    businessEvidenceRefs: ["b-catalog"],
    readOp: "products",
    op: "productUpdate",
  },
  inventory: {
    candidateId: "activate-second-location-stock",
    diagnosedProblem: "A low-cover bestseller has unactivated on-hand stock at a second location.",
    relevantFamilyId: "inventory",
    businessEvidenceRefs: ["b-inventory"],
    readOp: "locations",
    op: "inventoryActivate",
  },
  discount: {
    candidateId: "replace-blanket-discount",
    diagnosedProblem: "The blanket discount code is concentrated 76% on one already-strong product.",
    relevantFamilyId: "discounts_promotions",
    businessEvidenceRefs: ["b-discount"],
    readOp: "codeDiscountNodes",
    op: "discountCodeBasicCreate",
  },
};

/** Build a discovery response from a { domainKey: priority } map. */
function discoveryCandidates(priorities) {
  return Object.entries(priorities).map(([domainKey, priority]) => {
    const c = CANDIDATES[domainKey];
    return candidateFixture(c.candidateId, c.diagnosedProblem, priority, {
      businessEvidenceRefs: c.businessEvidenceRefs,
      relevantFamilyId: c.relevantFamilyId,
    });
  });
}

/**
 * A provider that, for whichever candidate is investigated, records it in `investigatedIds` and
 * returns a legitimate RECOMMEND_ACTION for that candidate's domain. If a second candidate is
 * ever investigated, the test's own assertion on investigatedIds.length will catch it — but we
 * also fail loudly here in case something upstream changes and a candidate we didn't expect gets
 * reached mid-run.
 */
function buildCompetitionProvider(priorities, investigatedIds) {
  return scriptedProvider((payload) => {
    if (payload.mode === "candidate_discovery") {
      return { candidates: discoveryCandidates(priorities) };
    }
    const candidateId = payload.focusCandidate?.candidateId;
    investigatedIds.push(candidateId);
    const entry = Object.values(CANDIDATES).find((c) => c.candidateId === candidateId);
    if (!entry) throw new Error(`unexpected candidate investigated: ${candidateId}`);
    return investigate(
      {
        status: "RECOMMEND_ACTION",
        recommendation: validRec({
          title: `Act on ${entry.candidateId}`,
          diagnosedProblem: entry.diagnosedProblem,
          mechanism: `${entry.op} implements this.`,
          supportingBeliefIds: entry.businessEvidenceRefs,
          feasibleWriteOperations: [entry.op],
        }),
      },
      { toolCalls: [readCall(entry.readOp)] },
    )(payload);
  });
}

test("Competition 1: customer=1, product=2, inventory=3 -> customer wins, only customer investigated", async () => {
  const investigatedIds = [];
  const provider = buildCompetitionProvider({ customer: 1, product: 2, inventory: 3 }, investigatedIds);
  const result = await runCandidateDrivenRecommendation(
    baseInput({ provider, snapshot: SNAPSHOT, client: CLIENT, grantedScopes: ALL_GRANTED_SCOPES }),
  );

  assert.equal(result.status, "RECOMMEND_ACTION");
  assert.equal(result.recommendation.feasibleWriteOperations[0], "customerUpdate");
  const uniqueInvestigated = [...new Set(investigatedIds)];
  assert.equal(uniqueInvestigated.length, 1, `expected exactly one candidate investigated, got ${JSON.stringify(uniqueInvestigated)}`);
  assert.deepEqual(uniqueInvestigated, [CANDIDATES.customer.candidateId]);
});

test("Competition 2: same three candidates, product=1 -> product wins, only product investigated", async () => {
  const investigatedIds = [];
  const provider = buildCompetitionProvider({ product: 1, customer: 2, inventory: 3 }, investigatedIds);
  const result = await runCandidateDrivenRecommendation(
    baseInput({ provider, snapshot: SNAPSHOT, client: CLIENT, grantedScopes: ALL_GRANTED_SCOPES }),
  );

  assert.equal(result.status, "RECOMMEND_ACTION");
  assert.equal(result.recommendation.feasibleWriteOperations[0], "productUpdate");
  const uniqueInvestigated = [...new Set(investigatedIds)];
  assert.equal(uniqueInvestigated.length, 1, `expected exactly one candidate investigated, got ${JSON.stringify(uniqueInvestigated)}`);
  assert.deepEqual(uniqueInvestigated, [CANDIDATES.product.candidateId]);
});

test("Competition 3: discount=1, customer=2, product=3 -> discount wins, only discount investigated", async () => {
  const investigatedIds = [];
  const provider = buildCompetitionProvider({ discount: 1, customer: 2, product: 3 }, investigatedIds);
  const result = await runCandidateDrivenRecommendation(
    baseInput({ provider, snapshot: SNAPSHOT, client: CLIENT, grantedScopes: ALL_GRANTED_SCOPES }),
  );

  assert.equal(result.status, "RECOMMEND_ACTION");
  assert.equal(result.recommendation.feasibleWriteOperations[0], "discountCodeBasicCreate");
  const uniqueInvestigated = [...new Set(investigatedIds)];
  assert.equal(uniqueInvestigated.length, 1, `expected exactly one candidate investigated, got ${JSON.stringify(uniqueInvestigated)}`);
  assert.deepEqual(uniqueInvestigated, [CANDIDATES.discount.candidateId]);
});
