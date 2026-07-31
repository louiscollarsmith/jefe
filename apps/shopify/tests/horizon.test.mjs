import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSeasonalHorizon,
  computeHorizon,
  getLatestHorizon,
} from "../app/lib/merchant-memory/horizon.server.js";

// Fixed clock built with the local-time constructor so day labels are stable
// regardless of the runner's timezone (the service formats + adds days locally).
const NOW = new Date(2026, 6, 31, 12, 0, 0); // 31 Jul 2026, local noon

// Mirror the service's date helpers so expectations are derived, not hardcoded.
const label = (/** @type {Date} */ d) =>
  d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const addDays = (/** @type {Date} */ d, /** @type {number} */ n) => {
  const r = new Date(d.getTime());
  r.setDate(r.getDate() + n);
  return r;
};

const SEASONAL_IDS = ["back-to-school", "bfcm", "christmas", "returns"];
const lowCoverItem = (/** @type {object} */ overrides) => ({
  productId: "p1",
  title: "Rosehip Serum",
  available: 5,
  dailyVelocity: 1.2,
  daysOfCover: 4,
  ...overrides,
});

test("near stockout is dated from stock ÷ velocity, not fabricated", () => {
  const { near } = computeHorizon({
    now: NOW,
    lowCoverItems: [lowCoverItem({})],
    recentRefundCount: 0,
  });
  const item = near.find((n) => n.id === "stockout-p1");
  assert.ok(item, "expected a near item for the low-cover product");
  assert.equal(item.date, label(addDays(NOW, 4))); // "4 Aug"
  assert.match(item.title, /Rosehip Serum/);
  assert.match(item.body, /About 5 left/);
  assert.match(item.body, /1\.2\/day/);
  assert.match(item.body, new RegExp(label(addDays(NOW, 4))));
  assert.equal(item.action, null);
});

test("store-grounded near items sort ahead of the far-out seasonal timeline", () => {
  const { near } = computeHorizon({
    now: NOW,
    lowCoverItems: [lowCoverItem({})],
    recentRefundCount: 0,
  });
  const ids = near.map((n) => n.id);
  // Seasonal timeline is kept, in full.
  for (const key of SEASONAL_IDS) assert.ok(ids.includes(key), `missing seasonal ${key}`);
  // The 4-Aug run-out sorts before back-to-school (1 Sep) and is the soonest item.
  assert.equal(ids[0], "stockout-p1");
  assert.ok(ids.indexOf("stockout-p1") < ids.indexOf("back-to-school"));
});

test("at-risk stock beyond two weeks becomes a 'watching' item with an honest revisit date", () => {
  const { near, watching } = computeHorizon({
    now: NOW,
    lowCoverItems: [
      lowCoverItem({ productId: "p2", title: "Clay Mask", available: 30, dailyVelocity: 1.5, daysOfCover: 20 }),
    ],
    recentRefundCount: 0,
  });
  assert.ok(!near.some((n) => n.id === "stockout-p2"), "20-day cover must not be a near item");
  const w = watching.find((x) => x.id === "stockwatch-p2");
  assert.ok(w, "expected a watching item for the later-risk product");
  assert.match(w.title, /Clay Mask/);
  assert.match(w.title, /about 20 days/);
  assert.match(w.reason, /1\.5\/day/);
  // Revisit when it enters the two-week window: now + (20 - 14) days.
  assert.match(w.reason, new RegExp(label(addDays(NOW, 6))));
});

test("refund projection is a dated near item derived from the trailing-30d count", () => {
  const { near } = computeHorizon({ now: NOW, lowCoverItems: [], recentRefundCount: 6 });
  const r = near.find((n) => n.id === "refund-projection");
  assert.ok(r, "expected a refund projection near item");
  // round(6 * 14 / 30) = round(2.8) = 3
  assert.match(r.title, /About 3 more refunds/);
  assert.match(r.body, /6 refunds in the last 30 days/);
  assert.match(r.body, /around 3 more/);
  assert.equal(r.date, label(addDays(NOW, 14))); // "14 Aug"
});

test("refund projection reads as singular when only ~1 is expected", () => {
  const { near } = computeHorizon({ now: NOW, lowCoverItems: [], recentRefundCount: 2 });
  const r = near.find((n) => n.id === "refund-projection");
  assert.ok(r);
  assert.match(r.title, /Another refund likely/);
});

test("a single recent refund is watched, not projected; zero refunds says nothing", () => {
  const one = computeHorizon({ now: NOW, lowCoverItems: [], recentRefundCount: 1 });
  assert.ok(one.watching.some((x) => x.id === "refund-watch"));
  assert.ok(!one.near.some((n) => n.id === "refund-projection"));

  const zero = computeHorizon({ now: NOW, lowCoverItems: [], recentRefundCount: 0 });
  assert.ok(!zero.watching.some((x) => x.id === "refund-watch"));
});

test("with no store signals, near is the seasonal timeline only and watching is empty", () => {
  const { near, watching } = computeHorizon({ now: NOW, lowCoverItems: [], recentRefundCount: 0 });
  assert.deepEqual([...near.map((n) => n.id)].sort(), [...SEASONAL_IDS].sort());
  assert.equal(watching.length, 0);
});

test("near stockouts are capped so the section can't flood", () => {
  const items = Array.from({ length: 7 }, (_, i) =>
    lowCoverItem({ productId: `p${i}`, title: `P${i}`, available: 3, dailyVelocity: 1, daysOfCover: i }),
  );
  const { near } = computeHorizon({ now: NOW, lowCoverItems: items, recentRefundCount: 0 });
  const stockCount = near.filter((n) => n.id.startsWith("stockout-")).length;
  assert.equal(stockCount, 5);
});

test("buildSeasonalHorizon returns four future entries, sorted, with matching labels", () => {
  const seasonal = buildSeasonalHorizon(NOW);
  assert.equal(seasonal.length, 4);
  for (let i = 1; i < seasonal.length; i++) {
    assert.ok(seasonal[i - 1].date.getTime() <= seasonal[i].date.getTime(), "not sorted ascending");
  }
  for (const e of seasonal) {
    assert.ok(e.date.getTime() >= NOW.getTime(), `${e.key} should roll forward to the future`);
    assert.equal(e.dateLabel, label(e.date));
  }
});

// ── wrapper: read path + resilience ───────────────────────────────────────────

function beliefRow(value) {
  return {
    id: "belief-low-cover",
    merchantId: "m1",
    shopId: "s1",
    category: "inventory",
    key: "inventory.low_cover_products.trailing_30d",
    value,
    valueType: "json",
    status: "system_inferred",
    confidence: 0.8,
    confidenceReason: null,
    firstObservedAt: null,
    lastObservedAt: null,
    lastEvaluatedAt: null,
    lastConfirmedAt: null,
    evidence: [],
  };
}

test("getLatestHorizon reads a merchant+shop-scoped 30d refund window and the low-cover belief", async () => {
  const calls = {};
  const prisma = {
    merchantMemoryBelief: {
      async findFirst(args) {
        calls.beliefWhere = args.where;
        return beliefRow({
          items: [{ productId: "p1", title: "Rosehip Serum", available: 5, dailyVelocity: 1.2, daysOfCover: 4 }],
        });
      },
    },
    refund: {
      async count(args) {
        calls.refundWhere = args.where;
        return 6;
      },
    },
  };

  const { near } = await getLatestHorizon(prisma, { merchantId: "m1", shopId: "s1", now: NOW });

  assert.equal(calls.beliefWhere.merchantId, "m1");
  assert.equal(calls.beliefWhere.key, "inventory.low_cover_products.trailing_30d");
  assert.equal(calls.refundWhere.merchantId, "m1");
  assert.equal(calls.refundWhere.shopId, "s1");
  assert.ok(calls.refundWhere.processedAt.gte instanceof Date, "expected a processedAt lower bound");
  assert.equal(calls.refundWhere.processedAt.gte.getTime(), addDays(NOW, -30).getTime());

  assert.ok(near.some((n) => n.id === "stockout-p1"));
  assert.ok(near.some((n) => n.id === "refund-projection"));
});

test("malformed belief items are skipped, never coerced into a fabricated stockout", async () => {
  const prisma = {
    merchantMemoryBelief: {
      async findFirst() {
        return beliefRow({
          items: [
            { productId: "bad", title: "No Velocity" }, // missing numbers → dropped
            { productId: "good", title: "Good", available: 5, dailyVelocity: 1, daysOfCover: 3 },
          ],
        });
      },
    },
    refund: { async count() { return 0; } },
  };

  const { near } = await getLatestHorizon(prisma, { merchantId: "m1", shopId: "s1", now: NOW });
  assert.ok(near.some((n) => n.id === "stockout-good"));
  assert.ok(!near.some((n) => n.id === "stockout-bad"));
});

test("a read failure degrades to the seasonal timeline only — no guessed numbers", async () => {
  const prisma = {
    merchantMemoryBelief: {
      async findFirst() {
        throw new Error("db unavailable");
      },
    },
    refund: { async count() { return 3; } },
  };

  const { near, watching } = await getLatestHorizon(prisma, { merchantId: "m1", shopId: "s1", now: NOW });
  assert.deepEqual([...near.map((n) => n.id)].sort(), [...SEASONAL_IDS].sort());
  assert.equal(watching.length, 0);
  assert.ok(!near.some((n) => n.id === "refund-projection"), "must not project refunds after a failed read");
});
