/**
 * Deterministic tests for Merchant Memory exposure to recommendation Luna.
 *
 * Guards:
 *  - No arbitrary recency-based truncation (was LIMIT 40)
 *  - llmExposure semantics are honoured (core/on_demand visible; guardrail excluded)
 *  - Authority labels are preserved; precedence does not control visibility
 *  - Merchant-confirmed beliefs remain highest authority
 *  - Serialization is deterministic (identical content → identical hash)
 *  - Model-visible belief change invalidates snapshot hash
 *  - Guardrail-only change does not affect the model-visible hash
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveExposure,
  compareBeliefStable,
  partitionBeliefsByExposure,
  hashJson,
} from "../app/lib/shopify/agentic-runtime/recommendation-service.server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @param {Partial<{id:string,key:string,authority:string,value:any,precedence:number,status:string,evidence:any[]}>} overrides */
function makeBelief(overrides = {}) {
  return {
    id: overrides.id ?? "belief-1",
    key: overrides.key ?? "business.store_name",
    category: overrides.category ?? "business",
    label: overrides.label ?? overrides.key ?? "store name",
    val: overrides.value ?? "test value",
    value: overrides.value ?? "test value",
    type: "string",
    status: overrides.status ?? "active",
    authority: overrides.authority ?? "deterministic",
    llmExposure: resolveExposure(overrides.key ?? "business.store_name"),
    confidence: 0.95,
    evidence: overrides.evidence ?? [],
  };
}

/** Build a minimal hashable snapshot (excluding dataQualityContext as the service does). */
function makeHashableSnapshot(beliefs = [], extra = {}) {
  return {
    snapshotVersion: 3,
    merchantId: "merchant-test-1",
    shopId: "shop-test-1",
    privacy: {
      source: "merchant_memory_goals_insights_and_bounded_shopify_reads",
      excludesCredentialsAndTokens: true,
      excludesFullUploadedDocuments: true,
    },
    goalCoaching: [],
    goals: [],
    insights: [],
    beliefCount: beliefs.length,
    beliefs,
    merchantContext: [],
    previousRecommendations: [],
    activeWork: [],
    shopifyMirrorWatermark: null,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Test 1 — More than 40 beliefs: all recommendation-eligible beliefs reach snapshot
// ---------------------------------------------------------------------------

test("more than 40 core beliefs: all are visible, none truncated by recency", () => {
  const manyBeliefs = Array.from({ length: 55 }, (_, i) =>
    makeBelief({
      id: `b${i}`,
      key: "business.store_name", // core exposure
      authority: "deterministic",
    }),
  );
  const { visible, guardrails } = partitionBeliefsByExposure(manyBeliefs);
  assert.equal(visible.length, 55, "all 55 beliefs must be visible");
  assert.equal(guardrails.length, 0);
});

// ---------------------------------------------------------------------------
// Test 2 — Recency does not control visibility
// ---------------------------------------------------------------------------

test("belief updated 10 days ago and belief updated now are both visible", () => {
  const old = makeBelief({ id: "old", key: "business.store_name", authority: "deterministic" });
  const recent = makeBelief({ id: "new", key: "catalog.active_product_count", authority: "deterministic" });
  // Both are core keys — neither should be excluded regardless of updatedAt.
  // (updatedAt does not appear in partitioning at all.)
  const { visible } = partitionBeliefsByExposure([old, recent]);
  assert.equal(visible.length, 2);
  assert.ok(visible.some((b) => b.id === "old"), "old belief must be visible");
  assert.ok(visible.some((b) => b.id === "new"), "recent belief must be visible");
});

// ---------------------------------------------------------------------------
// Test 3 — internal_guardrail excluded from recommendation evidence
// ---------------------------------------------------------------------------

test("resolveExposure returns 'guardrail' for data.* quality keys", () => {
  assert.equal(resolveExposure("data.order_timestamp_coverage"), "guardrail");
  assert.equal(resolveExposure("data.currency_consistency"), "guardrail");
  assert.equal(resolveExposure("data.inventory_freshness_hours_p90"), "guardrail");
});

test("guardrail beliefs are not in the visible set", () => {
  const guardrailBelief = makeBelief({
    id: "g1",
    key: "data.order_timestamp_coverage",
    authority: "deterministic",
  });
  const coreBelief = makeBelief({
    id: "c1",
    key: "business.store_name",
    authority: "deterministic",
  });
  const { visible, guardrails } = partitionBeliefsByExposure([guardrailBelief, coreBelief]);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, "c1");
  assert.equal(guardrails.length, 1);
  assert.equal(guardrails[0].id, "g1");
});

// ---------------------------------------------------------------------------
// Test 4 — on_demand visible until retrieval infrastructure exists
// ---------------------------------------------------------------------------

test("resolveExposure returns 'on_demand' for on-demand keys", () => {
  assert.equal(resolveExposure("inventory.out_of_stock_variant_count"), "on_demand");
  assert.equal(resolveExposure("refunds.refunded_order_rate.all_time"), "on_demand");
});

test("on_demand beliefs are included in the visible set", () => {
  const onDemandBelief = makeBelief({
    id: "od1",
    key: "inventory.out_of_stock_variant_count",
    authority: "deterministic",
  });
  const { visible, guardrails } = partitionBeliefsByExposure([onDemandBelief]);
  assert.equal(visible.length, 1, "on_demand belief must be in visible set");
  assert.equal(guardrails.length, 0);
});

// ---------------------------------------------------------------------------
// Test 5 — Goals visible despite lower authority (precedence 20 = system_inference)
// ---------------------------------------------------------------------------

test("deterministic belief (precedence 40) and goal belief (precedence 20) both visible", () => {
  const deterministicBelief = makeBelief({
    id: "det",
    key: "catalog.active_product_count",
    authority: "deterministic",
  });
  const goalBelief = makeBelief({
    id: "goal",
    key: "preferences.growth_goal", // non-registry key → defaults to core
    authority: "system_inference",
  });
  const { visible } = partitionBeliefsByExposure([deterministicBelief, goalBelief]);
  assert.equal(visible.length, 2);
  assert.ok(visible.some((b) => b.id === "det"), "deterministic belief must be visible");
  assert.ok(visible.some((b) => b.id === "goal"), "goal/system_inference belief must be visible");

  // Authority labels must be preserved — deterministic first in stable sort
  const sorted = [...visible].sort(compareBeliefStable);
  assert.equal(sorted[0].authority, "deterministic");
  assert.equal(sorted[1].authority, "system_inference");
});

// ---------------------------------------------------------------------------
// Test 6 — Merchant-confirmed intent remains highest-authority
// ---------------------------------------------------------------------------

test("merchant_confirmed authority sorts before deterministic in stable order", () => {
  const confirmed = makeBelief({
    id: "mc",
    key: "preferences.optimisation_priority",
    authority: "merchant_confirmed",
  });
  const deterministic = makeBelief({
    id: "det",
    key: "catalog.active_product_count",
    authority: "deterministic",
  });
  const sorted = [deterministic, confirmed].sort(compareBeliefStable);
  assert.equal(sorted[0].authority, "merchant_confirmed", "merchant_confirmed must sort first");
  assert.equal(sorted[1].authority, "deterministic");

  // Both are in the visible set (neither is a guardrail)
  const { visible } = partitionBeliefsByExposure([confirmed, deterministic]);
  assert.equal(visible.length, 2);
});

test("merchant_corrected authority sorts before merchant_confirmed", () => {
  const corrected = makeBelief({ id: "mcor", authority: "merchant_corrected" });
  const confirmed = makeBelief({ id: "mcon", authority: "merchant_confirmed" });
  const deterministic = makeBelief({ id: "det", authority: "deterministic" });
  const sorted = [deterministic, confirmed, corrected].sort(compareBeliefStable);
  assert.equal(sorted[0].authority, "merchant_corrected");
  assert.equal(sorted[1].authority, "merchant_confirmed");
  assert.equal(sorted[2].authority, "deterministic");
});

// ---------------------------------------------------------------------------
// Test 7 — Stable serialization
// ---------------------------------------------------------------------------

test("same belief set in different insertion order produces the same hash", () => {
  const a = makeBelief({ id: "a", key: "catalog.active_product_count", authority: "deterministic" });
  const b = makeBelief({ id: "b", key: "business.store_name", authority: "deterministic" });
  const c = makeBelief({ id: "c", key: "orders.average_order_value.trailing_90d", authority: "deterministic" });

  const { visible: ordered1 } = partitionBeliefsByExposure([a, b, c]);
  const { visible: ordered2 } = partitionBeliefsByExposure([c, a, b]);
  const { visible: ordered3 } = partitionBeliefsByExposure([b, c, a]);

  const h1 = hashJson(makeHashableSnapshot(ordered1));
  const h2 = hashJson(makeHashableSnapshot(ordered2));
  const h3 = hashJson(makeHashableSnapshot(ordered3));

  assert.equal(h1, h2, "insertion order must not affect hash");
  assert.equal(h2, h3, "insertion order must not affect hash");
});

// ---------------------------------------------------------------------------
// Test 8 — Model-visible belief change invalidates snapshot hash
// ---------------------------------------------------------------------------

test("changing a visible belief value changes the snapshot hash", () => {
  const beliefV1 = makeBelief({ id: "b1", key: "business.store_name", value: "Shop A", authority: "deterministic" });
  const beliefV2 = makeBelief({ id: "b1", key: "business.store_name", value: "Shop B", authority: "deterministic" });

  const { visible: v1 } = partitionBeliefsByExposure([beliefV1]);
  const { visible: v2 } = partitionBeliefsByExposure([beliefV2]);

  const h1 = hashJson(makeHashableSnapshot(v1));
  const h2 = hashJson(makeHashableSnapshot(v2));

  assert.notEqual(h1, h2, "changing a visible belief value must change the hash");
});

// ---------------------------------------------------------------------------
// Test 9 — Guardrail-only change does not affect the model-visible hash
// ---------------------------------------------------------------------------

test("changing only a guardrail belief does not change the model-visible snapshot hash", () => {
  const coreBeliefA = makeBelief({ id: "c1", key: "business.store_name", authority: "deterministic" });
  const guardrailV1 = makeBelief({ id: "g1", key: "data.currency_consistency", value: 0.98, authority: "deterministic" });
  const guardrailV2 = makeBelief({ id: "g1", key: "data.currency_consistency", value: 0.72, authority: "deterministic" });

  const { visible: vis1, guardrails: guard1 } = partitionBeliefsByExposure([coreBeliefA, guardrailV1]);
  const { visible: vis2, guardrails: guard2 } = partitionBeliefsByExposure([coreBeliefA, guardrailV2]);

  // Visible sets are identical — hashes must match
  const h1 = hashJson(makeHashableSnapshot(vis1));
  const h2 = hashJson(makeHashableSnapshot(vis2));
  assert.equal(h1, h2, "guardrail-only change must not affect the model-visible hash");

  // Guardrail sets do differ (the guardrail value changed)
  assert.notEqual(guard1[0].val, guard2[0].val, "sanity: guardrail values should differ");
});
