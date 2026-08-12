// @ts-check

export const DEFAULT_LLM_PROVIDER = "groq";
export const DEFAULT_LLM_MODEL = "openai/gpt-oss-120b";
export const DEFAULT_LLM_FALLBACK_PROVIDER = "gemini";
// NOTE (held for a founder call): -3.5-flash-lite's free quota was exhausted
// (CHANGELOG 2026-08-07) and LLM_MODEL was moved off it, so a fallback onto it
// would 429 exactly when the primary (Groq) does. Recommended change:
// gemini-3.1-flash-lite. Prod runs this default (no LLM_FALLBACK_MODEL env), so
// changing it alters live fallback behaviour — not shipped without a nod.
export const DEFAULT_LLM_FALLBACK_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_LLM_TIMEOUT_MS = 8000;
export const DEFAULT_LLM_MAX_INPUT_TOKENS = 6000;
export const DEFAULT_LLM_MAX_OUTPUT_TOKENS = 900;
export const DEFAULT_LLM_MAX_RETRIES = 1;

export function getLlmConfig() {
  const geminiApiKey = process.env.GEMINI_API_KEY || "";
  const groqApiKey = process.env.GROQ_API_KEY || "";
  const enabled =
    process.env.LLM_ENABLED === "true" ||
    (process.env.LLM_ENABLED !== "false" && Boolean(geminiApiKey || groqApiKey));
  return {
    enabled,
    provider: process.env.LLM_PROVIDER || DEFAULT_LLM_PROVIDER,
    model: process.env.LLM_MODEL || DEFAULT_LLM_MODEL,
    fallbackProvider:
      process.env.LLM_FALLBACK_PROVIDER || DEFAULT_LLM_FALLBACK_PROVIDER,
    fallbackModel: process.env.LLM_FALLBACK_MODEL || DEFAULT_LLM_FALLBACK_MODEL,
    geminiApiKey,
    groqApiKey,
    timeoutMs: positiveInteger(
      process.env.LLM_TIMEOUT_MS,
      DEFAULT_LLM_TIMEOUT_MS,
    ),
    maxInputTokens: positiveInteger(
      process.env.LLM_MAX_INPUT_TOKENS,
      DEFAULT_LLM_MAX_INPUT_TOKENS,
    ),
    maxOutputTokens: positiveInteger(
      process.env.LLM_MAX_OUTPUT_TOKENS,
      DEFAULT_LLM_MAX_OUTPUT_TOKENS,
    ),
    maxRetries: positiveInteger(
      process.env.LLM_MAX_RETRIES,
      DEFAULT_LLM_MAX_RETRIES,
    ),
  };
}

/**
 * @param {string | undefined} value
 * @param {number} fallback
 */
function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
