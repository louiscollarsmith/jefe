// @ts-check

import { getLlmConfig } from "./config.server.js";
import { LlmDisabledError } from "./errors.server.js";
import { createGeminiProvider } from "./providers/gemini.server.js";
import { logger as baseLogger } from "../observability/logger.server.js";
import { recordLlmUsage } from "./usage-recorder.server.js";

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
  if (config.provider !== "gemini") {
    throw new Error(`Unsupported LLM_PROVIDER: ${config.provider}`);
  }
  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is required when LLM_ENABLED=true.");
  }
  // Default to the structured logger (tagged for filtering) when a caller does
  // not inject one. The provider only ever logs request metadata — token
  // counts, timings and error names — never prompt or response bodies.
  const logger = input.logger ?? baseLogger.child({ component: "llm" });
  const provider = createGeminiProvider({ config, logger });
  return input.usage ? withUsageRecording(provider, input.usage) : provider;
}

/**
 * Wrap a provider so each generate call records an `LlmUsageEvent` (the cost
 * ledger). Fire-and-forget — recording never affects the generation result.
 *
 * @param {LlmProvider} provider
 * @param {LlmUsageContext} ctx
 * @returns {LlmProvider}
 */
function withUsageRecording(provider, ctx) {
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
      model: provider.model,
    };
    try {
      const result = await method(request);
      void recordLlmUsage(ctx.prisma, {
        ...base,
        usage: result.usage,
        latencyMs: result.durationMs,
        status: "ok",
      });
      return result;
    } catch (error) {
      void recordLlmUsage(ctx.prisma, { ...base, usage: null, status: "error" });
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
 * @param {ReturnType<typeof getLlmConfig>} config
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
 *   generateStructuredOperation: (request: {
 *     systemPrompt: string;
 *     prompt: string;
 *     schema: any;
 *     maxInputTokens?: number;
 *     maxOutputTokens?: number;
 *     timeoutMs?: number;
 *   }) => Promise<{
 *     operation: any;
 *     usage: {
 *       inputTokens?: number | null;
 *       outputTokens?: number | null;
 *       totalTokens?: number | null;
 *       estimatedInputTokens: number;
 *     };
 *     attempts: number;
 *     durationMs: number;
 *   }>;
 *   generateStructuredJson?: (request: {
 *     systemPrompt: string;
 *     prompt: string;
 *     schema: any;
 *     maxInputTokens?: number;
 *     maxOutputTokens?: number;
 *     timeoutMs?: number;
 *   }) => Promise<{
 *     json: any;
 *     usage: {
 *       inputTokens?: number | null;
 *       outputTokens?: number | null;
 *       totalTokens?: number | null;
 *       estimatedInputTokens: number;
 *     };
 *     attempts: number;
 *     durationMs: number;
 *   }>;
 * }} LlmProvider
 */
