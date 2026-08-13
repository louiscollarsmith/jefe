// @ts-check

import { externalLlmCallsDisabled } from "./external-call-guard.server.js";

export const DEFAULT_LLM_PROVIDER = "gemini";
export const DEFAULT_LLM_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_LLM_FALLBACK_PROVIDER = "gemini";
export const DEFAULT_LLM_FALLBACK_MODEL = "gemini-3.1-flash-lite";
export const DEFAULT_LLM_CHAT_PROVIDER = "groq";
export const DEFAULT_LLM_CHAT_MODEL = "openai/gpt-oss-120b";
export const DEFAULT_LLM_CHAT_FALLBACK_PROVIDER = "gemini";
export const DEFAULT_LLM_CHAT_FALLBACK_MODEL = "gemini-3.5-flash-lite";
// 30s, not 8s: the real conversation prompt is ~6k input tokens and the primary
// (Groq gpt-oss-120b) takes ~19s at that size, so an 8s default timed out a large
// fraction of real turns (measured 2026-08-12). Prod overrides LLM_TIMEOUT_MS; this
// default is for un-overridden envs so a fresh deploy isn't broken out of the box.
export const DEFAULT_LLM_TIMEOUT_MS = 30000;
export const DEFAULT_LLM_MAX_INPUT_TOKENS = 18000;
export const DEFAULT_LLM_MAX_OUTPUT_TOKENS = 900;
export const DEFAULT_LLM_MAX_RETRIES = 1;
export const DEFAULT_GROQ_MAX_INPUT_TOKENS = 6000;
export const DEFAULT_GEMINI_MAX_INPUT_TOKENS = 18000;
export const DEFAULT_EPISODIC_EMBEDDING_MODEL = "gemini-embedding-2";
export const DEFAULT_EPISODIC_EMBEDDING_DIMENSIONS = 768;
export const DEFAULT_EPISODIC_EMBEDDING_TIMEOUT_MS = 5000;

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

/**
 * @param {{ feature?: string | null; slice?: "chat" | "memory" | null; env?: Record<string, string | undefined> }} [input]
 */
export function getLlmConfig(input = {}) {
  const env = input.env ?? process.env;
  const slice = input.slice ?? sliceForFeature(input.feature);
  const prefix = slice === "chat" ? "LLM_CHAT_" : "LLM_";
  const geminiApiKey = env.GEMINI_API_KEY || "";
  const groqApiKey = env.GROQ_API_KEY || "";
  const openAiCompatible = getOpenAiCompatibleProviders(env);
  const anyCompatKey = Object.values(openAiCompatible).some((p) =>
    Boolean(p.apiKey),
  );
  const enabled =
    !externalLlmCallsDisabled() &&
    (env.LLM_ENABLED === "true" ||
      (env.LLM_ENABLED !== "false" &&
        Boolean(geminiApiKey || groqApiKey || anyCompatKey)));
  const defaults = slice === "chat"
    ? {
        provider: DEFAULT_LLM_CHAT_PROVIDER,
        model: DEFAULT_LLM_CHAT_MODEL,
        fallbackProvider: DEFAULT_LLM_CHAT_FALLBACK_PROVIDER,
        fallbackModel: DEFAULT_LLM_CHAT_FALLBACK_MODEL,
      }
    : {
        provider: DEFAULT_LLM_PROVIDER,
        model: DEFAULT_LLM_MODEL,
        fallbackProvider: DEFAULT_LLM_FALLBACK_PROVIDER,
        fallbackModel: DEFAULT_LLM_FALLBACK_MODEL,
      };
  return {
    enabled,
    slice,
    provider: env[`${prefix}PROVIDER`] || defaults.provider,
    model: env[`${prefix}MODEL`] || defaults.model,
    fallbackProvider: env[`${prefix}FALLBACK_PROVIDER`] || defaults.fallbackProvider,
    fallbackModel: env[`${prefix}FALLBACK_MODEL`] || defaults.fallbackModel,
    geminiApiKey,
    groqApiKey,
    openAiCompatible,
    timeoutMs: positiveInteger(
      env[`${prefix}TIMEOUT_MS`] ?? env.LLM_TIMEOUT_MS,
      DEFAULT_LLM_TIMEOUT_MS,
    ),
    maxInputTokens: positiveInteger(
      env[`${prefix}MAX_INPUT_TOKENS`] ?? env.LLM_MAX_INPUT_TOKENS,
      DEFAULT_LLM_MAX_INPUT_TOKENS,
    ),
    maxOutputTokens: positiveInteger(
      env[`${prefix}MAX_OUTPUT_TOKENS`] ?? env.LLM_MAX_OUTPUT_TOKENS,
      DEFAULT_LLM_MAX_OUTPUT_TOKENS,
    ),
    maxRetries: positiveInteger(
      env[`${prefix}MAX_RETRIES`] ?? env.LLM_MAX_RETRIES,
      DEFAULT_LLM_MAX_RETRIES,
    ),
    providerInputLimits: {
      groq: positiveInteger(env.LLM_GROQ_MAX_INPUT_TOKENS, DEFAULT_GROQ_MAX_INPUT_TOKENS),
      gemini: positiveInteger(env.LLM_GEMINI_MAX_INPUT_TOKENS, DEFAULT_GEMINI_MAX_INPUT_TOKENS),
    },
  };
}

export function getEpisodicEmbeddingConfig() {
  const apiKey = process.env.GEMINI_API_KEY || "";
  return {
    enabled:
      !externalLlmCallsDisabled() &&
      process.env.EPISODIC_EMBEDDING_ENABLED !== "false" && Boolean(apiKey),
    apiKey,
    model:
      process.env.EPISODIC_EMBEDDING_MODEL || DEFAULT_EPISODIC_EMBEDDING_MODEL,
    dimensions: DEFAULT_EPISODIC_EMBEDDING_DIMENSIONS,
    timeoutMs: positiveInteger(
      process.env.EPISODIC_EMBEDDING_TIMEOUT_MS,
      DEFAULT_EPISODIC_EMBEDDING_TIMEOUT_MS,
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

/**
 * @param {string | null | undefined} feature
 * @returns {"chat" | "memory"}
 */
export function sliceForFeature(feature) {
  return ["general_chat", "conversation"].includes(String(feature ?? ""))
    ? "chat"
    : "memory";
}
