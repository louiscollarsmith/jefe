// @ts-check

// LLM cost / margin READ — the aggregation side of the cost ledger. The ledger (`llm_usage_event`)
// was write-only (the only other read was retention pruning); this adds the margin-visibility read:
// total spend + a per-model / per-feature breakdown over an optional time window. Read-only.
//
// Costs are only as good as the pricing table (`pricing.server.js`), where every model rate is
// currently `verified: false` (real Gemini rates pending). `rateVerified` per model + the top-level
// `allRatesVerified` surface that honestly — a margin figure is never mistaken for a confirmed number.

import { rateFor } from "./pricing.server.js";

/** @param {unknown} v */
const num = (v) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
/** @param {number} n */
const round6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * Pure: shape prisma `groupBy(['model','feature'])` rows into a cost summary. Defensive against
 * empty / malformed rows (Decimal sums arrive as strings/Decimal — coerced via Number).
 *
 * @param {Array<{ model?: string, feature?: string|null, _sum?: { costUsd?: unknown, totalTokens?: unknown }, _count?: { _all?: number } }>|null|undefined} rows
 */
export function shapeCostSummary(rows) {
  const list = Array.isArray(rows) ? rows : [];
  /** @type {Map<string, { costUsd: number, tokens: number, calls: number, rateVerified: boolean }>} */
  const byModelMap = new Map();
  /** @type {Map<string, { costUsd: number, tokens: number, calls: number }>} */
  const byFeatureMap = new Map();
  let totalCostUsd = 0;
  let totalTokens = 0;
  let totalCalls = 0;

  for (const r of list) {
    const cost = num(r?._sum?.costUsd);
    const tokens = num(r?._sum?.totalTokens);
    const calls = num(r?._count?._all);
    totalCostUsd += cost;
    totalTokens += tokens;
    totalCalls += calls;

    const model = r?.model ?? "unknown";
    const m = byModelMap.get(model) ?? { costUsd: 0, tokens: 0, calls: 0, rateVerified: rateFor(model).verified };
    m.costUsd += cost;
    m.tokens += tokens;
    m.calls += calls;
    byModelMap.set(model, m);

    const feature = r?.feature ?? "unknown";
    const f = byFeatureMap.get(feature) ?? { costUsd: 0, tokens: 0, calls: 0 };
    f.costUsd += cost;
    f.tokens += tokens;
    f.calls += calls;
    byFeatureMap.set(feature, f);
  }

  const byModel = [...byModelMap.entries()]
    .map(([model, v]) => ({ model, costUsd: round6(v.costUsd), tokens: v.tokens, calls: v.calls, rateVerified: v.rateVerified }))
    .sort((a, b) => b.costUsd - a.costUsd);
  const byFeature = [...byFeatureMap.entries()]
    .map(([feature, v]) => ({ feature, costUsd: round6(v.costUsd), tokens: v.tokens, calls: v.calls }))
    .sort((a, b) => b.costUsd - a.costUsd);

  return {
    totalCostUsd: round6(totalCostUsd),
    totalTokens,
    totalCalls,
    byModel,
    byFeature,
    // False while any model's rate is a placeholder — so a caller never treats spend as confirmed.
    allRatesVerified: byModel.length > 0 && byModel.every((m) => m.rateVerified),
  };
}

/**
 * Read the cost ledger and return a margin-visibility summary over an optional window.
 * @param {{ llmUsageEvent: { groupBy: Function } }} prisma
 * @param {{ since?: Date, until?: Date }} [opts]
 */
export async function summarizeLlmCost(prisma, opts = {}) {
  /** @type {Record<string, any>} */
  const where = {};
  if (opts.since || opts.until) {
    where.createdAt = {};
    if (opts.since) where.createdAt.gte = opts.since;
    if (opts.until) where.createdAt.lte = opts.until;
  }
  const rows = await prisma.llmUsageEvent.groupBy({
    by: ["model", "feature"],
    where,
    _sum: { costUsd: true, totalTokens: true },
    _count: { _all: true },
  });
  return shapeCostSummary(rows);
}
