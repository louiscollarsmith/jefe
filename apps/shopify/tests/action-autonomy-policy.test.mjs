import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAutonomyPolicy,
  DEFAULT_ACTION_MODE,
  getActionMode,
  getActionPolicy,
  isValidActionMode,
  setActionMode,
} from "../app/lib/actions/action-autonomy-policy.server.js";

test("applyAutonomyPolicy degrades an over-cap auto run to approve; leaves within-cap auto alone", () => {
  const auto = { mode: "auto", reason: "merchant_autonomous_and_eligible" };
  // Over the trapped-capital cap → degrade to approve, naming the violation.
  const over = applyAutonomyPolicy(auto, { autoMaxTrappedCapital: 500 }, { trappedCapital: 900, variantCount: 3, maxDiscountPercent: 30 });
  assert.equal(over.mode, "approve");
  assert.equal(over.reason, "exceeds_autonomy_policy");
  assert.deepEqual(over.policyViolations, ["over_auto_max_trapped_capital"]);
  // Within all caps → stays auto.
  const within = applyAutonomyPolicy(auto, { autoMaxTrappedCapital: 1000, autoMaxVariants: 5 }, { trappedCapital: 900, variantCount: 3, maxDiscountPercent: 30 });
  assert.equal(within.mode, "auto");
  // Empty policy → no-op.
  assert.equal(applyAutonomyPolicy(auto, {}, { trappedCapital: 9e9 }).mode, "auto");
});

test("applyAutonomyPolicy never widens — approve/recommend pass through untouched", () => {
  const approve = { mode: "approve", reason: "merchant_approve_execute" };
  assert.equal(applyAutonomyPolicy(approve, { autoMaxTrappedCapital: 1 }, { trappedCapital: 9e9 }).mode, "approve");
  const recommend = { mode: "recommend", reason: "merchant_recommend_only" };
  assert.equal(applyAutonomyPolicy(recommend, { autoMaxVariants: 0 }, { variantCount: 9e9 }).mode, "recommend");
});

test("getActionPolicy keeps only known finite non-negative caps", async () => {
  const prisma = {
    actionAutonomyPolicy: {
      findUnique: async () => ({ policy: { autoMaxTrappedCapital: 500, autoMaxVariants: -3, bogus: "x", autoMaxDiscountPercent: 40 } }),
    },
  };
  const policy = await getActionPolicy(prisma, { merchantId: "m1", actionType: "price_markdown" });
  assert.deepEqual(policy, { autoMaxTrappedCapital: 500, autoMaxDiscountPercent: 40 }); // -3 + bogus dropped
});

function mockPolicyPrisma(initial = null) {
  let row = initial;
  return {
    _row: () => row,
    actionAutonomyPolicy: {
      findUnique: async () => (row ? { ...row } : null),
      upsert: async ({ create, update }) => {
        row = row ? { ...row, ...update } : { ...create };
        return { ...row };
      },
    },
  };
}

test("isValidActionMode accepts the three settings, rejects anything else", () => {
  assert.equal(isValidActionMode("recommend"), true);
  assert.equal(isValidActionMode("approve_execute"), true);
  assert.equal(isValidActionMode("autonomous"), true);
  assert.equal(isValidActionMode("auto"), false); // that's a resolved mode, not a setting
  assert.equal(isValidActionMode(null), false);
});

test("getActionMode defaults to approve_execute (propose-first) when no dial is set", async () => {
  const prisma = mockPolicyPrisma(null);
  assert.equal(await getActionMode(prisma, { merchantId: "m1", actionType: "price_markdown" }), DEFAULT_ACTION_MODE);
  assert.equal(DEFAULT_ACTION_MODE, "approve_execute"); // never auto by default
});

test("getActionMode returns the stored mode; a corrupt value falls back to the default", async () => {
  assert.equal(
    await getActionMode(mockPolicyPrisma({ mode: "autonomous" }), { merchantId: "m1", actionType: "price_markdown" }),
    "autonomous",
  );
  assert.equal(
    await getActionMode(mockPolicyPrisma({ mode: "garbage" }), { merchantId: "m1", actionType: "price_markdown" }),
    DEFAULT_ACTION_MODE, // never trust a bad stored value
  );
});

test("setActionMode upserts a valid mode", async () => {
  const prisma = mockPolicyPrisma(null);
  const res = await setActionMode(prisma, { merchantId: "m1", actionType: "price_markdown", mode: "autonomous" });
  assert.equal(res.status, "ok");
  assert.equal(prisma._row().mode, "autonomous");
  // idempotent update path
  await setActionMode(prisma, { merchantId: "m1", actionType: "price_markdown", mode: "recommend" });
  assert.equal(prisma._row().mode, "recommend");
});

test("setActionMode refuses an invalid mode and writes nothing", async () => {
  const prisma = mockPolicyPrisma(null);
  const res = await setActionMode(prisma, { merchantId: "m1", actionType: "price_markdown", mode: "auto" });
  assert.equal(res.status, "invalid_mode");
  assert.equal(prisma._row(), null); // nothing stored
});
