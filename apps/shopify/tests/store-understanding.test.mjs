import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { createMockLlmProvider } from "../app/lib/llm/provider.server.js";
import {
  getMerchantInterviewExperience,
  submitInterviewAnswer,
} from "../app/lib/merchant-memory/interview.server.js";
import {
  correctBelief,
  getBelief,
  rebuildMerchantMemory,
} from "../app/lib/merchant-memory/service.server.js";
import {
  buildStoreUnderstandingSummary,
  runStoreUnderstandingPass,
} from "../app/lib/merchant-memory/store-understanding.server.js";
import {
  STORE_UNDERSTANDING_DERIVATION_VERSION,
  STORE_UNDERSTANDING_RUN_STATUS,
} from "../app/lib/merchant-memory/store-understanding-registry.server.js";

const databaseUrl = process.env.DATABASE_URL;
const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

test("Store Understanding persists only registered safe inferences with capped confidence", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Store Understanding tests");
    return;
  }

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = uniqueSuffix();

  try {
    const { merchant, shop } = await createStoreUnderstandingFixture(prisma, suffix);
    const result = await rebuildMerchantMemory(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      llmProvider: createMockLlmProvider({
        operation: storeUnderstandingOutput({
          candidates: [
            {
              beliefKey: "business.description",
              value: { text: "a premium candle and home fragrance store" },
              confidence: 0.99,
            },
            {
              beliefKey: "customers.likely_primary_customer_type",
              value: { text: "gift buyers and home fragrance shoppers" },
              confidence: 0.92,
            },
            {
              beliefKey: "arbitrary.private_strategy",
              value: { text: "dominate gifting" },
              confidence: 0.9,
            },
            {
              beliefKey: "business.business_model",
              value: { text: "call jane@example.com" },
              confidence: 0.8,
            },
          ],
        }),
      }),
      logger: silentLogger,
    });

    const description = await getBelief(prisma, {
      merchantId: merchant.id,
      key: "business.description",
      includeEvidence: true,
    });
    const customer = await getBelief(prisma, {
      merchantId: merchant.id,
      key: "customers.likely_primary_customer_type",
    });
    const unsupported = await prisma.merchantMemoryBelief.count({
      where: { merchantId: merchant.id, key: "arbitrary.private_strategy" },
    });
    const pii = await prisma.merchantMemoryBelief.count({
      where: { merchantId: merchant.id, key: "business.business_model" },
    });
    const run = await prisma.storeUnderstandingRun.findFirstOrThrow({
      where: { merchantId: merchant.id },
      orderBy: { createdAt: "desc" },
    });

    assert.equal(result.storeUnderstanding.status, STORE_UNDERSTANDING_RUN_STATUS.completed);
    assert.equal(description.derivationVersion, undefined);
    assert.equal(description.status, "inferred");
    assert.equal(description.evidence[0].sourceType, "llm_store_analysis");
    assert.equal(description.evidence[0].evidenceType, "model_inference");
    assert.equal(description.evidence[0].metadata.promptVersion, STORE_UNDERSTANDING_DERIVATION_VERSION);
    assert.equal(description.confidence, 0.72);
    assert.equal(customer.confidence, 0.6);
    assert.equal(unsupported, 0);
    assert.equal(pii, 0);
    assert.equal(run.acceptedCount, 2);
    assert.equal(run.rejectedCount, 2);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Store Understanding Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("Store Understanding rerun updates changed inferences and obsoletes unsupported old ones", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Store Understanding tests");
    return;
  }

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = uniqueSuffix();

  try {
    const { merchant, shop } = await createStoreUnderstandingFixture(prisma, suffix);
    await runStoreUnderstandingPass(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      force: true,
      llmProvider: createMockLlmProvider({
        operation: storeUnderstandingOutput({
          candidates: [
            {
              beliefKey: "business.description",
              value: { text: "a specialist candle store" },
              confidence: 0.7,
            },
            {
              beliefKey: "brand.apparent_positioning",
              value: { option: "premium" },
              confidence: 0.64,
            },
          ],
        }),
      }),
      logger: silentLogger,
    });
    await runStoreUnderstandingPass(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      force: true,
      llmProvider: createMockLlmProvider({
        operation: storeUnderstandingOutput({
          candidates: [
            {
              beliefKey: "business.description",
              value: { text: "a home fragrance and gifting store" },
              confidence: 0.68,
            },
          ],
        }),
      }),
      logger: silentLogger,
    });

    const description = await getBelief(prisma, {
      merchantId: merchant.id,
      key: "business.description",
    });
    const brandRows = await prisma.merchantMemoryBelief.findMany({
      where: { merchantId: merchant.id, key: "brand.apparent_positioning" },
    });
    const activeDescriptions = await prisma.merchantMemoryBelief.count({
      where: {
        merchantId: merchant.id,
        key: "business.description",
        status: { in: ["inferred", "merchant_confirmed", "merchant_corrected"] },
      },
    });

    assert.equal(description.value.text, "a home fragrance and gifting store");
    assert.equal(activeDescriptions, 1);
    assert.equal(brandRows[0].status, "obsolete");
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Store Understanding Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("Store Understanding does not overwrite merchant-authoritative beliefs and disabled mode falls back", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Store Understanding tests");
    return;
  }

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = uniqueSuffix();

  try {
    const { merchant, shop } = await createStoreUnderstandingFixture(prisma, suffix);
    await rebuildMerchantMemory(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      llmProvider: createMockLlmProvider({
        operation: storeUnderstandingOutput({
          candidates: [
            {
              beliefKey: "business.description",
              value: { text: "a candle store" },
              confidence: 0.7,
            },
          ],
        }),
      }),
      logger: silentLogger,
    });
    await correctBelief(prisma, {
      merchantId: merchant.id,
      key: "business.description",
      value: { text: "merchant-corrected home fragrance brand" },
      valueType: "string",
      correctedBy: "merchant:test",
    });
    await runStoreUnderstandingPass(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      force: true,
      llmProvider: createMockLlmProvider({
        operation: storeUnderstandingOutput({
          candidates: [
            {
              beliefKey: "business.description",
              value: { text: "model changed description" },
              confidence: 0.7,
            },
          ],
        }),
      }),
      logger: silentLogger,
    });
    const disabled = await runStoreUnderstandingPass(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      force: true,
      llmProvider: {
        provider: "mock",
        model: "disabled",
        enabled: false,
        async generateStructuredOperation() {
          throw new Error("disabled");
        },
        async generateStructuredJson() {
          throw new Error("disabled");
        },
      },
      logger: silentLogger,
    });
    const corrected = await getBelief(prisma, {
      merchantId: merchant.id,
      key: "business.description",
    });

    assert.equal(corrected.status, "merchant_corrected");
    assert.equal(corrected.value.text, "merchant-corrected home fragrance brand");
    assert.equal(disabled.status, STORE_UNDERSTANDING_RUN_STATUS.modelDisabled);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Store Understanding Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("adaptive interview asks confirmation from high-confidence Store Understanding and confirmation upgrades authority", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Store Understanding tests");
    return;
  }

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = uniqueSuffix();

  try {
    const { merchant, shop } = await createStoreUnderstandingFixture(prisma, suffix);
    await rebuildMerchantMemory(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      llmProvider: createMockLlmProvider({
        operation: storeUnderstandingOutput({
          candidates: [
            {
              beliefKey: "business.description",
              value: { text: "a premium candle and home fragrance store" },
              confidence: 0.72,
            },
          ],
        }),
      }),
      logger: silentLogger,
    });
    const plannerProvider = createStoreUnderstandingQuestionPlannerProvider(
      storeUnderstandingOutput({
        candidates: [
          {
            beliefKey: "business.description",
            value: { text: "a premium candle and home fragrance store" },
            confidence: 0.72,
          },
        ],
      }),
    );

    const experience = await getMerchantInterviewExperience(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      llmProvider: plannerProvider,
      logger: silentLogger,
    });
    const businessCoverage = experience.readiness.coverage.find(
      (topic) => topic.topicKey === "business.description",
    );

    assert.equal(experience.currentTurn.topicKey, "business.description");
    assert.match(experience.currentTurn.question, /LLM read/i);
    assert.match(experience.currentTurn.question, /accurate/i);
    assert.doesNotMatch(
      experience.currentTurn.question,
      /describe what your business sells, in your own words/i,
    );
    assert.deepEqual(
      experience.messages.map((message) => message.type).slice(0, 2),
      ["assistant_context", "assistant_question"],
    );
    assert.match(experience.messages[0].content, /studied your catalogue/i);
    assert.equal(businessCoverage.status, "provisionally_covered");
    assert.equal(businessCoverage.contribution, 12);

    await submitInterviewAnswer(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      turnId: experience.currentTurn.id,
      answer: "Yes, that's accurate.",
      llmProvider: plannerProvider,
      logger: silentLogger,
    });
    const confirmed = await getBelief(prisma, {
      merchantId: merchant.id,
      key: "business.description",
    });

    assert.equal(confirmed.status, "merchant_confirmed");
    assert.equal(confirmed.confidence, 1);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Store Understanding Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

function createStoreUnderstandingQuestionPlannerProvider(storeUnderstandingOperation) {
  return {
    provider: "mock",
    model: "mock-store-understanding-question-planner",
    enabled: true,
    async generateStructuredOperation() {
      throw new Error("not used");
    },
    async generateStructuredJson(request) {
      if (request.systemPrompt.includes("next merchant interview question")) {
        const prompt = JSON.parse(request.prompt);
        const topic =
          prompt.allowedTopics.find(
            (item) => item.topicKey === "business.description",
          ) ?? prompt.allowedTopics[0];
        return {
          json: {
            topic_key: topic.topicKey,
            question:
              "Jefe's LLM read is that you sell premium candles for home fragrance and gifting. Is that accurate?",
            question_intent: "confirm_inference",
            answer_suggestions: ["Yes", "Not quite"],
            rationale: "Confirm the high-confidence Store Understanding inference.",
          },
          usage: { estimatedInputTokens: 1 },
          attempts: 1,
          durationMs: 0,
        };
      }
      if (request.systemPrompt.includes("Store Understanding")) {
        return {
          json: storeUnderstandingOperation,
          usage: { estimatedInputTokens: 1 },
          attempts: 1,
          durationMs: 0,
        };
      }
      throw new Error("fall back to deterministic answer interpretation");
    },
  };
}

test("Store Understanding summary excludes customer PII and bounds catalogue input", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Store Understanding tests");
    return;
  }

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = uniqueSuffix();

  try {
    const { merchant, shop } = await createStoreUnderstandingFixture(prisma, suffix, {
      productCount: 65,
    });
    const summary = await buildStoreUnderstandingSummary(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });
    const serialized = JSON.stringify(summary);

    assert.equal(summary.catalogueSamples.length, 50);
    assert.equal(serialized.includes("@example.com"), false);
    assert.equal(serialized.includes("maskedEmail"), false);
    assert.equal(summary.privacy.excludesCustomerNamesEmailsPhonesAddresses, true);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Store Understanding Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

function storeUnderstandingOutput({ candidates }) {
  return {
    storeSummary: "The store appears to sell candles and home fragrance products.",
    candidateBeliefs: candidates.map((candidate) => ({
      reason:
        "Catalogue titles, product types and order aggregates consistently support this interpretation.",
      supportingEvidence: [
        {
          type: "catalogue_summary",
          reference: "sampled_products",
          summary: "Sampled product titles and product types are concentrated in candles.",
        },
      ],
      ...candidate,
    })),
    uncertainties: [],
    suggestedInterviewConfirmations: candidates.map((candidate) => ({
      beliefKey: candidate.beliefKey,
      question: "Is this interpretation accurate?",
    })),
  };
}

async function createStoreUnderstandingFixture(prisma, suffix, options = {}) {
  const merchant = await prisma.merchant.create({
    data: {
      name: `Store Understanding Test Merchant ${suffix}`,
      shops: {
        create: {
          shopDomain: `store-understanding-${suffix}.myshopify.com`,
          rawPayload: { name: `Store Understanding ${suffix}` },
        },
      },
    },
    include: { shops: true },
  });
  const shop = merchant.shops[0];
  const productCount = options.productCount ?? 6;
  const products = [];
  for (let index = 0; index < productCount; index += 1) {
    products.push(
      await prisma.product.create({
        data: {
          merchantId: merchant.id,
          shopId: shop.id,
          externalId: `product-${suffix}-${index}`,
          title: `Luxury Soy Candle ${index}`,
          status: "ACTIVE",
          vendor: "Jefe Test",
          productType: "Candles",
          rawPayload: {
            tags: "candles, gifts, fragrance",
            description: "A hand-poured candle for gifting and home fragrance.",
          },
          variants: {
            create: {
              merchantId: merchant.id,
              shopId: shop.id,
              externalId: `variant-${suffix}-${index}`,
              title: "Default",
              price: index % 2 === 0 ? "32.00" : "42.00",
              currency: "GBP",
              inventoryItemExternalId: `inventory-${suffix}-${index}`,
            },
          },
        },
        include: { variants: true },
      }),
    );
  }

  for (let index = 0; index < 6; index += 1) {
    const product = products[index % products.length];
    const variant = product.variants[0];
    await prisma.order.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        externalId: `order-${suffix}-${index}`,
        currency: "GBP",
        totalPrice: index % 2 === 0 ? "64.00" : "42.00",
        processedAt: new Date(`2026-07-${10 + index}T10:00:00Z`),
        lineItems: {
          create: {
            merchantId: merchant.id,
            shopId: shop.id,
            productId: product.id,
            variantId: variant.id,
            externalId: `line-${suffix}-${index}`,
            title: product.title,
            quantity: index % 2 === 0 ? 2 : 1,
            unitPrice: variant.price,
            totalPrice: index % 2 === 0 ? "64.00" : "42.00",
          },
        },
      },
    });
  }

  await prisma.customerIdentity.createMany({
    data: [
      {
        merchantId: merchant.id,
        shopId: shop.id,
        normalizedEmail: `repeat-${suffix}@example.com`,
        emailHash: `repeat-hash-${suffix}`,
        maskedEmail: "r***@example.com",
        orderCount: 2,
        totalSpend: "128.00",
        averageOrderValue: "64.00",
        source: "shopify_order",
      },
      {
        merchantId: merchant.id,
        shopId: shop.id,
        normalizedEmail: `single-${suffix}@example.com`,
        emailHash: `single-hash-${suffix}`,
        maskedEmail: "s***@example.com",
        orderCount: 1,
        totalSpend: "42.00",
        averageOrderValue: "42.00",
        source: "shopify_order",
      },
    ],
  });

  await prisma.inventoryLevel.createMany({
    data: products.slice(0, 4).map((product, index) => ({
      merchantId: merchant.id,
      shopId: shop.id,
      variantId: product.variants[0].id,
      inventoryItemExternalId: product.variants[0].inventoryItemExternalId,
      locationExternalId: `location-${suffix}`,
      available: 12 + index,
      observedAt: new Date("2026-07-22T08:15:00Z"),
    })),
  });

  return { merchant, shop };
}

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`.replace(
    /[^a-z0-9-]/gi,
    "",
  );
}
