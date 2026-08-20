// @ts-check

// Generic OpenAI-compatible chat-completions provider. Groq, Kimi (Moonshot),
// Meta Spark and any other provider that speaks the OpenAI `/chat/completions`
// contract (json_schema structured output, Bearer auth) share this one adapter —
// parameterised by providerName + baseUrl + apiKey, so adding a provider is a
// registry entry, not a new file.
//
// NOTE: the live Groq primary still uses its own `groq.server.js` for now; this
// adapter powers the added backup providers (Kimi/Spark). Folding Groq onto this
// shared core is a safe follow-up (behaviour-preserving, gated by the Groq tests)
// deliberately not bundled here so the live primary path is untouched.

import {
  LlmInputLimitError,
  LlmOutputValidationError,
  LlmProviderHttpError,
  estimateTokens,
} from "../errors.server.js";
import { assertExternalLlmCallAllowed } from "../external-call-guard.server.js";
import { parseAndValidateStructuredOperation } from "../structured-operation-schema.server.js";

const STRUCTURED_RESPONSE_NAME = "jefe_structured_response";

/**
 * @param {{
 *   providerName: string;
 *   baseUrl: string;
 *   apiKey: string;
 *   config: any;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 *   fetchImpl?: typeof fetch;
 * }} input
 * @returns {import("../provider.server.js").LlmProvider}
 */
export function createOpenAiCompatibleProvider(input) {
  const logger = input.logger ?? console;
  const fetchImpl = input.fetchImpl ?? fetch;
  const hasInjectedTransport = Boolean(input.fetchImpl);
  const providerName = input.providerName;
  const chatUrl = `${input.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    provider: providerName,
    model: input.config.model,
    enabled: true,
    /**
     * @param {{ systemPrompt: string; prompt: string; schema: any; maxInputTokens?: number; maxOutputTokens?: number; timeoutMs?: number }} request
     */
    async generateStructuredOperation(request) {
      assertExternalLlmCallAllowed({ hasInjectedTransport });
      const result = await generateStructuredJson({
        providerName,
        chatUrl,
        apiKey: input.apiKey,
        config: input.config,
        fetchImpl,
        logger,
        request,
      });
      const parsed = /** @type {any} */ (
        parseAndValidateStructuredOperation(result.json)
      );
      if (!parsed.ok) {
        throw new LlmOutputValidationError(parsed.error);
      }
      return {
        provider: providerName,
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
      return generateStructuredJson({
        providerName,
        chatUrl,
        apiKey: input.apiKey,
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
 *   providerName: string;
 *   chatUrl: string;
 *   apiKey: string;
 *   config: any;
 *   fetchImpl: typeof fetch;
 *   logger: Pick<Console, "info" | "warn" | "error">;
 *   request: { systemPrompt: string|string[]; prompt: string; schema: any; maxInputTokens?: number; maxOutputTokens?: number; timeoutMs?: number };
 * }} input
 */
async function generateStructuredJson(input) {
  const startedAt = Date.now();
  const { providerName } = input;
  const systemPrompt = normalizePrompt(input.request.systemPrompt);
  const promptText = `${systemPrompt}\n\n${input.request.prompt}`;
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
    const timeoutMs = input.request.timeoutMs ?? input.config.timeoutMs;

    try {
      const body = {
        model: input.config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: input.request.prompt },
        ],
        store: false,
        n: 1,
        max_completion_tokens:
          input.request.maxOutputTokens ?? input.config.maxOutputTokens,
        reasoning_effort: "low",
        response_format: {
          type: "json_schema",
          json_schema: {
            name: STRUCTURED_RESPONSE_NAME,
            schema: toJsonSchema(input.request.schema),
          },
        },
      };
      if (providerName !== "openai") {
        Object.assign(body, {
          temperature: 0,
          top_p: 0.1,
        });
      }

      input.logger.info?.("LLM structured operation attempt started", {
        provider: providerName,
        model: input.config.model,
        attempt,
        timeoutMs,
        estimatedInputTokens,
        maxInputTokens,
        maxOutputTokens:
          input.request.maxOutputTokens ?? input.config.maxOutputTokens,
      });

      const response = /** @type {Response} */ (await withDeadline(
        input.fetchImpl(input.chatUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${input.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        {
          controller,
          timeoutMs,
          providerName,
          phase: "request",
          logger: input.logger,
        },
      ));
      input.logger.info?.("LLM structured operation response headers received", {
        provider: providerName,
        model: input.config.model,
        attempt,
        status: response.status,
      });

      if (!response.ok) {
        throw await buildHttpError(response, providerName, {
          controller,
          timeoutMs,
          logger: input.logger,
        });
      }

      const payload = await withDeadline(response.json(), {
        controller,
        timeoutMs,
        providerName,
        phase: "response_body",
        logger: input.logger,
      });
      input.logger.info?.("LLM structured operation response body parsed", {
        provider: providerName,
        model: input.config.model,
        attempt,
      });
      const content = extractContent(payload);
      const json = parseJson(content);
      if (json === null) {
        throw new LlmOutputValidationError("Model output must be JSON.");
      }

      const durationMs = Date.now() - startedAt;
      const usage = {
        inputTokens: payload?.usage?.prompt_tokens ?? null,
        cachedInputTokens:
          payload?.usage?.prompt_tokens_details?.cached_tokens ?? null,
        outputTokens: payload?.usage?.completion_tokens ?? null,
        totalTokens: payload?.usage?.total_tokens ?? null,
        estimatedInputTokens,
      };
      logUsage(input.logger, {
        status: "success",
        provider: providerName,
        model: input.config.model,
        attempts: attempt,
        durationMs,
        usage,
        maxInputTokens,
        maxOutputTokens:
          input.request.maxOutputTokens ?? input.config.maxOutputTokens,
      });

      return {
        provider: providerName,
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
          provider: providerName,
          model: input.config.model,
          attempts: attempt,
          durationMs,
          usage: {
            estimatedInputTokens,
            inputTokens: null,
            cachedInputTokens: null,
            outputTokens: null,
            totalTokens: null,
          },
          maxInputTokens,
          maxOutputTokens:
            input.request.maxOutputTokens ?? input.config.maxOutputTokens,
          error: safeErrorName(error),
          statusCode:
            /** @type {{ status?: unknown }} */ (error ?? {}).status ?? null,
          providerCode:
            /** @type {{ code?: unknown }} */ (error ?? {}).code ?? null,
          providerMessage:
            /** @type {{ providerMessage?: unknown }} */ (error ?? {})
              .providerMessage ?? null,
        });
        throw error;
      }
      await wait(retryDelayMs(error, attempt));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`${providerName} request failed.`);
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {{ controller: AbortController; timeoutMs: number; providerName: string; phase: string; logger: Pick<Console, "info" | "warn" | "error"> }} input
 * @returns {Promise<T>}
 */
function withDeadline(promise, input) {
  let timeout = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      input.logger.warn?.("LLM structured operation timed out", {
        provider: input.providerName,
        phase: input.phase,
        timeoutMs: input.timeoutMs,
      });
      input.controller.abort();
      reject(
        new DOMException(
          `${input.providerName} ${input.phase} timed out after ${input.timeoutMs}ms.`,
          "AbortError",
        ),
      );
    }, input.timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

/** @param {string|string[]|unknown} prompt */
function normalizePrompt(prompt) {
  if (Array.isArray(prompt)) {
    return prompt.map((part) => String(part ?? "")).join("\n");
  }
  return String(prompt ?? "");
}

/**
 * Convert the app's Gemini-style responseSchema objects into standard JSON
 * Schema for the OpenAI-compatible structured-output endpoint.
 * @param {any} schema
 * @returns {any}
 */
export function toJsonSchema(schema) {
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
  if (schema.items) normalized.items = toJsonSchema(schema.items);
  if (schema.properties && typeof schema.properties === "object") {
    normalized.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      normalized.properties[key] = toJsonSchema(value);
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

/** @param {unknown} type @returns {string | null} */
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
 * @param {string} providerName
 * @param {{ controller: AbortController; timeoutMs: number; logger: Pick<Console, "info" | "warn" | "error"> }} input
 */
async function buildHttpError(response, providerName, input) {
  const retryAfter = response.headers.get("retry-after");
  let code = /** @type {string | number | null} */ (null);
  let providerMessage = /** @type {string | null} */ (null);
  if (response.status === 429) {
    try {
      await response.body?.cancel?.();
    } catch {
      // The body is irrelevant for rate-limit routing.
    }
    return new LlmProviderHttpError(
      `${providerName} request failed with HTTP ${response.status}.`,
      {
        provider: providerName,
        status: response.status,
        code: "rate_limit",
        retryAfter,
        providerMessage: null,
      },
    );
  }
  try {
    const payload = await withDeadline(response.json(), {
      controller: input.controller,
      timeoutMs: input.timeoutMs,
      providerName,
      phase: "error_body",
      logger: input.logger,
    });
    code = payload?.error?.code ?? payload?.error?.type ?? null;
    providerMessage =
      typeof payload?.error?.message === "string"
        ? payload.error.message.slice(0, 500)
        : null;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    // Keep provider failures sanitized; status + code are enough for routing.
  }
  return new LlmProviderHttpError(
    `${providerName} request failed with HTTP ${response.status}.`,
    {
      provider: providerName,
      status: response.status,
      code,
      retryAfter,
      providerMessage,
    },
  );
}

/** @param {any} payload */
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

/** @param {string} value */
function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** @param {unknown} error */
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

/** @param {unknown} error @param {number} attempt */
function retryDelayMs(error, attempt) {
  const retryAfter = Number(
    /** @type {{ retryAfter?: unknown }} */ (error ?? {}).retryAfter,
  );
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  return 250 * attempt;
}

/** @param {number} ms */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {Pick<Console, "info" | "warn" | "error">} logger @param {Record<string, unknown>} payload */
function logUsage(logger, payload) {
  const method = payload.status === "success" ? "info" : "warn";
  logger[method]("LLM structured operation request", payload);
}

/** @param {unknown} error */
function safeErrorName(error) {
  return error instanceof Error ? error.name : "UnknownError";
}
