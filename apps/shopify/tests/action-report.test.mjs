import assert from "node:assert/strict";
import test from "node:test";
import { shapeActionSummary, summarizeExecutedActions } from "../app/lib/actions/action-report.server.js";

test("shapeActionSummary is defensive against empty / malformed input", () => {
  const empty = shapeActionSummary([]);
  assert.equal(empty.totalRuns, 0);
  assert.equal(empty.hasExecutedAny, false);
  assert.equal(empty.executionSuccessRatePercent, null);
  assert.deepEqual(empty.byActionType, []);
  assert.equal(shapeActionSummary(null).totalExecuted, 0);
  assert.equal(shapeActionSummary([{ actionType: "x" }]).totalRuns, 0); // no _count
});

test("shapeActionSummary rolls up the proposal→execution funnel + outcome mix", () => {
  const rows = [
    { actionType: "price_markdown", status: "proposed", _count: { _all: 4 } },
    { actionType: "price_markdown", status: "applied", _count: { _all: 6 } },
    { actionType: "price_markdown", status: "partially_applied", _count: { _all: 1 } },
    { actionType: "price_markdown", status: "reverted", _count: { _all: 1 } },
    { actionType: "product_status_change", status: "applied", _count: { _all: 2 } },
    { actionType: "product_status_change", status: "failed", _count: { _all: 1 } },
  ];
  const s = shapeActionSummary(rows);
  assert.equal(s.proposed, 4);
  assert.equal(s.applied, 8); // 6 + 2
  assert.equal(s.partiallyApplied, 1);
  assert.equal(s.reverted, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.totalExecuted, 11); // 8 applied + 1 partial + 1 reverted + 1 failed
  assert.equal(s.successful, 9); // 8 applied + 1 partial
  assert.equal(s.executionSuccessRatePercent, round2(9 / 11 * 100));
  assert.equal(s.hasExecutedAny, true);
  assert.equal(s.byActionType[0].actionType, "price_markdown"); // highest total first
  const psc = s.byActionType.find((t) => t.actionType === "product_status_change");
  assert.equal(psc.applied, 2);
  assert.equal(psc.failed, 1);
  assert.equal(psc.successful, 2);
});

test("milestone: hasExecutedAny is false until a real successful execution lands", () => {
  // only proposed/approved so far (dark / pre-approval) → not yet executed
  const s = shapeActionSummary([
    { actionType: "price_markdown", status: "proposed", _count: { _all: 3 } },
    { actionType: "price_markdown", status: "approved", _count: { _all: 1 } },
  ]);
  assert.equal(s.hasExecutedAny, false);
  assert.equal(s.totalExecuted, 0);
  assert.equal(s.executionSuccessRatePercent, null);
  assert.equal(s.totalRuns, 4);
});

test("a run that only reverted/failed does not count as a successful execution", () => {
  const s = shapeActionSummary([
    { actionType: "price_markdown", status: "reverted", _count: { _all: 2 } },
    { actionType: "price_markdown", status: "failed", _count: { _all: 1 } },
  ]);
  assert.equal(s.hasExecutedAny, false);
  assert.equal(s.totalExecuted, 3);
  assert.equal(s.successful, 0);
  assert.equal(s.executionSuccessRatePercent, 0);
});

test("summarizeExecutedActions issues the groupBy + shapes it (mock prisma)", async () => {
  let captured = null;
  const prisma = {
    actionExecution: {
      groupBy: async (args) => {
        captured = args;
        return [{ actionType: "price_markdown", status: "applied", _count: { _all: 5 } }];
      },
    },
  };
  const s = await summarizeExecutedActions(prisma);
  assert.deepEqual(captured.by, ["actionType", "status"]);
  assert.equal(s.applied, 5);
  assert.equal(s.hasExecutedAny, true);
});

function round2(n) {
  return Math.round(n * 100) / 100;
}
