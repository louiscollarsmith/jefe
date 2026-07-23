import assert from "node:assert/strict";
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

test("adaptive interview starts with the business description question", async (t) => {
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
      logger: silentLogger,
    });

    assert.equal(experience.interview.status, INTERVIEW_STATUS.inProgress);
    assert.equal(experience.currentTurn.topicKey, "business.description");
    assert.match(experience.currentTurn.question, /describe what your business sells/i);
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
      logger: silentLogger,
    });

    const result = await submitInterviewAnswer(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      turnId: first.currentTurn.id,
      answer:
        "We sell premium handmade candles, mostly bought as gifts by women in their thirties through Instagram. Our biggest goal is repeat purchases.",
      logger: silentLogger,
    });
    const next = await getMerchantInterviewExperience(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
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
    assert.ok(next.completionMessage);
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
    const unsupported = await prisma.merchantMemoryBelief.count({
      where: { merchantId: merchant.id, key: "arbitrary.private_strategy" },
    });

    assert.equal(turn.operationStatus, INTERVIEW_TURN_STATUS.failed);
    assert.equal(unsupported, 0);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Interview Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
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

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`.replace(
    /[^a-z0-9-]/gi,
    "",
  );
}
