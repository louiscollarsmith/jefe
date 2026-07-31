// @ts-check

/**
 * LLM pricing — USD per 1,000,000 tokens, per model. Single source of truth for the cost ledger
 * (`llm_usage_event.cost_usd`) and margin math: update this map and every derived cost corrects
 * itself.
 *
 * ⚠️ PLACEHOLDER / UNVERIFIED. The provider is Google **Gemini** (default model
 * `gemini-3.1-flash-lite`); Lewis holds the Gemini billing account and the real per-model rates
 * were not available when the ledger shipped (2026-07-28). Every entry is `verified: false` —
 * treat absolute costs as indicative only until the real rates are pasted in here and flipped to
 * `verified: true`. Do NOT present these numbers as fact.
 */

/** @typedef {{ inputPer1M: number; outputPer1M: number; verified: boolean }} ModelRate */

/** @type {Record<string, ModelRate>} */
export const LLM_MODEL_PRICING = {
  // The app default (config.DEFAULT_LLM_MODEL / env LLM_MODEL). Flash-lite tier.
  "gemini-3.1-flash-lite": { inputPer1M: 0.1, outputPer1M: 0.4, verified: false },
  // Add other models AS THEY'RE ACTUALLY USED, with REAL rates from Google's pricing page — e.g.
  //   "gemini-3.1-flash": { inputPer1M: <real>, outputPer1M: <real>, verified: true },
  //   "gemini-3.1-pro":   { inputPer1M: <real>, outputPer1M: <real>, verified: true },
  // Deliberately left out rather than guessed — an invented rate would corrupt margin figures.
};

/** Fallback for an unlisted model — conservative + explicitly unverified. */
export const DEFAULT_MODEL_RATE = { inputPer1M: 0.1, outputPer1M: 0.4, verified: false };

/**
 * @param {string} model
 * @returns {ModelRate}
 */
export function rateFor(model) {
  return LLM_MODEL_PRICING[model] ?? DEFAULT_MODEL_RATE;
}

/**
 * Pure cost in USD for one call, rounded to 6dp (matches the `Decimal(12,6)` column). Safe for
 * unknown models (falls back) and non-finite token counts (treated as 0).
 *
 * @param {{ model: string; inputTokens?: number | null; outputTokens?: number | null }} args
 * @returns {number}
 */
export function computeLlmCostUsd({ model, inputTokens, outputTokens }) {
  const r = rateFor(model);
  const inT = Number.isFinite(inputTokens) ? /** @type {number} */ (inputTokens) : 0;
  const outT = Number.isFinite(outputTokens) ? /** @type {number} */ (outputTokens) : 0;
  const cost = (inT / 1e6) * r.inputPer1M + (outT / 1e6) * r.outputPer1M;
  return Math.round(cost * 1e6) / 1e6;
}

// ── Back-compat aliases — keep the existing call site (usage-recorder) + existing tests green,
//    and make this change trivially reversible. `priceUsd` is what the write path calls. ──

/** @type {Record<string, ModelRate>} */
export const LLM_PRICING = LLM_MODEL_PRICING;

/** @param {string} model @returns {ModelRate} */
export function priceFor(model) {
  return rateFor(model);
}

/**
 * @param {string} model
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {number}
 */
export function priceUsd(model, inputTokens, outputTokens) {
  return computeLlmCostUsd({ model, inputTokens, outputTokens });
}
