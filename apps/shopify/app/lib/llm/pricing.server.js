// @ts-check

/**
 * LLM pricing — $ per 1,000,000 tokens, per model.
 *
 * ⚠️ PLACEHOLDER / UNVERIFIED. Lewis holds the Gemini billing account and the
 * real per-model rates were not available when this shipped (2026-07-28). These
 * are best-effort estimates so the cost ledger and margin math have *a* number
 * to work with — treat absolute costs as indicative only until the real rates
 * are confirmed and pasted in here. This is the single source of truth: update
 * this map and every derived cost corrects itself.
 */
/** @type {Record<string, { inputPer1M: number; outputPer1M: number; verified: boolean }>} */
export const LLM_PRICING = {
  // gemini-3.1-flash-lite: the app default (see LLM_MODEL). Flash-lite tier.
  "gemini-3.1-flash-lite": { inputPer1M: 0.1, outputPer1M: 0.4, verified: false },
};

/** Fallback when a model isn't in the map. */
const DEFAULT_PRICE = { inputPer1M: 0.1, outputPer1M: 0.4, verified: false };

/**
 * @param {string} model
 * @returns {{ inputPer1M: number; outputPer1M: number; verified: boolean }}
 */
export function priceFor(model) {
  return LLM_PRICING[model] ?? DEFAULT_PRICE;
}

/**
 * Cost in USD for a single call, rounded to 6 decimal places (matches the
 * Decimal(12,6) column).
 *
 * @param {string} model
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {number}
 */
export function priceUsd(model, inputTokens, outputTokens) {
  const p = priceFor(model);
  const inT = Number.isFinite(inputTokens) ? inputTokens : 0;
  const outT = Number.isFinite(outputTokens) ? outputTokens : 0;
  const cost = (inT / 1e6) * p.inputPer1M + (outT / 1e6) * p.outputPer1M;
  return Math.round(cost * 1e6) / 1e6;
}
