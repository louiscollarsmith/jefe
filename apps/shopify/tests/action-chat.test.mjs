import assert from "node:assert/strict";
import test from "node:test";
import {
  actionConversationTopic,
  addActionChatNote,
  getActionChatThread,
  sendActionChatMessage,
} from "../app/lib/merchant-memory/conversation.server.js";

const COUNT_BELIEF_ID = "11111111-1111-4111-8111-111111111111";
const LOW_COVER_BELIEF_ID = "22222222-2222-4222-8222-222222222222";
const ACTION_RECOMMENDATION_ID = "33333333-3333-4333-8333-333333333333";
const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

test("actionConversationTopic is stable per recommendation, falling back to action run", () => {
  assert.equal(
    actionConversationTopic({ recommendationId: "rec-1", actionRunId: "run-1" }),
    "action:rec-1",
  );
  assert.equal(actionConversationTopic({ actionRunId: "run-1" }), "action:run-1");
});

test("getActionChatThread reads only the action-scoped topic", async () => {
  const calls = [];
  const prisma = {
    merchantMemoryConversation: {
      findFirst: async (args) => {
        calls.push(args);
        return { id: "conv-action", merchantId: "m1", shopId: "s1", topic: "action:rec-1" };
      },
    },
    merchantMemoryConversationMessage: {
      findMany: async ({ where }) =>
        where.conversationId === "conv-action"
          ? [
              {
                id: "msg-1",
                role: "assistant",
                content: "Scoped reply",
                structuredOperation: null,
                operationStatus: null,
                relatedBeliefIds: [],
                relatedOpenQuestionId: null,
                createdAt: new Date("2026-08-10T12:00:00.000Z"),
              },
            ]
          : [],
    },
  };

  const thread = await getActionChatThread(prisma, {
    merchantId: "m1",
    shopId: "s1",
    recommendationId: "rec-1",
    actionRunId: "run-1",
  });

  assert.equal(calls[0].where.topic, "action:rec-1");
  assert.equal(thread.messages.length, 1);
  assert.equal(thread.messages[0].content, "Scoped reply");
});

test("sendActionChatMessage creates an action topic and never uses the memory topic", async () => {
  const conversations = [];
  const messages = [];
  const updates = [];
  const prompts = [];
  const prisma = {
    merchantMemoryConversation: {
      findFirst: async ({ where }) => conversations.find((c) => c.topic === where.topic) ?? null,
      create: async ({ data }) => {
        const row = {
          id: `conv-${conversations.length + 1}`,
          status: "active",
          createdAt: new Date("2026-08-10T12:00:00.000Z"),
          updatedAt: new Date("2026-08-10T12:00:00.000Z"),
          ...data,
        };
        conversations.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        updates.push({ where, data });
        return { ...conversations.find((c) => c.id === where.id), ...data };
      },
    },
    merchantMemoryConversationMessage: {
      create: async ({ data }) => {
        const row = {
          id: `msg-${messages.length + 1}`,
          createdAt: new Date("2026-08-10T12:00:00.000Z"),
          structuredOperation: null,
          operationStatus: null,
          relatedBeliefIds: [],
          relatedOpenQuestionId: null,
          ...data,
        };
        messages.push(row);
        return row;
      },
      findMany: async ({ where }) =>
        messages.filter((message) => message.conversationId === where.conversationId),
    },
    actionExecution: {
      findFirst: async () => ({
        merchantId: "m1",
        shopId: "s1",
        runId: "run-1",
        actionType: "price_markdown",
        actionKind: "dead_stock_clearance",
        status: "proposed",
        resolvedMode: "approve",
        proposalSummary: {
          variantCount: 2,
          topItems: [
            { title: "Rosehip Serum 30ml", unitsOnHand: 5, trappedCapital: "£120" },
            { title: "Camomile Bath Oil", unitsOnHand: 8, trappedCapital: "£90" },
          ],
          sourceRecommendation: {
            id: ACTION_RECOMMENDATION_ID,
            title: "Clear old stock",
            summary: "Move two products that have not sold.",
            whyThisAction: "Cash is tied up.",
            whyNow: "The stock has not sold.",
          },
        },
        preview: { variantCount: 2 },
      }),
      findMany: async () => [],
    },
    merchantPlanRecommendation: {
      findFirst: async () => ({
        id: ACTION_RECOMMENDATION_ID,
        runId: "plan-run-1",
        merchantId: "m1",
        shopId: "s1",
        title: "Secure Stock on Fast-Selling Drinks",
        summary: "Review products currently facing low stock cover.",
        primaryGoalId: "goal-3",
        supportingGoalIds: [],
        whyThisAction:
          "Two selling products hold fewer than 21 days of stock cover based on trailing sell rates.",
        whyNow: "Acting now protects sales momentum.",
        successSignal: { description: "Products are replenished.", timeframe: "one week" },
        expectedBenefit: "Prevent avoidable stockouts.",
        executionSteps: [],
        supportingBeliefIds: [COUNT_BELIEF_ID],
        supportingInsightIds: [],
        run: { snapshotHash: "plan-hash-1" },
        evidenceSnapshot: {
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
                items: [
                  { title: "Yuzu Tonic", available: 6, dailyVelocity: 1, daysOfCover: 6 },
                  { title: "Cherry Cola", available: 12, dailyVelocity: 1, daysOfCover: 12 },
                ],
              },
            },
          ],
          limitsJson: { snapshotSource: "plan_generation" },
          createdAt: new Date("2026-08-10T12:00:00.000Z"),
        },
      }),
    },
    merchantMemoryBelief: {
      findMany: async ({ where }) => {
        const ids = new Set((where.OR ?? []).flatMap((item) => item?.id?.in ?? []));
        const keys = new Set([
          ...(where.key?.in ?? []),
          ...(where.OR ?? []).flatMap((item) => item?.key?.in ?? []),
        ]);
        const rows = [
          {
            id: COUNT_BELIEF_ID,
            key: "inventory.at_risk_stockout_count.trailing_30d",
            category: "inventory",
            value: { count: 2 },
            valueType: "number",
            status: "inferred",
            confidence: "0.8500",
            confidenceReason: "Direct deterministic observation.",
            evidence: [],
          },
          {
            id: LOW_COVER_BELIEF_ID,
            key: "inventory.low_cover_products.trailing_30d",
            category: "inventory",
            value: {
              items: [
                { productId: "p1", title: "Yuzu Tonic", available: 6, unitsSold: 30, dailyVelocity: 1, daysOfCover: 6 },
                { productId: "p2", title: "Cherry Cola", available: 12, unitsSold: 30, dailyVelocity: 1, daysOfCover: 12 },
              ],
              atRiskProductCount: 2,
              thresholdDays: 21,
              window: "trailing_30d",
            },
            valueType: "structured",
            status: "inferred",
            confidence: "0.8500",
            confidenceReason: "Direct deterministic observation.",
            evidence: [],
          },
        ];
        return rows.filter((row) => ids.has(row.id) || keys.has(row.key));
      },
    },
    merchantGoalHorizon: {
      findMany: async () => [],
    },
    merchantInsightFinding: {
      findMany: async () => [],
    },
  };
  const llmProvider = {
    provider: "mock",
    model: "mock-action-chat",
    enabled: true,
    generateStructuredOperation: async () => {
      throw new Error("not used");
    },
    generateStructuredJson: async (request) => {
      prompts.push(request);
      return {
        json: { reply: "The two products are Rosehip Serum 30ml and Camomile Bath Oil." },
        usage: { estimatedInputTokens: 12, inputTokens: 12, outputTokens: 8, totalTokens: 20 },
        attempts: 1,
        durationMs: 5,
      };
    },
  };

  const fakeShopifyToken = `shpat_${"0123456789abcdef0123456789abcdef"}`;
  const result = await sendActionChatMessage(prisma, {
    merchantId: "m1",
    shopId: "s1",
    recommendationId: ACTION_RECOMMENDATION_ID,
    actionRunId: "run-1",
    actionTitle: "Clear old stock",
    whyThis: "Cash is tied up.",
    whyNow: "The stock has not sold.",
    message: `What are the two products? Customer name Jane Smith, owner@example.com, +44 7700 900123, ${fakeShopifyToken}.`,
    llmProvider,
  });

  assert.equal(result.ok, true);
  assert.equal(conversations[0].topic, `action:${ACTION_RECOMMENDATION_ID}`);
  assert.notEqual(conversations[0].topic, "memory");
  assert.equal(messages[0].role, "merchant");
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].content, "The two products are Rosehip Serum 30ml and Camomile Bath Oil.");
  assert.match(prompts[0].prompt, /Rosehip Serum 30ml/);
  assert.match(prompts[0].prompt, /Camomile Bath Oil/);
  assert.match(prompts[0].prompt, /Yuzu Tonic/);
  assert.match(prompts[0].prompt, /Cherry Cola/);
  assert.match(prompts[0].prompt, /planEvidenceAtRecommendationTime/);
  assert.match(prompts[0].prompt, /currentSystemContext/);
  assert.doesNotMatch(prompts[0].prompt, /owner@example\.com/);
  assert.doesNotMatch(prompts[0].prompt, /7700 900123/);
  assert.equal(prompts[0].prompt.includes(fakeShopifyToken), false);
  assert.doesNotMatch(prompts[0].prompt, /Jane Smith/);
  assert.equal(updates[0].data.context.actionRunId, "run-1");
  assert.equal(updates.at(-1).data.context.planEvidenceSnapshotId, "snapshot-1");
});

test("action chat plans and executes commerce calculations before answering", async () => {
  const prompts = [];
  const { prisma, messages } = createCalculationChatPrisma();
  const llmProvider = {
    provider: "mock",
    model: "mock-action-chat",
    enabled: true,
    generateStructuredOperation: async () => {
      throw new Error("not used");
    },
    generateStructuredJson: async (request) => {
      prompts.push(request);
      if (request.prompt.includes("commerceCalculationCatalog")) {
        return {
          json: {
            requests: [
              {
                id: "revenue_impact",
                kind: "impact_estimate",
                measure: "revenue",
                filters: { scope: "current_move" },
                window: { days: 30, label: "trailing_30d" },
                horizonDays: 30,
              },
            ],
          },
          usage: { estimatedInputTokens: 10, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          attempts: 1,
          durationMs: 2,
        };
      }
      return {
        json: { reply: "At the current 30-day run rate, about GBP 180 is at risk over the next 30 days." },
        usage: { estimatedInputTokens: 20, inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        attempts: 1,
        durationMs: 3,
      };
    },
  };

  const result = await sendActionChatMessage(prisma, {
    merchantId: "m1",
    shopId: "s1",
    recommendationId: ACTION_RECOMMENDATION_ID,
    actionRunId: "run-1",
    message: "Can you quantify the predicted loss of revenue?",
    llmProvider,
  });

  assert.equal(result.ok, true);
  assert.equal(prompts.length, 2);
  assert.match(prompts[0].prompt, /commerceCalculationCatalog/);
  assert.match(prompts[1].prompt, /analysisPacket/);
  assert.match(prompts[1].prompt, /atRiskRevenue/);
  assert.match(prompts[1].prompt, /Picnic Xinomavro/);
  assert.match(prompts[1].prompt, /180/);
  assert.equal(messages.at(-1).content, "At the current 30-day run rate, about GBP 180 is at risk over the next 30 days.");
});

test("action chat rejects invalid calculation plans and still answers from context", async () => {
  const prompts = [];
  const { prisma } = createCalculationChatPrisma();
  const llmProvider = {
    provider: "mock",
    model: "mock-action-chat",
    enabled: true,
    generateStructuredOperation: async () => {
      throw new Error("not used");
    },
    generateStructuredJson: async (request) => {
      prompts.push(request);
      if (request.prompt.includes("commerceCalculationCatalog")) {
        return {
          json: { requests: [{ id: "unsafe", kind: "sql", measure: "revenue" }] },
          usage: { estimatedInputTokens: 10, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          attempts: 1,
          durationMs: 2,
        };
      }
      return {
        json: { reply: "I can explain the move, but I do not have an executable calculation result for that amount." },
        usage: { estimatedInputTokens: 20, inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        attempts: 1,
        durationMs: 3,
      };
    },
  };

  await sendActionChatMessage(prisma, {
    merchantId: "m1",
    shopId: "s1",
    recommendationId: ACTION_RECOMMENDATION_ID,
    actionRunId: "run-1",
    message: "Can you quantify the predicted loss of revenue?",
    llmProvider,
    logger: silentLogger,
  });

  assert.match(prompts[1].prompt, /analysisPacket/);
  assert.doesNotMatch(prompts[1].prompt, /SELECT|sql/i);
});

test("action chat gives an opinionated replenishment quantity when commerce data supports it", async () => {
  const prompts = [];
  const { prisma, messages } = createTwoProductReplenishmentChatPrisma();
  const llmProvider = {
    provider: "mock",
    model: "mock-action-chat",
    enabled: true,
    generateStructuredOperation: async () => {
      throw new Error("not used");
    },
    generateStructuredJson: async (request) => {
      prompts.push(request);
      if (request.prompt.includes("commerceAnalystToolCatalog")) {
        return {
          json: {
            toolCalls: [
              {
                id: "current_move_stock_cover",
                kind: "commerce_calculation",
                request: {
                  id: "current_move_stock_cover",
                  kind: "ranking",
                  measure: "stock_cover_days",
                  dimensions: ["product"],
                  filters: { scope: "current_move" },
                  window: { days: 30, label: "trailing_30d" },
                  topN: 12,
                },
              },
              {
                id: "recommended_purchase_units",
                kind: "derive",
                operation: "recommended_purchase_units",
                sourceResultId: "current_move_stock_cover",
                formula: "ceil(max(0, dailyUnits * targetCoverDays - availableUnits))",
                outputField: "recommendedUnits",
                assumptions: { targetCoverDays: 30, targetCoverDaysSource: "default_30_day_cover" },
              },
            ],
          },
          usage: { estimatedInputTokens: 10, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          attempts: 1,
          durationMs: 2,
        };
      }
      return {
        json: { reply: "I do not have specific purchase quantity recommendations in my current data." },
        usage: { estimatedInputTokens: 20, inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        attempts: 1,
        durationMs: 3,
      };
    },
  };

  const result = await sendActionChatMessage(prisma, {
    merchantId: "m1",
    shopId: "s1",
    recommendationId: ACTION_RECOMMENDATION_ID,
    actionRunId: "run-1",
    message: "How much should I purchase of each?",
    llmProvider,
    logger: silentLogger,
  });

  assert.equal(result.ok, true);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].prompt, /analysisPacket/);
  assert.match(messages.at(-1).content, /3 units of Picnic Xinomavro/);
  assert.match(messages.at(-1).content, /3 units of Pear Skin Sipon/);
  assert.doesNotMatch(messages.at(-1).content, /do not have specific purchase quantity/i);
});

test("addActionChatNote keeps revision notes in the existing action thread", async () => {
  const messages = [];
  const conversation = {
    id: "conv-1",
    merchantId: "m1",
    shopId: "s1",
    topic: "action:rec-1",
    context: { actionRunId: "run-old", recommendationId: "rec-1" },
  };
  const prisma = {
    merchantMemoryConversation: {
      findFirst: async () => conversation,
      update: async ({ data }) => {
        conversation.context = data.context;
        return conversation;
      },
    },
    merchantMemoryConversationMessage: {
      create: async ({ data }) => {
        messages.push(data);
        return { id: "msg-note", createdAt: new Date(), ...data };
      },
    },
  };

  await addActionChatNote(prisma, {
    merchantId: "m1",
    shopId: "s1",
    recommendationId: "rec-1",
    actionRunId: "run-new",
    note: "I narrowed the typed preview to one product.",
  });

  assert.equal(conversation.context.actionRunId, "run-new");
  assert.equal(conversation.context.recommendationId, "rec-1");
  assert.equal(messages[0].role, "assistant");
  assert.match(messages[0].content, /one product/);
});

function createCalculationChatPrisma() {
  const conversations = [];
  const messages = [];
  const now = new Date("2026-08-11T09:30:00.000Z");
  const orders = [
    { id: "o1", merchantId: "m1", shopId: "s1", currency: "GBP", totalPrice: 180, totalDiscount: 0, processedAt: new Date(now.getTime() - 10 * 86400000), financialStatus: "paid", sourceName: "web", shippingCountry: "GB" },
  ];
  const orderById = new Map(orders.map((order) => [order.id, order]));
  const prisma = {
    merchantMemoryConversation: {
      findFirst: async ({ where }) => conversations.find((c) => c.topic === where.topic) ?? null,
      create: async ({ data }) => {
        const row = { id: `conv-${conversations.length + 1}`, status: "active", createdAt: now, updatedAt: now, ...data };
        conversations.push(row);
        return row;
      },
      update: async ({ where, data }) => ({ ...conversations.find((c) => c.id === where.id), ...data }),
    },
    merchantMemoryConversationMessage: {
      create: async ({ data }) => {
        const row = { id: `msg-${messages.length + 1}`, createdAt: now, structuredOperation: null, operationStatus: null, relatedBeliefIds: [], relatedOpenQuestionId: null, ...data };
        messages.push(row);
        return row;
      },
      findMany: async ({ where }) => messages.filter((message) => message.conversationId === where.conversationId),
    },
    actionExecution: {
      findFirst: async () => ({
        merchantId: "m1",
        shopId: "s1",
        runId: "run-1",
        actionType: "restock",
        actionKind: "low_cover_replenishment",
        status: "proposed",
        resolvedMode: "approve",
        proposalSummary: {
          sourceRecommendation: { id: ACTION_RECOMMENDATION_ID, runId: "plan-run-1", title: "Restock Low-Cover Wine Products" },
        },
        preview: {},
      }),
      findMany: async () => [],
    },
    merchantPlanRecommendation: {
      findFirst: async () => ({
        id: ACTION_RECOMMENDATION_ID,
        runId: "plan-run-1",
        merchantId: "m1",
        shopId: "s1",
        title: "Restock Low-Cover Wine Products",
        summary: "Review supplier replenishment options for specific wine products.",
        whyThisAction: "Two selling products hold fewer than 21 days of stock cover.",
        whyNow: "Acting now prevents stockouts.",
        supportingBeliefIds: [COUNT_BELIEF_ID],
        supportingInsightIds: [],
        run: { snapshotHash: "plan-hash-1" },
        evidenceSnapshot: null,
      }),
    },
    merchantPlanEvidenceSnapshot: {
      findUnique: async () => null,
      create: async ({ data }) => ({ id: "snapshot-1", createdAt: now, updatedAt: now, ...data }),
    },
    merchantMemoryBelief: {
      findMany: async () => [
        {
          id: COUNT_BELIEF_ID,
          key: "inventory.at_risk_stockout_count.trailing_30d",
          category: "inventory",
          value: { count: 1 },
          valueType: "number",
          status: "inferred",
          confidence: "0.8500",
          confidenceReason: "Direct deterministic observation.",
          evidence: [],
        },
        {
          id: LOW_COVER_BELIEF_ID,
          key: "inventory.low_cover_products.trailing_30d",
          category: "inventory",
          value: {
            items: [
              { productId: "p1", title: "Picnic Xinomavro", available: 0, unitsSold: 3, dailyVelocity: 0.1, daysOfCover: 0 },
            ],
            atRiskProductCount: 1,
            thresholdDays: 21,
            window: "trailing_30d",
          },
          valueType: "structured",
          status: "inferred",
          confidence: "0.8500",
          confidenceReason: "Direct deterministic observation.",
          evidence: [],
        },
      ],
    },
    merchantGoalHorizon: { findMany: async () => [] },
    merchantInsightFinding: { findMany: async () => [] },
    product: {
      findMany: async () => [{ id: "p1", merchantId: "m1", shopId: "s1", title: "Picnic Xinomavro", vendor: "Picnic", productType: "Wine", status: "ACTIVE" }],
    },
    variant: {
      findMany: async () => [{ id: "v1", merchantId: "m1", shopId: "s1", productId: "p1", title: "Default", sku: "PX", price: 60, currency: "GBP", unitCost: 20 }],
    },
    order: { findMany: async () => orders },
    orderLineItem: {
      findMany: async () => [
        { merchantId: "m1", shopId: "s1", orderId: "o1", productId: "p1", variantId: "v1", sku: "PX", title: "Picnic Xinomavro", quantity: 3, unitPrice: 60, totalPrice: 180, discount: 0, order: orderById.get("o1") },
      ],
    },
    inventoryLevel: { findMany: async () => [{ merchantId: "m1", shopId: "s1", variantId: "v1", available: 0 }] },
    refund: { findMany: async () => [] },
  };
  return { prisma, messages };
}

function createTwoProductReplenishmentChatPrisma() {
  const conversations = [];
  const messages = [];
  const now = new Date("2026-08-11T09:30:00.000Z");
  const orders = [
    { id: "o1", merchantId: "m1", shopId: "s1", currency: "GBP", totalPrice: 180, totalDiscount: 0, processedAt: new Date(now.getTime() - 10 * 86400000), financialStatus: "paid", sourceName: "web", shippingCountry: "GB" },
    { id: "o2", merchantId: "m1", shopId: "s1", currency: "GBP", totalPrice: 144, totalDiscount: 0, processedAt: new Date(now.getTime() - 8 * 86400000), financialStatus: "paid", sourceName: "web", shippingCountry: "GB" },
  ];
  const orderById = new Map(orders.map((order) => [order.id, order]));
  const prisma = {
    merchantMemoryConversation: {
      findFirst: async ({ where }) => conversations.find((c) => c.topic === where.topic) ?? null,
      create: async ({ data }) => {
        const row = { id: `conv-${conversations.length + 1}`, status: "active", createdAt: now, updatedAt: now, ...data };
        conversations.push(row);
        return row;
      },
      update: async ({ where, data }) => ({ ...conversations.find((c) => c.id === where.id), ...data }),
    },
    merchantMemoryConversationMessage: {
      create: async ({ data }) => {
        const row = { id: `msg-${messages.length + 1}`, createdAt: now, structuredOperation: null, operationStatus: null, relatedBeliefIds: [], relatedOpenQuestionId: null, ...data };
        messages.push(row);
        return row;
      },
      findMany: async ({ where }) => messages.filter((message) => message.conversationId === where.conversationId),
    },
    actionExecution: {
      findFirst: async () => ({
        merchantId: "m1",
        shopId: "s1",
        runId: "run-1",
        actionType: "restock",
        actionKind: "low_cover_replenishment",
        status: "proposed",
        resolvedMode: "approve",
        proposalSummary: {
          sourceRecommendation: { id: ACTION_RECOMMENDATION_ID, runId: "plan-run-1", title: "Restock Low-Cover Wine Products" },
        },
        preview: {},
      }),
      findMany: async () => [],
    },
    merchantPlanRecommendation: {
      findFirst: async () => ({
        id: ACTION_RECOMMENDATION_ID,
        runId: "plan-run-1",
        merchantId: "m1",
        shopId: "s1",
        title: "Restock Low-Cover Wine Products",
        summary: "Review supplier replenishment options for specific wine products.",
        whyThisAction: "Two selling products hold fewer than 21 days of stock cover.",
        whyNow: "Acting now prevents stockouts.",
        supportingBeliefIds: [COUNT_BELIEF_ID],
        supportingInsightIds: [],
        run: { snapshotHash: "plan-hash-1" },
        evidenceSnapshot: null,
      }),
    },
    merchantPlanEvidenceSnapshot: {
      findUnique: async () => null,
      create: async ({ data }) => ({ id: "snapshot-1", createdAt: now, updatedAt: now, ...data }),
    },
    merchantMemoryBelief: {
      findMany: async () => [
        {
          id: COUNT_BELIEF_ID,
          key: "inventory.at_risk_stockout_count.trailing_30d",
          category: "inventory",
          value: { count: 2 },
          valueType: "number",
          status: "inferred",
          confidence: "0.8500",
          confidenceReason: "Direct deterministic observation.",
          evidence: [],
        },
        {
          id: LOW_COVER_BELIEF_ID,
          key: "inventory.low_cover_products.trailing_30d",
          category: "inventory",
          value: {
            items: [
              { productId: "p1", variantId: "v1", title: "Picnic Xinomavro", available: 0, unitsSold: 3, dailyVelocity: 0.1, daysOfCover: 0 },
              { productId: "p2", variantId: "v2", title: "Pear Skin Sipon", available: 0, unitsSold: 3, dailyVelocity: 0.1, daysOfCover: 0 },
            ],
            atRiskProductCount: 2,
            thresholdDays: 21,
            window: "trailing_30d",
          },
          valueType: "structured",
          status: "inferred",
          confidence: "0.8500",
          confidenceReason: "Direct deterministic observation.",
          evidence: [],
        },
      ],
    },
    merchantGoalHorizon: { findMany: async () => [] },
    merchantInsightFinding: { findMany: async () => [] },
    product: {
      findMany: async () => [
        { id: "p1", merchantId: "m1", shopId: "s1", title: "Picnic Xinomavro", vendor: "Picnic", productType: "Wine", status: "ACTIVE" },
        { id: "p2", merchantId: "m1", shopId: "s1", title: "Pear Skin Sipon", vendor: "Pear", productType: "Wine", status: "ACTIVE" },
      ],
    },
    variant: {
      findMany: async () => [
        { id: "v1", merchantId: "m1", shopId: "s1", productId: "p1", title: "Default", sku: "PX", price: 60, currency: "GBP", unitCost: 20 },
        { id: "v2", merchantId: "m1", shopId: "s1", productId: "p2", title: "Default", sku: "PS", price: 48, currency: "GBP", unitCost: 16 },
      ],
    },
    order: { findMany: async () => orders },
    orderLineItem: {
      findMany: async () => [
        { merchantId: "m1", shopId: "s1", orderId: "o1", productId: "p1", variantId: "v1", sku: "PX", title: "Picnic Xinomavro", quantity: 3, unitPrice: 60, totalPrice: 180, discount: 0, order: orderById.get("o1") },
        { merchantId: "m1", shopId: "s1", orderId: "o2", productId: "p2", variantId: "v2", sku: "PS", title: "Pear Skin Sipon", quantity: 3, unitPrice: 48, totalPrice: 144, discount: 0, order: orderById.get("o2") },
      ],
    },
    inventoryLevel: {
      findMany: async () => [
        { merchantId: "m1", shopId: "s1", variantId: "v1", available: 0 },
        { merchantId: "m1", shopId: "s1", variantId: "v2", available: 0 },
      ],
    },
    refund: { findMany: async () => [] },
  };
  return { prisma, messages };
}
