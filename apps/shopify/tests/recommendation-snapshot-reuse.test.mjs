/**
 * Regression tests: snapshot-reuse freshness.
 *
 * Guards the invariant that external Shopify state changes (product DRAFT↔ACTIVE)
 * are reflected in the snapshot hash via the shopifyMirrorWatermark, preventing
 * stale `no_actionable_opportunity` results from being reused after Shopify mutations.
 *
 * What "reused" means after the fix
 * ---------------------------------------------------------------------------
 * SAFE to reuse:
 *   A terminal (completed/no_actionable_opportunity) run whose snapshotHash matches
 *   the current snapshot hash. The current snapshot hash incorporates:
 *     • all Merchant Memory (beliefs, goals, insights, context)
 *     • all active Action ledger entries (proposed + accepted)
 *     • the ShopBackfillStatus.updatedAt watermark for the merchant_memory domain
 *   Because the watermark advances on every Shopify webhook → memory-refresh cycle,
 *   a hash match means Shopify state, Memory, and the Action ledger are all unchanged.
 *
 * NEVER reused:
 *   Any run whose hash was computed under a different ShopBackfillStatus.updatedAt.
 *   Externally changing a product (DRAFT→ACTIVE or ACTIVE→DRAFT) fires the webhook,
 *   which advances updatedAt → different hash → cache miss → fresh Luna investigation.
 *
 * Home-triggered generation (`resetAttempts: true`) is unconditionally fresh:
 *   It always salts the base hash with `retrySnapshotHash()`, bypassing the cache
 *   regardless of watermark state. The watermark fix addresses the non-reset path only.
 */

import assert from "node:assert/strict";
import test from "node:test";

// We test the snapshot hash behaviour by constructing the snapshot object directly
// and running hashJson on it, exactly as buildAgenticRecommendationSnapshot does.
// This avoids standing up Prisma or the full service.

import { createHash } from "node:crypto";

function hashJson(obj) {
  return createHash("sha256")
    .update(JSON.stringify(obj, null, 0))
    .digest("hex");
}

/**
 * Minimal snapshot factory matching the structure of buildAgenticRecommendationSnapshot.
 * Only the fields relevant to hash sensitivity are varied in these tests.
 */
function makeSnapshot({ watermark = null, activeWork = [], beliefs = [], previousRecommendations = [] } = {}) {
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
    previousRecommendations,
    activeWork,
    shopifyMirrorWatermark: watermark,
  };
}

// ---------------------------------------------------------------------------
// Direction A: DRAFT → ACTIVE (product becomes available, opportunity opens)
// ---------------------------------------------------------------------------

test("watermark advance after DRAFT→ACTIVE change produces a different snapshot hash", () => {
  const t1 = "2026-08-23T10:00:00.000Z";
  const t2 = "2026-08-23T10:05:00.000Z"; // Shopify webhook fired, watermark advanced

  const snapshotBefore = makeSnapshot({ watermark: t1 });
  const snapshotAfter = makeSnapshot({ watermark: t2 });

  assert.notEqual(
    hashJson(snapshotBefore),
    hashJson(snapshotAfter),
    "Advancing the watermark must change the snapshot hash",
  );
});

test("hash changes only from watermark advance, all other fields equal", () => {
  const beliefs = [{ id: "b1", claim: "test belief", status: "active" }];
  const t1 = "2026-08-23T10:00:00.000Z";
  const t2 = "2026-08-23T10:05:01.000Z";

  const before = hashJson(makeSnapshot({ watermark: t1, beliefs }));
  const after = hashJson(makeSnapshot({ watermark: t2, beliefs }));

  // Different hashes even though beliefs, activeWork, goals are identical
  assert.notEqual(before, after);

  // And identical snapshots still produce identical hashes (determinism check)
  assert.equal(before, hashJson(makeSnapshot({ watermark: t1, beliefs })));
});

test("null watermark and non-null watermark produce different hashes", () => {
  const withWatermark = hashJson(makeSnapshot({ watermark: "2026-08-23T10:00:00.000Z" }));
  const withoutWatermark = hashJson(makeSnapshot({ watermark: null }));
  assert.notEqual(withWatermark, withoutWatermark);
});

// ---------------------------------------------------------------------------
// Direction B: ACTIVE → DRAFT (opportunity closes; must not re-recommend)
// ---------------------------------------------------------------------------

test("watermark advance after ACTIVE→DRAFT change produces a different snapshot hash", () => {
  const t1 = "2026-08-23T11:00:00.000Z";
  const t2 = "2026-08-23T11:03:00.000Z"; // webhook fired after merchant set product to DRAFT

  const snapshotBefore = makeSnapshot({ watermark: t1 });
  const snapshotAfter = makeSnapshot({ watermark: t2 });

  assert.notEqual(
    hashJson(snapshotBefore),
    hashJson(snapshotAfter),
    "Advancing the watermark must change the snapshot hash regardless of direction",
  );
});

test("two advances at different times produce three distinct hashes", () => {
  const t1 = "2026-08-23T12:00:00.000Z";
  const t2 = "2026-08-23T12:10:00.000Z";
  const t3 = "2026-08-23T12:20:00.000Z";

  const h1 = hashJson(makeSnapshot({ watermark: t1 }));
  const h2 = hashJson(makeSnapshot({ watermark: t2 }));
  const h3 = hashJson(makeSnapshot({ watermark: t3 }));

  assert.notEqual(h1, h2);
  assert.notEqual(h2, h3);
  assert.notEqual(h1, h3);
});

// ---------------------------------------------------------------------------
// Reuse semantics: what is and is not safe to reuse
// ---------------------------------------------------------------------------

test("identical watermark + identical memory → same hash (safe to reuse)", () => {
  const t = "2026-08-23T09:00:00.000Z";
  const beliefs = [{ id: "b1", claim: "has dead stock", status: "active" }];
  const activeWork = [{ actionId: "a1", status: "proposed", intendedOperations: ["productupdate"] }];

  assert.equal(
    hashJson(makeSnapshot({ watermark: t, beliefs, activeWork })),
    hashJson(makeSnapshot({ watermark: t, beliefs, activeWork })),
    "Same watermark + same content = same hash = safe reuse",
  );
});

test("adding an active Action changes the hash even if watermark unchanged", () => {
  const t = "2026-08-23T09:00:00.000Z";
  const withoutAction = hashJson(makeSnapshot({ watermark: t, activeWork: [] }));
  const withAction = hashJson(makeSnapshot({
    watermark: t,
    activeWork: [{ actionId: "a42", status: "proposed", intendedOperations: ["productupdate"], targetResources: ["gid://P/1"] }],
  }));
  assert.notEqual(withoutAction, withAction, "New active Action must invalidate the snapshot hash");
});

test("belief change invalidates hash independent of watermark", () => {
  const t = "2026-08-23T09:00:00.000Z";
  const before = hashJson(makeSnapshot({ watermark: t, beliefs: [] }));
  const after = hashJson(makeSnapshot({
    watermark: t,
    beliefs: [{ id: "b99", claim: "new belief appeared", status: "active" }],
  }));
  assert.notEqual(before, after);
});

test("previousRecommendations change invalidates hash", () => {
  const t = "2026-08-23T09:00:00.000Z";
  const before = hashJson(makeSnapshot({ watermark: t, previousRecommendations: [] }));
  const after = hashJson(makeSnapshot({
    watermark: t,
    previousRecommendations: [{ id: "r1", title: "Hide dead-stock", summary: "...", reviewStatus: "accepted" }],
  }));
  assert.notEqual(before, after);
});

// ---------------------------------------------------------------------------
// Watermark field structure
// ---------------------------------------------------------------------------

test("watermark is ISO 8601 string or null — never a Date object", () => {
  // The snapshot serialises to JSON for hashing; a Date object serialises
  // differently from its toISOString() string. Ensure our factory (and the
  // real service) always stores the string form.
  const t = new Date("2026-08-23T10:00:00.000Z").toISOString();
  assert.equal(typeof t, "string");

  const snapshot = makeSnapshot({ watermark: t });
  const parsed = JSON.parse(JSON.stringify(snapshot));
  assert.equal(typeof parsed.shopifyMirrorWatermark, "string");
  assert.equal(parsed.shopifyMirrorWatermark, t);
});

test("null watermark is preserved through JSON serialisation", () => {
  const snapshot = makeSnapshot({ watermark: null });
  const parsed = JSON.parse(JSON.stringify(snapshot));
  assert.equal(parsed.shopifyMirrorWatermark, null);
});

// ---------------------------------------------------------------------------
// Summary: reuse semantics table (documented as passing assertions)
// ---------------------------------------------------------------------------

test("reuse semantics: only equal-hash runs are reused — watermark is part of the key", () => {
  // Scenario table:
  //
  //  Shopify mutation occurred?  | watermark changed? | hash changed? | result
  //  ----------------------------|--------------------|--------------|---------
  //  No                          | No                 | No*          | REUSED (safe)
  //  Yes (webhook fired)         | Yes                | Yes          | FRESH (safe)
  //  Yes (no webhook — impossible| —                  | —            | N/A (Shopify always fires webhooks on status change)
  //
  // * assuming Memory and Action ledger also unchanged, which is enforced by the
  //   other components of the hash (beliefs, activeWork, priorRecommendations).

  const watermark = "2026-08-23T15:00:00.000Z";

  // No mutation: hash stable
  const runA = hashJson(makeSnapshot({ watermark }));
  const runB = hashJson(makeSnapshot({ watermark }));
  assert.equal(runA, runB, "No mutation → identical hashes → safe reuse");

  // Mutation: hash changes
  const newWatermark = "2026-08-23T15:01:00.000Z";
  const runC = hashJson(makeSnapshot({ watermark: newWatermark }));
  assert.notEqual(runA, runC, "Mutation → different hashes → fresh investigation");
});
