// @ts-check

export const DEFAULT_LLM_PROVIDER = "groq";
export const DEFAULT_LLM_MODEL = "openai/gpt-oss-120b";
export const DEFAULT_LLM_FALLBACK_PROVIDER = "gemini";
// gemini-3.1-flash-lite, NOT -3.5-flash-lite: -3.5-flash-lite's free quota was
// exhausted (CHANGELOG 2026-08-07) and LLM_MODEL was already moved off it for that
// reason, so a fallback onto it would 429 exactly when the primary (Groq) does —
// a dead safety net. Point the fallback at the same non-exhausted Gemini tier the
// app already defaults LLM_MODEL to.
export const DEFAULT_LLM_FALLBACK_MODEL = "gemini-3.1-flash-lite";
export const DEFAULT_LLM_TIMEOUT_MS = 8000;
export const DEFAULT_LLM_MAX_INPUT_TOKENS = 6000;
export const DEFAULT_LLM_MAX_OUTPUT_TOKENS = 900;
export const DEFAULT_LLM_MAX_RETRIES = 1;

/**
 * OpenAI-compatible backup providers beyond the built-in groq/gemini (Kimi K3 /
 * Moonshot today; Meta Spark and any other `/chat/completions`-speaking vendor
 * drop in as one entry here — no new adapter code). Each is DARK until its API
 * key env is set: an unkeyed provider yields no client. The MODEL is supplied by
 * LLM_MODEL / LLM_FALLBACK_MODEL when the provider is selected, e.g.
 * `LLM_FALLBACK_PROVIDER=kimi LLM_FALLBACK_MODEL=kimi-k3`.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {Record<string, { apiKey: string; baseUrl: string }>}
 */
export function getOpenAiCompatibleProviders(env = process.env) {
  return {
    kimi: {
      apiKey: env.KIMI_API_KEY || env.MOONSHOT_API_KEY || "",
      baseUrl: env.KIMI_BASE_URL || "https://api.moonshot.ai/v1",
    },
    // meta-spark: add here once its base URL is confirmed (same shape if it's
    // OpenAI-compatible; otherwise it needs its own adapter).
  };
}

export function getLlmConfig() {
  const geminiApiKey = process.env.GEMINI_API_KEY || "";
  const groqApiKey = process.env.GROQ_API_KEY || "";
  const openAiCompatible = getOpenAiCompatibleProviders();
  const anyCompatKey = Object.values(openAiCompatible).some((p) =>
    Boolean(p.apiKey),
  );
  const enabled =
    process.env.LLM_ENABLED === "true" ||
    (process.env.LLM_ENABLED !== "false" &&
      Boolean(geminiApiKey || groqApiKey || anyCompatKey));
  return {
    enabled,
    provider: process.env.LLM_PROVIDER || DEFAULT_LLM_PROVIDER,
    model: process.env.LLM_MODEL || DEFAULT_LLM_MODEL,
    fallbackProvider:
      process.env.LLM_FALLBACK_PROVIDER || DEFAULT_LLM_FALLBACK_PROVIDER,
    fallbackModel: process.env.LLM_FALLBACK_MODEL || DEFAULT_LLM_FALLBACK_MODEL,
    geminiApiKey,
    groqApiKey,
    openAiCompatible,
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
