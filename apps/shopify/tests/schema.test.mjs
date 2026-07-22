import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.DATABASE_URL;

test("inserts and reads core tenant, ledger, commerce and action rows", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for schema tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const merchant = await prisma.merchant.create({
      data: {
        name: `Schema Test Merchant ${suffix}`,
        primaryCurrency: "GBP",
        shops: {
          create: {
            shopDomain: `schema-test-${suffix}.myshopify.com`,
            externalShopId: `gid://shopify/Shop/${suffix}`,
            rawPayload: { source: "test" },
          },
        },
      },
      include: { shops: true },
    });

    const shop = merchant.shops[0];
    assert.ok(shop.id);
    assert.equal(shop.merchantId, merchant.id);

    const user = await prisma.merchantUser.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        email: `founder-${suffix}@example.com`,
        name: "Founder",
      },
    });

    const houseRule = await prisma.houseRule.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        title: "Hero product discount cap",
        structuredRules: { maxDiscountBps: 2000 },
        freeTextRules: "Never discount protected hero products beyond 20%.",
        maxDiscountBps: 2000,
        protectedProducts: [{ sku: "HERO-1" }],
        lastEditedByUserId: user.id,
      },
    });

    const goal = await prisma.goal.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        horizon: "THREE_MONTHS",
        description: "Improve verified contribution margin",
        metric: "incremental_margin",
        targetValue: "5000",
      },
    });

    const ledgerEvent = await prisma.ledgerEvent.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        eventType: "house_rules.updated",
        source: "app",
        dedupeKey: `ledger-${suffix}`,
        payload: { houseRuleId: houseRule.id },
        rawPayload: { test: true },
        eventTs: new Date("2026-07-13T07:00:00Z"),
      },
    });

    const product = await prisma.product.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        externalId: `product-${suffix}`,
        title: "Hero Product",
        rawPayload: { source: "test" },
        variants: {
          create: {
            merchantId: merchant.id,
            shopId: shop.id,
            externalId: `variant-${suffix}`,
            sku: "HERO-1",
            title: "Default",
            price: "49.00",
            rawPayload: { source: "test" },
          },
        },
      },
      include: { variants: true },
    });

    const variant = product.variants[0];

    await prisma.inventoryLevel.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        variantId: variant.id,
        inventoryItemExternalId: `inventory-${suffix}`,
        locationExternalId: `location-${suffix}`,
        available: 20,
        rawPayload: { source: "test" },
      },
    });

    await prisma.cogsInput.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        productId: product.id,
        variantId: variant.id,
        sku: "HERO-1",
        costAmount: "12.50",
        source: "merchant_import",
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      },
    });

    const order = await prisma.order.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        externalId: `order-${suffix}`,
        orderName: "#1001",
        totalPrice: "49.00",
        processedAt: new Date("2026-07-01T10:00:00Z"),
        lineItems: {
          create: {
            merchantId: merchant.id,
            shopId: shop.id,
            productId: product.id,
            variantId: variant.id,
            externalId: `line-item-${suffix}`,
            sku: "HERO-1",
            title: "Hero Product",
            quantity: 1,
            unitPrice: "49.00",
            totalPrice: "49.00",
          },
        },
      },
      include: { lineItems: true },
    });

    await prisma.refund.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        orderId: order.id,
        externalId: `refund-${suffix}`,
        amount: "5.00",
        reason: "test_refund",
      },
    });

    const brief = await prisma.dailyBrief.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        briefDate: new Date("2026-07-13T00:00:00Z"),
        verdict: { summary: "Margin opportunity found" },
        evidence: [{ ledgerEventId: ledgerEvent.id }],
        idempotencyKey: `brief-${suffix}`,
      },
    });

    const action = await prisma.action.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        dailyBriefId: brief.id,
        actionType: "klaviyo_winback",
        title: "Dormant customer winback",
        summary: "Prepare a measured winback campaign.",
        expectedValue: { lowMargin: 100, highMargin: 220, currency: "GBP" },
        valueCurrency: "GBP",
        valueType: "verified_margin",
        confidence: "0.7000",
        riskLevel: "medium",
        approvalRequired: true,
        evidence: [{ ledgerEventId: ledgerEvent.id }],
        rulesConsulted: [{ houseRuleId: houseRule.id }],
        ruleConstraintsApplied: [{ maxDiscountBps: 2000 }],
        capsApplied: [{ maxDiscountBps: 2000 }],
        provenanceReferences: [{ ledgerEventId: ledgerEvent.id }],
        preview: { campaignName: "Dormant customer winback" },
        verificationClass: "VERIFIED",
        executionMode: "dry_run",
        externalSystem: "klaviyo",
        idempotencyKey: `action-${suffix}`,
      },
    });

    const approvalEvent = await prisma.actionApprovalEvent.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        actionId: action.id,
        previousStatus: "needs_approval",
        newStatus: "approved",
        actor: "schema-test",
        actorType: "system",
        reason: "schema coverage",
        requestSnapshot: { source: "schema.test" },
      },
    });

    const execution = await prisma.execution.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        actionId: action.id,
        status: "dry_run",
        connector: "klaviyo",
        idempotencyKey: `execution-${suffix}`,
        dryRun: true,
        request: { previewOnly: true },
      },
    });

    await prisma.feedback.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        actionId: action.id,
        dailyBriefId: brief.id,
        merchantUserId: user.id,
        feedbackType: "text",
        sentiment: "positive",
        rawText: "This recommendation makes sense.",
      },
    });

    await prisma.provenanceLink.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        entityType: "action",
        entityId: action.id,
        sourceEventId: ledgerEvent.id,
        metadata: { reason: "action evidence" },
      },
    });

    await prisma.holdoutAssignment.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        actionId: action.id,
        variantId: variant.id,
        subjectType: "customer",
        subjectExternalId: `customer-${suffix}`,
        assignmentGroup: "holdout",
        dedupeKey: `holdout-${suffix}`,
      },
    });

    await prisma.attributionResult.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        actionId: action.id,
        verificationClass: "VERIFIED",
        method: "holdout",
        windowStart: new Date("2026-07-01T00:00:00Z"),
        windowEnd: new Date("2026-07-08T00:00:00Z"),
        incrementalRevenue: "120.00",
        incrementalMargin: "60.00",
        result: { confidence: "measured" },
      },
    });

    await prisma.connectorAccount.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        connector: "shopify",
        accountExternalId: shop.shopDomain,
        scopes: [],
        readTokenRef: "secret-manager://dev/shopify/read",
        authMetadata: { tokenStorage: "reference_only" },
      },
    });

    await prisma.merchantKlaviyoCredential.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        provider: "klaviyo",
        encryptedPrivateKey: "v1:test",
        keyPrefix: "pk_test",
        lastFour: "1234",
        scopesJson: ["profiles:write"],
        connectionStatus: "active",
      },
    });

    await prisma.externalActionArtifact.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        actionId: action.id,
        provider: "klaviyo",
        artifactType: "klaviyo_campaign",
        externalId: `campaign-${suffix}`,
        externalName: "Dormant customer winback",
        externalStatus: "draft_created",
        payloadSnapshotJson: { sendEnabled: false },
      },
    });

    await prisma.costMetering.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        usageDate: new Date("2026-07-13T00:00:00Z"),
        provider: "openai",
        service: "responses",
        operation: "classification",
        quantity: "1",
        unit: "request",
        costAmount: "0.000100",
        currency: "GBP",
      },
    });

    const memoryDocument = await prisma.merchantMemoryDocument.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        title: "Merchant Memory",
        status: "active",
        metadata: { source: "schema.test" },
      },
    });

    const memoryVersion = await prisma.merchantMemoryVersion.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        documentId: memoryDocument.id,
        versionNumber: 1,
        status: "draft",
        generatedBy: "system",
        generationReason: "schema_coverage",
        documentJson: {
          business_summary: "Schema test merchant sells one hero product.",
        },
        sourceSnapshot: { ledgerEventIds: [ledgerEvent.id] },
        summary: "Initial memory draft",
      },
    });

    const memoryEvidence = await prisma.merchantMemoryEvidenceItem.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        evidenceType: "deterministic_feature",
        factKey: "product.hero_revenue",
        summary: "Hero Product sold in the test period.",
        valueJson: { sku: "HERO-1", units: 1 },
        sourceSystem: "shopify",
        sourceTable: "order_line_items",
        sourceRecordId: order.lineItems[0].id,
        ledgerEventId: ledgerEvent.id,
        computedAt: new Date("2026-07-13T07:05:00Z"),
      },
    });

    const memoryClaim = await prisma.merchantMemoryClaim.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        versionId: memoryVersion.id,
        sectionKey: "products",
        claimType: "observed_fact",
        status: "observed_fact",
        confidence: "0.9000",
        statement: "Hero Product is represented in Shopify order data.",
        normalizedValue: { sku: "HERO-1" },
        evidenceSummary: [{ evidenceItemId: memoryEvidence.id }],
      },
    });

    await prisma.merchantMemoryClaimEvidence.create({
      data: {
        claimId: memoryClaim.id,
        evidenceItemId: memoryEvidence.id,
        ledgerEventId: ledgerEvent.id,
        relationship: "supports",
      },
    });

    await prisma.merchantMemoryCorrection.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        versionId: memoryVersion.id,
        claimId: memoryClaim.id,
        merchantUserId: user.id,
        correctionType: "confirmation",
        originalText: memoryClaim.statement,
        correctedText: memoryClaim.statement,
      },
    });

    await prisma.merchantMemoryOpenQuestion.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        versionId: memoryVersion.id,
        sectionKey: "commercial_model",
        question: "Which products should be treated as protected hero products?",
        reason: "Needed before recommendations can propose discounts.",
        priority: 10,
      },
    });

    await prisma.merchantMemoryDocument.update({
      where: { id: memoryDocument.id },
      data: {
        currentVersionNumber: 1,
        currentVersionId: memoryVersion.id,
      },
    });

    const readBack = await prisma.merchant.findUniqueOrThrow({
      where: { id: merchant.id },
      include: {
        shops: true,
        houseRules: true,
        goals: true,
        ledgerEvents: true,
        products: { include: { variants: true } },
        orders: { include: { lineItems: true, refunds: true } },
        actions: {
          include: {
            approvalEvents: true,
            executions: true,
            attributionResults: true,
          },
        },
        connectorAccounts: true,
        klaviyoCredentials: true,
        externalArtifacts: true,
        costMetering: true,
        memoryDocuments: true,
        memoryVersions: {
          include: {
            claims: {
              include: {
                evidenceLinks: true,
                corrections: true,
              },
            },
            openQuestions: true,
          },
        },
        memoryEvidenceItems: true,
      },
    });

    assert.equal(readBack.shops.length, 1);
    assert.equal(readBack.houseRules[0].maxDiscountBps, 2000);
    assert.equal(readBack.goals[0].horizon, "THREE_MONTHS");
    assert.equal(readBack.ledgerEvents[0].dedupeKey, `ledger-${suffix}`);
    assert.equal(
      readBack.ledgerEvents[0].eventTs.toISOString(),
      "2026-07-13T07:00:00.000Z",
    );
    assert.equal(readBack.products[0].variants[0].sku, "HERO-1");
    assert.equal(readBack.orders[0].lineItems[0].quantity, 1);
    assert.equal(readBack.actions[0].verificationClass, "VERIFIED");
    assert.equal(readBack.actions[0].title, "Dormant customer winback");
    assert.equal(readBack.actions[0].valueType, "verified_margin");
    assert.equal(
      readBack.actions[0].approvalEvents[0].id,
      approvalEvent.id,
    );
    assert.equal(readBack.actions[0].executions[0].id, execution.id);
    assert.equal(
      readBack.actions[0].attributionResults[0].verificationClass,
      "VERIFIED",
    );
    assert.equal(
      readBack.connectorAccounts[0].readTokenRef,
      "secret-manager://dev/shopify/read",
    );
    assert.equal(readBack.klaviyoCredentials[0].connectionStatus, "active");
    assert.equal(readBack.externalArtifacts[0].externalStatus, "draft_created");
    assert.equal(readBack.costMetering[0].operation, "classification");
    assert.equal(readBack.memoryDocuments[0].currentVersionNumber, 1);
    assert.equal(readBack.memoryVersions[0].claims[0].status, "observed_fact");
    assert.equal(
      readBack.memoryVersions[0].claims[0].evidenceLinks[0].relationship,
      "supports",
    );
    assert.equal(
      readBack.memoryVersions[0].claims[0].corrections[0].correctionType,
      "confirmation",
    );
    assert.equal(
      readBack.memoryVersions[0].openQuestions[0].sectionKey,
      "commercial_model",
    );
    assert.equal(
      readBack.memoryEvidenceItems[0].ledgerEventId,
      ledgerEvent.id,
    );
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: { startsWith: "Schema Test Merchant" } },
    });
    await prisma.$disconnect();
  }
});
