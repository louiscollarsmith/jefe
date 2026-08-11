import assert from "node:assert/strict";
import test from "node:test";
import {
  computeLlmCostUsd,
  LLM_MODEL_PRICING,
  priceUsd,
} from "../app/lib/llm/pricing.server.js";
import { shapeCostSummary, summarizeLlmCost } from "../app/lib/llm/cost-report.server.js";

test("computeLlmCostUsd matches per-model rates (object API)", () => {
  // 1M input x $0.15 + 1M output x $0.60 = 0.75.
  assert.equal(computeLlmCostUsd({ model: "openai/gpt-oss-120b", inputTokens: 1_000_000, outputTokens: 1_000_000 }), 0.75);
});

test("computeLlmCostUsd falls back safely for unknown models + non-finite tokens", () => {
  const c = computeLlmCostUsd({ model: "not-a-real-model", inputTokens: NaN, outputTokens: 5678 });
  assert.equal(typeof c, "number");
  assert.equal(c, Math.round(c * 1e6) / 1e6);
});

test("every shipped LLM rate is backed by published pricing", () => {
  for (const [model, r] of Object.entries(LLM_MODEL_PRICING)) {
    assert.equal(r.verified, true, `${model} should use published pricing`);
  }
});

test("legacy priceUsd stays behaviourally identical (reversibility of the pricing refactor)", () => {
  assert.equal(priceUsd("openai/gpt-oss-120b", 500_000, 0), 0.075);
});

test("shapeCostSummary aggregates by model + feature with totals + the verified flag", () => {
  const rows = [
    { model: "openai/gpt-oss-120b", feature: "insights", _sum: { costUsd: 0.5, totalTokens: 2_000_000 }, _count: { _all: 3 } },
    { model: "openai/gpt-oss-120b", feature: "goals", _sum: { costUsd: 0.25, totalTokens: 1_000_000 }, _count: { _all: 2 } },
    { model: "gemini-3.1-pro", feature: "insights", _sum: { costUsd: 1.0, totalTokens: 500_000 }, _count: { _all: 1 } },
  ];
  const s = shapeCostSummary(rows);
  assert.equal(s.totalCostUsd, 1.75);
  assert.equal(s.totalCalls, 6);
  assert.equal(s.byModel[0].model, "gemini-3.1-pro", "highest cost first");
  assert.equal(s.byModel.find((m) => m.model === "openai/gpt-oss-120b").costUsd, 0.75);
  assert.equal(s.byFeature.find((f) => f.feature === "insights").costUsd, 1.5);
  assert.equal(s.allRatesVerified, false, "unknown models keep the summary unverified");
});

test("shapeCostSummary is defensive against empty / malformed input", () => {
  assert.deepEqual(shapeCostSummary([]).byModel, []);
  assert.equal(shapeCostSummary(null).totalCostUsd, 0);
  assert.equal(shapeCostSummary([{ model: "x", _sum: {}, _count: {} }]).totalCostUsd, 0);
});

test("summarizeLlmCost builds the groupBy (window) + shapes it (mock prisma)", async () => {
  let captured = null;
  const prisma = {
    llmUsageEvent: {
      groupBy: async (args) => {
        captured = args;
        return [{ model: "openai/gpt-oss-120b", feature: "insights", _sum: { costUsd: 0.5, totalTokens: 100 }, _count: { _all: 1 } }];
      },
    },
  };
  const since = new Date("2026-07-01T00:00:00Z");
  const s = await summarizeLlmCost(prisma, { since });
  assert.deepEqual(captured.by, ["model", "feature"]);
  assert.equal(captured.where.createdAt.gte, since);
  assert.equal(s.totalCostUsd, 0.5);
  assert.equal(s.byModel[0].model, "openai/gpt-oss-120b");
});
