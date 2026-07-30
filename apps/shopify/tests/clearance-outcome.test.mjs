import assert from "node:assert/strict";
import test from "node:test";
import {
  measureAndRecordClearanceOutcomes,
  measureClearanceOutcome,
} from "../app/lib/actions/clearance-outcome.server.js";

const run = {
  appliedAt: "2026-07-01T00:00:00.000Z",
  changes: [
    { variantId: "v1", toPrice: 70 },
    { variantId: "v2", toPrice: 45 },
    { variantId: "v3", toPrice: 20 },
  ],
};

test("measures post-clearance movement: units, revenue, effectiveness rate", () => {
  const out = measureClearanceOutcome(run, [
    // v1 moved twice after the clearance, at the paid price.
    { variantId: "v1", quantity: 2, unitPrice: 70, processedAt: "2026-07-05T00:00:00.000Z" },
    { variantId: "v1", quantity: 1, unitPrice: 70, processedAt: "2026-07-09T00:00:00.000Z" },
    // v2 moved once.
    { variantId: "v2", quantity: 1, unitPrice: 45, processedAt: "2026-07-06T00:00:00.000Z" },
    // v3 never sold post-clearance.
  ]);
  assert.equal(out.variantsCleared, 3);
  assert.equal(out.variantsSold, 2); // v1, v2
  assert.equal(out.unitsMoved, 4); // 2 + 1 + 1
  assert.equal(out.revenueRecovered, 255); // 3*70 + 1*45
  assert.equal(out.effectivenessRatePercent, round2((2 / 3) * 100)); // 66.67
});

test("excludes sales BEFORE the clearance was applied (no false credit)", () => {
  const out = measureClearanceOutcome(run, [
    { variantId: "v1", quantity: 5, unitPrice: 70, processedAt: "2026-06-20T00:00:00.000Z" }, // pre-clearance
    { variantId: "v1", quantity: 1, unitPrice: 70, processedAt: "2026-07-02T00:00:00.000Z" }, // post
  ]);
  assert.equal(out.unitsMoved, 1); // only the post-clearance unit
  assert.equal(out.variantsSold, 1);
});

test("excludes variants that weren't part of the run", () => {
  const out = measureClearanceOutcome(run, [
    { variantId: "vX", quantity: 9, unitPrice: 100, processedAt: "2026-07-05T00:00:00.000Z" },
  ]);
  assert.equal(out.unitsMoved, 0);
  assert.equal(out.variantsSold, 0);
  assert.equal(out.revenueRecovered, 0);
});

test("falls back to the clearance target price when the line item has no unit price", () => {
  const out = measureClearanceOutcome(run, [
    { variantId: "v2", quantity: 2, processedAt: "2026-07-05T00:00:00.000Z" }, // no unitPrice -> use toPrice 45
  ]);
  assert.equal(out.revenueRecovered, 90); // 2 * 45
});

test("empty / no-movement runs report zeros without dividing by zero", () => {
  assert.deepEqual(measureClearanceOutcome({ appliedAt: run.appliedAt, changes: [] }, []), {
    variantsCleared: 0,
    variantsSold: 0,
    unitsMoved: 0,
    revenueRecovered: 0,
    effectivenessRatePercent: 0,
  });
  // Cleared but nothing sold -> 0% effectiveness, not NaN.
  const cold = measureClearanceOutcome(run, []);
  assert.equal(cold.effectivenessRatePercent, 0);
  assert.equal(cold.variantsCleared, 3);
});

test("measureAndRecordClearanceOutcomes scores an applied run and writes outcome=measured", async () => {
  let findManyArgs = null;
  const updates = [];
  const prisma = {
    actionExecution: {
      findMany: async (args) => {
        findManyArgs = args;
        return [
          {
            id: "e1",
            runId: "r1",
            merchantId: "m1",
            shopId: "s1",
            appliedAt: new Date("2026-07-01T00:00:00.000Z"),
            preview: { changes: [{ variantId: "v1", toPrice: 70 }, { variantId: "v2", toPrice: 45 }] },
          },
        ];
      },
      update: async ({ where, data }) => {
        updates.push({ where, data });
        return { id: where.id, ...data };
      },
    },
    orderLineItem: {
      findMany: async () => [
        { variantId: "v1", quantity: 2, unitPrice: 70, order: { processedAt: new Date("2026-07-05T00:00:00.000Z") } },
      ],
    },
  };

  const res = await measureAndRecordClearanceOutcomes(prisma, {
    now: new Date("2026-07-20T00:00:00.000Z"),
    measurementWindowDays: 14,
  });

  // Query targets only unscored, applied, past-window runs.
  assert.deepEqual(findManyArgs.where.status, { in: ["applied", "partially_applied"] });
  assert.equal(findManyArgs.where.outcomeStatus, "pending");
  assert.deepEqual(findManyArgs.where.appliedAt, { lte: new Date("2026-07-06T00:00:00.000Z") });

  assert.equal(res.measured, 1);
  assert.equal(res.results[0].variantsCleared, 2);
  assert.equal(res.results[0].variantsSold, 1); // only v1 moved
  assert.equal(res.results[0].unitsMoved, 2);
  // Persisted onto the ledger row: the outcome + measured status.
  assert.equal(updates.length, 1);
  assert.equal(updates[0].where.id, "e1");
  assert.equal(updates[0].data.outcomeStatus, "measured");
  assert.equal(updates[0].data.outcome.variantsCleared, 2);
  assert.ok(updates[0].data.outcomeMeasuredAt instanceof Date);
});

test("measureAndRecordClearanceOutcomes: no eligible runs → nothing measured, no writes", async () => {
  const prisma = {
    actionExecution: {
      findMany: async () => [],
      update: async () => {
        throw new Error("must not update when there are no eligible runs");
      },
    },
    orderLineItem: { findMany: async () => [] },
  };
  const res = await measureAndRecordClearanceOutcomes(prisma, {});
  assert.equal(res.measured, 0);
  assert.deepEqual(res.results, []);
});

/** @param {number} value */
function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
