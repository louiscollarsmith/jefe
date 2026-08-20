// @ts-check

/**
 * LLM pricing — USD per 1,000,000 tokens, per model. Single source of truth for the cost ledger
 * (`llm_usage_event.cost_usd`) and margin math: update this map and every derived cost corrects
 * itself.
 *
 * Pricing sources:
 * - OpenAI GPT-5.6 Luna: https://developers.openai.com/api/docs/models/gpt-5.6-luna
 * - Groq GPT-OSS 120B: https://console.groq.com/docs/model/openai/gpt-oss-120b
 * - Google Gemini: https://ai.google.dev/gemini-api/docs/pricing
 *
 * Free-tier calls are free of charge up to provider quota. The rates below are paid-tier fallback
 * rates so the cost ledger stays conservative if the project moves onto paid usage; they are not a
 * promise that local development will be billed.
 */

/** @typedef {{ inputPer1M: number; outputPer1M: number; cachedInputPer1M?: number; verified: boolean }} ModelRate */

/** @type {Record<string, ModelRate>} */
export const LLM_MODEL_PRICING = {
  "gpt-5.6-luna": {
    inputPer1M: 0.2,
    cachedInputPer1M: 0.02,
    outputPer1M: 1.2,
    verified: true,
  },
  // App default (config.DEFAULT_LLM_MODEL / env LLM_MODEL).
  "openai/gpt-oss-120b": { inputPer1M: 0.15, outputPer1M: 0.6, verified: true },
  "gemini-3.5-flash": { inputPer1M: 1.5, outputPer1M: 9, verified: true },
  "gemini-3.5-flash-lite": { inputPer1M: 0.3, outputPer1M: 2.5, verified: true },
  "gemini-3.1-flash-lite": { inputPer1M: 0.25, outputPer1M: 1.5, verified: true },
};

/** Fallback for an unlisted model — conservative + explicitly unverified. */
export const DEFAULT_MODEL_RATE = { inputPer1M: 1.5, outputPer1M: 9, verified: false };

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
 * @param {{ model: string; inputTokens?: number | null; cachedInputTokens?: number | null; outputTokens?: number | null }} args
 * @returns {number}
 */
export function computeLlmCostUsd({ model, inputTokens, outputTokens, cachedInputTokens }) {
  const r = rateFor(model);
  const inT = Number.isFinite(inputTokens) ? /** @type {number} */ (inputTokens) : 0;
  const cachedT = Math.min(
    inT,
    Math.max(
      0,
      Number.isFinite(cachedInputTokens)
        ? /** @type {number} */ (cachedInputTokens)
        : 0,
    ),
  );
  const uncachedT = Math.max(0, inT - cachedT);
  const outT = Number.isFinite(outputTokens) ? /** @type {number} */ (outputTokens) : 0;
  const cachedRate = r.cachedInputPer1M ?? r.inputPer1M;
  const cost =
    (uncachedT / 1e6) * r.inputPer1M +
    (cachedT / 1e6) * cachedRate +
    (outT / 1e6) * r.outputPer1M;
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
export function priceUsd(model, inputTokens, outputTokens, cachedInputTokens = 0) {
  return computeLlmCostUsd({ model, inputTokens, outputTokens, cachedInputTokens });
}
