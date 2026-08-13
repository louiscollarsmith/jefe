import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPlanEvidenceSnapshot,
  expandBeliefRowsForContext,
  getMerchantContextForQuestion,
} from "../app/lib/merchant-memory/context-retriever.server.js";

const NOW = new Date("2026-08-11T08:30:00.000Z");
const RECOMMENDATION_ID = "33333333-3333-4333-8333-333333333333";
const ACTION_RECOMMENDATION_ID = "44444444-4444-4444-8444-444444444444";
const COUNT_BELIEF_ID = "11111111-1111-4111-8111-111111111111";
const LOW_COVER_BELIEF_ID = "22222222-2222-4222-8222-222222222222";
const FOCUSED_ACTION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REFERENCED_ACTION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_ACTION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

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
    recommendationId: RECOMMENDATION_ID,
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
      id: ACTION_RECOMMENDATION_ID,
      runId: "plan-run-action",
    }),
    actionRow: actionRowFixture({
      proposalSummary: {
        variantCount: 0,
        sourceRecommendation: {
          id: ACTION_RECOMMENDATION_ID,
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
    recommendationId: RECOMMENDATION_ID,
    actionRunId: "run-1",
    message: "What are the two products?",
    logger: silentLogger,
  });

  assert.deepEqual(recommendationIds, [ACTION_RECOMMENDATION_ID]);
  assert.equal(context.recommendationId, ACTION_RECOMMENDATION_ID);
  assert.equal(context.actionRunId, "run-1");
  assert.ok(context.retrieval.warnings.includes("supplied_recommendation_id_ignored_action_source_mismatch"));
});

test("malformed recommendation ids are ignored before Prisma UUID queries", async () => {
  const recommendationIds = [];
  const warnings = [];
  const prisma = createContextPrisma({
    actionRow: null,
    onRecommendationFind: ({ where }) => recommendationIds.push(where.id),
  });

  const context = await getMerchantContextForQuestion(prisma, {
    merchantId: "m1",
    shopId: "s1",
    recommendationId: "recommendation[object Object]",
    actionRunId: null,
    message: "What are the two products?",
    logger: { ...silentLogger, warn: (_message, data) => warnings.push(data) },
  });

  assert.deepEqual(recommendationIds, []);
  assert.equal(context.recommendationId, null);
  assert.ok(context.retrieval.warnings.includes("malformed_recommendation_id_ignored"));
  assert.equal(warnings.length, 1);
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

// --- Tenant scoping -------------------------------------------------------
// Every read in the retriever is scoped to ONE shop. These tests assert the WHERE clause
// itself rather than fixture output, because the failure mode is silent: a dropped filter
// returns MORE rows and a naive filter returns FEWER, and a stub that ignores `where`
// cannot tell either apart from correct behaviour.

test("belief reads are scoped to the shop AND the merchant-wide rows", async () => {
  const wheres = captureWheres(createContextPrisma());

  await getMerchantContextForQuestion(wheres.prisma, {
    merchantId: "m1",
    shopId: "s1",
    recommendationId: RECOMMENDATION_ID,
    message: "which products are low on cover?",
    logger: silentLogger,
  });

  assert.ok(wheres.belief.length > 0, "expected at least one belief read");
  for (const where of wheres.belief) {
    // Shop's own beliefs ∪ merchant-wide (null-shopId) beliefs — never another shop's.
    assert.deepEqual(where.AND, [{ OR: [{ shopId: "s1" }, { shopId: null }] }]);
    // A bare equality here would silently drop every merchant-wide belief.
    assert.equal(where.shopId, undefined);
  }
});

test("not-null models are scoped by plain equality, never a null-inclusive OR", async () => {
  const wheres = captureWheres(createContextPrisma());

  await getMerchantContextForQuestion(wheres.prisma, {
    merchantId: "m1",
    shopId: "s1",
    recommendationId: RECOMMENDATION_ID,
    actionRunId: "run-1",
    message: "what happened?",
    logger: silentLogger,
  });

  // MerchantGoalHorizon / MerchantInsightFinding / MerchantPlanRecommendation /
  // ActionExecution all have NOT NULL shop_id, so a `{ shopId: null }` arm would be dead
  // weight that invites someone to copy the belief filter onto a model that must not have it.
  for (const where of [...wheres.recommendation, ...wheres.action]) {
    assert.equal(where.shopId, "s1");
    assert.equal(where.AND, undefined);
  }
});

test("the shop scope reaches Prisma byte-for-byte, never through free-text redaction", async () => {
  const wheres = captureWheres(createContextPrisma());
  // A REAL-SHAPED shop id. The middle groups are numeric on purpose: the free-text PII
  // redactor's phone-number rule (\+?\d[\d\s().-]{7,}\d) matches `1234-5678` inside a UUID
  // and rewrites it to "[redacted]", which Prisma then rejects as a malformed uuid. Fixture
  // ids like "s1" cannot catch this — they contain no digit run to redact.
  const shopId = "facdb9ef-1234-5678-81f2-f90b543224c2";

  await getMerchantContextForQuestion(wheres.prisma, {
    merchantId: "m1",
    shopId,
    recommendationId: RECOMMENDATION_ID,
    actionRunId: "run-1",
    message: "which products are low on cover?",
    logger: silentLogger,
  });

  assert.ok(wheres.belief.length > 0, "expected at least one belief read");
  for (const where of wheres.belief) {
    assert.deepEqual(where.AND, [{ OR: [{ shopId }, { shopId: null }] }]);
  }
  for (const where of [...wheres.recommendation, ...wheres.action]) {
    assert.equal(where.shopId, shopId);
  }
  const serialized = JSON.stringify([...wheres.belief, ...wheres.recommendation, ...wheres.action]);
  assert.doesNotMatch(serialized, /\[redacted\]/);
});

test("a missing shop scope reads nothing rather than every shop the merchant owns", async () => {
  const wheres = captureWheres(createContextPrisma());
  const warned = [];

  const context = await getMerchantContextForQuestion(wheres.prisma, {
    merchantId: "m1",
    shopId: null,
    recommendationId: RECOMMENDATION_ID,
    actionRunId: "run-1",
    // A message that DOES drive a keyword belief lookup, so an unguarded loader would
    // genuinely issue the query. With a message that matches nothing, this test would pass
    // whether or not the guard exists.
    message: "which products are dead stock?",
    logger: { ...silentLogger, warn: (_message, data) => warned.push(data) },
  });

  // Fail CLOSED: not one scoped row is read. Before this guard, `shopId: undefined` made
  // Prisma drop the filter entirely and answer from every shop under the merchant.
  assert.deepEqual(wheres.belief, []);
  assert.deepEqual(wheres.recommendation, []);
  assert.deepEqual(wheres.action, []);
  assert.deepEqual(context.currentSystemContext.blocks, []);
  assert.equal(context.planEvidenceAtRecommendationTime, null);
  // ...and loudly: an empty answer must not look like a merchant with no data.
  assert.ok(context.retrieval.warnings.includes("missing_shop_scope_context_withheld"));
  assert.equal(warned.length, 1);
  assert.equal(warned[0].merchantId, "m1");
});

test("question context separates focused, referenced, and other relevant actions", async () => {
  const focusedAction = merchantActionFixture({
    id: FOCUSED_ACTION_ID,
    title: "Clear slow stock",
    sourceRecommendationId: RECOMMENDATION_ID,
    currentActionRunId: "run-focus",
    sourceRecommendation: {
      id: RECOMMENDATION_ID,
      title: "Clear slow stock",
      summary: "Markdown slow-moving products.",
      reviewStatus: "proposed",
      workflows: [
        {
          id: "workflow-1",
          status: "active",
          steps: [
            {
              id: "step-1",
              orderIndex: 0,
              title: "Review the markdown preview",
              description: "Check the products and prices.",
              completionCriteria: "Preview is understood.",
              status: "pending",
              mode: "assist",
              capabilityRef: "assist:merchant_checklist",
            },
          ],
        },
      ],
      successSignal: {},
    },
    displaySteps: [{ label: "Review the markdown preview" }],
  });
  const referencedAction = merchantActionFixture({
    id: REFERENCED_ACTION_ID,
    title: "Restock Yuzu Tonic",
    sourceRecommendationId: ACTION_RECOMMENDATION_ID,
    currentActionRunId: "run-reference",
  });
  const otherAction = merchantActionFixture({
    id: OTHER_ACTION_ID,
    title: "Restock Cherry Cola",
    sourceRecommendationId: null,
    currentActionRunId: "run-other",
  });
  const prisma = createContextPrisma({
    actionRow: actionRowFixture({
      runId: "run-focus",
      proposalSummary: {
        variantCount: 0,
        sourceRecommendation: {
          id: RECOMMENDATION_ID,
          runId: "plan-run-1",
          title: "Clear slow stock",
          summary: "Markdown slow-moving products.",
        },
      },
    }),
    merchantActions: [focusedAction, referencedAction, otherAction],
    referencedActionEvents: [
      {
        id: "event-1",
        merchantId: "m1",
        shopId: "s1",
        conversationId: "c1",
        eventType: "action_referenced",
        merchantAction: referencedAction,
        createdAt: NOW,
      },
    ],
  });

  const context = await getMerchantContextForQuestion(prisma, {
    merchantId: "m1",
    shopId: "s1",
    conversationId: "c1",
    focusedActionId: FOCUSED_ACTION_ID,
    message: "Should the restock work change the markdown?",
    logger: silentLogger,
  });

  assert.equal(context.focusedAction.id, FOCUSED_ACTION_ID);
  assert.deepEqual(context.focusedAction.proposedSteps, [
    {
      id: "step-1",
      orderIndex: 0,
      title: "Review the markdown preview",
      description: "Check the products and prices.",
      completionCriteria: "Preview is understood.",
      status: "pending",
      mode: "assist",
      capabilityRef: "assist:merchant_checklist",
    },
  ]);
  assert.equal(
    context.focusedAction.permissions.mayMutateByDefault,
    true,
  );
  assert.deepEqual(
    context.referencedActions.map((action) => action.id),
    [REFERENCED_ACTION_ID],
  );
  assert.equal(
    context.referencedActions[0].permissions.mayMutateByDefault,
    false,
  );
  assert.deepEqual(
    context.otherRelevantActions.map((action) => action.id),
    [OTHER_ACTION_ID],
  );
  assert.equal(
    context.otherRelevantActions[0].permissions.mayMutateByDefault,
    false,
  );
  assert.deepEqual(context.mutationPolicy, {
    defaultMutationTargetActionId: FOCUSED_ACTION_ID,
    referencedActionsReadOnly: true,
    note:
      "Only focusedAction is the default action mutation target. Referenced and other relevant actions are read-only context.",
  });
  assert.equal(context.recommendationId, RECOMMENDATION_ID);
  assert.equal(context.actionRunId, "run-focus");
});

// Wrap a fixture prisma so each model's `where` is recorded, leaving its behaviour intact.
function captureWheres(prisma) {
  const belief = [];
  const recommendation = [];
  const action = [];
  const spy = (list, fn) => async (args) => {
    if (args?.where) list.push(args.where);
    return fn(args);
  };
  return {
    belief,
    recommendation,
    action,
    prisma: {
      ...prisma,
      merchantMemoryBelief: {
        findMany: spy(belief, prisma.merchantMemoryBelief.findMany),
      },
      merchantPlanRecommendation: {
        findFirst: spy(recommendation, prisma.merchantPlanRecommendation.findFirst),
      },
      merchantGoalHorizon: { findMany: spy(recommendation, prisma.merchantGoalHorizon.findMany) },
      merchantInsightFinding: { findMany: spy(recommendation, prisma.merchantInsightFinding.findMany) },
      actionExecution: {
        findFirst: spy(action, prisma.actionExecution.findFirst),
        findMany: spy(action, prisma.actionExecution.findMany),
      },
    },
  };
}

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
  merchantActions = [],
  referencedActionEvents = [],
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
    merchantAction: {
      findFirst: async ({ where }) =>
        merchantActions.find(
          (action) =>
            action.id === where.id &&
            action.merchantId === where.merchantId &&
            action.shopId === where.shopId,
        ) ?? null,
      findMany: async ({ where }) =>
        merchantActions.filter((action) => {
          if (action.merchantId !== where.merchantId || action.shopId !== where.shopId) {
            return false;
          }
          if (where.status?.in) return where.status.in.includes(action.status);
          return true;
        }),
    },
    merchantActionEvent: {
      findMany: async ({ where }) =>
        referencedActionEvents.filter(
          (event) =>
            event.merchantId === where.merchantId &&
            event.shopId === where.shopId &&
            event.conversationId === where.conversationId &&
            event.eventType === where.eventType,
        ),
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
    id: RECOMMENDATION_ID,
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
        id: RECOMMENDATION_ID,
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

function merchantActionFixture(overrides = {}) {
  return {
    id: "ma-1",
    merchantId: "m1",
    shopId: "s1",
    title: "Clear slow stock",
    summary: "Markdown slow-moving products.",
    status: "proposed",
    sourceRecommendationId: RECOMMENDATION_ID,
    currentActionRunId: "run-1",
    progress: { workflow: null },
    outcome: {},
    createdAt: NOW,
    updatedAt: NOW,
    sourceRecommendation: {
      id: RECOMMENDATION_ID,
      title: "Clear slow stock",
      summary: "Markdown slow-moving products.",
      reviewStatus: "proposed",
      workflows: [],
      successSignal: {},
    },
    currentExecution: {
      runId: overrides.currentActionRunId ?? "run-1",
      actionType: "price_markdown",
      actionKind: "dead_stock_clearance",
      status: "proposed",
      resolvedMode: "approve",
      preview: {},
      proposalSummary: {},
    },
    executions: [],
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
