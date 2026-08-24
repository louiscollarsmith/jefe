// @ts-check

// In-place recovery for a single LLM invocation inside recommendation generation.
//
// The provider layer (openai-compatible.server.js) already retries a call
// internally, but that loop exists to absorb sub-second blips: with
// LLM_MAX_RETRIES=1 it is one extra attempt with ~250-500ms backoff (or the
// provider's own Retry-After, if shorter than the layer above deems useful).
// A real TPM-window rate limit does not clear in 500ms, so that budget is
// exhausted and the error escapes to the caller — which, before this module
// existed, meant `runCandidateDrivenRecommendation` threw, the whole
// candidate-driven pipeline was abandoned mid-flight (discovery, investigated
// candidates, live Shopify reads, rescue discovery — all discarded), the run
// was marked failed, and the BackfillJob worker restarted the entire pipeline
// from DISCOVER_CANDIDATES on its next attempt. Confirmed live: run
// 29bfa119-18b8-4d6c-8193-9a0f53f6b892 reached rescue-candidate investigation
// with real Shopify reads three separate times, losing that work each time to
// the same HTTP 429.
//
// This module sits between the candidate pipeline and each individual
// `provider.generateStructuredJson(...)` call: on a retryable infrastructure
// error it waits (honouring Retry-After where the provider supplies it) and
// replays the exact same closure — same prompt, same schema, same candidate/
// turn state, nothing upstream re-derived — for a much longer, recommendation-
// specific budget. Deterministic errors (schema/validation, input-too-large,
// auth, unsupported model) are not retried here; they propagate immediately
// to their existing failure/repair paths, unchanged.

import { isRetryableLlmInfrastructureError } from "../../llm/errors.server.js";
import { logger as baseLogger } from "../../observability/logger.server.js";

const log = baseLogger.child({ component: "agentic-recommendation-llm-retry" });

// Recommendation generation is infrequent and high-value: a merchant waiting
// an extra 30-120s beats seeing "I couldn't safely turn the store evidence
// into a recommendation" over a transient provider throttling window (Part 5
// of the task brief this implements). Bounded per invocation, not per run —
// a run with several candidates may pay this budget more than once, but each
// individual LLM step cannot hang the worker indefinitely.
export const RECOMMENDATION_LLM_RETRY_MAX_ATTEMPTS = 6;
export const RECOMMENDATION_LLM_RETRY_MAX_CUMULATIVE_WAIT_MS = 5 * 60_000;

// Illustrative bounded backoff (~15s / 30s / 60s / 60s / 60s) used only when the
// provider does not supply a Retry-After. Deliberately far longer than the
// provider's own 250ms*attempt backoff — that one is sized for blips, this one
// is sized to let a TPM window actually clear.
const FALLBACK_DELAYS_MS = [15_000, 30_000, 60_000, 60_000, 60_000];
const MAX_SINGLE_DELAY_MS = 90_000;
const JITTER_RATIO = 0.2;

export const RECOMMENDATION_LLM_RETRY_EVENT = Object.freeze({
  retryableError: "recommendation_llm_retryable_error",
  backoffStarted: "recommendation_llm_backoff_started",
  retryAttempt: "recommendation_llm_retry_attempt",
  recovered: "recommendation_llm_recovered",
  retryExhausted: "recommendation_llm_retry_exhausted",
});

/**
 * Parses an HTTP Retry-After header value, which per RFC 9110 is either a
 * non-negative integer number of delay-seconds or an HTTP-date.
 * @param {string | null | undefined} retryAfter
 * @returns {number | null} delay in milliseconds, or null if unparseable
 */
export function parseRetryAfterMs(retryAfter) {
  if (retryAfter == null || retryAfter === "") return null;
  const asSeconds = Number(retryAfter);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds * 1000;
  const asDateMs = Date.parse(String(retryAfter));
  if (Number.isFinite(asDateMs)) return Math.max(0, asDateMs - Date.now());
  return null;
}

/** @param {number} ms */
function withJitter(ms) {
  const spread = ms * JITTER_RATIO;
  return Math.max(0, Math.round(ms - spread + Math.random() * spread * 2));
}

/** @param {unknown} error @param {number} attempt */
function delayForAttempt(error, attempt) {
  const fromHeader = parseRetryAfterMs(/** @type {{ retryAfter?: string | null }} */ (error)?.retryAfter);
  if (fromHeader != null) return Math.min(MAX_SINGLE_DELAY_MS, withJitter(fromHeader));
  const base = FALLBACK_DELAYS_MS[Math.min(attempt - 1, FALLBACK_DELAYS_MS.length - 1)];
  return Math.min(MAX_SINGLE_DELAY_MS, withJitter(base));
}

/** @param {number} ms */
function defaultWait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps one logical LLM invocation with a long, generous in-place retry
 * budget for transient provider/infrastructure failures. On a retryable
 * error, waits and re-invokes the exact same closure — it never re-derives
 * candidate discovery, the candidate queue, capability binding, or Shopify
 * reads; the caller's closure captures only the one call being retried.
 *
 * @template T
 * @param {() => Promise<T>} invoke
 * @param {{
 *   runId?: string | null;
 *   phase: string;
 *   candidateId?: string | null;
 *   provider?: string | null;
 *   model?: string | null;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 *   maxAttempts?: number;
 *   maxCumulativeWaitMs?: number;
 *   waitImpl?: (ms: number) => Promise<void>;
 * }} context
 * @returns {Promise<T>}
 */
export async function withRecommendationLlmRetry(invoke, context) {
  const logger = context.logger ?? log;
  const maxAttempts = context.maxAttempts ?? RECOMMENDATION_LLM_RETRY_MAX_ATTEMPTS;
  const maxCumulativeWaitMs = context.maxCumulativeWaitMs ?? RECOMMENDATION_LLM_RETRY_MAX_CUMULATIVE_WAIT_MS;
  const waitImpl = context.waitImpl ?? defaultWait;
  const baseLog = {
    runId: context.runId ?? null,
    phase: context.phase,
    candidateId: context.candidateId ?? null,
    provider: context.provider ?? null,
    model: context.model ?? null,
  };
  let cumulativeWaitMs = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await invoke();
      if (attempt > 1) {
        logger.info(RECOMMENDATION_LLM_RETRY_EVENT.recovered, { ...baseLog, attempt, cumulativeWaitMs });
      }
      return result;
    } catch (error) {
      if (!isRetryableLlmInfrastructureError(error)) throw error;
      const statusCode = /** @type {{ status?: unknown }} */ (error)?.status ?? null;
      const errorName = error instanceof Error ? error.name : "UnknownError";
      logger.warn(RECOMMENDATION_LLM_RETRY_EVENT.retryableError, {
        ...baseLog,
        attempt,
        statusCode,
        errorName,
      });

      const delayMs = delayForAttempt(error, attempt);
      const wouldExceedBudget = cumulativeWaitMs + delayMs > maxCumulativeWaitMs;
      if (attempt >= maxAttempts || wouldExceedBudget) {
        logger.error(RECOMMENDATION_LLM_RETRY_EVENT.retryExhausted, {
          ...baseLog,
          attempts: attempt,
          cumulativeWaitMs,
          statusCode,
          errorName,
          reason: wouldExceedBudget ? "cumulative_budget_exceeded" : "max_attempts_exceeded",
        });
        throw error;
      }

      cumulativeWaitMs += delayMs;
      logger.warn(RECOMMENDATION_LLM_RETRY_EVENT.backoffStarted, {
        ...baseLog,
        attempt,
        delayMs,
        cumulativeWaitMs,
        statusCode,
      });
      await waitImpl(delayMs);
      logger.info(RECOMMENDATION_LLM_RETRY_EVENT.retryAttempt, {
        ...baseLog,
        attempt: attempt + 1,
        cumulativeWaitMs,
      });
    }
  }
  // Unreachable: the loop always returns or throws before exhausting maxAttempts iterations.
  throw new Error("Recommendation LLM retry loop exited unexpectedly.");
}
