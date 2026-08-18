import { test } from "node:test";
import assert from "node:assert/strict";
import {
  proactiveBudget,
  decideProactiveGeneration,
  startOfMerchantDay,
  startOfNextMerchantDay,
  computeNextRecommendationCheck,
  maybeEnqueueProactivePlan,
  DEFAULT_PROACTIVE_DAILY_CAP,
} from "../app/lib/merchant-plan/proactive-recommendations.server.js";

test("proactiveBudget: under the cap → allowed with remaining", () => {
  const b = proactiveBudget({ generatedToday: 2 });
  assert.equal(b.allowed, true);
  assert.equal(b.cap, DEFAULT_PROACTIVE_DAILY_CAP);
  assert.equal(b.remaining, 3);
  assert.equal(b.reason, null);
});

test("proactiveBudget: exactly at the cap → blocked", () => {
  const b = proactiveBudget({ generatedToday: 5 });
  assert.equal(b.allowed, false);
  assert.equal(b.remaining, 0);
  assert.equal(b.reason, "daily_cap_reached");
});

test("proactiveBudget: over the cap never goes negative", () => {
  const b = proactiveBudget({ generatedToday: 9 });
  assert.equal(b.allowed, false);
  assert.equal(b.remaining, 0);
});

test("proactiveBudget: custom cap is honoured", () => {
  assert.equal(proactiveBudget({ generatedToday: 2, cap: 3 }).remaining, 1);
  assert.equal(proactiveBudget({ generatedToday: 3, cap: 3 }).allowed, false);
});

test("proactiveBudget: junk inputs fall back safely (no negative cap, no NaN)", () => {
  assert.equal(proactiveBudget({ generatedToday: NaN }).remaining, DEFAULT_PROACTIVE_DAILY_CAP);
  assert.equal(proactiveBudget({ generatedToday: -4 }).remaining, DEFAULT_PROACTIVE_DAILY_CAP);
  assert.equal(proactiveBudget({ generatedToday: 0, cap: 0 }).cap, DEFAULT_PROACTIVE_DAILY_CAP);
  assert.equal(proactiveBudget({ generatedToday: 0, cap: -2 }).cap, DEFAULT_PROACTIVE_DAILY_CAP);
});

test("decideProactiveGeneration: enqueues when under cap", async () => {
  const res = await decideProactiveGeneration(/** @type {any} */ ({}), {
    merchantId: "m1",
    since: new Date("2026-08-12T00:00:00Z"),
    deps: { count: async () => 1 },
  });
  assert.equal(res.enqueue, true);
  assert.equal(res.generatedToday, 1);
  assert.equal(res.remaining, 4);
});

test("decideProactiveGeneration: refuses at the cap", async () => {
  const res = await decideProactiveGeneration(/** @type {any} */ ({}), {
    merchantId: "m1",
    since: new Date("2026-08-12T00:00:00Z"),
    deps: { count: async () => 5 },
  });
  assert.equal(res.enqueue, false);
  assert.equal(res.reason, "daily_cap_reached");
});

test("decideProactiveGeneration: FAIL-CLOSED when the count read throws", async () => {
  const res = await decideProactiveGeneration(/** @type {any} */ ({}), {
    merchantId: "m1",
    since: new Date("2026-08-12T00:00:00Z"),
    deps: {
      count: async () => {
        throw new Error("db down");
      },
    },
  });
  assert.equal(res.enqueue, false, "a broken cap read must never over-message the merchant");
  assert.equal(res.reason, "cap_read_failed");
});

test("startOfMerchantDay: midnight UTC of the merchant's local date; bad tz falls back", () => {
  // 01:30 UTC on the 12th is still the 11th in Los Angeles (UTC-7/8).
  const now = new Date("2026-08-12T01:30:00Z");
  assert.equal(startOfMerchantDay(now, "America/Los_Angeles").toISOString(), "2026-08-11T00:00:00.000Z");
  assert.equal(startOfMerchantDay(now, "UTC").toISOString(), "2026-08-12T00:00:00.000Z");
  assert.equal(startOfMerchantDay(now, "Not/AZone").toISOString(), "2026-08-12T00:00:00.000Z");
});

test("maybeEnqueueProactivePlan: enqueues a proactive run when under cap", async () => {
  const calls = [];
  const res = await maybeEnqueueProactivePlan(/** @type {any} */ ({}), {
    merchantId: "m1",
    shopId: "s1",
    now: new Date("2026-08-12T09:00:00Z"),
    timeZone: "Europe/London",
    deps: { count: async () => 1 },
    ensureQueued: async (_p, input) => {
      calls.push(input);
      return { status: "queued" };
    },
  });
  assert.equal(res.enqueued, true);
  assert.equal(res.status, "queued");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceMode, "proactive", "the run must be marked proactive so the cap counts it");
});

test("maybeEnqueueProactivePlan: at the cap, never touches generation", async () => {
  let called = false;
  const res = await maybeEnqueueProactivePlan(/** @type {any} */ ({}), {
    merchantId: "m1",
    shopId: "s1",
    now: new Date("2026-08-12T09:00:00Z"),
    deps: { count: async () => DEFAULT_PROACTIVE_DAILY_CAP },
    ensureQueued: async () => {
      called = true;
      return { status: "queued" };
    },
  });
  assert.equal(res.enqueued, false);
  assert.equal(res.reason, "daily_cap_reached");
  assert.equal(called, false, "capped merchant must not reach the generator at all");
});

test("maybeEnqueueProactivePlan: an unchanged snapshot ('reused') is not an enqueue", async () => {
  const res = await maybeEnqueueProactivePlan(/** @type {any} */ ({}), {
    merchantId: "m1",
    shopId: "s1",
    now: new Date("2026-08-12T09:00:00Z"),
    deps: { count: async () => 0 },
    ensureQueued: async () => ({ status: "reused" }),
  });
  assert.equal(res.enqueued, false, "nothing new to say → not counted as a generation");
  assert.equal(res.status, "reused");
});

test("startOfNextMerchantDay: rolls to the following merchant-local date", () => {
  const now = new Date("2026-08-12T09:00:00Z");
  assert.equal(
    startOfNextMerchantDay(now, "Europe/London").toISOString(),
    "2026-08-13T00:00:00.000Z",
  );
});

test("computeNextRecommendationCheck: under cap → next hourly boundary", () => {
  const now = new Date("2026-08-12T09:17:00Z");
  const check = computeNextRecommendationCheck({
    now,
    timeZone: "Europe/London",
    generatedToday: 2,
  });
  assert.equal(check.kind, "hourly_check");
  assert.equal(check.at.toISOString(), "2026-08-12T10:00:00.000Z");
  assert.equal(check.remaining, 3);
});

test("computeNextRecommendationCheck: at cap → next merchant day", () => {
  const now = new Date("2026-08-12T21:00:00Z");
  const check = computeNextRecommendationCheck({
    now,
    timeZone: "Europe/London",
    generatedToday: DEFAULT_PROACTIVE_DAILY_CAP,
  });
  assert.equal(check.kind, "daily_cap_reached");
  assert.equal(check.at.toISOString(), "2026-08-13T00:00:00.000Z");
  assert.equal(check.remaining, 0);
});
