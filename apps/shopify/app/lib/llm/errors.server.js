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

export class LlmOutputValidationError extends Error {
  constructor(message = "LLM returned invalid structured output.") {
    super(message);
    this.name = "LlmOutputValidationError";
  }
}

/**
 * @param {string} text
 */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}
