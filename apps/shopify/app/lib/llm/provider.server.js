// @ts-check

import { getLlmConfig } from "./config.server.js";
import { LlmDisabledError } from "./errors.server.js";
import { createGeminiProvider } from "./providers/gemini.server.js";

/**
 * @param {{ config?: ReturnType<typeof getLlmConfig>; logger?: Pick<Console, "info" | "warn" | "error"> }} [input]
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
  return createGeminiProvider({ config, logger: input.logger });
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
 * }} LlmProvider
 */
