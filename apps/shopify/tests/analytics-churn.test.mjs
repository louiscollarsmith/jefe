import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChurnSnapshot,
  captureShopChurn,
} from "../app/services/analytics/churn.server.js";

const NOW = new Date("2026-07-29T00:00:00.000Z");

function fakePrisma(counts = { orders: 0, products: 0, memoryBeliefs: 0 }) {
  const created = [];
  return {
    created,
    order: { async count() { return counts.orders; } },
    product: { async count() { return counts.products; } },
    merchantMemoryBelief: { async count() { return counts.memoryBeliefs; } },
    activityEvent: {
      async create(args) {
        created.push(args.data);
        return { id: "evt_1", ...args.data };
      },
    },
  };
}

test("buildChurnSnapshot computes tenure and progress flags", () => {
  const snap = buildChurnSnapshot(
    {
      createdAt: new Date("2026-07-19T00:00:00.000Z"), // 10 days before NOW
      onboardingCompletedAt: new Date("2026-07-20T00:00:00.000Z"),
      backfillCompletedAt: null,
      goalsCompleted: true,
      houseRulesCompleted: false,
      cogsCompletionPercentage: 42.5,
      cogsConfidenceLevel: "partial",
    },
    { orders: 12, products: 3, memoryBeliefs: 5 },
    NOW,
  );
  assert.equal(snap.tenureDays, 10);
  assert.equal(snap.onboardingCompleted, true);
  assert.equal(snap.backfillCompleted, false);
  assert.equal(snap.goalsCompleted, true);
  assert.equal(snap.houseRulesCompleted, false);
  assert.equal(snap.cogsCoveragePct, 42.5);
  assert.equal(snap.cogsConfidence, "partial");
  assert.equal(snap.orders, 12);
  assert.equal(snap.reachedMemory, true);
});

test("buildChurnSnapshot clamps negative tenure and defaults COGS", () => {
  const snap = buildChurnSnapshot(
    { createdAt: new Date("2026-07-30T00:00:00.000Z") }, // future -> clamp to 0
    { orders: 0, products: 0, memoryBeliefs: 0 },
    NOW,
  );
  assert.equal(snap.tenureDays, 0);
  assert.equal(snap.reachedMemory, false);
  assert.equal(snap.cogsCoveragePct, 0);
  assert.equal(snap.cogsConfidence, "missing");
  assert.equal(snap.onboardingCompleted, false);
});

test("captureShopChurn emits a PII-free shop_uninstalled event", async () => {
  const prisma = fakePrisma({ orders: 7, products: 2, memoryBeliefs: 4 });
  const snap = await captureShopChurn(
    prisma,
    {
      id: "shop_1",
      merchantId: "m_1",
      shopDomain: "jaspers-market.myshopify.com",
      createdAt: new Date("2026-07-24T00:00:00.000Z"), // 5 days
      onboardingCompletedAt: new Date("2026-07-25T00:00:00.000Z"),
      goalsCompleted: true,
      cogsCompletionPercentage: 0,
      cogsConfidenceLevel: "missing",
    },
    { now: NOW },
  );
  assert.equal(prisma.created.length, 1);
  const row = prisma.created[0];
  assert.equal(row.type, "shop_uninstalled");
  assert.equal(row.topic, "lifecycle");
  assert.equal(row.shopId, "shop_1");
  assert.equal(row.merchantId, "m_1");
  assert.equal(row.shopDomain, "jaspers-market.myshopify.com");
  assert.equal(row.properties.tenureDays, 5);
  assert.equal(row.properties.orders, 7);
  assert.equal(row.properties.reachedMemory, true);
  assert.match(row.summary, /Uninstalled after 5d/);
  assert.equal(snap.tenureDays, 5);
});

test("captureShopChurn never throws when a count query fails", async () => {
  const prisma = {
    order: { async count() { throw new Error("db down"); } },
    product: { async count() { return 0; } },
    merchantMemoryBelief: { async count() { return 0; } },
    activityEvent: { async create() { return {}; } },
  };
  let result;
  await assert.doesNotReject(async () => {
    result = await captureShopChurn(
      prisma,
      { id: "s", merchantId: "m", shopDomain: "s.myshopify.com" },
      { now: NOW },
    );
  });
  assert.equal(result, null);
});
