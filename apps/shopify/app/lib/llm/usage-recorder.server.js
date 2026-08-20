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
 * @property {number|null} [cachedInputTokens]
 * @property {number|null} [outputTokens]
 * @property {number|null} [totalTokens]
 * @property {number} [estimatedInputTokens]
 */

/**
 * @typedef {object} LlmUsagePrisma
 * @property {{
 *   create?: (args: any) => Promise<unknown>;
 *   update?: (args: any) => Promise<unknown>;
 * }} llmUsageEvent
 */

/**
 * @param {LlmUsagePrisma & { llmUsageEvent: { create: (args: any) => Promise<unknown> } }} prisma
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
    await prisma.llmUsageEvent.create({
      data: llmUsageData(input),
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

/**
 * Record a visible in-flight attempt before the provider call starts. A row
 * left in `started` means the process died or the call hung before completion.
 *
 * @param {LlmUsagePrisma & { llmUsageEvent: { create: (args: any) => Promise<unknown> } }} prisma
 * @param {Parameters<typeof recordLlmUsage>[1]} input
 * @returns {Promise<string | null>}
 */
export async function startLlmUsageAttempt(prisma, input) {
  try {
    const row = await prisma.llmUsageEvent.create({
      data: llmUsageData({ ...input, usage: null, latencyMs: null, status: "started" }),
    });
    return typeof /** @type {any} */ (row)?.id === "string"
      ? /** @type {any} */ (row).id
      : null;
  } catch (error) {
    log.warn("Failed to record LLM usage attempt start", {
      err: error,
      feature: input.feature,
    });
    return null;
  }
}

/**
 * @param {LlmUsagePrisma} prisma
 * @param {string | null} id
 * @param {Parameters<typeof recordLlmUsage>[1]} input
 * @returns {Promise<boolean>}
 */
export async function finishLlmUsageAttempt(prisma, id, input) {
  if (!id || typeof prisma.llmUsageEvent?.update !== "function") {
    return typeof prisma.llmUsageEvent?.create === "function"
      ? recordLlmUsage(
          /** @type {LlmUsagePrisma & { llmUsageEvent: { create: (args: any) => Promise<unknown> } }} */ (prisma),
          input,
        )
      : false;
  }
  try {
    await prisma.llmUsageEvent.update({
      where: { id },
      data: llmUsageData(input),
    });
    return true;
  } catch (error) {
    log.warn("Failed to finish LLM usage attempt", {
      err: error,
      feature: input.feature,
    });
    return false;
  }
}

/**
 * @param {Parameters<typeof recordLlmUsage>[1]} input
 */
function llmUsageData(input) {
  const usage = input.usage ?? {};
  const inputTokens = usage.inputTokens ?? usage.estimatedInputTokens ?? 0;
  const cachedInputTokens = Math.min(
    Math.max(0, usage.cachedInputTokens ?? 0),
    Math.max(0, inputTokens),
  );
  const outputTokens = usage.outputTokens ?? 0;
  const totalTokens = usage.totalTokens ?? inputTokens + outputTokens;

  return {
    merchantId: input.merchantId ?? null,
    shopId: input.shopId ?? null,
    feature: input.feature,
    runType: input.runType ?? null,
    runId: input.runId ?? null,
    provider: input.provider || "gemini",
    model: input.model,
    inputTokens: Math.max(0, Math.round(inputTokens) || 0),
    cachedInputTokens: Math.max(0, Math.round(cachedInputTokens) || 0),
    outputTokens: Math.max(0, Math.round(outputTokens) || 0),
    totalTokens: Math.max(0, Math.round(totalTokens) || 0),
    costUsd: priceUsd(
      input.model,
      inputTokens,
      outputTokens,
      cachedInputTokens,
    ),
    latencyMs: input.latencyMs != null ? Math.round(input.latencyMs) : null,
    status: input.status ?? "ok",
  };
}
