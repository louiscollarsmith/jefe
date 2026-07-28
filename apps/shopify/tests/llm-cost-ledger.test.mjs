import assert from "node:assert/strict";
import test from "node:test";
import { priceUsd, priceFor } from "../app/lib/llm/pricing.server.js";
import { recordLlmUsage } from "../app/lib/llm/usage-recorder.server.js";

function fakePrisma() {
  const created = [];
  return {
    created,
    llmUsageEvent: {
      async create(args) {
        created.push(args.data);
        return { id: "u1", ...args.data };
      },
    },
  };
}

test("priceUsd computes cost from token counts and the pricing table", () => {
  // flash-lite placeholder: $0.10/1M in, $0.40/1M out
  assert.equal(priceUsd("gemini-3.1-flash-lite", 1_000_000, 1_000_000), 0.5);
  assert.equal(priceUsd("gemini-3.1-flash-lite", 500_000, 0), 0.05);
  assert.equal(priceUsd("gemini-3.1-flash-lite", 0, 0), 0);
});

test("priceUsd falls back to a default for unknown models and rounds to 6dp", () => {
  const cost = priceUsd("some-future-model", 1234, 5678);
  assert.equal(typeof cost, "number");
  assert.equal(cost, Math.round(cost * 1e6) / 1e6);
});

test("pricing is flagged unverified (placeholder until real rates)", () => {
  assert.equal(priceFor("gemini-3.1-flash-lite").verified, false);
});

test("recordLlmUsage writes a ledger row with computed cost", async () => {
  const prisma = fakePrisma();
  const ok = await recordLlmUsage(prisma, {
    merchantId: "m1",
    shopId: "s1",
    feature: "insights",
    runType: "MerchantInsightRun",
    runId: "r1",
    model: "gemini-3.1-flash-lite",
    usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 },
    latencyMs: 1234,
    status: "ok",
  });
  assert.equal(ok, true);
  const row = prisma.created[0];
  assert.equal(row.feature, "insights");
  assert.equal(row.model, "gemini-3.1-flash-lite");
  assert.equal(row.inputTokens, 1_000_000);
  assert.equal(row.outputTokens, 1_000_000);
  assert.equal(row.costUsd, 0.5);
  assert.equal(row.latencyMs, 1234);
  assert.equal(row.status, "ok");
});

test("recordLlmUsage tolerates missing usage (failed call) as zero cost", async () => {
  const prisma = fakePrisma();
  await recordLlmUsage(prisma, { feature: "plan", model: "gemini-3.1-flash-lite", usage: null, status: "error" });
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
