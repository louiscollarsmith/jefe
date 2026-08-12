import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
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
  __resetGroqCoordinators,
  parseGroqDurationMs,
  retryDelayMs,
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

beforeEach(() => {
  __resetGroqCoordinators();
});

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
        {
          status: 429,
          headers: {
            "retry-after": "2",
            "x-ratelimit-remaining-tokens": "0",
            "x-ratelimit-reset-tokens": "2s",
          },
        },
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
      assert.equal(error.rateLimitRemainingTokens, 0);
      assert.equal(error.rateLimitResetTokens, "2s");
      assert.match(error.message, /HTTP 429/);
      return true;
    },
  );
});

test("Groq parses provider rate-limit timing for diagnostics", () => {
  assert.equal(retryDelayMs({ retryAfter: "2" }, 1), 2_000);
  assert.equal(retryDelayMs({ retryAfter: "42.5" }, 1), 42_500);
  assert.equal(retryDelayMs({ retryAfter: "600" }, 1), 600_000);
  assert.equal(retryDelayMs({}, 2), 500);
  assert.equal(parseGroqDurationMs("644ms"), 644);
  assert.equal(parseGroqDurationMs("1m26.4s"), 86_400);
  assert.equal(parseGroqDurationMs("bad"), null);
});

test("Groq serializes concurrent calls sharing an API key", async () => {
  let calls = 0;
  let releaseFirst = () => {};
  const firstMayFinish = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const provider = createGroqProvider({
    config: baseConfig(),
    logger,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) await firstMayFinish;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ reply: "ok" }) } }],
          usage: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const request = {
    systemPrompt: "system",
    prompt: "merchant",
    schema: { type: "OBJECT", properties: { reply: { type: "STRING" } } },
  };

  const first = provider.generateStructuredJson(request);
  const second = provider.generateStructuredJson(request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(calls, 2);
});

test("Groq 429 immediately uses Gemini and suppresses further Groq calls until reset", async () => {
  let groqCalls = 0;
  let fallbackCalls = 0;
  const primary = createGroqProvider({
    config: baseConfig({ maxRetries: 1 }),
    logger,
    fetchImpl: async () => {
      groqCalls += 1;
      return new Response(
        JSON.stringify({ error: { type: "rate_limit_exceeded" } }),
        {
          status: 429,
          headers: {
            "retry-after": "600",
            "x-ratelimit-limit-tokens": "8000",
            "x-ratelimit-remaining-tokens": "0",
            "x-ratelimit-reset-tokens": "10m",
          },
        },
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
        durationMs: 1,
      };
    },
  );
  const provider = withFallbackProvider(primary, fallback, logger);
  const request = {
    systemPrompt: "system",
    prompt: "merchant",
    schema: { type: "OBJECT", properties: { reply: { type: "STRING" } } },
  };

  const startedAt = Date.now();
  const first = await provider.generateStructuredJson(request);
  const second = await provider.generateStructuredJson(request);

  assert.equal(first.provider, "gemini");
  assert.equal(second.provider, "gemini");
  assert.equal(groqCalls, 1, "known-empty Groq budget should not be called again");
  assert.equal(fallbackCalls, 2);
  assert.ok(Date.now() - startedAt < 500, "Retry-After must not delay fallback");
});

test("Groq timeout covers a response body that stalls after headers", async () => {
  const provider = createGroqProvider({
    config: baseConfig({ timeoutMs: 10, maxRetries: 0 }),
    logger,
    fetchImpl: async (_url, options) => ({
      ok: true,
      async json() {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    }),
  });

  await assert.rejects(
    provider.generateStructuredJson({
      systemPrompt: "system",
      prompt: "merchant",
      schema: { type: "OBJECT", properties: {} },
    }),
    (error) => error instanceof DOMException && error.name === "AbortError",
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

test("fallback records the failed primary and bills the provider that answered", async () => {
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
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => [row.provider, row.model, row.status]),
    [
      ["groq", "openai/gpt-oss-120b", "error"],
      ["gemini", "gemini-3.1-flash-lite", "ok"],
    ],
  );

  // And the transition is now a durable /health signal, not just a log line.
  assert.equal(getLlmProviderHealth().fallbacksInWindow, 1);
});

test("a failed fallback records both provider attempts with their real models", async () => {
  const rows = [];
  const prisma = {
    llmUsageEvent: { create: async ({ data }) => rows.push(data) },
  };
  const primary = fakeProvider("groq", "openai/gpt-oss-120b", async () => {
    throw Object.assign(new Error("rate limited"), { status: 429 });
  });
  const fallback = fakeProvider("gemini", "gemini-3.5-flash-lite", async () => {
    throw Object.assign(new Error("fallback quota unavailable"), {
      status: 429,
      code: "RESOURCE_EXHAUSTED",
    });
  });
  const messages = [];
  const composed = withUsageRecording(
    withFallbackProvider(primary, fallback, {
      info() {},
      warn(message, metadata) {
        messages.push({ message, metadata });
      },
      error() {},
    }),
    { prisma, feature: "test", runType: "test", runId: "r2" },
  );

  await assert.rejects(composed.generateStructuredJson({}), /fallback quota/);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(
    rows.map((row) => [row.provider, row.model, row.status]),
    [
      ["groq", "openai/gpt-oss-120b", "error"],
      ["gemini", "gemini-3.5-flash-lite", "error"],
    ],
  );
  const fallbackFailure = messages.find(
    (entry) => entry.message === "LLM fallback provider also failed",
  );
  assert.equal(fallbackFailure.metadata.statusCode, 429);
  assert.equal(fallbackFailure.metadata.reasonCode, "RESOURCE_EXHAUSTED");
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
