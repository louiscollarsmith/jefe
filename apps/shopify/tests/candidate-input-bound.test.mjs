import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokens } from "../app/lib/llm/errors.server.js";
import {
  buildMerchantInsightSnapshot,
  selectPrioritizedCandidates,
} from "../app/lib/merchant-insights/candidates.server.js";
import {
  buildMerchantInsightsPrompt,
  buildMerchantInsightsSystemPrompt,
} from "../app/lib/merchant-insights/prompt.server.js";
import { MAX_INSIGHT_BELIEFS } from "../app/lib/merchant-insights/constants.server.js";
import { buildMerchantGoalSnapshot } from "../app/lib/merchant-goals/candidates.server.js";
import {
  buildMerchantGoalsPrompt,
  buildMerchantGoalsSystemPrompt,
} from "../app/lib/merchant-goals/prompt.server.js";
import { MAX_GOAL_BELIEFS } from "../app/lib/merchant-goals/constants.server.js";

// The generation prompt is `${systemPrompt}\n\n${prompt}` and the provider
// rejects it when Math.ceil(length / 4) exceeds maxInputTokens.
const INSIGHTS_MAX_INPUT_TOKENS = 16000; // service.server.js generateValidatedInsights
const GOALS_MAX_INPUT_TOKENS = 18000; // service.server.js generateValidatedGoals

const CATEGORIES = [
  "orders",
  "customers",
  "products",
  "inventory",
  "revenue",
  "retention",
  "operations",
  "geography",
  "growth",
  "risk",
];

const input = { merchantId: "merchant-1", shopId: "shop-1" };

// ---------------------------------------------------------------------------
// selectPrioritizedCandidates — pure unit tests (no DB, no normalization)
// ---------------------------------------------------------------------------

function scoredItem(category, key, score) {
  return { candidate: { id: key, cat: category, key }, category, key, score };
}

test("selectPrioritizedCandidates returns every candidate (sorted) when at or under the cap", () => {
  const scored = [
    scoredItem("orders", "b", 5),
    scoredItem("customers", "a", 1),
    scoredItem("orders", "a", 9),
  ];
  const result = selectPrioritizedCandidates(scored, 40);
  assert.equal(result.droppedCount, 0);
  assert.deepEqual(result.droppedCategories, []);
  // Sorted by category then key for a deterministic snapshot hash.
  assert.deepEqual(
    result.selected.map((candidate) => candidate.key),
    ["a", "a", "b"],
  );
  assert.deepEqual(
    result.selected.map((candidate) => candidate.cat),
    ["customers", "orders", "orders"],
  );
});

test("selectPrioritizedCandidates caps to N and reports how many were dropped", () => {
  const scored = Array.from({ length: 100 }, (_, index) =>
    scoredItem("orders", `k${String(index).padStart(3, "0")}`, index),
  );
  const result = selectPrioritizedCandidates(scored, 40);
  assert.equal(result.selected.length, 40);
  assert.equal(result.droppedCount, 60);
  assert.deepEqual(result.droppedCategories, ["orders"]);
});

test("selectPrioritizedCandidates keeps at least one belief per represented category", () => {
  // One dominant category plus several sparse categories that would be lost by
  // a naive top-N-by-score selection.
  const scored = [];
  for (let i = 0; i < 90; i += 1) {
    scored.push(scoredItem("orders", `orders-${i}`, 100 + i));
  }
  for (const category of ["customers", "products", "inventory", "risk", "growth"]) {
    // Deliberately low scores so plain top-40 would drop them entirely.
    scored.push(scoredItem(category, `${category}-only`, 1));
  }
  const cap = 40;
  const result = selectPrioritizedCandidates(scored, cap);
  assert.equal(result.selected.length, cap);
  const keptCategories = new Set(result.selected.map((candidate) => candidate.cat));
  for (const category of [
    "orders",
    "customers",
    "products",
    "inventory",
    "risk",
    "growth",
  ]) {
    assert.equal(
      keptCategories.has(category),
      true,
      `expected category ${category} to survive the cap`,
    );
  }
  // No represented category is fully dropped.
  assert.deepEqual(result.fullyDroppedCategories, []);
});

test("selectPrioritizedCandidates keeps the highest-priority categories when categories exceed the cap", () => {
  const scored = Array.from({ length: 50 }, (_, index) =>
    scoredItem(`cat-${String(index).padStart(2, "0")}`, "only", index),
  );
  const result = selectPrioritizedCandidates(scored, 40);
  assert.equal(result.selected.length, 40);
  // 50 categories, 40 slots -> 10 categories fully dropped, the lowest-scored.
  assert.equal(result.fullyDroppedCategories.length, 10);
  assert.equal(result.droppedCount, 10);
});

// ---------------------------------------------------------------------------
// Insights snapshot — integration via mock prisma
// ---------------------------------------------------------------------------

function bigBelief(index) {
  const category = CATEGORIES[index % CATEGORIES.length];
  const daysAgo = index;
  const at = new Date(Date.UTC(2026, 6, 1) - daysAgo * 86_400_000);
  return {
    id: `belief-${String(index).padStart(3, "0")}`,
    merchantId: "merchant-1",
    shopId: "shop-1",
    category,
    key: `${category}.synthetic_signal_${index}`,
    value: {
      amount: 1000 + index,
      currency: "GBP",
      percentage: index % 100,
      window: `${index} day rolling window ${"x".repeat(200)}`,
      label: `Signal ${index} ${"detail ".repeat(40)}`,
      note: "context ".repeat(60),
      count: index,
      status: "active",
    },
    valueType: "object",
    status: index % 7 === 0 ? "merchant_corrected" : "inferred",
    confidence: (0.5 + (index % 50) / 100).toFixed(4),
    confidenceReason: `Reason ${index} ${"why ".repeat(30)}`,
    precedence: index % 3 === 0 ? 40 : 20,
    derivationVersion: "v1",
    firstObservedAt: new Date("2026-05-01T09:00:00Z"),
    lastObservedAt: at,
    lastEvaluatedAt: at,
    lastConfirmedAt: null,
    updatedAt: at,
    createdAt: new Date("2026-05-01T09:00:00Z"),
    evidence: [
      {
        sourceType: "system_derivation",
        evidenceType: "deterministic_calculation",
        summary: `Evidence ${index} ${"backed by stored orders ".repeat(10)}`,
        metadata: { sourceRecordCounts: { orders: 6 } },
        observedAt: new Date("2026-07-01T09:00:00Z"),
        createdAt: new Date("2026-07-01T09:00:00Z"),
      },
    ],
  };
}

function insightsPrismaFor(beliefs) {
  return {
    merchantMemoryBelief: {
      async findMany() {
        return beliefs;
      },
    },
    merchantMemoryRefreshRun: {
      async findFirst() {
        return { id: "memory-run-1", completedAt: new Date("2026-07-25T09:00:00Z") };
      },
    },
  };
}

test("large insight snapshot is capped, stays under the token limit, and covers every category", async () => {
  const beliefs = Array.from({ length: 150 }, (_, index) => bigBelief(index + 1));
  const snapshot = await buildMerchantInsightSnapshot(insightsPrismaFor(beliefs), input);

  assert.equal(snapshot.candidateCount, MAX_INSIGHT_BELIEFS);
  assert.equal(snapshot.snapshot.beliefCount, MAX_INSIGHT_BELIEFS);
  assert.equal(snapshot.droppedBeliefCount, 150 - MAX_INSIGHT_BELIEFS);
  assert.ok(snapshot.droppedCategories.length > 0);

  // The actual generation input must fit under the provider limit.
  const promptText = `${buildMerchantInsightsSystemPrompt()}\n\n${buildMerchantInsightsPrompt(snapshot.snapshot)}`;
  assert.ok(
    estimateTokens(promptText) <= INSIGHTS_MAX_INPUT_TOKENS,
    `estimated ${estimateTokens(promptText)} tokens exceeds ${INSIGHTS_MAX_INPUT_TOKENS}`,
  );

  // Every category present in the input still has at least one belief.
  const inputCategories = new Set(beliefs.map((belief) => belief.category));
  const outputCategories = new Set(snapshot.snapshot.beliefs.map((belief) => belief.cat));
  for (const category of inputCategories) {
    assert.equal(
      outputCategories.has(category),
      true,
      `category ${category} was dropped entirely`,
    );
  }
});

test("insight snapshot selection is deterministic for a given belief set", async () => {
  const beliefs = Array.from({ length: 150 }, (_, index) => bigBelief(index + 1));
  const first = await buildMerchantInsightSnapshot(insightsPrismaFor(beliefs), input);
  // Same beliefs, reversed row order (DB order must not change the outcome).
  const second = await buildMerchantInsightSnapshot(
    insightsPrismaFor([...beliefs].reverse()),
    input,
  );
  assert.equal(first.snapshotHash, second.snapshotHash);
  assert.deepEqual(first.beliefIds, second.beliefIds);
});

// ⚠️ These hashes moved on 2026-08-13. The context packet's `limits` block declared
// `excludesCustomerNamesEmailsPhonesAddresses: true`, which stopped being true when PII
// scrubbing was removed; correcting it to `false` changed the snapshot and therefore the
// hash. That is the pin doing its job. Consequence to be aware of: a changed context hash
// forces insights and goals to REGENERATE rather than reuse a cached run.
test("small insight snapshot keeps the v4 context hash", async () => {
  const snapshot = await buildMerchantInsightSnapshot(
    insightsPrismaFor(goldenBeliefs()),
    input,
  );
  assert.equal(snapshot.candidateCount, 5);
  assert.equal(snapshot.droppedBeliefCount, 0);
  assert.deepEqual(snapshot.droppedCategories, []);
  // Golden hash for the versioned snapshot that includes the bounded unified
  // context adapter. No per-run diagnostic identifiers enter this hash.
  assert.equal(
    snapshot.snapshotHash,
    "b0170085129e14ebfd33fa5b7a9d78aa792331748efd56bca83557e7b9456bbe",
  );
});

// ---------------------------------------------------------------------------
// Goals snapshot — integration via mock prisma
// ---------------------------------------------------------------------------

function goalsPrismaFor(beliefs, { findings = [], coaching = [] } = {}) {
  return {
    ...insightsPrismaFor(beliefs),
    merchantInsightRun: {
      async findFirst() {
        return { id: "insight-run-1", findings };
      },
    },
    merchantMemoryEvidence: {
      async findMany() {
        return coaching;
      },
    },
  };
}

test("large goal snapshot is capped, stays under the token limit, and covers every category", async () => {
  const beliefs = Array.from({ length: 150 }, (_, index) => bigBelief(index + 1));
  const snapshot = await buildMerchantGoalSnapshot(goalsPrismaFor(beliefs), input);

  assert.ok(snapshot.candidateCount <= MAX_GOAL_BELIEFS);
  assert.equal(snapshot.snapshot.beliefCount, snapshot.candidateCount);
  assert.ok(snapshot.droppedBeliefCount > 0);

  const promptText = `${buildMerchantGoalsSystemPrompt()}\n\n${buildMerchantGoalsPrompt(snapshot.snapshot)}`;
  assert.ok(
    estimateTokens(promptText) <= GOALS_MAX_INPUT_TOKENS,
    `estimated ${estimateTokens(promptText)} tokens exceeds ${GOALS_MAX_INPUT_TOKENS}`,
  );

  const inputCategories = new Set(beliefs.map((belief) => belief.category));
  const outputCategories = new Set(snapshot.snapshot.beliefs.map((belief) => belief.cat));
  for (const category of inputCategories) {
    assert.equal(
      outputCategories.has(category),
      true,
      `category ${category} was dropped entirely`,
    );
  }
});

test("small goal snapshot keeps the v2 context hash", async () => {
  const snapshot = await buildMerchantGoalSnapshot(
    goalsPrismaFor(goldenBeliefs(), {
      findings: [
        {
          id: "finding-1",
          title: "Revenue concentration",
          finding: "A few products matter.",
          whyItMatters: "Buying shapes cash.",
          category: "inventory",
          confidence: "high",
          reviewStatus: "confirmed",
          supportingBeliefIds: ["b-3", "missing"],
        },
      ],
      coaching: [
        {
          id: "evidence-1",
          sourceType: "merchant_goals",
          evidenceType: "merchant_goal_coaching",
          summary: "Prioritise profit.",
          observedAt: new Date("2026-07-26T10:00:00Z"),
        },
      ],
    }),
    input,
  );
  // Goal snapshot excludes the goal-memory belief (b-5) but keeps the other 4.
  assert.equal(snapshot.candidateCount, 4);
  assert.equal(snapshot.droppedBeliefCount, 0);
  assert.equal(snapshot.beliefIds.includes("b-5"), false);
  assert.equal(
    snapshot.snapshotHash,
    "9e0df62bc667162a5016a96752fd51667e89f5e466b4ba8278be2ab2a990c1d8",
  );
  assert.equal(
    snapshot.snapshot.memorySnapshotHash,
    "6a1f191b5551d978f416bdf23737ed9326bd82e05ab7b5902a1736fcba17b681",
  );
});

// Golden fixture: mirrors the pre-change hash-capture fixture exactly.
function goldenBeliefs() {
  return [
    goldenBelief({
      id: "b-1",
      key: "orders.average_order_value.all_time",
      category: "orders",
      value: { amount: 64, currency: "GBP" },
      evidenceSummary: "AOV from stored orders.",
    }),
    goldenBelief({
      id: "b-2",
      key: "customers.repeat_rate",
      category: "customers",
      value: { percentage: 22 },
      evidenceSummary: "Repeat rate from stored customers.",
    }),
    goldenBelief({
      id: "b-3",
      key: "products.top_share",
      category: "products",
      value: { share: 0.4 },
      evidenceSummary: "Top product share.",
    }),
    goldenBelief({
      id: "b-4",
      key: "business.description",
      category: "business",
      value: { text: "Independent wine merchant" },
      valueType: "string",
      status: "merchant_corrected",
      sourceType: "merchant_input",
      evidenceSummary: "Merchant supplied description.",
    }),
    goldenBelief({
      id: "b-5",
      key: "goals.generated.six_months",
      category: "goals",
      value: { title: "Grow repeat revenue" },
      valueType: "goal",
      sourceType: "merchant_goals",
      evidenceSummary: "Prior generated goal.",
    }),
  ];
}

function goldenBelief({
  id,
  key,
  category = "orders",
  value,
  status = "inferred",
  evidenceSummary,
  sourceType = "system_derivation",
  valueType = "number",
}) {
  return {
    id,
    merchantId: "merchant-1",
    shopId: "shop-1",
    category,
    key,
    value,
    valueType,
    status,
    confidence: "0.9000",
    confidenceReason: "Supported by stored evidence.",
    precedence: sourceType === "system_derivation" ? 40 : 80,
    derivationVersion: `${key}@v1`,
    firstObservedAt: new Date("2026-07-25T09:00:00Z"),
    lastObservedAt: new Date("2026-07-25T09:00:00Z"),
    lastEvaluatedAt: new Date("2026-07-25T09:00:00Z"),
    lastConfirmedAt: null,
    evidence: [
      {
        sourceType,
        evidenceType: "deterministic_calculation",
        summary: evidenceSummary,
        metadata: { sourceRecordCounts: { orders: 6 } },
        observedAt: new Date("2026-07-25T09:00:00Z"),
        createdAt: new Date("2026-07-25T09:00:00Z"),
      },
    ],
  };
}
