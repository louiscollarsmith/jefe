import assert from "node:assert/strict";
import test from "node:test";

import { deferMerchantAction } from "../app/lib/actions/action-command.server.js";
import { PLAN_REVIEW_STATUS } from "../app/lib/merchant-plan/constants.js";

const MERCHANT = "m1";
const SHOP = "s1";

function fakePrisma({ action, recommendation } = {}) {
  const actions = action ? [{ ...action }] : [];
  const recommendations = recommendation ? [{ ...recommendation }] : [];
  const events = [];
  return {
    actions,
    recommendations,
    events,
    merchantAction: {
      findFirst: async ({ where }) =>
        actions.find(
          (row) =>
            row.id === where.id &&
            row.merchantId === where.merchantId &&
            row.shopId === where.shopId,
        ) ?? null,
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const row of actions) {
          if (
            row.id === where.id &&
            row.merchantId === where.merchantId &&
            row.shopId === where.shopId
          ) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      },
    },
    merchantPlanRecommendation: {
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const row of recommendations) {
          if (
            row.id === where.id &&
            row.merchantId === where.merchantId &&
            row.shopId === where.shopId
          ) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      },
    },
    merchantActionEvent: {
      create: async ({ data }) => {
        events.push(data);
        return data;
      },
    },
  };
}

test("deferMerchantAction reject path writes canonical PLAN_REVIEW_STATUS.rejected with rejectedAt, not an orphan 'declined' string", async () => {
  const prisma = fakePrisma({
    action: { id: "action-1", merchantId: MERCHANT, shopId: SHOP, sourceRecommendationId: "rec-1", status: "proposed" },
    recommendation: { id: "rec-1", merchantId: MERCHANT, shopId: SHOP, reviewStatus: "proposed", rejectedAt: null },
  });

  const result = await deferMerchantAction(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "action-1",
    actor: MERCHANT,
    status: "declined",
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "declined");
  // MerchantAction keeps its own vocabulary ("declined")...
  assert.equal(prisma.actions[0].status, "declined");
  // ...but the recommendation-level concept is the canonical enum value that
  // candidates.server.js and schema.server.js#duplicatesPriorRecommendation
  // actually query for, not a "declined" synonym that would silently drop out
  // of future-recommendation history.
  assert.equal(prisma.recommendations[0].reviewStatus, PLAN_REVIEW_STATUS.rejected);
  assert.equal(prisma.recommendations[0].reviewStatus, "rejected");
  assert.ok(prisma.recommendations[0].rejectedAt instanceof Date);
  assert.equal(
    prisma.events.some((event) => event.eventType === "action_rejected"),
    true,
  );
});

test("deferMerchantAction defer path holds the action without writing rejectedAt", async () => {
  const prisma = fakePrisma({
    action: { id: "action-1", merchantId: MERCHANT, shopId: SHOP, sourceRecommendationId: "rec-1", status: "proposed" },
    recommendation: { id: "rec-1", merchantId: MERCHANT, shopId: SHOP, reviewStatus: "proposed", rejectedAt: null },
  });

  const result = await deferMerchantAction(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "action-1",
    actor: MERCHANT,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "deferred");
  assert.equal(prisma.actions[0].status, "deferred");
  assert.equal(prisma.recommendations[0].reviewStatus, "deferred");
  assert.notEqual(prisma.recommendations[0].reviewStatus, PLAN_REVIEW_STATUS.rejected);
  assert.equal(prisma.recommendations[0].rejectedAt, null);
  assert.equal(
    prisma.events.some((event) => event.eventType === "action_deferred"),
    true,
  );
});

test("deferMerchantAction returns not_found for an unknown action and writes nothing", async () => {
  const prisma = fakePrisma({});

  const result = await deferMerchantAction(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "missing",
    status: "declined",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_found");
  assert.equal(prisma.events.length, 0);
});
