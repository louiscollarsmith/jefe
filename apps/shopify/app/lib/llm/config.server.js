// @ts-check

export const DEFAULT_LLM_PROVIDER = "groq";
export const DEFAULT_LLM_MODEL = "openai/gpt-oss-120b";
export const DEFAULT_LLM_FALLBACK_PROVIDER = "gemini";
// gemini-flash-lite-latest (an ALIAS), not a pinned version. Pinned versions rot:
// gemini-2.0-flash-lite and gemini-2.5-flash-lite both now 404 "no longer
// available", and a pinned free tier can quota-exhaust (gemini-3.5-flash-lite,
// CHANGELOG 2026-08-07) so the fallback 429s exactly when the primary does — a dead
// safety net either way. The -latest alias tracks Google's current flash-lite, so
// the fallback can't decay to a dead model name (the recurring failure this class
// keeps producing). Verified callable via the app's SDK 2026-08-12. Stays a
// DIFFERENT provider from the Groq primary, so they don't share a quota ceiling.
export const DEFAULT_LLM_FALLBACK_MODEL = "gemini-flash-lite-latest";
// 30s, not 8s: the real conversation prompt is ~6k input tokens and the primary
// (Groq gpt-oss-120b) takes ~19s at that size, so an 8s default timed out a large
// fraction of real turns (measured 2026-08-12). Prod overrides LLM_TIMEOUT_MS; this
// default is for un-overridden envs so a fresh deploy isn't broken out of the box.
export const DEFAULT_LLM_TIMEOUT_MS = 30000;
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
