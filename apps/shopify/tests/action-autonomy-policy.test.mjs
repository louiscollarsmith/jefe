import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ACTION_MODE,
  getActionMode,
  isValidActionMode,
  setActionMode,
} from "../app/lib/actions/action-autonomy-policy.server.js";

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
