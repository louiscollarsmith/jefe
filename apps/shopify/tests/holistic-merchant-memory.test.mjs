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
  deterministicCandidateProposals,
  processPassiveMemoryMessage,
} from "../app/lib/merchant-memory/passive-memory.server.js";

const databaseUrl = process.env.DATABASE_URL;
const disabledProvider = {
  enabled: false,
  provider: "disabled",
  model: "disabled",
};

test("memory text is sanitised and query intent distinguishes current from explicit history", () => {
  const clean = sanitizeMemoryText(
    "Email jane@example.com or +44 7700 900123; card number 4242 4242 4242 4242.",
  );
  assert.equal(clean.includes("jane@example.com"), false);
  assert.equal(clean.includes("7700 900123"), false);
  assert.equal(clean.includes("4242 4242"), false);
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

test("passive extraction recognises a durable policy but leaves an anecdote episodic", () => {
  const policy = deterministicCandidateProposals(
    "We never use blanket storewide discounts.",
  );
  assert.deepEqual(
    policy.map((candidate) => candidate.key),
    ["policies.allow_blanket_storewide_discounts"],
  );
  assert.deepEqual(policy[0].proposedValue, { boolean: false });
  assert.deepEqual(
    deterministicCandidateProposals(
      "I met a supplier at a trade show yesterday.",
    ),
    [],
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
      llmProvider: disabledProvider,
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
