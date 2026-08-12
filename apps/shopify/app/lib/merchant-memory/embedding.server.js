// @ts-check

import { GoogleGenAI } from "@google/genai";
import { getEpisodicEmbeddingConfig } from "../llm/config.server.js";
import { recordLlmUsage } from "../llm/usage-recorder.server.js";
import { logger as baseLogger } from "../observability/logger.server.js";
import {
  recordEmbeddingFailure,
  recordEmbeddingSuccess,
} from "../observability/embedding-health.server.js";

const log = baseLogger.child({ component: "merchant-memory-embedding" });

/**
 * @param {string} text
 * @param {{ taskType?: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY"; config?: ReturnType<typeof getEpisodicEmbeddingConfig>; client?: GoogleGenAI; prisma?: any; merchantId?: string | null; shopId?: string | null }} [input]
 */
export async function embedMerchantMemoryText(text, input = {}) {
  const config = input.config ?? getEpisodicEmbeddingConfig();
  if (!config.enabled || !text.trim()) return null;
  const client =
    input.client ??
    new GoogleGenAI({
      apiKey: config.apiKey,
      httpOptions: { timeout: config.timeoutMs, retryOptions: { attempts: 1 } },
    });
  const startedAt = Date.now();
  try {
    const response = await client.models.embedContent({
      model: config.model,
      contents: text,
      config: {
        taskType: input.taskType ?? "RETRIEVAL_DOCUMENT",
        outputDimensionality: config.dimensions,
      },
    });
    const values = response.embeddings?.[0]?.values;
    if (!Array.isArray(values) || values.length !== config.dimensions) {
      throw new Error("embedding_dimension_mismatch");
    }
    recordEmbeddingSuccess();
    if (input.prisma) {
      void recordLlmUsage(input.prisma, {
        merchantId: input.merchantId ?? null,
        shopId: input.shopId ?? null,
        feature: "episodic_embedding",
        provider: "gemini",
        model: config.model,
        usage: {
          inputTokens: Math.ceil(text.length / 4),
          outputTokens: 0,
          totalTokens: Math.ceil(text.length / 4),
        },
        latencyMs: Date.now() - startedAt,
        status: "ok",
      });
    }
    return { values, model: config.model, dimensions: config.dimensions };
  } catch (error) {
    const code = safeEmbeddingErrorCode(error);
    recordEmbeddingFailure(code);
    log.warn("Episodic embedding failed; lexical retrieval remains available", {
      error: error instanceof Error ? error.name : "UnknownError",
      code,
      model: config.model,
      textLength: text.length,
    });
    if (input.prisma) {
      void recordLlmUsage(input.prisma, {
        merchantId: input.merchantId ?? null,
        shopId: input.shopId ?? null,
        feature: "episodic_embedding",
        provider: "gemini",
        model: config.model,
        usage: null,
        latencyMs: Date.now() - startedAt,
        status: "error",
      });
    }
    return {
      errorCode: code,
      model: config.model,
      dimensions: config.dimensions,
    };
  }
}

/** @param {unknown} error */
function safeEmbeddingErrorCode(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/dimension/i.test(message)) return "dimension_mismatch";
  if (/timeout|abort/i.test(message)) return "timeout";
  const status = Number(/** @type {any} */ (error)?.status ?? 0);
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "authentication";
  if (status >= 500) return "provider_unavailable";
  return "provider_error";
}
