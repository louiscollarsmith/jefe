// Controlled domain fixtures (Task 3 §7): deterministic proof that multiple, materially
// different Shopify domains — not just products — can independently reach RECOMMEND_ACTION
// (or the furthest disposition their current execution semantics allow) through the real
// candidate-pipeline runtime, using the real generated Shopify API catalog. No category
// quotas, no prompt steering — each fixture's winning candidate is scripted to win because its
// evidence is the strongest candidate offered that pass, exactly like a real Luna call would
// pick the strongest of what discovery proposed.

import assert from "node:assert/strict";
import test from "node:test";

import { runCandidateDrivenRecommendation, CANDIDATE_STATUS } from "../app/lib/shopify/agentic-runtime/candidate-pipeline.server.js";
import {
  scriptedProvider,
  fakeShopifyClient,
  baseInput,
  candidateFixture,
  validRec,
  investigate,
  readCall,
  retrieveCall,
  isAttemptable,
  catalogOp,
} from "./helpers/agentic-recommendation-fixtures.mjs";

const ALL_GRANTED_SCOPES = [
  "read_products",
  "write_products",
  "read_orders",
  "write_orders",
  "read_customers",
  "write_customers",
  "read_inventory",
  "write_inventory",
  "read_discounts",
  "write_discounts",
  "read_online_store_navigation",
  "write_online_store_navigation",
  "read_merchant_managed_fulfillment_orders",
  "read_returns",
];

// ---------------------------------------------------------------------------
// A. Product — positive control: product action wins when it genuinely is strongest.
// ---------------------------------------------------------------------------

test("Domain fixture A (product): strongest evidence is a draft product, product action wins", async () => {
  assert.equal(isAttemptable("productUpdate"), true, "productUpdate must remain attemptable in the real catalog for this control to be meaningful");

  const snapshot = {
    beliefs: [
      { id: "b-catalog-1", key: "catalog.draft_product_count", category: "catalog", authority: "deterministic", value: { count: 1 } },
    ],
    goals: [],
    insights: [],
    goalCoaching: [],
    merchantContext: [],
    previousRecommendations: [],
    privacy: {},
    beliefCount: 1,
  };

  const provider = scriptedProvider((payload) => {
    if (payload.mode === "candidate_discovery") {
      return {
        candidates: [
          candidateFixture("activate-draft-product", "A stocked product is DRAFT and invisible to customers.", 1, {
            possibleIntervention: "publish the draft product",
            businessEvidenceRefs: ["b-catalog-1"],
            relevantFamilyId: "products",
          }),
        ],
      };
    }
    return investigate({
      status: "RECOMMEND_ACTION",
      recommendation: validRec({
        title: "Activate the stocked draft product",
        diagnosedProblem: "A stocked product is DRAFT and invisible to customers.",
        mechanism: "productUpdate sets status to ACTIVE.",
        supportingBeliefIds: ["b-catalog-1"],
        feasibleWriteOperations: ["productUpdate"],
        eligibilityCriteria: [{ resourceType: "Product", field: "status", operator: "eq", value: "DRAFT" }],
      }),
    })(payload);
  });

  const client = fakeShopifyClient(
    { "products(": { products: { edges: [{ node: { id: "gid://shopify/Product/1", title: "Test Wine", status: "DRAFT" } }] }, pageInfo: { hasNextPage: false } } },
    { grantedScopes: ALL_GRANTED_SCOPES },
  );

  const result = await runCandidateDrivenRecommendation(baseInput({ provider, snapshot, client, grantedScopes: ALL_GRANTED_SCOPES }));

  assert.equal(result.status, "RECOMMEND_ACTION");
  assert.equal(result.recommendation.feasibleWriteOperations[0], "productUpdate");
  const queue = result.diagnostics.candidateQueue;
  assert.equal(queue[0].domain, "products");
  assert.equal(queue[0].finalDisposition, "RECOMMENDED");
});

// ---------------------------------------------------------------------------
// B. Customer — RFM-style intelligence wins discovery and reaches as far as execution
//    semantics permit. customerUpdate is EXECUTABLE_WITH_CONFIRMATION in the real catalog, so
//    this fixture is expected to reach RECOMMEND_ACTION, not just be discovered.
// ---------------------------------------------------------------------------

test("Domain fixture B (customer): RFM at-risk segment wins over a weaker product candidate", async () => {
  assert.equal(isAttemptable("customerUpdate"), true, "customerUpdate must remain attemptable in the real catalog for this fixture to prove the intended point");

  const snapshot = {
    beliefs: [
      {
        id: "b-customer-rfm",
        key: "customers.rfm_segment_mix.all_time",
        category: "customers",
        authority: "deterministic",
        value: { atRisk: { count: 14, revenueAtStake: 9200 }, champions: { count: 22 } },
      },
      // A materially weaker, unrelated product signal in the same run — proves the winner is
      // chosen by evidence strength, not by being the only candidate offered.
      { id: "b-catalog-weak", key: "catalog.variant_count", category: "catalog", authority: "deterministic", value: { count: 40 } },
    ],
    goals: [],
    insights: [],
    goalCoaching: [],
    merchantContext: [],
    previousRecommendations: [],
    privacy: {},
    beliefCount: 2,
  };

  const provider = scriptedProvider((payload) => {
    if (payload.mode === "candidate_discovery") {
      return {
        candidates: [
          candidateFixture(
            "protect-at-risk-champions",
            "14 champion-tier customers have gone quiet (RFM at-risk segment), representing £9,200 of repeat revenue at stake.",
            1,
            {
              possibleIntervention: "tag the at-risk champion customers for a targeted winback",
              businessEvidenceRefs: ["b-customer-rfm"],
              relevantFamilyId: "customers",
            },
          ),
          candidateFixture("minor-catalog-note", "Variant count is unremarkable and does not indicate a problem.", 2, {
            possibleIntervention: "no clear action",
            businessEvidenceRefs: ["b-catalog-weak"],
          }),
        ],
      };
    }
    if (payload.focusCandidate?.candidateId === "protect-at-risk-champions") {
      return investigate(
        {
          status: "RECOMMEND_ACTION",
          recommendation: validRec({
            title: "Tag at-risk champion customers for winback",
            diagnosedProblem: "14 champion-tier customers have gone quiet, representing £9,200 of repeat revenue at stake.",
            mechanism: "customerUpdate tags the at-risk champion cohort so a winback flow can target them.",
            supportingBeliefIds: ["b-customer-rfm"],
            feasibleWriteOperations: ["customerUpdate"],
            eligibilityCriteria: [{ resourceType: "Customer", field: "tags", operator: "not_contains", value: "at-risk-champion" }],
          }),
        },
        { toolCalls: [readCall("customers")] },
      )(payload);
    }
    // The weaker candidate is never reached because the pipeline stops at the first
    // RECOMMEND_ACTION — asserted below via investigatedIds.
    throw new Error(`unexpected candidate investigated: ${payload.focusCandidate?.candidateId}`);
  });

  const client = fakeShopifyClient(
    { "customers(": { customers: { edges: [{ node: { id: "gid://shopify/Customer/1", displayName: "Champion One", numberOfOrders: 6 } }] }, pageInfo: { hasNextPage: false } } },
    { grantedScopes: ALL_GRANTED_SCOPES },
  );

  const result = await runCandidateDrivenRecommendation(baseInput({ provider, snapshot, client, grantedScopes: ALL_GRANTED_SCOPES }));

  assert.equal(result.status, "RECOMMEND_ACTION");
  assert.equal(result.recommendation.feasibleWriteOperations[0], "customerUpdate");
  const queue = result.diagnostics.candidateQueue;
  const winner = queue.find((c) => c.candidateId === "protect-at-risk-champions");
  assert.equal(winner.status, CANDIDATE_STATUS.recommended);
  assert.equal(winner.domain, "customers");
});

// ---------------------------------------------------------------------------
// C. Discount — discount-effect/concentration evidence wins, reaches RECOMMEND_ACTION via
//    discountCodeBasicCreate. Grounded in two real deterministic belief keys:
//    business.discount_concentration.trailing_90d and
//    business.discount_order_value_effect.trailing_90d (see
//    app/lib/merchant-memory/shopify-derivations.server.js's discountOrderValueEffect, whose own
//    code comment states the AOV comparison is "correlational, not causal" — a bigger discounted
//    basket could be the discount working, or just that big spenders are the ones who bother to
//    apply a code). The fixture's diagnosedProblem/mechanism text mirrors that hedge rather than
//    asserting the discount code *causes* underperformance.
// ---------------------------------------------------------------------------

test("Domain fixture C (discount): concentration + non-causal AOV comparison wins, discountCodeBasicCreate", async () => {
  assert.equal(isAttemptable("discountCodeBasicCreate"), true, "discountCodeBasicCreate must remain attemptable in the real catalog for this fixture to prove the intended point");

  const snapshot = {
    beliefs: [
      {
        id: "b-discount-concentration",
        key: "business.discount_concentration.trailing_90d",
        category: "business",
        authority: "deterministic",
        value: {
          items: [{ productId: "gid://shopify/Product/501", title: "Signature Chair", discountAmount: 4200, discountSharePercent: 81.3 }],
          topDiscountedProduct: { productId: "gid://shopify/Product/501", title: "Signature Chair", discountAmount: 4200, discountSharePercent: 81.3 },
        },
      },
      {
        id: "b-discount-aov-effect",
        key: "business.discount_order_value_effect.trailing_90d",
        category: "business",
        authority: "deterministic",
        // Correlational comparison, not a causal claim — mirrors discountOrderValueEffect's own
        // code comment. A negative lift here means discounted orders are NOT bigger, not that
        // the code "caused" anything.
        value: {
          discountedOrderCount: 40,
          undiscountedOrderCount: 120,
          discountedAverageOrderValue: 62.1,
          undiscountedAverageOrderValue: 64.8,
          averageOrderValueLiftPercent: -4.17,
        },
      },
    ],
    goals: [],
    insights: [],
    goalCoaching: [],
    merchantContext: [],
    previousRecommendations: [],
    privacy: {},
    beliefCount: 2,
  };

  const provider = scriptedProvider((payload) => {
    if (payload.mode === "candidate_discovery") {
      return {
        candidates: [
          candidateFixture(
            "replace-blanket-discount-code",
            "The active blanket discount code is redeemed almost entirely against one already-strong product (81% of trailing-90d discount spend on Signature Chair), and discounted orders show no meaningful average-order-value lift over undiscounted ones (-4.2%, a correlational comparison, not a causal claim) — the code is not demonstrably growing baskets, it is mostly cutting margin on an item that already sells at full price.",
            1,
            {
              possibleIntervention: "issue a new discount code scoped to slower-moving inventory instead of the current unrestricted blanket code",
              businessEvidenceRefs: ["b-discount-concentration", "b-discount-aov-effect"],
              relevantFamilyId: "discounts_promotions",
            },
          ),
        ],
      };
    }
    return investigate(
      {
        status: "RECOMMEND_ACTION",
        recommendation: validRec({
          title: "Scope the blanket discount code to slow-moving inventory instead of store-wide",
          diagnosedProblem:
            "The active blanket discount code is redeemed almost entirely against one already-strong product (81% of discount spend), and discounted orders show no meaningful AOV lift over undiscounted ones (-4.2%, correlational, not causal).",
          mechanism:
            "discountCodeBasicCreate creates a new code restricted to a slow-moving product segment, replacing reliance on the unrestricted code that is mostly discounting the already-strong bestseller without a demonstrated AOV lift.",
          whyThisAction: "codeDiscountNodes confirms the current code applies store-wide with no product restriction.",
          supportingBeliefIds: ["b-discount-concentration", "b-discount-aov-effect"],
          feasibleWriteOperations: ["discountCodeBasicCreate"],
          eligibilityCriteria: [{ resourceType: "Product", field: "tags", operator: "eq", value: "slow-mover" }],
          materialExpectedEffects: ["New code redemptions concentrate on slow-moving stock rather than the already-strong bestseller."],
        }),
      },
      { toolCalls: [readCall("codeDiscountNodes")] },
    )(payload);
  });

  const client = fakeShopifyClient(
    {
      "codeDiscountNodes(": {
        codeDiscountNodes: {
          edges: [
            {
              node: {
                id: "gid://shopify/DiscountCodeNode/1",
                codeDiscount: { __typename: "DiscountCodeBasic", title: "SAVE10" },
              },
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    },
    { grantedScopes: ALL_GRANTED_SCOPES },
  );

  const result = await runCandidateDrivenRecommendation(baseInput({ provider, snapshot, client, grantedScopes: ALL_GRANTED_SCOPES }));

  assert.equal(result.status, "RECOMMEND_ACTION");
  assert.equal(result.recommendation.feasibleWriteOperations[0], "discountCodeBasicCreate");
  const queue = result.diagnostics.candidateQueue;
  assert.equal(queue[0].domain, "discounts_promotions");
  assert.equal(queue[0].finalDisposition, "RECOMMENDED");
});

// ---------------------------------------------------------------------------
// D. Inventory — a fix that does NOT require cost data: a bestselling item has stock sitting at
//    a second location that was never activated for sale there, so Shopify won't sell it from
//    that location even though units physically exist. inventoryActivate turns on availability
//    for an existing inventory item at a location; no cost-per-item or margin figure is used
//    anywhere in this fixture.
// ---------------------------------------------------------------------------

test("Domain fixture D (inventory): unactivated stock at a second location wins, inventoryActivate", async () => {
  assert.equal(isAttemptable("inventoryActivate"), true, "inventoryActivate must remain attemptable in the real catalog for this fixture to prove the intended point");

  const snapshot = {
    beliefs: [
      {
        id: "b-inv-cover",
        key: "inventory.low_cover_products.trailing_30d",
        category: "inventory",
        authority: "deterministic",
        value: { items: [{ productId: "gid://shopify/Product/701", title: "Aurora Lamp", daysOfCover: 4, unitsSold30d: 180 }] },
      },
      {
        // Synthetic, not a current registry key — fulfillment-adjacent per-location activation
        // state isn't a deterministic belief yet. Grounded in a plausible raw Shopify read fact
        // (an inventory item's activation status at a location) rather than a fabricated metric.
        id: "b-inv-location-gap",
        key: "inventory.location_activation_gap",
        category: "inventory",
        authority: "deterministic",
        value: {
          productId: "gid://shopify/Product/701",
          inventoryItemId: "gid://shopify/InventoryItem/9101",
          primaryLocationId: "gid://shopify/Location/1",
          secondaryLocationId: "gid://shopify/Location/2",
          activatedAtSecondary: false,
          secondaryLocationOnHand: 40,
        },
      },
    ],
    goals: [],
    insights: [],
    goalCoaching: [],
    merchantContext: [],
    previousRecommendations: [],
    privacy: {},
    beliefCount: 2,
  };

  const provider = scriptedProvider((payload) => {
    if (payload.mode === "candidate_discovery") {
      return {
        candidates: [
          candidateFixture(
            "activate-bestseller-second-location",
            "Aurora Lamp is a bestseller with only 4 days of cover at its primary location (180 units sold in the trailing 30 days), while 40 units of the same inventory item already sit on hand at a second location but are not activated for sale there — Shopify will not sell stock at a location it isn't activated for.",
            1,
            {
              possibleIntervention: "activate the Aurora Lamp inventory item for sale at the second location",
              businessEvidenceRefs: ["b-inv-cover", "b-inv-location-gap"],
              relevantFamilyId: "inventory",
            },
          ),
        ],
      };
    }
    return investigate(
      {
        status: "RECOMMEND_ACTION",
        recommendation: validRec({
          title: "Activate the Aurora Lamp for sale at the second location",
          diagnosedProblem: "40 units of a low-cover bestseller sit on hand at a second location that was never activated for sale.",
          mechanism: "inventoryActivate turns on tracking/availability for the existing inventory item at the second location so the units already on hand there become sellable.",
          whyThisAction: "locations confirms the second location is active and operating; the inventory item is simply not yet activated there.",
          supportingBeliefIds: ["b-inv-cover", "b-inv-location-gap"],
          feasibleWriteOperations: ["inventoryActivate"],
          eligibilityCriteria: [
            { resourceType: "InventoryItem", field: "id", operator: "eq", value: "gid://shopify/InventoryItem/9101" },
            { resourceType: "Location", field: "id", operator: "eq", value: "gid://shopify/Location/2" },
          ],
          materialExpectedEffects: ["The 40 on-hand units at the second location become purchasable there."],
        }),
      },
      { toolCalls: [readCall("locations")] },
    )(payload);
  });

  const client = fakeShopifyClient(
    {
      "locations(": {
        locations: { edges: [{ node: { id: "gid://shopify/Location/2", name: "Downtown Pop-up", isActive: true } }] },
        pageInfo: { hasNextPage: false },
      },
    },
    { grantedScopes: ALL_GRANTED_SCOPES },
  );

  const result = await runCandidateDrivenRecommendation(baseInput({ provider, snapshot, client, grantedScopes: ALL_GRANTED_SCOPES }));

  assert.equal(result.status, "RECOMMEND_ACTION");
  assert.equal(result.recommendation.feasibleWriteOperations[0], "inventoryActivate");
  const queue = result.diagnostics.candidateQueue;
  assert.equal(queue[0].domain, "inventory");
  assert.equal(queue[0].finalDisposition, "RECOMMENDED");
});

// ---------------------------------------------------------------------------
// E. Fulfillment — as of the 2026-08-25 execution-safety architecture change (CLAUDE.md),
//    fulfillmentCreate is EXECUTABLE_WITH_CONFIRMATION (a reviewed override — HIGH_RISK,
//    irreversible, explicit confirmation required), not a dead end. This fixture proves the
//    pipeline discovers and reads real fulfillment operations AND carries a genuinely-found,
//    attemptable candidate through to RECOMMEND_ACTION — the previous version of this fixture
//    proved the opposite (a correct EXECUTION_SEMANTICS_MISSING dead end), which was the exact
//    "Jefe's own missing support" gap this change eliminated.
// ---------------------------------------------------------------------------

test("Domain fixture E (fulfillment): stalled fulfillment orders investigated for real, reaches RECOMMEND_ACTION via fulfillmentCreate", async () => {
  assert.equal(catalogOp("fulfillmentCreate")?.execution?.status, "EXECUTABLE_WITH_CONFIRMATION", "fulfillmentCreate must be attemptable for this fixture to prove the intended point");

  const snapshot = {
    beliefs: [
      {
        // Synthetic — fulfillment isn't a covered deterministic-belief domain yet, so this
        // mirrors the shape of a real deterministic belief without claiming registry status.
        id: "b-fulfillment-stalled",
        key: "fulfillment.stalled_open_orders_count.trailing_30d",
        category: "fulfillment",
        authority: "deterministic",
        value: { count: 11, thresholdDays: 5 },
      },
    ],
    goals: [],
    insights: [],
    goalCoaching: [],
    merchantContext: [],
    previousRecommendations: [],
    privacy: {},
    beliefCount: 1,
  };

  const provider = scriptedProvider((payload) => {
    if (payload.mode === "candidate_discovery") {
      return {
        candidates: [
          candidateFixture(
            "stalled-fulfillment-orders",
            "11 fulfillment orders have remained OPEN for more than 5 days with no fulfillment created against them, indicating fulfillment is stalling and customers are waiting past a reasonable SLA.",
            1,
            {
              possibleIntervention: "intervene on the stalled fulfillment orders",
              businessEvidenceRefs: ["b-fulfillment-stalled"],
              relevantFamilyId: "fulfillment",
            },
          ),
        ],
      };
    }
    return investigate(
      {
        status: "RECOMMEND_ACTION",
        recommendation: validRec({
          title: "Create a fulfillment for the stalled fulfillment order",
          diagnosedProblem: "11 fulfillment orders have sat OPEN for more than 5 days with no fulfillment created against them.",
          mechanism: "fulfillmentCreate creates a fulfillment against the open, unsubmitted fulfillment order so the shipment actually moves.",
          whyThisAction: "fulfillmentOrders confirms the order is OPEN and UNSUBMITTED — nothing is blocking fulfillment except that it hasn't been created yet.",
          supportingBeliefIds: ["b-fulfillment-stalled"],
          feasibleWriteOperations: ["fulfillmentCreate"],
          eligibilityCriteria: [
            { resourceType: "FulfillmentOrder", field: "id", operator: "eq", value: "gid://shopify/FulfillmentOrder/1" },
          ],
          materialExpectedEffects: ["The stalled order is fulfilled and moves toward shipment."],
        }),
      },
      { toolCalls: [retrieveCall("list all fulfillment orders"), readCall("fulfillmentOrders")] },
    )(payload);
  });

  const client = fakeShopifyClient(
    {
      "fulfillmentOrders(": {
        fulfillmentOrders: { edges: [{ node: { id: "gid://shopify/FulfillmentOrder/1", status: "OPEN", requestStatus: "UNSUBMITTED" } }] },
        pageInfo: { hasNextPage: false },
      },
    },
    { grantedScopes: ALL_GRANTED_SCOPES },
  );

  const result = await runCandidateDrivenRecommendation(baseInput({ provider, snapshot, client, grantedScopes: ALL_GRANTED_SCOPES }));

  assert.equal(result.status, "RECOMMEND_ACTION");
  assert.equal(result.recommendation.feasibleWriteOperations[0], "fulfillmentCreate");
  const queue = result.diagnostics.candidateQueue;
  const candidate = queue.find((c) => c.candidateId === "stalled-fulfillment-orders");
  assert.equal(candidate.domain, "fulfillment");
  assert.ok(
    candidate.retrievedOperations.includes("fulfillmentOrders"),
    `expected a real fulfillment operation in retrievedOperations, got ${JSON.stringify(candidate.retrievedOperations)}`,
  );
  assert.equal(candidate.finalDisposition, "RECOMMENDED");
});

// ---------------------------------------------------------------------------
// F. Returns — as of the 2026-08-25 execution-safety architecture change, returnApproveRequest
//    is EXECUTABLE_WITH_CONFIRMATION (structural classification: money/order-state domain,
//    compensatable, explicit confirmation required — not autonomous, not a dead end). This
//    fixture proves a genuinely-found return candidate now reaches RECOMMEND_ACTION rather than
//    stopping at "discovered but can't execute."
// ---------------------------------------------------------------------------

test("Domain fixture F (returns): pending return backlog investigated for real, reaches RECOMMEND_ACTION via returnApproveRequest", async () => {
  assert.equal(catalogOp("returnApproveRequest")?.execution?.status, "EXECUTABLE_WITH_CONFIRMATION", "returnApproveRequest must be attemptable for this fixture to prove the intended point");

  const snapshot = {
    beliefs: [
      {
        // Synthetic — returns isn't a covered deterministic-belief domain yet.
        id: "b-returns-backlog",
        key: "returns.pending_review_count",
        category: "returns",
        authority: "deterministic",
        value: { count: 7, averageAgeDays: 6 },
      },
    ],
    goals: [],
    insights: [],
    goalCoaching: [],
    merchantContext: [],
    previousRecommendations: [],
    privacy: {},
    beliefCount: 1,
  };

  const provider = scriptedProvider((payload) => {
    if (payload.mode === "candidate_discovery") {
      return {
        candidates: [
          candidateFixture(
            "returns-backlog-pending-review",
            "7 customer return requests have been pending review for an average of 6 days with no resolution — a materially slow returns process.",
            1,
            {
              possibleIntervention: "review and process the backlog of pending return requests",
              businessEvidenceRefs: ["b-returns-backlog"],
              relevantFamilyId: "returns",
            },
          ),
        ],
      };
    }
    return investigate(
      {
        status: "RECOMMEND_ACTION",
        recommendation: validRec({
          title: "Approve the pending return request",
          diagnosedProblem: "A customer return has sat OPEN and pending review for 6 days with no resolution.",
          mechanism: "returnApproveRequest approves the pending return request so it moves out of the backlog toward resolution.",
          whyThisAction: "return confirms the return is OPEN and awaiting a decision — nothing else is blocking approval.",
          supportingBeliefIds: ["b-returns-backlog"],
          feasibleWriteOperations: ["returnApproveRequest"],
          eligibilityCriteria: [
            { resourceType: "Return", field: "id", operator: "eq", value: "gid://shopify/Return/9001" },
          ],
          materialExpectedEffects: ["The pending return moves out of the review backlog."],
        }),
      },
      { toolCalls: [retrieveCall("return status"), readCall("return", { id: "gid://shopify/Return/9001" })] },
    )(payload);
  });

  const client = fakeShopifyClient(
    {
      "return(id:": { return: { id: "gid://shopify/Return/9001", status: "OPEN", totalQuantity: 2 } },
    },
    { grantedScopes: ALL_GRANTED_SCOPES },
  );

  const result = await runCandidateDrivenRecommendation(baseInput({ provider, snapshot, client, grantedScopes: ALL_GRANTED_SCOPES }));

  assert.equal(result.status, "RECOMMEND_ACTION");
  assert.equal(result.recommendation.feasibleWriteOperations[0], "returnApproveRequest");
  const queue = result.diagnostics.candidateQueue;
  const candidate = queue.find((c) => c.candidateId === "returns-backlog-pending-review");
  assert.equal(candidate.domain, "returns");
  assert.ok(candidate.retrievedOperations.some((op) => op === "return" || op === "reverseFulfillmentOrder" || op === "reverseFulfillmentOrderDispose"));
  assert.equal(candidate.finalDisposition, "RECOMMENDED");
});

// ---------------------------------------------------------------------------
// G. Navigation — a merchandising-findability problem: the bestselling product's collection is
//    not linked anywhere in the store's primary navigation menu. menuUpdate is
//    EXECUTABLE_WITH_CONFIRMATION, so this reaches RECOMMEND_ACTION.
// ---------------------------------------------------------------------------

test("Domain fixture G (navigation): bestseller's collection missing from primary menu wins, menuUpdate", async () => {
  assert.equal(isAttemptable("menuUpdate"), true, "menuUpdate must remain attemptable in the real catalog for this fixture to prove the intended point");

  const snapshot = {
    beliefs: [
      {
        id: "b-nav-bestseller",
        key: "products.bestseller_by_revenue.trailing_90d",
        category: "products",
        authority: "deterministic",
        value: { productId: "gid://shopify/Product/301", title: "Heritage Rug", revenueSharePercent: 22.4 },
      },
      {
        // Synthetic — navigation coverage isn't a deterministic belief key yet.
        id: "b-nav-gap",
        key: "navigation.primary_menu_missing_top_collection",
        category: "navigation",
        authority: "deterministic",
        value: { collectionId: "gid://shopify/Collection/55", collectionHandle: "rugs", collectionTitle: "Rugs", inPrimaryMenu: false },
      },
    ],
    goals: [],
    insights: [],
    goalCoaching: [],
    merchantContext: [],
    previousRecommendations: [],
    privacy: {},
    beliefCount: 2,
  };

  const provider = scriptedProvider((payload) => {
    if (payload.mode === "candidate_discovery") {
      return {
        candidates: [
          candidateFixture(
            "bestseller-collection-missing-from-nav",
            "The bestselling product by revenue (Heritage Rug, 22% of trailing-90d revenue) belongs to the Rugs collection, but that collection is not linked anywhere in the store's primary navigation menu — customers can only reach it via direct search or a product link, not by browsing.",
            1,
            {
              possibleIntervention: "add the Rugs collection to the primary navigation menu",
              businessEvidenceRefs: ["b-nav-bestseller", "b-nav-gap"],
              relevantFamilyId: "navigation",
            },
          ),
        ],
      };
    }
    return investigate(
      {
        status: "RECOMMEND_ACTION",
        recommendation: validRec({
          title: "Add the Rugs collection to the primary navigation menu",
          diagnosedProblem: "The Rugs collection, home to the top-revenue product, has no link in the store's primary navigation menu.",
          mechanism: "menuUpdate adds a new COLLECTION-type item pointing at the Rugs collection to the existing main-menu, alongside its current items.",
          whyThisAction: "menus confirms the main-menu currently has no item linking to the Rugs collection.",
          supportingBeliefIds: ["b-nav-bestseller", "b-nav-gap"],
          feasibleWriteOperations: ["menuUpdate"],
          eligibilityCriteria: [{ resourceType: "Menu", field: "handle", operator: "eq", value: "main-menu" }],
          materialExpectedEffects: ["The Rugs collection becomes reachable by browsing the primary menu."],
        }),
      },
      { toolCalls: [readCall("menus")] },
    )(payload);
  });

  const client = fakeShopifyClient(
    {
      "menus(": {
        menus: {
          edges: [
            {
              node: {
                id: "gid://shopify/Menu/1",
                handle: "main-menu",
                title: "Main menu",
                items: [
                  { id: "gid://shopify/MenuItem/1", title: "Home", type: "FRONTPAGE" },
                  { id: "gid://shopify/MenuItem/2", title: "All Products", type: "COLLECTION" },
                ],
              },
            },
          ],
        },
        pageInfo: { hasNextPage: false },
      },
    },
    { grantedScopes: ALL_GRANTED_SCOPES },
  );

  const result = await runCandidateDrivenRecommendation(baseInput({ provider, snapshot, client, grantedScopes: ALL_GRANTED_SCOPES }));

  assert.equal(result.status, "RECOMMEND_ACTION");
  assert.equal(result.recommendation.feasibleWriteOperations[0], "menuUpdate");
  const queue = result.diagnostics.candidateQueue;
  assert.equal(queue[0].domain, "navigation");
  assert.equal(queue[0].finalDisposition, "RECOMMENDED");
});
