import assert from "node:assert/strict";
import test from "node:test";
import { priceUsd, priceFor } from "../app/lib/llm/pricing.server.js";
import {
  finishLlmUsageAttempt,
  recordLlmUsage,
  startLlmUsageAttempt,
} from "../app/lib/llm/usage-recorder.server.js";

function fakePrisma() {
  const created = [];
  return {
    created,
    llmUsageEvent: {
      async create(args) {
        const row = { id: `u${created.length + 1}`, ...args.data };
        created.push(row);
        return row;
      },
      async update(args) {
        const index = created.findIndex((row) => row.id === args.where.id);
        if (index < 0) throw new Error("missing row");
        created[index] = { ...created[index], ...args.data };
        return created[index];
      },
    },
  };
}

test("priceUsd computes cost from token counts and the pricing table", () => {
  // Groq GPT-OSS 120B: $0.15/1M in, $0.60/1M out.
  assert.equal(priceUsd("openai/gpt-oss-120b", 1_000_000, 1_000_000), 0.75);
  assert.equal(priceUsd("openai/gpt-oss-120b", 500_000, 0), 0.075);
  assert.equal(priceUsd("openai/gpt-oss-120b", 0, 0), 0);
  // OpenAI GPT-5.6 Luna: $0.20/M input, $0.02/M cached input, $1.20/M output.
  assert.equal(priceUsd("gpt-5.6-luna", 1_000_000, 1_000_000), 1.4);
  assert.equal(priceUsd("gpt-5.6-luna", 1_000_000, 0, 500_000), 0.11);
});

test("priceUsd falls back to a default for unknown models and rounds to 6dp", () => {
  const cost = priceUsd("some-future-model", 1234, 5678);
  assert.equal(typeof cost, "number");
  assert.equal(cost, Math.round(cost * 1e6) / 1e6);
});

test("published LLM pricing is verified", () => {
  assert.equal(priceFor("gpt-5.6-luna").verified, true);
  assert.equal(priceFor("openai/gpt-oss-120b").verified, true);
  assert.equal(priceFor("gemini-3.5-flash-lite").verified, true);
});

test("recordLlmUsage writes a ledger row with computed cost", async () => {
  const prisma = fakePrisma();
  const ok = await recordLlmUsage(prisma, {
    merchantId: "m1",
    shopId: "s1",
    feature: "insights",
    runType: "MerchantInsightRun",
    runId: "r1",
    provider: "openai",
    model: "gpt-5.6-luna",
    usage: {
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      outputTokens: 1_000_000,
      totalTokens: 2_000_000,
    },
    latencyMs: 1234,
    status: "ok",
  });
  assert.equal(ok, true);
  const row = prisma.created[0];
  assert.equal(row.feature, "insights");
  assert.equal(row.provider, "openai");
  assert.equal(row.model, "gpt-5.6-luna");
  assert.equal(row.inputTokens, 1_000_000);
  assert.equal(row.cachedInputTokens, 500_000);
  assert.equal(row.outputTokens, 1_000_000);
  assert.equal(row.costUsd, 1.31);
  assert.equal(row.latencyMs, 1234);
  assert.equal(row.status, "ok");
});

test("recordLlmUsage tolerates missing usage (failed call) as zero cost", async () => {
  const prisma = fakePrisma();
  await recordLlmUsage(prisma, {
    feature: "plan",
    provider: "groq",
    model: "openai/gpt-oss-120b",
    usage: null,
    status: "error",
  });
  const row = prisma.created[0];
  assert.equal(row.inputTokens, 0);
  assert.equal(row.outputTokens, 0);
  assert.equal(row.costUsd, 0);
  assert.equal(row.status, "error");
});

test("recordLlmUsage never throws on a DB error", async () => {
  const prisma = {
    llmUsageEvent: {
      async create() {
        throw new Error("db down");
      },
    },
  };
  let result;
  await assert.doesNotReject(async () => {
    result = await recordLlmUsage(prisma, { feature: "goals", model: "x", usage: {} });
  });
  assert.equal(result, false);
});

test("usage attempts record started then update to final status", async () => {
  const prisma = fakePrisma();
  const id = await startLlmUsageAttempt(prisma, {
    merchantId: "m1",
    shopId: "s1",
    feature: "general_chat",
    provider: "openai",
    model: "gpt-5.6-luna",
  });
  assert.equal(id, "u1");
  assert.equal(prisma.created.length, 1);
  assert.equal(prisma.created[0].status, "started");

  await finishLlmUsageAttempt(prisma, id, {
    merchantId: "m1",
    shopId: "s1",
    feature: "general_chat",
    provider: "openai",
    model: "gpt-5.6-luna",
    usage: {
      inputTokens: 100,
      cachedInputTokens: 50,
      outputTokens: 10,
      totalTokens: 110,
    },
    latencyMs: 25,
    status: "ok",
  });

  assert.equal(prisma.created.length, 1);
  assert.equal(prisma.created[0].status, "ok");
  assert.equal(prisma.created[0].inputTokens, 100);
  assert.equal(prisma.created[0].cachedInputTokens, 50);
  assert.equal(prisma.created[0].outputTokens, 10);
  assert.equal(prisma.created[0].latencyMs, 25);
});
