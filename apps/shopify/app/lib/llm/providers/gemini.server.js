// @ts-check

import { GoogleGenAI } from "@google/genai";
import {
  LlmInputLimitError,
  LlmOutputValidationError,
  estimateTokens,
} from "../errors.server.js";
import { parseAndValidateStructuredOperation } from "../structured-operation-schema.server.js";

/**
 * @param {{ config: import("../config.server.js").getLlmConfig extends () => infer T ? T : never; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export function createGeminiProvider(input) {
  const logger = input.logger ?? console;
  const client = new GoogleGenAI({ apiKey: input.config.geminiApiKey });

  return {
    provider: "gemini",
    model: input.config.model,
    enabled: true,
    /**
     * @param {{ systemPrompt: string; prompt: string; schema: any; maxInputTokens?: number; maxOutputTokens?: number; timeoutMs?: number }} request
     */
    async generateStructuredOperation(request) {
      const startedAt = Date.now();
      const promptText = `${request.systemPrompt}\n\n${request.prompt}`;
      const estimatedInputTokens = estimateTokens(promptText);
      const maxInputTokens =
        request.maxInputTokens ?? input.config.maxInputTokens;
      if (estimatedInputTokens > maxInputTokens) {
        throw new LlmInputLimitError(
          `Estimated ${estimatedInputTokens} input tokens exceeds ${maxInputTokens}.`,
        );
      }

      const maxAttempts = input.config.maxRetries + 1;
      let lastError = /** @type {unknown} */ (null);

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          request.timeoutMs ?? input.config.timeoutMs,
        );

        try {
          const response = await client.models.generateContent({
            model: input.config.model,
            contents: request.prompt,
            config: {
              systemInstruction: request.systemPrompt,
              temperature: 0,
              topP: 0.1,
              candidateCount: 1,
              maxOutputTokens:
                request.maxOutputTokens ?? input.config.maxOutputTokens,
              responseMimeType: "application/json",
              responseSchema: request.schema,
              abortSignal: controller.signal,
            },
          });
          clearTimeout(timeout);

          const parsed = /** @type {any} */ (parseAndValidateStructuredOperation(
            response.text ?? "",
          ));
          if (!parsed.ok) {
            throw new LlmOutputValidationError(parsed.error);
          }

          const durationMs = Date.now() - startedAt;
          const usage = {
            inputTokens: response.usageMetadata?.promptTokenCount ?? null,
            outputTokens: response.usageMetadata?.candidatesTokenCount ?? null,
            totalTokens: response.usageMetadata?.totalTokenCount ?? null,
            estimatedInputTokens,
          };
          logUsage(logger, {
            status: "success",
            provider: "gemini",
            model: input.config.model,
            attempts: attempt,
            durationMs,
            usage,
            maxInputTokens,
            maxOutputTokens:
              request.maxOutputTokens ?? input.config.maxOutputTokens,
          });

          return {
            operation: parsed.operation,
            usage,
            attempts: attempt,
            durationMs,
          };
        } catch (error) {
          clearTimeout(timeout);
          lastError = error;
          if (attempt >= maxAttempts || !isRetryableError(error)) {
            const durationMs = Date.now() - startedAt;
            logUsage(logger, {
              status: "failed",
              provider: "gemini",
              model: input.config.model,
              attempts: attempt,
              durationMs,
              usage: {
                estimatedInputTokens,
                inputTokens: null,
                outputTokens: null,
                totalTokens: null,
              },
              maxInputTokens,
              maxOutputTokens:
                request.maxOutputTokens ?? input.config.maxOutputTokens,
              error: safeErrorName(error),
            });
            throw error;
          }
          await wait(backoffMs(attempt));
        }
      }

      throw lastError instanceof Error
        ? lastError
        : new Error("Gemini request failed.");
    },
  };
}

/**
 * @param {unknown} error
 */
function isRetryableError(error) {
  if (error instanceof LlmOutputValidationError) return false;
  if (error instanceof LlmInputLimitError) return false;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  const status = Number(
    /** @type {{ status?: unknown; code?: unknown }} */ (error ?? {}).status ??
      /** @type {{ status?: unknown; code?: unknown }} */ (error ?? {}).code,
  );
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|network|fetch failed|ECONNRESET/i.test(message);
}

/**
 * @param {number} attempt
 */
function backoffMs(attempt) {
  return 250 * attempt;
}

/**
 * @param {number} ms
 */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {Pick<Console, "info" | "warn" | "error">} logger
 * @param {Record<string, unknown>} payload
 */
function logUsage(logger, payload) {
  const method = payload.status === "success" ? "info" : "warn";
  logger[method]("LLM structured operation request", payload);
}

/**
 * @param {unknown} error
 */
function safeErrorName(error) {
  return error instanceof Error ? error.name : "UnknownError";
}
