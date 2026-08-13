import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";

import {
  appendConversationMessage,
  createMerchantConversation,
  sanitizeMemoryText,
} from "../app/lib/merchant-memory/episodic-memory.server.js";
import { segmentMessages } from "../app/lib/merchant-memory/episode-processor.server.js";
import {
  assembleBoundedContext,
  MerchantContextScopeError,
  retrieveMerchantContext,
} from "../app/lib/merchant-memory/merchant-context.server.js";
import {
  classifyHistoricalRecall,
  containsUnresolvedDeicticReference,
} from "../app/lib/merchant-memory/retrievers/episodic-memory-retriever.server.js";
import {
  decideMerchantMessage,
  processPassiveMemoryMessage,
} from "../app/lib/merchant-memory/passive-memory.server.js";
import { getBeliefDefinition } from "../app/lib/merchant-memory/conversational-belief-registry.server.js";
import {
  buildGroundedFallbackReply,
  buildMemoryDecisionReply,
} from "../app/lib/merchant-memory/general-chat.server.js";

const databaseUrl = process.env.DATABASE_URL;

test("memory text passes through and query intent distinguishes current from explicit history", () => {
  // ⛔ PII scrubbing REMOVED 2026-08-13 (founder's call). sanitizeMemoryText no longer masks
  // emails, phone numbers, payment identifiers or customer names — they reach prompts, stored
  // threads and the activity log verbatim. These assertions pin that, so re-enabling scrubbing
  // is a deliberate change rather than a silent one.
  const clean = sanitizeMemoryText(
    "Email jane@example.com or +44 7700 900123; card number 4242 4242 4242 4242.",
  );
  assert.equal(clean.includes("jane@example.com"), true);
  assert.equal(clean.includes("7700 900123"), true);
  assert.equal(clean.includes("4242 4242"), true);
  // Shopify credentials are STILL masked — deliberately not part of the change.
  assert.equal(sanitizeMemoryText("token shpat_abc123").includes("shpat_abc123"), false);
  assert.equal(
    classifyHistoricalRecall("Didn't we discuss France before?"),
    true,
  );
  assert.equal(classifyHistoricalRecall("Where are we expanding next?"), false);
  assert.equal(
    containsUnresolvedDeicticReference("What about that recommendation?"),
    true,
  );
});

test("the LLM decides whether a merchant message is a durable instruction", async () => {
  const requests = [];
  const decision = await decideMerchantMessage({
    prisma: {},
    message: {
      id: "message-1",
      merchantId: "merchant-1",
      shopId: "shop-1",
      content:
        "Before judging margin, always use Shopify Cost per item.",
    },
    semanticMemory: [],
    llmProvider: {
      enabled: true,
      provider: "mock",
      model: "mock",
      async generateStructuredJson(request) {
        requests.push(request);
        return {
          json: {
            action: "acknowledge_memory",
            candidates: [
              {
                operationType: "create",
                key: "policies.margin_cost_basis",
                proposedValue: { option: "shopify_cost_per_item" },
                confidence: 0.99,
                rationale: "Explicit operating rule.",
                explicitChange: true,
              },
            ],
          },
        };
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  assert.equal(requests.length, 1);
  assert.match(requests[0].systemPrompt, /Mentioning revenue, margin, stock/);
  assert.equal(requests[0].maxInputTokens, 8000);
  assert.equal(decision.action, "acknowledge_memory");
  assert.equal(decision.candidates[0].key, "policies.margin_cost_basis");
  assert.deepEqual(decision.candidates[0].proposedValue, {
    option: "shopify_cost_per_item",
  });
  assert.deepEqual(
    getBeliefDefinition("policies.margin_cost_basis")?.allowedValues,
    ["shopify_cost_per_item"],
  );
});

test("message decision prompt is compact and bounded before provider input guard", async () => {
  const requests = [];
  const semanticMemory = Array.from({ length: 20 }, (_, index) => ({
    id: `semantic:${index}`,
    key: `policies.test_${index}`,
    category: "policies",
    content: "x".repeat(2200),
    data: { raw: "y".repeat(2500) },
    source: {
      type: "merchant_memory_belief",
      beliefId: `belief-${index}`,
      evidenceIds: Array.from({ length: 20 }, (__, evidenceIndex) =>
        `evidence-${index}-${evidenceIndex}`,
      ),
    },
    authority: "merchant_confirmed",
    confidence: 0.9,
    temporalStatus: "current",
  }));
  await decideMerchantMessage({
    prisma: {},
    message: {
      id: "message-1",
      merchantId: "merchant-1",
      shopId: "shop-1",
      content:
        "Before judging margin, always use Shopify Cost per item.",
    },
    semanticMemory,
    llmProvider: {
      enabled: true,
      provider: "mock",
      model: "mock",
      async generateStructuredJson(request) {
        requests.push(request);
        return {
          json: {
            action: "general_chat",
            candidates: [],
          },
        };
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  assert.equal(requests.length, 1);
  const prompt = JSON.parse(requests[0].prompt);
  assert.equal(prompt.currentSemanticMemory.length, 8);
  assert.ok(requests[0].prompt.length < 24_000);
  assert.equal(requests[0].maxInputTokens, 8000);
});

test("grounded fallback prefers relevant recall and never dumps unrelated JSON", () => {
  const reply = buildGroundedFallbackReply(
    "What did we say about Shopify Cost per item?",
    {
      queryClass: "historical_recall",
      episodicMemory: [
        {
          content:
            "Before judging margin, always use Shopify Cost per item.",
        },
      ],
      semanticMemory: [
        {
          content:
            "12-month goal: Drive growth by increasing repeat customer revenue",
        },
      ],
      actionMemory: [],
    },
  );
  assert.match(reply, /earlier conversation/);
  assert.match(reply, /Shopify Cost per item/);
  assert.doesNotMatch(reply, /repeat customer revenue/);
  assert.equal(
    buildGroundedFallbackReply("go again please", {
      queryClass: "current",
      episodicMemory: [],
      semanticMemory: [{ content: "12-month goal: growth" }],
      actionMemory: [],
    }),
    "I couldn’t connect that request to grounded information yet. Tell me which part you want me to revisit.",
  );
});

test("a promoted model candidate produces a truthful saved-memory acknowledgement", () => {
  const reply = buildMemoryDecisionReply(
    {
      action: "acknowledge_memory",
      candidates: [
        {
          status: "promoted",
          operationType: "create",
          key: "policies.margin_cost_basis",
          proposedValue: { option: "shopify_cost_per_item" },
        },
      ],
    },
    "Before judging margin, always use Shopify Cost per item.",
  );
  assert.equal(
    reply,
    "Got it — I’ve saved that for future decisions: always use Shopify Cost per item when assessing margin.",
  );
  assert.equal(
    buildMemoryDecisionReply(
      {
        action: "acknowledge_memory",
        candidates: [
          {
            status: "promoted",
            operationType: "create",
            key: "policies.never_recommend",
            proposedValue: {
              text: "Do not calculate margin without Shopify Cost per item.",
            },
          },
        ],
      },
      "Always use Shopify Cost per item.",
    ),
    "Got it — I’ve saved that for future decisions: never calculate margin without Shopify Cost per item.",
  );
});

test("summary segmentation is bounded and overlaps by one canonical message", () => {
  const messages = Array.from({ length: 25 }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 ? "assistant" : "merchant",
    content: "x".repeat(310),
  }));
  const segments = segmentMessages(messages);
  assert.equal(
    segments.every((segment) => segment.length <= 20),
    true,
  );
  assert.equal(
    segments.every(
      (segment) =>
        segment.reduce((sum, message) => sum + message.content.length, 0) <=
        6000,
    ),
    true,
  );
  for (let index = 1; index < segments.length; index += 1) {
    assert.equal(segments[index - 1].at(-1).id, segments[index][0].id);
  }
});

test("context assembly enforces the token budget and required tenant scope", async () => {
  const item = (id, content) => ({
    id,
    content,
    memoryType: "semantic",
    authority: "merchant_confirmed",
    confidence: 1,
    temporalStatus: "current",
    scope: {},
    source: { type: "test" },
    score: { authority: 1 },
  });
  const result = assembleBoundedContext(
    {
      semanticMemory: [
        item("one", "x".repeat(1500)),
        item("two", "x".repeat(1500)),
      ],
    },
    { tokenBudget: 500, order: ["semanticMemory"] },
  );
  assert.equal(result.tokenUsed <= 500, true);
  assert.equal(result.discardedCount > 0, true);
  await assert.rejects(
    retrieveMerchantContext(
      {},
      { merchantId: "merchant", shopId: "", task: "general_chat" },
    ),
    MerchantContextScopeError,
  );
});

test("cross-chat retrieval is tenant-isolated, historical-aware, idempotent and promotes durable teaching", async (t) => {
  if (!databaseUrl) {
    t.skip(
      "DATABASE_URL is required for holistic Merchant Memory integration coverage",
    );
    return;
  }
  const previousEmbeddingFlag = process.env.EPISODIC_EMBEDDING_ENABLED;
  process.env.EPISODIC_EMBEDDING_ENABLED = "false";
  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const firstMerchant = await prisma.merchant.create({
    data: { name: `Memory A ${suffix}` },
  });
  const secondMerchant = await prisma.merchant.create({
    data: { name: `Memory B ${suffix}` },
  });
  const firstShop = await prisma.shop.create({
    data: {
      merchantId: firstMerchant.id,
      shopDomain: `memory-a-${suffix}.myshopify.com`,
    },
  });
  const secondShop = await prisma.shop.create({
    data: {
      merchantId: secondMerchant.id,
      shopDomain: `memory-b-${suffix}.myshopify.com`,
    },
  });
  const decisionProvider = {
    enabled: true,
    provider: "mock",
    model: "mock-message-decision",
    async generateStructuredJson(request) {
      const prompt = JSON.parse(request.prompt);
      if (/blanket storewide discounts/i.test(prompt.merchantMessage)) {
        return {
          json: {
            action: "acknowledge_memory",
            candidates: [
              {
                operationType: "create",
                key: "policies.allow_blanket_storewide_discounts",
                proposedValue: { boolean: false },
                confidence: 0.99,
                rationale: "Explicit discount policy.",
                explicitChange: true,
              },
            ],
          },
        };
      }
      return {
        json: {
          action: "acknowledge_memory",
          candidates: [
            {
              operationType: "create",
              key: "policies.margin_cost_basis",
              proposedValue: { option: "shopify_cost_per_item" },
              confidence: 0.99,
              rationale: "Explicit margin policy.",
              explicitChange: true,
            },
          ],
        },
      };
    },
  };
  try {
    const earlier = await createMerchantConversation(prisma, {
      merchantId: firstMerchant.id,
      shopId: firstShop.id,
      conversationType: "general",
      surface: "app",
    });
    const first = await appendConversationMessage(prisma, {
      conversationId: earlier.id,
      merchantId: firstMerchant.id,
      shopId: firstShop.id,
      role: "merchant",
      content:
        "Let's use Shopify Cost per item before judging margin in France.",
      surface: "app",
      externalMessageId: `external-${suffix}`,
      enqueue: false,
    });
    const duplicate = await appendConversationMessage(prisma, {
      conversationId: earlier.id,
      merchantId: firstMerchant.id,
      shopId: firstShop.id,
      role: "merchant",
      content: "A retry must not create this message.",
      surface: "app",
      externalMessageId: `external-${suffix}`,
      enqueue: false,
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.message.id, first.message.id);
    const firstDecision = await processPassiveMemoryMessage(prisma, {
      messageId: first.message.id,
      llmProvider: decisionProvider,
    });
    assert.equal(firstDecision.action, "acknowledge_memory");
    assert.equal(firstDecision.candidates[0].status, "promoted");
    const marginRule = await prisma.merchantMemoryBelief.findFirst({
      where: {
        merchantId: firstMerchant.id,
        shopId: firstShop.id,
        key: "policies.margin_cost_basis",
      },
    });
    assert.deepEqual(marginRule?.value, {
      option: "shopify_cost_per_item",
    });

    const isolated = await createMerchantConversation(prisma, {
      merchantId: secondMerchant.id,
      shopId: secondShop.id,
      conversationType: "general",
      surface: "app",
    });
    await appendConversationMessage(prisma, {
      conversationId: isolated.id,
      merchantId: secondMerchant.id,
      shopId: secondShop.id,
      role: "merchant",
      content: "Shopify Cost per item SECRET-SECOND-MERCHANT.",
      surface: "app",
      enqueue: false,
    });

    const current = await retrieveMerchantContext(prisma, {
      merchantId: firstMerchant.id,
      shopId: firstShop.id,
      task: "general_chat",
      query: "What did we say about Shopify Cost per item?",
      embeddingProvider: async () => null,
    });
    assert.equal(
      current.episodicMemory.some((item) =>
        item.content.includes("Cost per item"),
      ),
      true,
    );
    assert.equal(
      JSON.stringify(current).includes("SECRET-SECOND-MERCHANT"),
      false,
    );

    await prisma.merchantMemoryEpisode.updateMany({
      where: {
        merchantId: firstMerchant.id,
        sourceMessageIds: { has: first.message.id },
      },
      data: { visibility: "historical_only" },
    });
    const currentTruth = await retrieveMerchantContext(prisma, {
      merchantId: firstMerchant.id,
      shopId: firstShop.id,
      task: "general_chat",
      query: "Where are we expanding next?",
      embeddingProvider: async () => null,
    });
    assert.equal(
      currentTruth.episodicMemory.some((item) =>
        item.content.includes("France"),
      ),
      false,
    );
    const history = await retrieveMerchantContext(prisma, {
      merchantId: firstMerchant.id,
      shopId: firstShop.id,
      task: "general_chat",
      query: "Didn't we discuss France before?",
      embeddingProvider: async () => null,
    });
    assert.equal(
      history.episodicMemory.some(
        (item) => item.temporalStatus === "historical",
      ),
      true,
    );

    const teaching = await appendConversationMessage(prisma, {
      conversationId: earlier.id,
      merchantId: firstMerchant.id,
      shopId: firstShop.id,
      role: "merchant",
      content: "We never use blanket storewide discounts.",
      surface: "app",
      enqueue: false,
    });
    await processPassiveMemoryMessage(prisma, {
      messageId: teaching.message.id,
      llmProvider: decisionProvider,
    });
    const belief = await prisma.merchantMemoryBelief.findFirst({
      where: {
        merchantId: firstMerchant.id,
        shopId: firstShop.id,
        key: "policies.allow_blanket_storewide_discounts",
      },
    });
    assert.deepEqual(belief?.value, { boolean: false });
  } finally {
    await prisma.merchant.deleteMany({
      where: { id: { in: [firstMerchant.id, secondMerchant.id] } },
    });
    await prisma.$disconnect();
    if (previousEmbeddingFlag === undefined)
      delete process.env.EPISODIC_EMBEDDING_ENABLED;
    else process.env.EPISODIC_EMBEDDING_ENABLED = previousEmbeddingFlag;
  }
});
