import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";

import {
  approveWinbackProposal,
  buildWinbackProposal,
  cancelWinbackProposal,
  connectKlaviyoPrivateKey,
  createWinbackProposal,
  diagnoseWinbackOrderInputs,
  dormantCustomersFromOrders,
  estimateWinbackValue,
  executeApprovedWinbackDraft,
  rejectWinbackProposal,
  WINBACK_DORMANT_MAX_DAYS,
  WINBACK_DORMANT_MIN_DAYS,
} from "../app/services/klaviyo-winback.server.js";
import {
  decryptKlaviyoPrivateKey,
  saveKlaviyoPrivateKey,
} from "../app/services/klaviyo-credentials.server.js";
import { saveOnboardingHouseRules } from "../app/services/onboarding.server.js";

const now = new Date("2026-07-15T09:00:00Z");
const databaseUrl = process.env.DATABASE_URL;

test("Klaviyo key storage falls back to existing app secrets", async () => {
  const prisma = {
    merchantKlaviyoCredential: {
      upsert: async ({ create }) => ({
        id: "credential_test",
        ...create,
      }),
    },
  };
  const privateKey = "pk_test_private_key_secret";
  const credential = await saveKlaviyoPrivateKey(prisma, {
    merchantId: "merchant_test",
    shopId: "shop_test",
    privateKey,
    now,
    env: {
      SESSION_SECRET: "existing-session-secret-for-tests",
    },
  });

  assert.equal(credential.connectionStatus, "active");
  assert.notEqual(credential.encryptedPrivateKey, privateKey);
  assert.equal(
    decryptKlaviyoPrivateKey(credential, {
      SESSION_SECRET: "existing-session-secret-for-tests",
    }),
    privateKey,
  );
});

test("winback queue actions support legacy Klaviyo action rows", async (t) => {
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
        name: `Legacy Winback Queue Merchant ${suffix}`,
        primaryCurrency: "GBP",
        shops: {
          create: {
            shopDomain: `legacy-winback-${suffix}.myshopify.com`,
            rawPayload: { source: "test" },
          },
        },
      },
      include: { shops: true },
    });
    const shop = merchant.shops[0];
    const approveAction = await createLegacyWinbackAction(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      suffix: `approve-${suffix}`,
      status: "needs_approval",
    });
    const rejectAction = await createLegacyWinbackAction(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      suffix: `reject-${suffix}`,
      status: "needs_approval",
    });
    const cancelAction = await createLegacyWinbackAction(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      suffix: `cancel-${suffix}`,
      status: "needs_approval",
    });

    const approved = await approveWinbackProposal(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      actionId: approveAction.id,
      now,
    });
    const rejected = await rejectWinbackProposal(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      actionId: rejectAction.id,
      reason: "Rejected from test.",
      now,
    });
    const cancelled = await cancelWinbackProposal(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      actionId: cancelAction.id,
      now,
    });

    assert.equal(approved.status, "approved");
    assert.equal(rejected.status, "rejected");
    assert.equal(cancelled.status, "cancelled");
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Legacy Winback Queue Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

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
  process.env.KLAVIYO_KEY_ENCRYPTION_SECRET =
    process.env.KLAVIYO_KEY_ENCRYPTION_SECRET ??
      "test-klaviyo-key-encryption-secret";
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const klaviyoCalls = [];
  const fetchFn = async (url, init = {}) => {
    klaviyoCalls.push({ url: String(url), method: init.method });
    const path = new URL(String(url)).pathname;

    assert.doesNotMatch(path, /send|schedule/i);

    if (path === "/api/profile-import") {
      return jsonResponse(201, {
        data: {
          type: "profile",
          id: `profile_${klaviyoCalls.length}`,
        },
      });
    }
    if (path === "/api/lists") {
      return jsonResponse(201, {
        data: {
          type: "list",
          id: "list_123",
          attributes: { name: "Jefe Winback Treatment" },
        },
      });
    }
    if (path === "/api/lists/list_123/relationships/profiles") {
      return new Response(null, { status: 204 });
    }
    if (path === "/api/campaigns") {
      return jsonResponse(201, {
        data: {
          type: "campaign",
          id: "campaign_123",
          attributes: { name: "Jefe Dormant Customer Winback" },
          relationships: {
            "campaign-messages": {
              data: [{ type: "campaign-message", id: "message_123" }],
            },
          },
        },
      });
    }
    if (path === "/api/templates") {
      return jsonResponse(201, {
        data: {
          type: "template",
          id: "template_123",
          attributes: { name: "Jefe Winback Draft" },
        },
      });
    }
    if (path === "/api/campaign-message-assign-template") {
      return jsonResponse(200, {
        data: {
          type: "campaign-message",
          id: "message_123",
        },
      });
    }

    return jsonResponse(404, {
      errors: [{ detail: `Unexpected test endpoint ${path}` }],
    });
  };

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
    const credential = await prisma.merchantKlaviyoCredential.findFirstOrThrow({
      where: {
        merchantId: merchant.id,
        shopId: shop.id,
        provider: "klaviyo",
      },
    });

    assert.equal(action.status, "needs_approval");
    assert.equal(action.actionType, "klaviyo_winback_draft");
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
    assert.equal(executions.length, 0);
    assert.equal(connector.authMetadata.secretStorage, "encrypted_db");
    assert.equal(connector.rawPayload.secretStoredInDb, true);
    assert.equal(credential.connectionStatus, "active");
    assert.notEqual(credential.encryptedPrivateKey, `pk_test_${suffix}_secret`);

    const approved = await approveWinbackProposal(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      actionId: action.id,
      now,
    });
    const executedDraft = await executeApprovedWinbackDraft(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      actionId: action.id,
      now,
      fetchFn,
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
    const executionsAfterApproval = await prisma.execution.findMany({
      where: { actionId: action.id },
    });
    const artifacts = await prisma.externalActionArtifact.findMany({
      where: { actionId: action.id },
    });

    assert.equal(approved.status, "approved");
    assert.ok(approved.approvedAt);
    assert.equal(executedDraft.ok, true);
    assert.equal(executedDraft.action.status, "executed");
    assert.equal(executedDraft.response.sendEnabled, false);
    assert.equal(executedDraft.response.executionMode, "draft_only");
    assert.equal(executedDraft.response.klaviyoListId, "list_123");
    assert.equal(executedDraft.response.klaviyoCampaignId, "campaign_123");
    assert.equal(executedDraft.response.klaviyoTemplateId, "template_123");
    assert.equal(executedDraft.response.audience.treatmentCount, 9);
    assert.equal(executedDraft.response.audience.holdoutCount, 2);
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
    assert.equal(executionsAfterApproval[0].dryRun, false);
    assert.equal(executionsAfterApproval[0].status, "draft_created");
    assert.equal(executionsAfterApproval[0].response.sendEnabled, false);
    assert.ok(
      artifacts.some((artifact) => artifact.artifactType === "klaviyo_list"),
    );
    assert.ok(
      artifacts.some((artifact) => artifact.artifactType === "klaviyo_campaign"),
    );
    assert.ok(
      artifacts.some((artifact) => artifact.artifactType === "klaviyo_template"),
    );
    assert.ok(
      artifacts.some(
        (artifact) => artifact.artifactType === "klaviyo_campaign_message",
      ),
    );
    assert.equal(
      artifacts.filter((artifact) => artifact.artifactType === "klaviyo_profile")
        .length,
      9,
    );

    const callCountAfterFirstExecution = klaviyoCalls.length;
    const duplicateClick = await executeApprovedWinbackDraft(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      actionId: action.id,
      now,
      fetchFn,
    });

    assert.equal(duplicateClick.ok, true);
    assert.equal(klaviyoCalls.length, callCountAfterFirstExecution);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Winback Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/vnd.api+json" },
  });
}

async function createLegacyWinbackAction(
  prisma,
  { merchantId, shopId, suffix, status },
) {
  return prisma.action.create({
    data: {
      merchantId,
      shopId,
      actionType: "klaviyo_winback",
      status,
      title: "Dormant customer winback",
      summary: "Legacy Klaviyo winback draft queued before draft creation.",
      expectedValue: { base: 34.72, currency: "GBP" },
      valueCurrency: "GBP",
      valueType: "estimated_revenue",
      confidence: "0.5500",
      riskLevel: "low",
      approvalRequired: true,
      evidence: [],
      rulesConsulted: [],
      ruleConstraintsApplied: [],
      capsApplied: [],
      provenanceReferences: [],
      preview: {},
      verificationClass: "ESTIMATED",
      executionMode: "draft_only",
      externalSystem: "klaviyo",
      idempotencyKey: `legacy-winback-${suffix}`,
      proposedAt: now,
    },
  });
}

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
