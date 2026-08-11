import assert from "node:assert/strict";
import test from "node:test";
import {
  createLlmProvider,
  isLlmFallbackError,
  withFallbackProvider,
} from "../app/lib/llm/provider.server.js";
import {
  createGroqProvider,
  toGroqJsonSchema,
} from "../app/lib/llm/providers/groq.server.js";
import {
  LlmOutputValidationError,
  LlmProviderHttpError,
} from "../app/lib/llm/errors.server.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

function baseConfig(overrides = {}) {
  return {
    enabled: true,
    provider: "groq",
    model: "openai/gpt-oss-120b",
    fallbackProvider: "gemini",
    fallbackModel: "gemini-3.5-flash-lite",
    groqApiKey: "groq-test-key",
    geminiApiKey: "gemini-test-key",
    timeoutMs: 1000,
    maxInputTokens: 6000,
    maxOutputTokens: 900,
    maxRetries: 0,
    ...overrides,
  };
}

test("createLlmProvider defaults to Groq with Gemini fallback configured", () => {
  const provider = createLlmProvider({ config: baseConfig(), logger });
  assert.equal(provider.provider, "groq");
  assert.equal(provider.model, "openai/gpt-oss-120b");
  assert.equal(provider.fallbackProvider, "gemini");
  assert.equal(provider.fallbackModel, "gemini-3.5-flash-lite");
});

test("createLlmProvider uses Gemini fallback when Groq key is absent", () => {
  const provider = createLlmProvider({
    config: baseConfig({ groqApiKey: "" }),
    logger,
  });
  assert.equal(provider.provider, "gemini");
  assert.equal(provider.model, "gemini-3.5-flash-lite");
});

test("Groq provider sends JSON schema requests and maps usage", async () => {
  let captured = null;
  const provider = createGroqProvider({
    config: baseConfig(),
    logger,
    fetchImpl: async (url, options) => {
      captured = {
        url,
        body: JSON.parse(String(options.body)),
        authorization: options.headers.Authorization,
      };
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ reply: "ok" }) } }],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 4,
            total_tokens: 16,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const result = await provider.generateStructuredJson({
    systemPrompt: "system",
    prompt: "merchant",
    schema: {
      type: "OBJECT",
      required: ["reply"],
      properties: {
        reply: { type: "STRING" },
        confidence: { type: "NUMBER", nullable: true },
      },
    },
  });

  assert.equal(result.provider, "groq");
  assert.equal(result.model, "openai/gpt-oss-120b");
  assert.deepEqual(result.json, { reply: "ok" });
  assert.deepEqual(result.usage, {
    inputTokens: 12,
    outputTokens: 4,
    totalTokens: 16,
    estimatedInputTokens: 4,
  });
  assert.equal(captured.url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(captured.authorization, "Bearer groq-test-key");
  assert.equal(captured.body.model, "openai/gpt-oss-120b");
  assert.equal(captured.body.reasoning_effort, "low");
  assert.equal(captured.body.response_format.type, "json_schema");
  assert.deepEqual(
    captured.body.response_format.json_schema.schema.properties.confidence.type,
    ["number", "null"],
  );
});

test("Groq provider surfaces sanitized rate-limit errors", async () => {
  const provider = createGroqProvider({
    config: baseConfig(),
    logger,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ error: { type: "rate_limit_error" } }),
        { status: 429, headers: { "retry-after": "2" } },
      ),
  });

  await assert.rejects(
    provider.generateStructuredJson({
      systemPrompt: "system",
      prompt: "merchant",
      schema: { type: "OBJECT", properties: {} },
    }),
    (error) => {
      assert.equal(error instanceof LlmProviderHttpError, true);
      assert.equal(error.status, 429);
      assert.equal(error.provider, "groq");
      assert.equal(error.retryAfter, "2");
      assert.match(error.message, /HTTP 429/);
      return true;
    },
  );
});

test("withFallbackProvider falls back on rate limits and preserves final model", async () => {
  const primary = fakeProvider("groq", "openai/gpt-oss-120b", async () => {
    const error = new Error("rate limit reached");
    error.status = 429;
    throw error;
  });
  const fallback = fakeProvider("gemini", "gemini-3.5-flash-lite", async () => ({
    provider: "gemini",
    model: "gemini-3.5-flash-lite",
    json: { reply: "from fallback" },
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    attempts: 1,
    durationMs: 10,
  }));

  const provider = withFallbackProvider(primary, fallback, logger);
  const result = await provider.generateStructuredJson({});
  assert.equal(result.provider, "gemini");
  assert.equal(result.model, "gemini-3.5-flash-lite");
  assert.deepEqual(result.json, { reply: "from fallback" });
  assert.deepEqual(result.fallback, {
    fromProvider: "groq",
    fromModel: "openai/gpt-oss-120b",
  });
});

test("withFallbackProvider does not hide structured-output validation errors", async () => {
  const primary = fakeProvider("groq", "openai/gpt-oss-120b", async () => {
    throw new LlmOutputValidationError("bad json");
  });
  const fallback = fakeProvider("gemini", "gemini-3.5-flash-lite", async () => {
    throw new Error("should not call fallback");
  });

  const provider = withFallbackProvider(primary, fallback, logger);
  await assert.rejects(
    provider.generateStructuredJson({}),
    LlmOutputValidationError,
  );
});

test("isLlmFallbackError recognises capacity failures only", () => {
  const capacity = new Error("capacity exceeded");
  capacity.status = 498;
  assert.equal(isLlmFallbackError(capacity), true);
  assert.equal(isLlmFallbackError(new LlmOutputValidationError()), false);
});

test("toGroqJsonSchema converts Gemini-style nullable types", () => {
  assert.deepEqual(
    toGroqJsonSchema({
      type: "OBJECT",
      properties: {
        value: { type: "NUMBER", nullable: true, minimum: 0, maximum: 1 },
      },
    }),
    {
      type: "object",
      properties: {
        value: { type: ["number", "null"], minimum: 0, maximum: 1 },
      },
    },
  );
});

function fakeProvider(provider, model, generateStructuredJson) {
  return {
    provider,
    model,
    enabled: true,
    generateStructuredOperation: generateStructuredJson,
    generateStructuredJson,
  };
}
