import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  INTERVIEW_STATUS,
  INTERVIEW_TURN_STATUS,
  getMerchantInterviewExperience,
  interpretInterviewAnswerDeterministically,
  recalculateInterviewReadiness,
  submitInterviewAnswer,
  updateInterviewStatus,
} from "../app/lib/merchant-memory/interview.server.js";
import { upsertDerivedBelief } from "../app/lib/merchant-memory/service.server.js";

const databaseUrl = process.env.DATABASE_URL;
const silentLogger = {
  info() {},
  warn() {},
  error() {},
};
const disabledLlmProvider = {
  provider: "mock",
  model: "disabled",
  enabled: false,
  async generateStructuredOperation() {
    throw new Error("disabled");
  },
  async generateStructuredJson() {
    throw new Error("disabled");
  },
};
const questionPlannerProvider = {
  provider: "mock",
  model: "mock-question-planner",
  enabled: true,
  async generateStructuredOperation() {
    throw new Error("not used");
  },
  async generateStructuredJson(request) {
    if (request.systemPrompt.includes("next merchant interview question")) {
      const prompt = JSON.parse(request.prompt);
      const topic = prompt.allowedTopics[0];
      return {
        json: {
          topic_key: topic.topicKey,
          question: `Based on what Jefe already knows, what should I remember about ${topic.label.toLowerCase()}?`,
          question_intent: "open_question",
          answer_suggestions: ["Short answer", "Not sure"],
          rationale: "Ask the next highest-priority open topic without using stock wording.",
        },
        usage: { estimatedInputTokens: 1 },
        attempts: 1,
        durationMs: 0,
      };
    }
    if (request.systemPrompt.includes("Store Understanding")) {
      return {
        json: {
          storeSummary: "No Store Understanding in this test.",
          candidateBeliefs: [],
          uncertainties: [],
          suggestedInterviewConfirmations: [],
        },
        usage: { estimatedInputTokens: 1 },
        attempts: 1,
        durationMs: 0,
      };
    }
    throw new Error("fall back to deterministic answer interpretation");
  },
};

test("adaptive interview starts with an LLM-planned business description question", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for adaptive interview tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();

  try {
    const { merchant, shop } = await createInterviewFixture(prisma, suffix);
    const experience = await getMerchantInterviewExperience(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      llmProvider: questionPlannerProvider,
      logger: silentLogger,
    });

    assert.equal(experience.interview.status, INTERVIEW_STATUS.inProgress);
    assert.equal(experience.currentTurn.topicKey, "business.description");
    assert.match(experience.currentTurn.question, /Jefe already knows/i);
    assert.doesNotMatch(
      experience.currentTurn.question,
      /describe what your business sells, in your own words/i,
    );
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Interview Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("adaptive interview does not fall back to deterministic questions when the planner is unavailable", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for adaptive interview tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();

  try {
    const { merchant, shop } = await createInterviewFixture(prisma, suffix);
    const experience = await getMerchantInterviewExperience(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      llmProvider: disabledLlmProvider,
      logger: silentLogger,
    });

    assert.equal(experience.interview.status, INTERVIEW_STATUS.inProgress);
    assert.equal(experience.currentTurn, null);
    assert.match(experience.plannerUnavailableMessage, /LLM question planner/i);
    const turnCount = await prisma.merchantInterviewTurn.count({
      where: { merchantId: merchant.id },
    });
    assert.equal(turnCount, 0);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Interview Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("one answer can create multiple interview beliefs and reach readiness", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for adaptive interview tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();

  try {
    const { merchant, shop } = await createInterviewFixture(prisma, suffix);
    const first = await getMerchantInterviewExperience(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      llmProvider: questionPlannerProvider,
      logger: silentLogger,
    });

    const result = await submitInterviewAnswer(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      turnId: first.currentTurn.id,
      answer:
        "We sell premium handmade candles, mostly bought as gifts by women in their thirties through Instagram. Our biggest goal is repeat purchases.",
      llmProvider: questionPlannerProvider,
      logger: silentLogger,
    });
    const next = await getMerchantInterviewExperience(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      llmProvider: questionPlannerProvider,
      logger: silentLogger,
    });
    const beliefKeys = await prisma.merchantMemoryBelief.findMany({
      where: {
        merchantId: merchant.id,
        status: { in: ["merchant_confirmed", "merchant_corrected"] },
      },
      select: { key: true },
    });

    assert.equal(result.ok, true);
    assert.equal(next.readiness.ready, true);
    assert.equal(next.currentTurn, null);
    assert.equal(next.completionMessage, "I think I understand enough to start helping.");
    assert.equal(
      next.messages.at(-1).type,
      "assistant_acknowledgement",
      "final acknowledgement is rendered before completion controls",
    );
    assert.ok(beliefKeys.some((belief) => belief.key === "business.description"));
    assert.ok(
      beliefKeys.some((belief) => belief.key === "customers.primary_customer_type"),
    );
    assert.ok(
      beliefKeys.some(
        (belief) => belief.key === "marketing.primary_acquisition_channel",
      ),
    );
    assert.ok(
      beliefKeys.some((belief) => belief.key === "goals.primary_business_goal"),
    );
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Interview Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("interview message timeline orders question answer acknowledgement and next question", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for adaptive interview tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();

  try {
    const { merchant, shop } = await createInterviewFixture(prisma, suffix);
    const first = await getMerchantInterviewExperience(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      llmProvider: questionPlannerProvider,
      logger: silentLogger,
    });

    assert.deepEqual(
      first.messages.map((message) => message.type),
      ["assistant_question"],
    );

    await submitInterviewAnswer(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      turnId: first.currentTurn.id,
      answer: "We sell handmade candles for gifting.",
      llmProvider: questionPlannerProvider,
      logger: silentLogger,
    });

    const next = await getMerchantInterviewExperience(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      llmProvider: questionPlannerProvider,
      logger: silentLogger,
    });
    const types = next.messages.map((message) => message.type);
    assert.deepEqual(types, [
      "assistant_question",
      "merchant_answer",
      "assistant_acknowledgement",
      "assistant_question",
    ]);

    const [question, answer, acknowledgement, nextQuestion] = next.messages;
    assert.equal(question.turnId, first.currentTurn.id);
    assert.equal(answer.sourceTurnId, first.currentTurn.id);
    assert.equal(acknowledgement.sourceTurnId, first.currentTurn.id);
    assert.equal(nextQuestion.sourceTurnId, first.currentTurn.id);
    assert.match(acknowledgement.content, /you.ve described the business/i);

    const answeredTurn = await prisma.merchantInterviewTurn.findUniqueOrThrow({
      where: { id: first.currentTurn.id },
    });
    assert.equal(answeredTurn.questionMessageId, question.id);
    assert.equal(answeredTurn.answerMessageId, answer.id);
    assert.equal(answeredTurn.acknowledgementMessageId, acknowledgement.id);
    assert.equal(answeredTurn.nextTurnId, next.currentTurn.id);
    assert.deepEqual(answeredTurn.committedBeliefIds, acknowledgement.committedBeliefIds);
    assert.ok(answeredTurn.interpretationResultId);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Interview Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("acknowledgement never appears before its source answer and ordering survives reload", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for adaptive interview tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();

  try {
    const { merchant, shop } = await createInterviewFixture(prisma, suffix);
    const first = await getMerchantInterviewExperience(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      llmProvider: questionPlannerProvider,
      logger: silentLogger,
    });
    await submitInterviewAnswer(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      turnId: first.currentTurn.id,
      answer: "We sell premium skincare.",
      llmProvider: questionPlannerProvider,
      logger: silentLogger,
    });

    const loaded = await getMerchantInterviewExperience(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      llmProvider: questionPlannerProvider,
      logger: silentLogger,
    });
    const reloaded = await getMerchantInterviewExperience(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      llmProvider: questionPlannerProvider,
      logger: silentLogger,
    });

    assert.deepEqual(
      reloaded.messages.map((message) => message.id),
      loaded.messages.map((message) => message.id),
    );
    for (const acknowledgement of loaded.messages.filter(
      (message) => message.type === "assistant_acknowledgement",
    )) {
      const answerIndex = loaded.messages.findIndex(
        (message) =>
          message.type === "merchant_answer" &&
          message.sourceTurnId === acknowledgement.sourceTurnId,
      );
      const acknowledgementIndex = loaded.messages.findIndex(
        (message) => message.id === acknowledgement.id,
      );
      assert.ok(answerIndex >= 0);
      assert.ok(answerIndex < acknowledgementIndex);
    }
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Interview Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("acknowledgement references committed beliefs from that answer only", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for adaptive interview tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();

  try {
    const { merchant, shop } = await createInterviewFixture(prisma, suffix);
    const first = await getMerchantInterviewExperience(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      llmProvider: questionPlannerProvider,
      logger: silentLogger,
    });
    await submitInterviewAnswer(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      turnId: first.currentTurn.id,
      answer: "Our best channel is currently via Instagram.",
      llmProvider: interpretationProvider({
        candidate_beliefs: [
          {
            belief_key: "marketing.primary_acquisition_channel",
            value: { text: "Instagram" },
            value_type: "string",
            merchant_statement_summary: "Merchant said Instagram is currently the best channel.",
            confidence: 0.9,
          },
        ],
        covered_topics: ["marketing.primary_acquisition_channel"],
      }),
      logger: silentLogger,
    });
    const next = await getMerchantInterviewExperience(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      llmProvider: questionPlannerProvider,
      logger: silentLogger,
    });
    const acknowledgement = next.messages.find(
      (message) => message.type === "assistant_acknowledgement",
    );
    const committed = await prisma.merchantMemoryBelief.findMany({
      where: { id: { in: acknowledgement.committedBeliefIds } },
      select: { key: true },
    });

    assert.equal(
      acknowledgement.content,
      "Got it — you’ve said Instagram is currently your best channel.",
    );
    assert.deepEqual(committed.map((belief) => belief.key), [
      "marketing.primary_acquisition_channel",
    ]);
    assert.doesNotMatch(acknowledgement.content, /primary driver/i);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Interview Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("pause and resume preserve the active question", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for adaptive interview tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();

  try {
    const { merchant, shop } = await createInterviewFixture(prisma, suffix);
    const started = await getMerchantInterviewExperience(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      llmProvider: questionPlannerProvider,
      logger: silentLogger,
    });
    await updateInterviewStatus(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      intent: "pause",
      logger: silentLogger,
    });
    await updateInterviewStatus(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      intent: "resume",
      logger: silentLogger,
    });
    const resumed = await getMerchantInterviewExperience(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      llmProvider: questionPlannerProvider,
      logger: silentLogger,
    });

    assert.equal(resumed.interview.status, INTERVIEW_STATUS.inProgress);
    assert.equal(resumed.currentTurn.id, started.currentTurn.id);
    assert.equal(resumed.currentTurn.topicKey, "business.description");
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Interview Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("readiness gives partial credit for declined required topics", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for adaptive interview tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();

  try {
    const { merchant, shop } = await createInterviewFixture(prisma, suffix);
    const experience = await getMerchantInterviewExperience(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      llmProvider: questionPlannerProvider,
      logger: silentLogger,
    });
    await prisma.merchantInterviewTopic.updateMany({
      where: {
        interviewId: experience.interview.id,
        topicKey: "business.description",
      },
      data: { status: "declined", answeredAt: new Date() },
    });

    const readiness = await recalculateInterviewReadiness(prisma, {
      id: experience.interview.id,
    });
    const business = readiness.coverage.find(
      (topic) => topic.topicKey === "business.description",
    );

    assert.equal(business.contribution, 10);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Interview Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("unsupported interview belief keys fail validation without memory writes", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for adaptive interview tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();

  try {
    const { merchant, shop } = await createInterviewFixture(prisma, suffix);
    const first = await getMerchantInterviewExperience(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      llmProvider: questionPlannerProvider,
      logger: silentLogger,
    });
    await submitInterviewAnswer(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      turnId: first.currentTurn.id,
      answer: "Please remember arbitrary.private_strategy = dominate.",
      llmProvider: {
        provider: "mock",
        model: "mock",
        enabled: true,
        async generateStructuredOperation() {
          throw new Error("not used");
        },
        async generateStructuredJson() {
          return {
            json: {
              answer_status: "accepted",
              candidate_beliefs: [
                {
                  belief_key: "arbitrary.private_strategy",
                  value: { text: "dominate" },
                  value_type: "string",
                  merchant_statement_summary: "Merchant supplied unsupported context.",
                  confidence: 0.9,
                },
              ],
              covered_topics: ["business.description"],
              needs_clarification: false,
              clarification_question: null,
              merchant_visible_acknowledgement: "Understood.",
              suggested_next_topic: null,
            },
            usage: { estimatedInputTokens: 1 },
            attempts: 1,
            durationMs: 0,
          };
        },
      },
      logger: silentLogger,
    });

    const turn = await prisma.merchantInterviewTurn.findUniqueOrThrow({
      where: { id: first.currentTurn.id },
    });
    const messages = await prisma.merchantInterviewMessage.findMany({
      where: { turnId: first.currentTurn.id },
      orderBy: { sequence: "asc" },
    });
    const acknowledgement = messages.find(
      (message) => message.type === "assistant_acknowledgement",
    );
    const unsupported = await prisma.merchantMemoryBelief.count({
      where: { merchantId: merchant.id, key: "arbitrary.private_strategy" },
    });

    assert.equal(turn.operationStatus, INTERVIEW_TURN_STATUS.failed);
    assert.equal(acknowledgement.content, "I couldn’t safely store that yet.");
    assert.deepEqual(acknowledgement.committedBeliefIds, []);
    assert.doesNotMatch(acknowledgement.content, /understood/i);
    assert.equal(unsupported, 0);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Interview Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("interview UI source does not expose Memory updated labels", () => {
  const routeSource = fs.readFileSync(
    new URL("../app/routes/app._index.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(routeSource, /Memory updated/);
});

test("preorder answer creates policy instead of overwriting observed stock facts", () => {
  const interpretation = interpretInterviewAnswerDeterministically({
    answer:
      "Those products are not really out of stock because we sell them on preorder when stock reaches zero.",
    topic: {
      topicKey: "operations.biggest_operational_pain",
      beliefKey: "operations.biggest_operational_pain",
      label: "Operational problem",
    },
  });

  assert.equal(
    interpretation.candidate_beliefs.some(
      (belief) =>
        belief.belief_key === "policies.preorder_zero_inventory_available",
    ),
    true,
  );
  assert.equal(
    interpretation.candidate_beliefs.some(
      (belief) => belief.belief_key === "inventory.out_of_stock_variant_count",
    ),
    false,
  );
});

async function createInterviewFixture(prisma, suffix) {
  const merchant = await prisma.merchant.create({
    data: {
      name: `Interview Test Merchant ${suffix}`,
      shops: {
        create: {
          shopDomain: `interview-${suffix}.myshopify.com`,
          rawPayload: { name: `Interview Store ${suffix}` },
        },
      },
    },
    include: { shops: true },
  });
  const shop = merchant.shops[0];
  await upsertDerivedBelief(prisma, {
    merchantId: merchant.id,
    shopId: shop.id,
    category: "business",
    key: "business.store_name",
    value: { text: `Interview Store ${suffix}` },
    valueType: "string",
    confidence: 0.95,
    confidenceReason: "Fixture observed store name.",
    evidence: {
      sourceType: "system_derivation",
      sourceReference: "test",
      evidenceType: "deterministic_calculation",
      summary: "Fixture store name.",
      metadata: {},
      observedAt: new Date("2026-07-23T08:00:00Z"),
    },
  });
  return { merchant, shop };
}

function interpretationProvider({ candidate_beliefs, covered_topics }) {
  return {
    provider: "mock",
    model: "mock-interpretation",
    enabled: true,
    async generateStructuredOperation() {
      throw new Error("not used");
    },
    async generateStructuredJson(request) {
      if (request.systemPrompt.includes("next merchant interview question")) {
        return questionPlannerProvider.generateStructuredJson(request);
      }
      if (request.systemPrompt.includes("Store Understanding")) {
        return questionPlannerProvider.generateStructuredJson(request);
      }
      return {
        json: {
          answer_status: "accepted",
          candidate_beliefs,
          covered_topics,
          needs_clarification: false,
          clarification_question: null,
          merchant_visible_acknowledgement: "This model acknowledgement should not be rendered.",
          suggested_next_topic: null,
        },
        usage: { estimatedInputTokens: 1 },
        attempts: 1,
        durationMs: 0,
      };
    },
  };
}

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`.replace(
    /[^a-z0-9-]/gi,
    "",
  );
}
