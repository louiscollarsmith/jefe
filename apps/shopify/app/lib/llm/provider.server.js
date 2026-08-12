// @ts-check

import { getLlmConfig } from "./config.server.js";
import {
  LlmDisabledError,
  LlmInputLimitError,
  LlmOutputValidationError,
} from "./errors.server.js";
import { createGeminiProvider } from "./providers/gemini.server.js";
import { createGroqProvider } from "./providers/groq.server.js";
import { createOpenAiCompatibleProvider } from "./providers/openai-compatible.server.js";
import { logger as baseLogger } from "../observability/logger.server.js";
import { recordLlmUsage } from "./usage-recorder.server.js";
import { recordLlmFallback } from "../observability/llm-provider-health.server.js";

/**
 * @typedef {{ prisma: any; merchantId?: string | null; shopId?: string | null; feature: string; runType?: string | null; runId?: string | null }} LlmUsageContext
 */

/**
 * @param {{ config?: ReturnType<typeof getLlmConfig>; logger?: Pick<Console, "info" | "warn" | "error">; usage?: LlmUsageContext }} [input]
 */
export function createLlmProvider(input = {}) {
  const config = input.config ?? getLlmConfig();
  if (!config.enabled) {
    return createDisabledProvider(config);
  }
  // Default to the structured logger (tagged for filtering) when a caller does
  // not inject one. The provider only ever logs request metadata — token
  // counts, timings and error names — never prompt or response bodies.
  const logger = input.logger ?? baseLogger.child({ component: "llm" });
  const primary = createProviderForTarget({
    config,
    logger,
    provider: config.provider,
    model: config.model,
  });
  const fallback = createFallbackProvider(config, logger);
  if (!primary) {
    if (fallback) {
      logger.warn("Primary LLM provider is not configured; using fallback", {
        provider: config.provider,
        model: config.model,
        fallbackProvider: fallback.provider,
        fallbackModel: fallback.model,
      });
      return input.usage ? withUsageRecording(fallback, input.usage) : fallback;
    }
    throw missingApiKeyError(config.provider);
  }

  const provider = fallback
    ? withFallbackProvider(primary, fallback, logger)
    : primary;
  return input.usage ? withUsageRecording(provider, input.usage) : provider;
}

/**
 * @param {{ config: any; logger: Pick<Console, "info" | "warn" | "error">; provider: string; model: string }} input
 * @returns {LlmProvider | null}
 */
function createProviderForTarget(input) {
  const { config, logger, provider, model } = input;
  const targetConfig = { ...config, provider, model };
  if (provider === "gemini") {
    return config.geminiApiKey
      ? createGeminiProvider({ config: targetConfig, logger })
      : null;
  }
  if (provider === "groq") {
    return config.groqApiKey
      ? createGroqProvider({ config: targetConfig, logger })
      : null;
  }
  // Registry-driven OpenAI-compatible providers (Kimi/Moonshot, Meta Spark, …).
  // Dark until the provider's API key env is set (unkeyed ⇒ null, same as above).
  const compat = config.openAiCompatible?.[provider];
  if (compat) {
    return compat.apiKey
      ? createOpenAiCompatibleProvider({
          providerName: provider,
          baseUrl: compat.baseUrl,
          apiKey: compat.apiKey,
          config: targetConfig,
          logger,
        })
      : null;
  }
  throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
}

/**
 * @param {any} config
 * @param {Pick<Console, "info" | "warn" | "error">} logger
 * @returns {LlmProvider | null}
 */
function createFallbackProvider(config, logger) {
  if (!config.fallbackProvider || !config.fallbackModel) return null;
  if (
    config.fallbackProvider === config.provider &&
    config.fallbackModel === config.model
  ) {
    return null;
  }
  return createProviderForTarget({
    config,
    logger,
    provider: config.fallbackProvider,
    model: config.fallbackModel,
  });
}

/**
 * @param {string} provider
 */
function missingApiKeyError(provider) {
  if (provider === "groq") {
    return new Error("GROQ_API_KEY is required when LLM_ENABLED=true.");
  }
  if (provider === "gemini") {
    return new Error("GEMINI_API_KEY is required when LLM_ENABLED=true.");
  }
  if (provider === "kimi") {
    return new Error(
      "KIMI_API_KEY (or MOONSHOT_API_KEY) is required when the LLM provider is kimi.",
    );
  }
  return new Error(`API key is required for LLM_PROVIDER=${provider}.`);
}

/**
 * @param {LlmProvider} primary
 * @param {LlmProvider} fallback
 * @param {Pick<Console, "info" | "warn" | "error">} logger
 * @returns {LlmProvider}
 */
export function withFallbackProvider(primary, fallback, logger) {
  /**
   * @param {"generateStructuredOperation" | "generateStructuredJson"} methodName
   * @returns {(request: any) => Promise<any>}
   */
  const wrap = (methodName) => async (request) => {
    const primaryMethod = /** @type {any} */ (primary[methodName]);
    if (!primaryMethod) {
      throw new Error(`LLM provider does not support ${methodName}.`);
    }
    try {
      return await primaryMethod.call(primary, request);
    } catch (error) {
      if (!isLlmFallbackError(error)) throw error;
      const fallbackMethod = /** @type {any} */ (fallback[methodName]);
      if (!fallbackMethod) throw error;
      logger.warn("LLM primary provider failed; using fallback", {
        provider: primary.provider,
        model: primary.model,
        fallbackProvider: fallback.provider,
        fallbackModel: fallback.model,
        error: safeErrorName(error),
        statusCode:
          /** @type {{ status?: unknown }} */ (error ?? {}).status ?? null,
      });
      // Durable signal: a warn alone made sustained fallback operation invisible
      // outside a log grep. This feeds the rolling window on /health.
      recordLlmFallback({
        fromProvider: primary.provider,
        fromModel: primary.model,
        toProvider: fallback.provider,
        toModel: fallback.model,
      });
      try {
        const result = await fallbackMethod.call(fallback, request);
        return {
          ...result,
          fallback: {
            fromProvider: primary.provider,
            fromModel: primary.model,
          },
        };
      } catch (fallbackError) {
        logger.warn("LLM fallback provider also failed", {
          provider: fallback.provider,
          model: fallback.model,
          fallbackFromProvider: primary.provider,
          fallbackFromModel: primary.model,
          error: safeErrorName(fallbackError),
          statusCode:
            /** @type {{ status?: unknown }} */ (fallbackError ?? {}).status ??
            null,
          reasonCode:
            /** @type {{ code?: unknown }} */ (fallbackError ?? {}).code ??
            null,
        });
        if (fallbackError && typeof fallbackError === "object") {
          Object.assign(fallbackError, {
            llmFallbackAttempt: {
              fromProvider: primary.provider,
              fromModel: primary.model,
              toProvider: fallback.provider,
              toModel: fallback.model,
            },
          });
        }
        throw fallbackError;
      }
    }
  };
  return /** @type {LlmProvider} */ ({
    ...primary,
    fallbackProvider: fallback.provider,
    fallbackModel: fallback.model,
    generateStructuredOperation: wrap("generateStructuredOperation"),
    generateStructuredJson: primary.generateStructuredJson && fallback.generateStructuredJson
      ? wrap("generateStructuredJson")
      : undefined,
  });
}

/**
 * @param {unknown} error
 */
export function isLlmFallbackError(error) {
  if (error instanceof LlmOutputValidationError) return false;
  if (error instanceof LlmInputLimitError) return false;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  const status = Number(
    /** @type {{ status?: unknown; code?: unknown }} */ (error ?? {}).status ??
      /** @type {{ status?: unknown; code?: unknown }} */ (error ?? {}).code,
  );
  // 401/403: an expired or invalid primary API key — the most likely real Groq
  // outage mode — should degrade to the other provider, not hard-fail with it
  // sitting idle. 404: a retired/renamed primary model. 413: the provider's
  // request envelope is too small for a prompt/schema another provider may
  // accept. 429/498: rate-limit / capacity. 5xx: provider server error.
  if (status === 401 || status === 403 || status === 404) return true;
  if (status === 413) return true;
  if (status === 429 || status === 498) return true;
  if (status >= 500 && status <= 599) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /rate limit|too many requests|capacity|timeout|timed out|network|fetch failed|ECONNRESET/i.test(
    message,
  );
}

/**
 * Wrap a provider so each generate call records an `LlmUsageEvent` (the cost
 * ledger). Fire-and-forget — recording never affects the generation result.
 *
 * @param {LlmProvider} provider
 * @param {LlmUsageContext} ctx
 * @returns {LlmProvider}
 */
export function withUsageRecording(provider, ctx) {
  if (!ctx || !ctx.prisma) return provider;
  /**
   * @param {(request: any) => Promise<any>} method
   * @returns {(request: any) => Promise<any>}
   */
  const wrap = (method) => async (request) => {
    const base = {
      merchantId: ctx.merchantId,
      shopId: ctx.shopId,
      feature: ctx.feature,
      runType: ctx.runType,
      runId: ctx.runId,
      provider: provider.provider,
      model: provider.model,
    };
    try {
      const result = await method(request);
      if (result.fallback) {
        void recordLlmUsage(ctx.prisma, {
          ...base,
          provider: result.fallback.fromProvider,
          model: result.fallback.fromModel,
          usage: null,
          status: "error",
        });
      }
      void recordLlmUsage(ctx.prisma, {
        ...base,
        provider: result.provider ?? base.provider,
        model: result.model ?? base.model,
        usage: result.usage,
        latencyMs: result.durationMs,
        status: "ok",
      });
      return result;
    } catch (error) {
      const fallbackAttempt =
        /** @type {{ llmFallbackAttempt?: { fromProvider: string; fromModel: string; toProvider: string; toModel: string } }} */ (
          error ?? {}
        ).llmFallbackAttempt;
      if (fallbackAttempt) {
        void recordLlmUsage(ctx.prisma, {
          ...base,
          provider: fallbackAttempt.fromProvider,
          model: fallbackAttempt.fromModel,
          usage: null,
          status: "error",
        });
        void recordLlmUsage(ctx.prisma, {
          ...base,
          provider: fallbackAttempt.toProvider,
          model: fallbackAttempt.toModel,
          usage: null,
          status: "error",
        });
      } else {
        void recordLlmUsage(ctx.prisma, {
          ...base,
          usage: null,
          status: "error",
        });
      }
      throw error;
    }
  };
  return {
    ...provider,
    generateStructuredOperation: wrap(
      provider.generateStructuredOperation.bind(provider),
    ),
    generateStructuredJson: provider.generateStructuredJson
      ? wrap(provider.generateStructuredJson.bind(provider))
      : undefined,
  };
}

/**
 * @param {any} config
 */
export function createDisabledProvider(config) {
  return {
    provider: config.provider,
    model: config.model,
    enabled: false,
    /**
     * @returns {Promise<never>}
     */
    async generateStructuredOperation() {
      throw new LlmDisabledError();
    },
    /**
     * @returns {Promise<never>}
     */
    async generateStructuredJson() {
      throw new LlmDisabledError();
    },
  };
}

/**
 * @param {{ operation: any; usage?: any; delayMs?: number; error?: Error }} input
 */
export function createMockLlmProvider(input) {
  return {
    provider: "mock",
    model: "mock-structured-operation",
    enabled: true,
    /**
     */
    async generateStructuredOperation() {
      if (input.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, input.delayMs));
      }
      if (input.error) throw input.error;
      return {
        provider: "mock",
        model: "mock-structured-operation",
        operation: input.operation,
        usage: input.usage ?? {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          estimatedInputTokens: 10,
        },
        attempts: 1,
        durationMs: input.delayMs ?? 0,
      };
    },
    /**
     */
    async generateStructuredJson() {
      if (input.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, input.delayMs));
      }
      if (input.error) throw input.error;
      return {
        provider: "mock",
        model: "mock-structured-operation",
        json: input.operation,
        usage: input.usage ?? {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          estimatedInputTokens: 10,
        },
        attempts: 1,
        durationMs: input.delayMs ?? 0,
      };
    },
  };
}

/**
 * @typedef {{
 *   provider: string;
 *   model: string;
 *   enabled: boolean;
 *   fallbackProvider?: string;
 *   fallbackModel?: string;
 *   generateStructuredOperation: (request: {
 *     systemPrompt: string;
 *     prompt: string;
 *     schema: any;
 *     maxInputTokens?: number;
 *     maxOutputTokens?: number;
 *     timeoutMs?: number;
 *   }) => Promise<{
 *     provider?: string;
 *     model?: string;
 *     operation: any;
 *     usage: {
 *       inputTokens?: number | null;
 *       outputTokens?: number | null;
 *       totalTokens?: number | null;
 *       estimatedInputTokens: number;
 *     };
 *     attempts: number;
 *     durationMs: number;
 *     fallback?: { fromProvider: string; fromModel: string };
 *   }>;
 *   generateStructuredJson?: (request: {
 *     systemPrompt: string;
 *     prompt: string;
 *     schema: any;
 *     maxInputTokens?: number;
 *     maxOutputTokens?: number;
 *     timeoutMs?: number;
 *   }) => Promise<{
 *     provider?: string;
 *     model?: string;
 *     json: any;
 *     usage: {
 *       inputTokens?: number | null;
 *       outputTokens?: number | null;
 *       totalTokens?: number | null;
 *       estimatedInputTokens: number;
 *     };
 *     attempts: number;
 *     durationMs: number;
 *     fallback?: { fromProvider: string; fromModel: string };
 *   }>;
 * }} LlmProvider
 */

/**
 * @param {unknown} error
 */
function safeErrorName(error) {
  return error instanceof Error ? error.name : "UnknownError";
}
