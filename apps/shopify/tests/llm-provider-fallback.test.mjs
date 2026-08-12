import assert from "node:assert/strict";
import test from "node:test";
import {
  createLlmProvider,
  isLlmFallbackError,
  withFallbackProvider,
  withUsageRecording,
} from "../app/lib/llm/provider.server.js";
import {
  getLlmProviderHealth,
  __resetLlmProviderHealth,
} from "../app/lib/observability/llm-provider-health.server.js";
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

test("Groq body-read timeout reaches the configured fallback", async () => {
  const primary = createGroqProvider({
    config: baseConfig({ timeoutMs: 10 }),
    logger,
    fetchImpl: async (_url, options) => ({
      ok: true,
      json: () =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Request timed out.", "AbortError")),
            { once: true },
          );
        }),
    }),
  });
  const fallback = fakeProvider(
    "gemini",
    "gemini-3.5-flash-lite",
    async () => ({
      provider: "gemini",
      model: "gemini-3.5-flash-lite",
      json: { reply: "from fallback" },
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      attempts: 1,
      durationMs: 5,
    }),
  );

  const provider = withFallbackProvider(primary, fallback, logger);
  const result = await provider.generateStructuredJson({
    systemPrompt: "system",
    prompt: "merchant",
    schema: { type: "OBJECT", properties: {} },
  });

  assert.equal(result.provider, "gemini");
  assert.deepEqual(result.fallback, {
    fromProvider: "groq",
    fromModel: "openai/gpt-oss-120b",
  });
});

test("Groq Retry-After cannot postpone the configured fallback", async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const primary = createGroqProvider({
    config: baseConfig({ maxRetries: 1 }),
    logger,
    fetchImpl: async () => {
      primaryCalls += 1;
      return new Response(
        JSON.stringify({ error: { type: "rate_limit_error" } }),
        { status: 429, headers: { "retry-after": "120" } },
      );
    },
  });
  const fallback = fakeProvider(
    "gemini",
    "gemini-3.5-flash-lite",
    async () => {
      fallbackCalls += 1;
      return {
        provider: "gemini",
        model: "gemini-3.5-flash-lite",
        json: { reply: "from fallback" },
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        attempts: 1,
        durationMs: 5,
      };
    },
  );

  const startedAt = Date.now();
  const result = await withFallbackProvider(
    primary,
    fallback,
    logger,
  ).generateStructuredJson({
    systemPrompt: "system",
    prompt: "merchant",
    schema: { type: "OBJECT", properties: {} },
  });

  assert.equal(primaryCalls, 2);
  assert.equal(fallbackCalls, 1);
  assert.equal(result.provider, "gemini");
  assert.equal(result.model, "gemini-3.5-flash-lite");
  assert.deepEqual(result.fallback, {
    fromProvider: "groq",
    fromModel: "openai/gpt-oss-120b",
  });
  assert.ok(Date.now() - startedAt < 1000);
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

test("isLlmFallbackError: auth/retired/request-size/rate-limit/5xx degrade to fallback; deterministic errors do not", () => {
  const withStatus = (s) =>
    Object.assign(new Error(`request failed with HTTP ${s}.`), { status: s });
  // 401/403 (bad/expired key — the most likely real Groq outage), 404 (retired
  // model), 413 (provider request-envelope limit), 429/498
  // (rate-limit/capacity), 5xx (server) all fall back.
  for (const s of [401, 403, 404, 413, 429, 498, 500, 503]) {
    assert.equal(
      isLlmFallbackError(withStatus(s)),
      true,
      `status ${s} should fall back`,
    );
  }
  // Deterministic client-side failures do NOT fall back (a different provider
  // won't fix bad output or an oversized prompt).
  assert.equal(isLlmFallbackError(new LlmOutputValidationError()), false);
  assert.equal(isLlmFallbackError(withStatus(400)), false);
  // A network-ish failure with no status still falls back (message match).
  assert.equal(isLlmFallbackError(new Error("fetch failed")), true);
});

test("fallback bills as the fallback provider and records a durable fallback signal", async () => {
  __resetLlmProviderHealth();
  /** @type {any[]} */
  const rows = [];
  const prisma = {
    llmUsageEvent: { create: async ({ data }) => rows.push(data) },
  };
  const primary = fakeProvider("groq", "openai/gpt-oss-120b", async () => {
    // A 401 (bad/expired Groq key) — previously bypassed the fallback entirely;
    // now it degrades to Gemini instead of hard-failing with Gemini idle.
    throw Object.assign(new Error("Groq request failed with HTTP 401."), {
      status: 401,
    });
  });
  const fallback = fakeProvider("gemini", "gemini-3.1-flash-lite", async () => ({
    provider: "gemini",
    model: "gemini-3.1-flash-lite",
    json: { reply: "from fallback" },
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    attempts: 1,
    durationMs: 5,
  }));

  const composed = withUsageRecording(
    withFallbackProvider(primary, fallback, logger),
    { prisma, feature: "test", runType: "test", runId: "r1" },
  );
  const result = await composed.generateStructuredJson({});

  assert.equal(result.provider, "gemini");
  assert.deepEqual(result.fallback, {
    fromProvider: "groq",
    fromModel: "openai/gpt-oss-120b",
  });

  // The ledger row attributes the ANSWERING (fallback) provider + model — so a
  // Groq-outage day bills at the Gemini rate, not undercounted as Groq. (record
  // is fire-and-forget, so let the microtask flush.)
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, "gemini");
  assert.equal(rows[0].model, "gemini-3.1-flash-lite");
  assert.equal(rows[0].status, "ok");

  // And the transition is now a durable /health signal, not just a log line.
  assert.equal(getLlmProviderHealth().fallbacksInWindow, 1);
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
