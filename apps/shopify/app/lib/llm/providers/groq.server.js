// @ts-check

import {
  LlmInputLimitError,
  LlmOutputValidationError,
  LlmProviderHttpError,
  estimateTokens,
} from "../errors.server.js";
import { assertExternalLlmCallAllowed } from "../external-call-guard.server.js";

import { parseAndValidateStructuredOperation } from "../structured-operation-schema.server.js";

const GROQ_CHAT_COMPLETIONS_URL =
  "https://api.groq.com/openai/v1/chat/completions";
const STRUCTURED_RESPONSE_NAME = "jefe_structured_response";
const groqCoordinators = new Map();

/**
 * @param {{
 *   config: import("../config.server.js").getLlmConfig extends () => infer T ? T : never;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 *   fetchImpl?: typeof fetch;
 * }} input
 */
export function createGroqProvider(input) {
  const logger = input.logger ?? console;
  const fetchImpl = input.fetchImpl ?? fetch;
  const hasInjectedTransport = Boolean(input.fetchImpl);
  const coordinator = getGroqCoordinator(input.config.groqApiKey);

  return {
    provider: "groq",
    model: input.config.model,
    enabled: true,
    /**
     * @param {{ systemPrompt: string; prompt: string; schema: any; maxInputTokens?: number; maxOutputTokens?: number; timeoutMs?: number }} request
     */
    async generateStructuredOperation(request) {
      assertExternalLlmCallAllowed({ hasInjectedTransport });
      const result = await coordinator.run(() =>
        generateStructuredJson({
          config: input.config,
          coordinator,
          fetchImpl,
          logger,
          request,
        }),
      );
      const parsed = /** @type {any} */ (parseAndValidateStructuredOperation(
        result.json,
      ));
      if (!parsed.ok) {
        throw new LlmOutputValidationError(parsed.error);
      }

      return {
        provider: "groq",
        model: input.config.model,
        operation: parsed.operation,
        usage: result.usage,
        attempts: result.attempts,
        durationMs: result.durationMs,
      };
    },
    /**
     * @param {{ systemPrompt: string; prompt: string; schema: any; maxInputTokens?: number; maxOutputTokens?: number; timeoutMs?: number }} request
     */
    async generateStructuredJson(request) {
      assertExternalLlmCallAllowed({ hasInjectedTransport });
      return coordinator.run(() =>
        generateStructuredJson({
          config: input.config,
          coordinator,
          fetchImpl,
          logger,
          request,
        }),
      );
    },
  };
}

/**
 * @param {{
 *   config: import("../config.server.js").getLlmConfig extends () => infer T ? T : never;
 *   coordinator: ReturnType<typeof createGroqCoordinator>;
 *   fetchImpl: typeof fetch;
 *   logger: Pick<Console, "info" | "warn" | "error">;
 *   request: { systemPrompt: string; prompt: string; schema: any; maxInputTokens?: number; maxOutputTokens?: number; timeoutMs?: number };
 * }} input
 */
async function generateStructuredJson(input) {
  const startedAt = Date.now();
  const promptText = `${input.request.systemPrompt}\n\n${input.request.prompt}`;
  const estimatedInputTokens = estimateTokens(promptText);
  const maxInputTokens =
    input.request.maxInputTokens ?? input.config.maxInputTokens;
  if (estimatedInputTokens > maxInputTokens) {
    throw new LlmInputLimitError(
      `Estimated ${estimatedInputTokens} input tokens exceeds ${maxInputTokens}.`,
    );
  }

  const maxAttempts = input.config.maxRetries + 1;
  const maxOutputTokens =
    input.request.maxOutputTokens ?? input.config.maxOutputTokens;
  const estimatedRequestTokens = estimatedInputTokens + maxOutputTokens;
  let lastError = /** @type {unknown} */ (null);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    input.coordinator.assertBudgetAvailable(estimatedRequestTokens);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      input.request.timeoutMs ?? input.config.timeoutMs,
    );

    try {
      const response = await input.fetchImpl(GROQ_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${input.config.groqApiKey}`,
        },
        body: JSON.stringify({
          model: input.config.model,
          messages: [
            { role: "system", content: input.request.systemPrompt },
            { role: "user", content: input.request.prompt },
          ],
          temperature: 0,
          top_p: 0.1,
          n: 1,
          max_completion_tokens: maxOutputTokens,
          reasoning_effort: "low",
          response_format: {
            type: "json_schema",
            json_schema: {
              name: STRUCTURED_RESPONSE_NAME,
              schema: toGroqJsonSchema(input.request.schema),
            },
          },
        }),
        signal: controller.signal,
      });
      input.coordinator.observe(response.headers);

      if (!response.ok) {
        throw await buildHttpError(response);
      }

      const payload = await response.json();
      const content = extractContent(payload);
      const json = parseJson(content);
      if (json === null) {
        throw new LlmOutputValidationError("Model output must be JSON.");
      }
      clearTimeout(timeout);

      const durationMs = Date.now() - startedAt;
      const usage = {
        inputTokens: payload?.usage?.prompt_tokens ?? null,
        outputTokens: payload?.usage?.completion_tokens ?? null,
        totalTokens: payload?.usage?.total_tokens ?? null,
        estimatedInputTokens,
      };
      logUsage(input.logger, {
        status: "success",
        provider: "groq",
        model: input.config.model,
        attempts: attempt,
        durationMs,
        usage,
        maxInputTokens,
        maxOutputTokens:
          maxOutputTokens,
      });

      return {
        provider: "groq",
        model: input.config.model,
        json,
        usage,
        attempts: attempt,
        durationMs,
      };
    } catch (error) {
      lastError = error;
      // A rate limit is a provider-availability failure, not an in-request
      // retry opportunity. Return it to the composed provider immediately so
      // the configured fallback can answer without sitting behind Retry-After
      // or generating another guaranteed-to-fail Groq request.
      if (isRateLimitError(error)) {
        const durationMs = Date.now() - startedAt;
        logUsage(input.logger, {
          status: "failed",
          provider: "groq",
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
          maxOutputTokens,
          error: safeErrorName(error),
          statusCode:
            /** @type {{ status?: unknown }} */ (error ?? {}).status ?? null,
          retrySkipped: "fallback_immediate",
          ...rateLimitLogFields(error),
        });
        throw error;
      }
      if (attempt >= maxAttempts || !isRetryableError(error)) {
        const durationMs = Date.now() - startedAt;
        logUsage(input.logger, {
          status: "failed",
          provider: "groq",
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
            maxOutputTokens,
          error: safeErrorName(error),
          statusCode:
            /** @type {{ status?: unknown }} */ (error ?? {}).status ?? null,
          ...rateLimitLogFields(error),
        });
        throw error;
      }
      await wait(retryDelayMs(error, attempt));
    } finally {
      // Fetch resolves as soon as response headers arrive. Keep the deadline
      // active while the response body is consumed as well, otherwise a
      // stalled streaming body can hang forever and prevent provider fallback.
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Groq request failed.");
}

/**
 * Groq's token quota is shared by every feature using the API key. Providers
 * are short-lived, so coordination has to live at module scope rather than on
 * one provider instance. This serializes calls within a process and uses
 * Groq's own remaining/reset headers to avoid knowingly sending a request that
 * cannot fit in the current token window.
 *
 * @param {string} apiKey
 */
function getGroqCoordinator(apiKey) {
  const key = apiKey || "unconfigured";
  let coordinator = groqCoordinators.get(key);
  if (!coordinator) {
    coordinator = createGroqCoordinator();
    groqCoordinators.set(key, coordinator);
  }
  return coordinator;
}

function createGroqCoordinator() {
  let tail = Promise.resolve();
  let tokenLimit = /** @type {number | null} */ (null);
  let tokenRemaining = /** @type {number | null} */ (null);
  let tokenResetAt = /** @type {number | null} */ (null);

  return {
    /** @template T @param {() => Promise<T>} task @returns {Promise<T>} */
    async run(task) {
      const previous = tail;
      let release = /** @type {() => void} */ (() => {});
      tail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await task();
      } finally {
        release();
      }
    },

    /** @param {number} estimatedTokens */
    assertBudgetAvailable(estimatedTokens) {
      const now = Date.now();
      if (tokenResetAt !== null && tokenResetAt <= now) {
        tokenRemaining = tokenLimit;
        tokenResetAt = null;
      }
      if (
        tokenRemaining === null ||
        !Number.isFinite(estimatedTokens) ||
        estimatedTokens <= tokenRemaining
      ) {
        if (tokenRemaining !== null && Number.isFinite(estimatedTokens)) {
          tokenRemaining = Math.max(0, tokenRemaining - estimatedTokens);
        }
        return;
      }

      const waitMs = tokenResetAt === null ? 0 : tokenResetAt - now;
      if (waitMs <= 0) return;
      throw new LlmProviderHttpError(
        "Groq token budget is unavailable until the provider reset.",
        {
          provider: "groq",
          status: 429,
          code: "local_rate_limit_budget",
          retryAfter: String(Math.ceil(waitMs / 1000)),
          rateLimitRemainingTokens: tokenRemaining,
          rateLimitResetTokens: `${waitMs}ms`,
        },
      );
    },

    /** @param {Headers | undefined} headers */
    observe(headers) {
      if (!headers || typeof headers.get !== "function") return;
      const nextLimit = finiteHeaderNumber(
        headers,
        "x-ratelimit-limit-tokens",
      );
      const nextRemaining = finiteHeaderNumber(
        headers,
        "x-ratelimit-remaining-tokens",
      );
      const resetMs = parseGroqDurationMs(
        headers.get("x-ratelimit-reset-tokens"),
      );
      if (nextLimit !== null) tokenLimit = nextLimit;
      if (nextRemaining !== null) tokenRemaining = nextRemaining;
      if (resetMs !== null) tokenResetAt = Date.now() + resetMs;
    },
  };
}

/** Reset only for isolated provider tests. */
export function __resetGroqCoordinators() {
  groqCoordinators.clear();
}

/**
 * Convert the app's Gemini responseSchema objects into standard JSON Schema
 * before sending them to Groq's OpenAI-compatible structured-output endpoint.
 *
 * @param {any} schema
 * @returns {any}
 */
export function toGroqJsonSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return schema;
  }
  const normalized = /** @type {Record<string, any>} */ ({});
  const type = normalizeSchemaType(schema.type);
  if (type) normalized.type = type;
  if (Array.isArray(schema.enum)) normalized.enum = [...schema.enum];
  if (typeof schema.description === "string") {
    normalized.description = schema.description;
  }
  if (Number.isFinite(schema.minimum)) normalized.minimum = schema.minimum;
  if (Number.isFinite(schema.maximum)) normalized.maximum = schema.maximum;
  if (Array.isArray(schema.required)) {
    normalized.required = schema.required.filter(
      /** @param {unknown} item */
      (item) => typeof item === "string",
    );
  }
  if (schema.items) normalized.items = toGroqJsonSchema(schema.items);
  if (schema.properties && typeof schema.properties === "object") {
    normalized.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      normalized.properties[key] = toGroqJsonSchema(value);
    }
  }
  if (schema.additionalProperties !== undefined) {
    normalized.additionalProperties = Boolean(schema.additionalProperties);
  }
  if (schema.nullable === true && normalized.type) {
    normalized.type = Array.isArray(normalized.type)
      ? Array.from(new Set([...normalized.type, "null"]))
      : [normalized.type, "null"];
  }
  return normalized;
}

/**
 * @param {unknown} type
 * @returns {string | null}
 */
function normalizeSchemaType(type) {
  if (!type) return null;
  const value = String(type).toLowerCase();
  if (value.endsWith("object")) return "object";
  if (value.endsWith("array")) return "array";
  if (value.endsWith("string")) return "string";
  if (value.endsWith("number")) return "number";
  if (value.endsWith("integer")) return "integer";
  if (value.endsWith("boolean")) return "boolean";
  if (value.endsWith("null")) return "null";
  return value;
}

/**
 * @param {Response} response
 */
async function buildHttpError(response) {
  const retryAfter = response.headers.get("retry-after");
  const rateLimitRemainingTokens = finiteHeaderNumber(
    response.headers,
    "x-ratelimit-remaining-tokens",
  );
  const rateLimitResetTokens = response.headers.get(
    "x-ratelimit-reset-tokens",
  );
  let code = /** @type {string | number | null} */ (null);
  try {
    const payload = await response.json();
    code = payload?.error?.code ?? payload?.error?.type ?? null;
  } catch {
    // Keep provider failures sanitized; status + code are enough for routing.
  }
  return new LlmProviderHttpError(
    `Groq request failed with HTTP ${response.status}.`,
    {
      provider: "groq",
      status: response.status,
      code,
      retryAfter,
      rateLimitRemainingTokens,
      rateLimitResetTokens,
    },
  );
}

/**
 * @param {any} payload
 */
function extractContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

/**
 * @param {string} value
 */
function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
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
  if (status === 429 || status === 498) return true;
  if (status >= 500 && status <= 599) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|network|fetch failed|ECONNRESET/i.test(message);
}

/** @param {unknown} error */
function isRateLimitError(error) {
  const status = Number(
    /** @type {{ status?: unknown; code?: unknown }} */ (error ?? {}).status ??
      /** @type {{ status?: unknown; code?: unknown }} */ (error ?? {}).code,
  );
  return status === 429 || status === 498;
}

/**
 * @param {unknown} error
 * @param {number} attempt
 */
export function retryDelayMs(error, attempt) {
  const rawRetryAfter =
    /** @type {{ retryAfter?: unknown }} */ (error ?? {}).retryAfter;
  if (rawRetryAfter !== null && rawRetryAfter !== undefined && rawRetryAfter !== "") {
    const retryAfterSeconds = Number(rawRetryAfter);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
      return Math.min(Math.ceil(retryAfterSeconds * 1000), backoffMs(attempt));
    }
  }
  if (typeof rawRetryAfter === "string") {
    const retryAt = Date.parse(rawRetryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.min(Math.max(0, retryAt - Date.now()), backoffMs(attempt));
    }
  }
  return backoffMs(attempt);
}

/** @param {string | null} value */
export function parseGroqDurationMs(value) {
  if (!value || typeof value !== "string") return null;
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let matchedLength = 0;
  let total = 0;
  for (const match of value.matchAll(pattern)) {
    matchedLength += match[0].length;
    const amount = Number(match[1]);
    const unit = match[2];
    if (!Number.isFinite(amount)) return null;
    total +=
      unit === "h"
        ? amount * 3_600_000
        : unit === "m"
          ? amount * 60_000
          : unit === "s"
            ? amount * 1_000
            : amount;
  }
  return matchedLength === value.length && total >= 0 ? Math.ceil(total) : null;
}

/** @param {Headers} headers @param {string} name */
function finiteHeaderNumber(headers, name) {
  const raw = headers.get(name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** @param {unknown} error */
function rateLimitLogFields(error) {
  const typed = /** @type {{
   * code?: unknown;
   * retryAfter?: unknown;
   * rateLimitRemainingTokens?: unknown;
   * rateLimitResetTokens?: unknown;
   * }} */ (error ?? {});
  const resetTokensMs = parseGroqDurationMs(
    typeof typed.rateLimitResetTokens === "string"
      ? typed.rateLimitResetTokens
      : null,
  );
  const status = Number(
    /** @type {{ status?: unknown }} */ (error ?? {}).status,
  );
  return {
    providerReasonCode:
      typeof typed.code === "string" || typeof typed.code === "number"
        ? typed.code
        : null,
    retryAfterMs: status === 429 ? retryDelayMs(error, 1) : null,
    rateLimitRemainingTokens: Number.isFinite(
      Number(typed.rateLimitRemainingTokens),
    )
      ? Number(typed.rateLimitRemainingTokens)
      : null,
    rateLimitResetTokensMs: resetTokensMs,
  };
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
