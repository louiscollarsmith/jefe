// @ts-check

export class LlmDisabledError extends Error {
  constructor(message = "LLM is disabled.") {
    super(message);
    this.name = "LlmDisabledError";
  }
}

export class LlmInputLimitError extends Error {
  constructor(message = "LLM input token limit exceeded.") {
    super(message);
    this.name = "LlmInputLimitError";
  }
}

export class LlmProviderInputLimitError extends LlmInputLimitError {
  /**
   * @param {string} message
   * @param {{ provider?: string; model?: string; estimatedInputTokens?: number; maxInputTokens?: number }} [metadata]
   */
  constructor(message = "LLM provider input token limit exceeded.", metadata = {}) {
    super(message);
    this.name = "LlmProviderInputLimitError";
    this.provider = metadata.provider ?? null;
    this.model = metadata.model ?? null;
    this.estimatedInputTokens = metadata.estimatedInputTokens ?? null;
    this.maxInputTokens = metadata.maxInputTokens ?? null;
  }
}

export class LlmOutputValidationError extends Error {
  constructor(message = "LLM returned invalid structured output.") {
    super(message);
    this.name = "LlmOutputValidationError";
  }
}

export class LlmProviderHttpError extends Error {
  /**
   * @param {string} message
   * @param {{
   *   provider?: string;
   *   status?: number | null;
   *   code?: string | number | null;
 *   retryAfter?: string | null;
 *   rateLimitRemainingTokens?: number | null;
 *   rateLimitResetTokens?: string | null;
 *   providerMessage?: string | null;
 * }} [metadata]
 */
  constructor(message, metadata = {}) {
    super(message);
    this.name = "LlmProviderHttpError";
    this.provider = metadata.provider ?? null;
    this.status = metadata.status ?? null;
    this.code = metadata.code ?? null;
    this.retryAfter = metadata.retryAfter ?? null;
    this.rateLimitRemainingTokens =
      metadata.rateLimitRemainingTokens ?? null;
    this.rateLimitResetTokens = metadata.rateLimitResetTokens ?? null;
    this.providerMessage = metadata.providerMessage ?? null;
  }
}

/**
 * @param {string} text
 */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Classifies an error from an LLM call as a transient infrastructure failure
 * worth retrying (429 rate limit, 5xx, request timeout/abort, network reset)
 * versus a deterministic failure that will not be fixed by waiting and
 * retrying the identical request (invalid schema/output, input too large,
 * auth failure, unsupported model, malformed request). Shared by the
 * provider's own short internal retry loop and by any longer-lived retry
 * wrapper built on top of it — callers should not duplicate this list.
 *
 * Deliberately narrower than `isLlmFallbackError` in provider.server.js:
 * that function also answers "is it worth trying a *different* provider"
 * (true for 401/403/404 there — the model or credentials may work
 * elsewhere), which is a different question from "is retrying the *same*
 * call worth it" (false for 401/403/404 here — nothing changes by waiting).
 *
 * @param {unknown} error
 */
export function isRetryableLlmInfrastructureError(error) {
  if (error instanceof LlmOutputValidationError) return false;
  if (error instanceof LlmInputLimitError) return false;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  const status = Number(
    /** @type {{ status?: unknown; code?: unknown }} */ (error ?? {}).status ??
      /** @type {{ status?: unknown; code?: unknown }} */ (error ?? {}).code,
  );
  if (status === 429 || status === 498) return true;
  if (status >= 500 && status <= 599) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|network|fetch failed|ECONNRESET/i.test(message);
}
