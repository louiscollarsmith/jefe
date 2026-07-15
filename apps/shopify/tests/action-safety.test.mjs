import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";

import {
  ACTION_STATUSES,
  approveAction,
  assertValueMatchesVerificationClass,
  blockAction,
  evaluateExecutionGates,
  executeAction,
  rejectAction,
} from "../app/services/action-safety.server.js";

const databaseUrl = process.env.DATABASE_URL;
const now = new Date("2026-07-15T09:00:00Z");

test("action lifecycle exposes the required safety statuses", () => {
  assert.deepEqual(ACTION_STATUSES, [
    "proposed",
    "draft_prepared",
    "needs_approval",
    "approved",
    "rejected",
    "blocked",
    "execution_queued",
    "executing",
    "executed",
    "execution_failed",
    "measurement_pending",
    "measured",
    "verified",
    "expired",
    "cancelled",
  ]);
});

test("estimated values cannot be labelled as verified lift", () => {
  assert.doesNotThrow(() =>
    assertValueMatchesVerificationClass({
      valueType: "estimated_prevention",
      verificationClass: "estimated",
    }),
  );
  assert.throws(
    () =>
      assertValueMatchesVerificationClass({
        valueType: "estimated_margin",
        verificationClass: "verified",
      }),
    /Estimated values cannot be stored as verified lift/,
  );
  assert.throws(
    () =>
      assertValueMatchesVerificationClass({
        valueType: "verified_margin",
        verificationClass: "estimated",
      }),
    /Verified value types require verified attribution/,
  );
});

test("approval and rejection transitions are audited and do not execute", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for action safety persistence tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const { merchant, shop } = await createTenant(prisma, suffix);
    const action = await createAction(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      suffix,
      status: "needs_approval",
      idempotencyKey: `approval-${suffix}`,
    });

    const approved = await approveAction(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      actionId: action.id,
      actor: "merchant-user-test",
      actorType: "merchant_user",
      comment: "Looks safe.",
      requestSnapshot: { source: "test" },
      now,
    });
    const approvalEvents = await prisma.actionApprovalEvent.findMany({
      where: { actionId: action.id },
      orderBy: { eventTs: "asc" },
    });
    const executions = await prisma.execution.findMany({
      where: { actionId: action.id },
    });

    assert.equal(approved.status, "approved");
    assert.ok(approved.approvedAt);
    assert.equal(executions.length, 0);
    assert.equal(approvalEvents.length, 1);
    assert.equal(approvalEvents[0].previousStatus, "needs_approval");
    assert.equal(approvalEvents[0].newStatus, "approved");
    assert.equal(approvalEvents[0].actorType, "merchant_user");

    const rejectedAction = await createAction(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      suffix: `reject-${suffix}`,
      status: "needs_approval",
      idempotencyKey: `reject-${suffix}`,
    });
    const rejected = await rejectAction(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      actionId: rejectedAction.id,
      actor: "merchant-user-test",
      actorType: "merchant_user",
      reason: "Not this week.",
      now,
    });
    const rejectionEvent = await prisma.actionApprovalEvent.findFirstOrThrow({
      where: { actionId: rejectedAction.id, newStatus: "rejected" },
    });

    assert.equal(rejected.status, "rejected");
    assert.ok(rejected.rejectedAt);
    assert.equal(rejectionEvent.reason, "Not this week.");
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Action Safety Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("execution gates block unsafe execution and keep verification separate", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for action safety persistence tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const { merchant, shop } = await createTenant(prisma, suffix);

    const needsApproval = await createAction(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      suffix: `needs-approval-${suffix}`,
      status: "needs_approval",
      idempotencyKey: `needs-approval-${suffix}`,
      executionMode: "live",
      externalSystem: "klaviyo",
    });
    const approvalBlocked = await executeAction(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      actionId: needsApproval.id,
      connector: "klaviyo",
      executionIdempotencyKey: `execute-needs-approval-${suffix}`,
      liveWritesEnabled: false,
      connectorAvailable: true,
      houseRulesPass: true,
      capsPass: true,
      now,
    });

    assert.equal(approvalBlocked.ok, false);
    assert.ok(approvalBlocked.blockedReasons.includes("approval_required"));

    const missingIdempotency = await createAction(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      suffix: `missing-idem-${suffix}`,
      status: "needs_approval",
      idempotencyKey: null,
      executionMode: "live",
      externalSystem: "klaviyo",
    });
    await approveAction(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      actionId: missingIdempotency.id,
      now,
    });
    const idempotencyBlocked = await executeAction(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      actionId: missingIdempotency.id,
      connector: "klaviyo",
      executionIdempotencyKey: `execute-missing-idem-${suffix}`,
      liveWritesEnabled: true,
      connectorAvailable: true,
      houseRulesPass: true,
      capsPass: true,
      now,
    });

    assert.equal(idempotencyBlocked.ok, false);
    assert.ok(
      idempotencyBlocked.blockedReasons.includes("missing_idempotency_key"),
    );

    const rulesBlockedAction = await createAction(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      suffix: `rules-${suffix}`,
      status: "needs_approval",
      idempotencyKey: `rules-${suffix}`,
      executionMode: "live",
      externalSystem: "klaviyo",
    });
    await approveAction(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      actionId: rulesBlockedAction.id,
      now,
    });
    const rulesBlocked = await executeAction(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      actionId: rulesBlockedAction.id,
      connector: "klaviyo",
      executionIdempotencyKey: `execute-rules-${suffix}`,
      liveWritesEnabled: true,
      connectorAvailable: true,
      houseRulesPass: false,
      capsPass: false,
      now,
    });

    assert.equal(rulesBlocked.ok, false);
    assert.ok(rulesBlocked.blockedReasons.includes("house_rules_blocked"));
    assert.ok(rulesBlocked.blockedReasons.includes("audience_cap_exceeded"));

    const missingConnectorAction = await createAction(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      suffix: `connector-${suffix}`,
      status: "needs_approval",
      idempotencyKey: `connector-${suffix}`,
      executionMode: "live",
      externalSystem: "klaviyo",
    });
    await approveAction(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      actionId: missingConnectorAction.id,
      now,
    });
    const connectorBlocked = await executeAction(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      actionId: missingConnectorAction.id,
      connector: "klaviyo",
      executionIdempotencyKey: `execute-connector-${suffix}`,
      liveWritesEnabled: true,
      connectorAvailable: false,
      houseRulesPass: true,
      capsPass: true,
      now,
    });

    assert.equal(connectorBlocked.ok, false);
    assert.ok(connectorBlocked.blockedReasons.includes("missing_connector"));

    const liveDisabledAction = await createAction(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      suffix: `live-${suffix}`,
      status: "needs_approval",
      idempotencyKey: `live-${suffix}`,
      executionMode: "live",
      externalSystem: "klaviyo",
    });
    await approveAction(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      actionId: liveDisabledAction.id,
      now,
    });
    const liveBlocked = await executeAction(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      actionId: liveDisabledAction.id,
      connector: "klaviyo",
      executionIdempotencyKey: `execute-live-${suffix}`,
      liveWritesEnabled: false,
      connectorAvailable: true,
      houseRulesPass: true,
      capsPass: true,
      now,
    });
    const liveExecutions = await prisma.execution.findMany({
      where: { actionId: liveDisabledAction.id },
    });

    assert.equal(liveBlocked.ok, false);
    assert.ok(liveBlocked.blockedReasons.includes("live_write_disabled"));
    assert.equal(liveExecutions.length, 0);

    const rejectedAction = await createAction(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      suffix: `rejected-${suffix}`,
      status: "needs_approval",
      idempotencyKey: `rejected-${suffix}`,
      executionMode: "live",
      externalSystem: "klaviyo",
    });
    await rejectAction(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      actionId: rejectedAction.id,
      reason: "Rejected before execution.",
      now,
    });
    const rejectedBlocked = await executeAction(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      actionId: rejectedAction.id,
      connector: "klaviyo",
      executionIdempotencyKey: `execute-rejected-${suffix}`,
      liveWritesEnabled: true,
      connectorAvailable: true,
      houseRulesPass: true,
      capsPass: true,
      now,
    });

    assert.equal(rejectedBlocked.ok, false);
    assert.ok(rejectedBlocked.blockedReasons.includes("invalid_status"));

    const blockedAction = await createAction(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      suffix: `blocked-${suffix}`,
      status: "proposed",
      idempotencyKey: `blocked-${suffix}`,
      executionMode: "live",
      externalSystem: "klaviyo",
    });
    await blockAction(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      actionId: blockedAction.id,
      reason: "house_rules_blocked",
      now,
    });
    const alreadyBlocked = await executeAction(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      actionId: blockedAction.id,
      connector: "klaviyo",
      executionIdempotencyKey: `execute-blocked-${suffix}`,
      liveWritesEnabled: true,
      connectorAvailable: true,
      houseRulesPass: true,
      capsPass: true,
      now,
    });

    assert.equal(alreadyBlocked.ok, false);
    assert.ok(alreadyBlocked.blockedReasons.includes("invalid_status"));

    const dryRunAction = await createAction(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      suffix: `dry-run-${suffix}`,
      status: "needs_approval",
      idempotencyKey: `dry-run-${suffix}`,
      executionMode: "dry_run",
      externalSystem: "klaviyo",
    });
    const dryRunGate = evaluateExecutionGates(dryRunAction, {
      liveWritesEnabled: false,
      connectorAvailable: false,
      houseRulesPass: true,
      capsPass: true,
    });

    assert.equal(dryRunGate.ok, true);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Action Safety Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

async function createTenant(prisma, suffix) {
  const merchant = await prisma.merchant.create({
    data: {
      name: `Action Safety Merchant ${suffix}`,
      primaryCurrency: "GBP",
      shops: {
        create: {
          shopDomain: `action-safety-${suffix}.myshopify.com`,
          rawPayload: { source: "test" },
        },
      },
    },
    include: { shops: true },
  });

  return { merchant, shop: merchant.shops[0] };
}

async function createAction(
  prisma,
  {
    merchantId,
    shopId,
    status,
    idempotencyKey,
    executionMode = "live",
    externalSystem = "klaviyo",
  },
) {
  return prisma.action.create({
    data: {
      merchantId,
      shopId,
      actionType: "klaviyo_winback",
      status,
      title: "Action safety test",
      summary: "Exercise action safety gates.",
      expectedValue: { base: 100, currency: "GBP" },
      valueCurrency: "GBP",
      valueType: "estimated_revenue",
      confidence: "0.7000",
      riskLevel: "medium",
      approvalRequired: true,
      evidence: [{ source: "test" }],
      rulesConsulted: [{ source: "test", rules: ["approval"] }],
      ruleConstraintsApplied: [{ rule: "test_cap" }],
      capsApplied: [{ rule: "test_cap" }],
      preview: { title: "Preview" },
      verificationClass: "ESTIMATED",
      executionMode,
      externalSystem,
      idempotencyKey,
      proposedAt: now,
    },
  });
}
