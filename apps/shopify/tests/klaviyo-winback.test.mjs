import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";

import {
  approveWinbackProposal,
  buildWinbackProposal,
  connectKlaviyoPrivateKey,
  createWinbackProposal,
  diagnoseWinbackOrderInputs,
  dormantCustomersFromOrders,
  estimateWinbackValue,
  WINBACK_DORMANT_MAX_DAYS,
  WINBACK_DORMANT_MIN_DAYS,
} from "../app/services/klaviyo-winback.server.js";
import { saveOnboardingHouseRules } from "../app/services/onboarding.server.js";

const now = new Date("2026-07-15T09:00:00Z");
const databaseUrl = process.env.DATABASE_URL;

test("winback audience includes only email-reachable dormant customers", () => {
  const audience = dormantCustomersFromOrders(
    [
      order({
        externalId: "recent",
        email: "recent@example.com",
        processedAt: "2026-06-20T10:00:00Z",
        totalPrice: "50.00",
      }),
      order({
        externalId: "dormant-1",
        customerExternalId: "gid://shopify/Customer/1",
        email: "founder@example.com",
        processedAt: "2026-04-20T10:00:00Z",
        totalPrice: "40.00",
        products: ["Starter Kit"],
      }),
      order({
        externalId: "dormant-2",
        customerExternalId: "gid://shopify/Customer/1",
        email: "founder@example.com",
        processedAt: "2026-02-20T10:00:00Z",
        totalPrice: "20.00",
        products: ["Refill"],
      }),
      order({
        externalId: "too-old",
        email: "old@example.com",
        processedAt: "2025-12-01T10:00:00Z",
        totalPrice: "80.00",
      }),
      order({
        externalId: "suppressed",
        email: "suppressed@example.com",
        processedAt: "2026-04-15T10:00:00Z",
        totalPrice: "100.00",
        acceptsMarketing: false,
      }),
      order({
        externalId: "missing-email",
        email: null,
        processedAt: "2026-04-15T10:00:00Z",
        totalPrice: "100.00",
      }),
    ],
    now,
  );

  assert.equal(audience.length, 1);
  assert.equal(audience[0].customerExternalId, "gid://shopify/Customer/1");
  assert.equal(audience[0].maskedEmail, "fo***@example.com");
  assert.equal(audience[0].emailHash.length, 64);
  assert.equal(audience[0].previousOrderCount, 2);
  assert.equal(audience[0].previousTotalSpend, 60);
  assert.equal(audience[0].averageOrderValue, 30);
  assert.deepEqual(audience[0].productsBought, ["Starter Kit", "Refill"]);
  assert.ok(audience[0].daysSinceLastOrder >= WINBACK_DORMANT_MIN_DAYS);
  assert.ok(audience[0].daysSinceLastOrder <= WINBACK_DORMANT_MAX_DAYS);
});

test("winback value estimate is conservative and separate from verified lift", () => {
  const estimate = estimateWinbackValue({
    audienceSize: 326,
    averageOrderValue: 41,
    discountPercent: 10,
  });

  assert.deepEqual(estimate.expectedRevenue, {
    low: 267.32,
    base: 668.3,
    high: 1069.28,
  });
  assert.deepEqual(estimate.discountCost, {
    low: 26.73,
    base: 66.83,
    high: 106.93,
  });
  assert.deepEqual(estimate.revenueAfterDiscount, {
    low: 240.59,
    base: 601.47,
    high: 962.35,
  });
});

test("winback proposal includes deterministic email campaign copy preview", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for winback persistence tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const merchant = await prisma.merchant.create({
      data: {
        name: `Winback Copy Test Merchant ${suffix}`,
        primaryCurrency: "GBP",
        shops: {
          create: {
            shopDomain: `winback-copy-${suffix}.myshopify.com`,
            rawPayload: { source: "test" },
          },
        },
      },
      include: { shops: true },
    });
    const shop = merchant.shops[0];

    await saveOnboardingHouseRules(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      rules: {
        maxDefaultDiscountPercent: "15",
        maxWinbackDiscountPercent: "10",
        maxCampaignAudienceSize: "20",
        emailCooldownDays: "7",
      },
    });
    await prisma.order.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        externalId: `copy-order-${suffix}`,
        customerExternalId: `gid://shopify/Customer/copy-${suffix}`,
        currency: "GBP",
        totalPrice: "40.00",
        processedAt: new Date("2026-04-15T10:00:00Z"),
        rawPayload: {
          email: `copy-buyer-${suffix}@example.com`,
          acceptsMarketing: true,
          customer: {
            email: `copy-buyer-${suffix}@example.com`,
          },
        },
      },
    });

    const proposal = await buildWinbackProposal(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      now,
    });

    assert.equal(
      proposal.preview.subjectLine,
      "A 10% thank-you for coming back",
    );
    assert.equal(
      proposal.preview.bodySummary,
      "We noticed it has been a while since your last order. Here is 10% off your next purchase.",
    );
    assert.deepEqual(proposal.preview.bodyCopy, [
      "We noticed it has been a while since your last order.",
      "As a thank-you for shopping with us before, here is 10% off your next purchase.",
      "No pressure. If now is a good time to come back, your offer is ready.",
    ]);
    assert.equal(proposal.preview.ctaText, "Shop with 10% off");
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Winback Copy Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("winback diagnostics distinguish recent orders from missing email", () => {
  const recentOnly = diagnoseWinbackOrderInputs(
    [
      order({
        externalId: "recent-with-email",
        email: "recent@example.com",
        processedAt: "2026-07-01T10:00:00Z",
        totalPrice: "50.00",
      }),
    ],
    now,
  );
  const dormantMissingEmail = diagnoseWinbackOrderInputs(
    [
      order({
        externalId: "dormant-missing-email",
        email: null,
        processedAt: "2026-04-15T10:00:00Z",
        totalPrice: "50.00",
      }),
    ],
    now,
  );

  assert.equal(recentOnly.totalOrdersChecked, 1);
  assert.equal(recentOnly.recentOrderCount, 1);
  assert.equal(recentOnly.ordersInDormantWindow, 0);
  assert.equal(recentOnly.ordersWithUsableEmail, 1);
  assert.equal(dormantMissingEmail.ordersInDormantWindow, 1);
  assert.equal(dormantMissingEmail.ordersInDormantWindowWithUsableEmail, 0);
});

test("winback treats disabled Shopify customer account state as email-reachable", () => {
  const audience = dormantCustomersFromOrders(
    [
      order({
        externalId: "disabled-account-marketable",
        customerExternalId: "gid://shopify/Customer/disabled-account",
        email: "disabled-account@example.com",
        processedAt: "2026-04-15T10:00:00Z",
        totalPrice: "50.00",
        customerState: "disabled",
        buyerAcceptsMarketing: true,
      }),
    ],
    now,
  );

  assert.equal(audience.length, 1);
  assert.equal(
    audience[0].customerExternalId,
    "gid://shopify/Customer/disabled-account",
  );
});

test("winback excludes explicit buyer marketing opt-outs", () => {
  const audience = dormantCustomersFromOrders(
    [
      order({
        externalId: "marketing-opt-out",
        email: "opt-out@example.com",
        processedAt: "2026-04-15T10:00:00Z",
        totalPrice: "50.00",
        buyerAcceptsMarketing: false,
      }),
    ],
    now,
  );

  assert.equal(audience.length, 0);
});

test("winback groups customers by email when customer IDs are incomplete", () => {
  const audience = dormantCustomersFromOrders(
    [
      order({
        externalId: "recent-no-customer-id",
        email: "same-buyer@example.com",
        processedAt: "2026-07-01T10:00:00Z",
        totalPrice: "30.00",
      }),
      order({
        externalId: "dormant-with-customer-id",
        customerExternalId: "gid://shopify/Customer/same-buyer",
        email: "same-buyer@example.com",
        processedAt: "2026-04-15T10:00:00Z",
        totalPrice: "50.00",
      }),
    ],
    now,
  );

  assert.equal(audience.length, 0);
});

test("winback proposal uses shared lifecycle before explicit approval", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for winback persistence tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const merchant = await prisma.merchant.create({
      data: {
        name: `Winback Test Merchant ${suffix}`,
        primaryCurrency: "GBP",
        shops: {
          create: {
            shopDomain: `winback-${suffix}.myshopify.com`,
            rawPayload: { source: "test" },
          },
        },
      },
      include: { shops: true },
    });
    const shop = merchant.shops[0];

    await saveOnboardingHouseRules(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      rules: {
        maxDefaultDiscountPercent: "15",
        maxWinbackDiscountPercent: "10",
        maxCampaignAudienceSize: "20",
        emailCooldownDays: "7",
      },
    });
    await connectKlaviyoPrivateKey(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      privateKey: `pk_test_${suffix}_secret`,
      now,
    });

    for (let index = 0; index < 11; index += 1) {
      await prisma.order.create({
        data: {
          merchantId: merchant.id,
          shopId: shop.id,
          externalId: `order-${suffix}-${index}`,
          customerExternalId: `gid://shopify/Customer/${suffix}-${index}`,
          currency: "GBP",
          totalPrice: "40.00",
          processedAt: new Date("2026-04-15T10:00:00Z"),
          rawPayload: {
            email: `buyer-${index}-${suffix}@example.com`,
            acceptsMarketing: true,
            customer: {
              email: `buyer-${index}-${suffix}@example.com`,
            },
          },
        },
      });
    }

    const action = await createWinbackProposal(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      now,
    });

    const assignments = await prisma.holdoutAssignment.findMany({
      where: { actionId: action.id },
    });
    const executions = await prisma.execution.findMany({
      where: { actionId: action.id },
    });
    const connector = await prisma.connectorAccount.findFirstOrThrow({
      where: {
        merchantId: merchant.id,
        shopId: shop.id,
        connector: "klaviyo",
      },
    });

    assert.equal(action.status, "needs_approval");
    assert.equal(action.title, "Dormant customer winback");
    assert.equal(action.valueType, "estimated_revenue");
    assert.equal(action.valueCurrency, "GBP");
    assert.equal(action.executionMode, "draft_only");
    assert.equal(action.externalSystem, "klaviyo");
    assert.equal(action.approvedAt, null);
    assert.equal(action.verificationClass, "ESTIMATED");
    assert.equal(assignments.length, 11);
    assert.equal(
      assignments.filter((assignment) => assignment.assignmentGroup === "holdout")
        .length,
      2,
    );
    assert.equal(
      assignments.filter((assignment) => assignment.assignmentGroup === "treatment")
        .length,
      9,
    );
    assert.equal(executions.length, 1);
    assert.equal(executions[0].connector, "klaviyo");
    assert.equal(executions[0].dryRun, true);
    assert.equal(executions[0].status, "draft_prepared");
    assert.equal(executions[0].response.dryRun, true);
    assert.equal(executions[0].response.externalDraftId, null);
    assert.equal(connector.authMetadata.secretStorage, "external_secret_required");
    assert.equal(connector.rawPayload.secretStoredInDb, false);

    const approved = await approveWinbackProposal(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      actionId: action.id,
      now,
    });
    const executionsAfterApproval = await prisma.execution.findMany({
      where: { actionId: action.id },
    });
    const approvalEvents = await prisma.actionApprovalEvent.findMany({
      where: { actionId: action.id },
      orderBy: { eventTs: "asc" },
    });
    const ledgers = await prisma.ledgerEvent.findMany({
      where: {
        merchantId: merchant.id,
      },
    });

    assert.equal(approved.status, "approved");
    assert.ok(approved.approvedAt);
    assert.ok(approvalEvents.length >= 2);
    assert.ok(
      approvalEvents.some(
        (event) =>
          event.previousStatus === "needs_approval" &&
          event.newStatus === "approved",
      ),
    );
    assert.ok(
      ledgers.some(
        (event) =>
          event.eventType === "action.approved" &&
          event.payload.actionId === action.id,
      ),
    );
    assert.equal(executionsAfterApproval.length, 1);
    assert.equal(executionsAfterApproval[0].dryRun, true);
    assert.equal(executionsAfterApproval[0].response.dryRun, true);
    assert.equal(executionsAfterApproval[0].response.externalDraftId, null);

    const redrafted = await createWinbackProposal(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      now,
    });

    assert.equal(redrafted.id, action.id);
    assert.equal(redrafted.status, "needs_approval");
    assert.equal(redrafted.approvedAt, null);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Winback Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

function order({
  externalId,
  customerExternalId = null,
  email,
  processedAt,
  totalPrice,
  acceptsMarketing = true,
  products = ["Hero Product"],
  customerState = undefined,
  buyerAcceptsMarketing = acceptsMarketing,
}) {
  return {
    externalId,
    customerExternalId,
    currency: "GBP",
    processedAt: new Date(processedAt),
    totalPrice,
    rawPayload: {
      email,
      buyer_accepts_marketing: buyerAcceptsMarketing,
      acceptsMarketing,
      customer: {
        id: customerExternalId,
        email,
        state: customerState,
      },
    },
    lineItems: products.map((title, index) => ({
      id: `${externalId}-line-${index}`,
      title,
      product: { title },
    })),
  };
}
