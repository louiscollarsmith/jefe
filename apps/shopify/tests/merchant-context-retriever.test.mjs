import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPlanEvidenceSnapshot,
  expandBeliefRowsForContext,
  getMerchantContextForQuestion,
} from "../app/lib/merchant-memory/context-retriever.server.js";

const NOW = new Date("2026-08-11T08:30:00.000Z");
const COUNT_BELIEF_ID = "11111111-1111-4111-8111-111111111111";
const LOW_COVER_BELIEF_ID = "22222222-2222-4222-8222-222222222222";

test("belief expansion carries stockout counts to the structured low-cover list", () => {
  const count = beliefFixture({
    id: COUNT_BELIEF_ID,
    key: "inventory.at_risk_stockout_count.trailing_30d",
    value: { count: 2 },
  });
  const lowCover = lowCoverBeliefFixture();

  const expanded = expandBeliefRowsForContext({
    allBeliefs: [count, lowCover],
    seedBeliefs: [count],
    max: 10,
  });

  assert.deepEqual(expanded.map((belief) => belief.key), [
    "inventory.at_risk_stockout_count.trailing_30d",
    "inventory.low_cover_products.trailing_30d",
  ]);
});

test("plan evidence snapshots persist low-cover product rows, not just the count", async () => {
  const writes = [];
  const prisma = createContextPrisma({ snapshotWrites: writes });
  const snapshot = await buildPlanEvidenceSnapshot(prisma, {
    merchantId: "m1",
    shopId: "s1",
    recommendation: recommendationFixture(),
    sourceSnapshotHash: "plan-hash-1",
    snapshotSource: "plan_generation",
  });
  const serialized = JSON.stringify(snapshot.blocksJson);

  assert.equal(writes.length, 1);
  assert.match(serialized, /inventory\.low_cover_products\.trailing_30d/);
  assert.match(serialized, /Yuzu Tonic/);
  assert.match(serialized, /Cherry Cola/);
  assert.match(serialized, /daysOfCover/);
  assert.doesNotMatch(serialized, /owner@example\.com/);
  assert.doesNotMatch(serialized, /rawPayload/);
  assert.equal(snapshot.limitsJson.snapshotSource, "plan_generation");
});

test("plan evidence snapshots persist scoped commerce calculation blocks", async () => {
  const prisma = createContextPrisma();
  const snapshot = await buildPlanEvidenceSnapshot(prisma, {
    merchantId: "m1",
    shopId: "s1",
    recommendation: recommendationFixture(),
    sourceSnapshotHash: "plan-hash-1",
    snapshotSource: "plan_generation",
  });
  const commerceMetric = snapshot.blocksJson.find((block) => block.kind === "commerce_metric");

  assert.ok(commerceMetric);
  assert.equal(commerceMetric.source, "commerce_calculations");
  assert.equal(commerceMetric.data.measure, "revenue");
  assert.equal(commerceMetric.data.kind, "impact_estimate");
  assert.equal(commerceMetric.data.totals.atRiskRevenue, 180);
  assert.equal(commerceMetric.data.source, "plan_generation");
});

test("plan evidence snapshots are immutable once created", async () => {
  const writes = [];
  const storedSnapshot = {
    id: "snapshot-existing",
    snapshotVersion: "plan_evidence_snapshot_v1",
    sourceSnapshotHash: "original-hash",
    blocksJson: [{ kind: "recommendation", id: "original", source: "plan_recommendation", data: {} }],
    limitsJson: { snapshotSource: "plan_generation" },
    createdAt: NOW,
  };
  const prisma = createContextPrisma({ storedSnapshot, snapshotWrites: writes });

  const snapshot = await buildPlanEvidenceSnapshot(prisma, {
    merchantId: "m1",
    shopId: "s1",
    recommendation: recommendationFixture({ whyNow: "New text that must not overwrite the snapshot." }),
    sourceSnapshotHash: "new-hash",
    snapshotSource: "plan_generation",
  });

  assert.equal(snapshot.id, "snapshot-existing");
  assert.equal(snapshot.sourceSnapshotHash, "original-hash");
  assert.deepEqual(snapshot.blocksJson, storedSnapshot.blocksJson);
  assert.equal(writes.length, 0);
});

test("question context includes recommendation-time evidence and current system context", async () => {
  const snapshot = {
    id: "snapshot-1",
    snapshotVersion: "plan_evidence_snapshot_v1",
    sourceSnapshotHash: "plan-hash-1",
    blocksJson: [
      {
        kind: "structured_evidence",
        id: "structured:snapshot-low-cover",
        source: "merchant_memory",
        data: {
          key: "inventory.low_cover_products.trailing_30d",
          items: [{ title: "Yuzu Tonic", available: 6, dailyVelocity: 1, daysOfCover: 6 }],
        },
      },
    ],
    limitsJson: { snapshotSource: "plan_generation" },
    createdAt: NOW,
  };
  const prisma = createContextPrisma({ storedSnapshot: snapshot });

  const context = await getMerchantContextForQuestion(prisma, {
    merchantId: "m1",
    shopId: "s1",
    recommendationId: "rec-1",
    actionRunId: "run-1",
    message: "What are the two products?",
    logger: silentLogger,
  });
  const current = JSON.stringify(context.currentSystemContext.blocks);

  assert.equal(context.planEvidenceAtRecommendationTime.snapshotId, "snapshot-1");
  assert.match(JSON.stringify(context.planEvidenceAtRecommendationTime.blocks), /Yuzu Tonic/);
  assert.match(current, /Yuzu Tonic/);
  assert.match(current, /Cherry Cola/);
  assert.deepEqual(context.retrieval.expansionKeys, [
    "inventory.low_cover_products.trailing_30d",
  ]);
});

test("question context canonicalizes mismatched recommendation ids through the action source", async () => {
  const recommendationIds = [];
  const prisma = createContextPrisma({
    recommendation: recommendationFixture({
      id: "rec-action",
      runId: "plan-run-action",
    }),
    actionRow: actionRowFixture({
      proposalSummary: {
        variantCount: 0,
        sourceRecommendation: {
          id: "rec-action",
          runId: "plan-run-action",
          title: "Secure Stock on Fast-Selling Drinks",
          summary: "Review products currently facing low stock cover.",
        },
      },
    }),
    onRecommendationFind: ({ where }) => recommendationIds.push(where.id),
  });

  const context = await getMerchantContextForQuestion(prisma, {
    merchantId: "m1",
    shopId: "s1",
    recommendationId: "rec-hidden-other",
    actionRunId: "run-1",
    message: "What are the two products?",
    logger: silentLogger,
  });

  assert.deepEqual(recommendationIds, ["rec-action"]);
  assert.equal(context.recommendationId, "rec-action");
  assert.equal(context.actionRunId, "run-1");
  assert.ok(context.retrieval.warnings.includes("supplied_recommendation_id_ignored_action_source_mismatch"));
});

test("retrieved context redacts customer PII and excludes raw payload fields", async () => {
  const prisma = createContextPrisma({
    beliefs: [
      beliefFixture({
        id: COUNT_BELIEF_ID,
        key: "inventory.at_risk_stockout_count.trailing_30d",
        value: {
          count: 2,
          customerEmail: "owner@example.com",
          rawPayload: { secret: "should-not-pass" },
        },
      }),
      lowCoverBeliefFixture({
        value: {
          items: [
            {
              productId: "p1",
              title: "Yuzu Tonic owner@example.com",
              available: 6,
              unitsSold: 30,
              dailyVelocity: 1,
              daysOfCover: 6,
            },
          ],
          atRiskProductCount: 1,
          thresholdDays: 21,
          window: "trailing_30d",
        },
      }),
    ],
  });

  const snapshot = await buildPlanEvidenceSnapshot(prisma, {
    merchantId: "m1",
    shopId: "s1",
    recommendation: recommendationFixture(),
    sourceSnapshotHash: "plan-hash-1",
  });
  const serialized = JSON.stringify(snapshot.blocksJson);

  assert.doesNotMatch(serialized, /owner@example\.com/);
  assert.doesNotMatch(serialized, /rawPayload/);
  assert.doesNotMatch(serialized, /should-not-pass/);
  assert.match(serialized, /Yuzu Tonic \[redacted\]/);
});

function createContextPrisma({
  beliefs = [
    beliefFixture({
      id: COUNT_BELIEF_ID,
      key: "inventory.at_risk_stockout_count.trailing_30d",
      value: { count: 2 },
    }),
    lowCoverBeliefFixture(),
  ],
  storedSnapshot = null,
  snapshotWrites = [],
  recommendation = recommendationFixture(),
  actionRow = actionRowFixture(),
  onRecommendationFind = () => {},
} = {}) {
  return {
    merchantPlanRecommendation: {
      findFirst: async (args) => {
        onRecommendationFind(args);
        return {
          ...recommendation,
          run: { snapshotHash: "plan-hash-1" },
          evidenceSnapshot: storedSnapshot,
        };
      },
    },
    merchantPlanEvidenceSnapshot: {
      findUnique: async () => storedSnapshot,
      create: async ({ data }) => {
        const row = {
          id: "snapshot-created",
          createdAt: NOW,
          updatedAt: NOW,
          ...data,
        };
        snapshotWrites.push(row);
        return row;
      },
    },
    actionExecution: {
      findFirst: async () => actionRow,
      findMany: async () => [],
    },
    merchantMemoryBelief: {
      findMany: async ({ where }) => {
        const ids = new Set(
          (where.OR ?? [])
            .flatMap((item) => item?.id?.in ?? [])
            .filter(Boolean),
        );
        const keys = new Set([
          ...(where.key?.in ?? []),
          ...(where.OR ?? [])
            .flatMap((item) => item?.key?.in ?? [])
            .filter(Boolean),
        ]);
        return beliefs.filter(
          (belief) =>
            (ids.size === 0 && keys.size === 0) ||
            ids.has(belief.id) ||
            keys.has(belief.key),
        );
      },
    },
    merchantGoalHorizon: { findMany: async () => [] },
    merchantInsightFinding: { findMany: async () => [] },
    product: {
      findMany: async () => [
        { id: "p1", merchantId: "m1", shopId: "s1", title: "Yuzu Tonic", vendor: "Yuzu", productType: "Drink", status: "ACTIVE" },
        { id: "p2", merchantId: "m1", shopId: "s1", title: "Cherry Cola", vendor: "Cherry", productType: "Drink", status: "ACTIVE" },
      ],
    },
    variant: {
      findMany: async () => [
        { id: "v1", merchantId: "m1", shopId: "s1", productId: "p1", title: "Default", sku: "YUZU", price: 60, currency: "GBP", unitCost: 20 },
        { id: "v2", merchantId: "m1", shopId: "s1", productId: "p2", title: "Default", sku: "COLA", price: 50, currency: "GBP", unitCost: 20 },
      ],
    },
    order: {
      findMany: async () => [
        { id: "o1", merchantId: "m1", shopId: "s1", currency: "GBP", totalPrice: 180, totalDiscount: 0, processedAt: NOW, financialStatus: "paid", sourceName: "web", shippingCountry: "GB" },
      ],
    },
    orderLineItem: {
      findMany: async () => [
        {
          merchantId: "m1",
          shopId: "s1",
          orderId: "o1",
          productId: "p1",
          variantId: "v1",
          sku: "YUZU",
          title: "Yuzu Tonic",
          quantity: 3,
          unitPrice: 60,
          totalPrice: 180,
          discount: 0,
          order: { id: "o1", currency: "GBP", processedAt: NOW, financialStatus: "paid", sourceName: "web", shippingCountry: "GB" },
        },
      ],
    },
    inventoryLevel: {
      findMany: async () => [
        { merchantId: "m1", shopId: "s1", variantId: "v1", available: 0 },
        { merchantId: "m1", shopId: "s1", variantId: "v2", available: 12 },
      ],
    },
    refund: { findMany: async () => [] },
  };
}

function recommendationFixture(overrides = {}) {
  return {
    id: "rec-1",
    runId: "plan-run-1",
    merchantId: "m1",
    shopId: "s1",
    title: "Secure Stock on Fast-Selling Drinks",
    summary:
      "Review products currently facing low stock cover and initiate replenishment orders.",
    primaryGoalId: "goal-3",
    supportingGoalIds: [],
    whyThisAction:
      "Two selling products hold fewer than 21 days of stock cover based on trailing sell rates.",
    whyNow: "Acting now prevents potential stockouts within the next three weeks.",
    startToday: "Check the products with lowest stock cover.",
    successSignal: { description: "Low-cover products are reordered.", timeframe: "one week" },
    expectedBenefit: "Protect sales momentum.",
    supportingBeliefIds: [COUNT_BELIEF_ID],
    supportingInsightIds: [],
    confidence: "reasonable",
    ...overrides,
  };
}

function actionRowFixture(overrides = {}) {
  return {
    runId: "run-1",
    merchantId: "m1",
    shopId: "s1",
    actionType: "price_markdown",
    actionKind: "dead_stock_clearance",
    status: "proposed",
    resolvedMode: "approve",
    proposalSummary: {
      variantCount: 0,
      sourceRecommendation: {
        id: "rec-1",
        runId: "plan-run-1",
        title: "Secure Stock on Fast-Selling Drinks",
        summary: "Review products currently facing low stock cover.",
      },
    },
    preview: { variantCount: 0 },
    outcomeStatus: "pending",
    outcome: null,
    ...overrides,
  };
}

function lowCoverBeliefFixture(overrides = {}) {
  return beliefFixture({
    id: LOW_COVER_BELIEF_ID,
    key: "inventory.low_cover_products.trailing_30d",
    category: "inventory",
    value: {
      items: [
        {
          productId: "p1",
          title: "Yuzu Tonic",
          available: 6,
          unitsSold: 30,
          dailyVelocity: 1,
          daysOfCover: 6,
        },
        {
          productId: "p2",
          title: "Cherry Cola",
          available: 12,
          unitsSold: 30,
          dailyVelocity: 1,
          daysOfCover: 12,
        },
      ],
      topAtRiskProduct: {
        productId: "p1",
        title: "Yuzu Tonic",
        available: 6,
        unitsSold: 30,
        dailyVelocity: 1,
        daysOfCover: 6,
      },
      atRiskProductCount: 2,
      thresholdDays: 21,
      window: "trailing_30d",
    },
    ...overrides,
  });
}

function beliefFixture({
  id,
  key,
  category = "inventory",
  value,
  valueType = "structured",
}) {
  return {
    id,
    merchantId: "m1",
    shopId: "s1",
    category,
    key,
    value,
    valueType,
    status: "inferred",
    confidence: "0.8500",
    confidenceReason: "Direct deterministic observation.",
    supersededAt: null,
    evidence: [
      {
        sourceType: "system_derivation",
        evidenceType: "deterministic_calculation",
        summary: "Calculated from Shopify orders and inventory records.",
        observedAt: NOW,
      },
    ],
  };
}

const silentLogger = {
  info() {},
  warn() {},
  error() {},
};
