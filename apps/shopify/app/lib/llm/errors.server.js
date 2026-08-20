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
