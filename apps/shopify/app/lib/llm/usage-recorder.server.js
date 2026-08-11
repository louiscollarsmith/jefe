// @ts-check

import { priceUsd } from "./pricing.server.js";
import { logger as baseLogger } from "../observability/logger.server.js";

/**
 * The LLM cost ledger writer. Records one `LlmUsageEvent` per model call so we
 * can answer "what does each merchant cost us" and compute margin. Best-effort
 * and never throws — recording a cost event must never break the generation it
 * describes.
 */

const log = baseLogger.child({ component: "llm-usage" });

/**
 * @typedef {object} LlmUsage
 * @property {number|null} [inputTokens]
 * @property {number|null} [outputTokens]
 * @property {number|null} [totalTokens]
 * @property {number} [estimatedInputTokens]
 */

/**
 * @param {{ llmUsageEvent: { create: (args: any) => Promise<unknown> } }} prisma
 * @param {{
 *   merchantId?: string | null;
 *   shopId?: string | null;
 *   feature: string;
 *   runType?: string | null;
 *   runId?: string | null;
 *   provider?: string | null;
 *   model: string;
 *   usage?: LlmUsage | null;
 *   latencyMs?: number | null;
 *   status?: string;
 * }} input
 * @returns {Promise<boolean>}
 */
export async function recordLlmUsage(prisma, input) {
  try {
    const usage = input.usage ?? {};
    const inputTokens = usage.inputTokens ?? usage.estimatedInputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const totalTokens = usage.totalTokens ?? inputTokens + outputTokens;

    await prisma.llmUsageEvent.create({
      data: {
        merchantId: input.merchantId ?? null,
        shopId: input.shopId ?? null,
        feature: input.feature,
        runType: input.runType ?? null,
        runId: input.runId ?? null,
        provider: input.provider || "gemini",
        model: input.model,
        inputTokens: Math.max(0, Math.round(inputTokens) || 0),
        outputTokens: Math.max(0, Math.round(outputTokens) || 0),
        totalTokens: Math.max(0, Math.round(totalTokens) || 0),
        costUsd: priceUsd(input.model, inputTokens, outputTokens),
        latencyMs: input.latencyMs != null ? Math.round(input.latencyMs) : null,
        status: input.status ?? "ok",
      },
    });
    return true;
  } catch (error) {
    log.warn("Failed to record LLM usage event", {
      err: error,
      feature: input.feature,
    });
    return false;
  }
}
