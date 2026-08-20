// @ts-check

import { createOpenAiCompatibleProvider } from "./openai-compatible.server.js";

/**
 * First-class OpenAI text provider for Jefe's LLM abstraction. It deliberately
 * reuses the OpenAI-compatible structured-output implementation so feature code
 * keeps asking for an LLM by slice/feature, not by vendor SDK.
 *
 * @param {{
 *   config: any;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 *   fetchImpl?: typeof fetch;
 * }} input
 * @returns {import("../provider.server.js").LlmProvider}
 */
export function createOpenAiProvider(input) {
  return createOpenAiCompatibleProvider({
    providerName: "openai",
    baseUrl: input.config.openAiBaseUrl || "https://api.openai.com/v1",
    apiKey: input.config.openAiApiKey,
    config: input.config,
    logger: input.logger,
    fetchImpl: input.fetchImpl,
  });
}
