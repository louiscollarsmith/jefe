// @ts-check

export const DEFAULT_LLM_PROVIDER = "gemini";
export const DEFAULT_LLM_MODEL = "gemini-3.1-flash-lite";
export const DEFAULT_LLM_TIMEOUT_MS = 8000;
export const DEFAULT_LLM_MAX_INPUT_TOKENS = 6000;
export const DEFAULT_LLM_MAX_OUTPUT_TOKENS = 900;
export const DEFAULT_LLM_MAX_RETRIES = 1;

export function getLlmConfig() {
  const geminiApiKey = process.env.GEMINI_API_KEY || "";
  const enabled =
    process.env.LLM_ENABLED === "true" ||
    (process.env.LLM_ENABLED !== "false" && Boolean(geminiApiKey));
  return {
    enabled,
    provider: process.env.LLM_PROVIDER || DEFAULT_LLM_PROVIDER,
    model: process.env.LLM_MODEL || DEFAULT_LLM_MODEL,
    geminiApiKey,
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
