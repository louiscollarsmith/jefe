// @ts-check

import {
  LlmInputLimitError,
  LlmOutputValidationError,
  LlmProviderHttpError,
  estimateTokens,
} from "../errors.server.js";
import { parseAndValidateStructuredOperation } from "../structured-operation-schema.server.js";

const GROQ_CHAT_COMPLETIONS_URL =
  "https://api.groq.com/openai/v1/chat/completions";
const STRUCTURED_RESPONSE_NAME = "jefe_structured_response";

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

  return {
    provider: "groq",
    model: input.config.model,
    enabled: true,
    /**
     * @param {{ systemPrompt: string; prompt: string; schema: any; maxInputTokens?: number; maxOutputTokens?: number; timeoutMs?: number }} request
     */
    async generateStructuredOperation(request) {
      const result = await generateStructuredJson({
        config: input.config,
        fetchImpl,
        logger,
        request,
      });
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
      return generateStructuredJson({
        config: input.config,
        fetchImpl,
        logger,
        request,
      });
    },
  };
}

/**
 * @param {{
 *   config: import("../config.server.js").getLlmConfig extends () => infer T ? T : never;
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
  let lastError = /** @type {unknown} */ (null);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
          max_completion_tokens:
            input.request.maxOutputTokens ?? input.config.maxOutputTokens,
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

      if (!response.ok) {
        throw await buildHttpError(response);
      }

      const payload = await response.json();
      const content = extractContent(payload);
      const json = parseJson(content);
      if (json === null) {
        throw new LlmOutputValidationError("Model output must be JSON.");
      }

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
          input.request.maxOutputTokens ?? input.config.maxOutputTokens,
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
            input.request.maxOutputTokens ?? input.config.maxOutputTokens,
          error: safeErrorName(error),
          statusCode:
            /** @type {{ status?: unknown }} */ (error ?? {}).status ?? null,
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

/**
 * @param {unknown} error
 * @param {number} attempt
 */
function retryDelayMs(error, attempt) {
  const retryAfter = Number(
    /** @type {{ retryAfter?: unknown }} */ (error ?? {}).retryAfter,
  );
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return retryAfter * 1000;
  }
  return backoffMs(attempt);
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
