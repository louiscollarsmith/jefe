import { test } from "node:test";
import assert from "node:assert/strict";
import {
  proactiveBudget,
  decideProactiveGeneration,
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
