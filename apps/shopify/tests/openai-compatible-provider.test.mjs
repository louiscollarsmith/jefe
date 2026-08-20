import assert from "node:assert/strict";
import test from "node:test";
import {
  createOpenAiCompatibleProvider,
  toJsonSchema,
} from "../app/lib/llm/providers/openai-compatible.server.js";
import { createOpenAiProvider } from "../app/lib/llm/providers/openai.server.js";
import {
  getOpenAiCompatibleProviders,
  getLlmConfig,
} from "../app/lib/llm/config.server.js";

const baseConfig = {
  model: "kimi-k3",
  maxInputTokens: 6000,
  maxOutputTokens: 900,
  maxRetries: 1,
  timeoutMs: 8000,
};
const silent = { info() {}, warn() {}, error() {} };

function okFetch(captured) {
  return async (url, opts) => {
    captured.url = url;
    captured.opts = opts;
    return {
      ok: true,
      headers: { get: () => null },
      async json() {
        return {
          choices: [{ message: { content: JSON.stringify({ answer: 42 }) } }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
            prompt_tokens_details: { cached_tokens: 6 },
          },
        };
      },
    };
  };
}

test("openai-compatible: posts to {baseUrl}/chat/completions with Bearer auth + model, parses JSON + usage", async () => {
  const captured = {};
  const p = createOpenAiCompatibleProvider({
    providerName: "kimi",
    baseUrl: "https://api.moonshot.ai/v1",
    apiKey: "test-key",
    config: baseConfig,
    logger: silent,
    fetchImpl: okFetch(captured),
  });
  assert.equal(p.provider, "kimi");
  assert.equal(p.model, "kimi-k3");

  const res = await p.generateStructuredJson({
    systemPrompt: "s",
    prompt: "p",
    schema: { type: "object", properties: { answer: { type: "number" } } },
  });

  assert.equal(captured.url, "https://api.moonshot.ai/v1/chat/completions");
  assert.equal(captured.opts.headers.Authorization, "Bearer test-key");
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.model, "kimi-k3");
  assert.equal(body.store, false);
  assert.equal(body.response_format.type, "json_schema");
  assert.deepEqual(res.json, { answer: 42 });
  assert.equal(res.usage.inputTokens, 10);
  assert.equal(res.usage.cachedInputTokens, 6);
  assert.equal(res.usage.outputTokens, 5);
  assert.equal(res.provider, "kimi");
});

test("openai provider: first-class provider uses OPENAI-compatible structured output path", async () => {
  const captured = {};
  const p = createOpenAiProvider({
    config: {
      ...baseConfig,
      model: "gpt-5.6-luna",
      openAiApiKey: "openai-test-key",
      openAiBaseUrl: "https://api.openai.test/v1",
    },
    logger: silent,
    fetchImpl: okFetch(captured),
  });

  const res = await p.generateStructuredJson({
    systemPrompt: ["stable", "system"],
    prompt: "dynamic",
    schema: { type: "object", properties: { answer: { type: "number" } } },
  });

  assert.equal(p.provider, "openai");
  assert.equal(p.model, "gpt-5.6-luna");
  assert.equal(captured.url, "https://api.openai.test/v1/chat/completions");
  assert.equal(captured.opts.headers.Authorization, "Bearer openai-test-key");
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.messages[0].content, "stable\nsystem");
  assert.equal(body.model, "gpt-5.6-luna");
  assert.equal(
    Object.hasOwn(body, "temperature"),
    false,
    "first-party OpenAI/Luna requests must not send unsupported temperature",
  );
  assert.equal(
    Object.hasOwn(body, "top_p"),
    false,
    "first-party OpenAI/Luna requests must not send unsupported top_p",
  );
  assert.deepEqual(res.json, { answer: 42 });
});

test("openai-compatible: trailing slash on baseUrl is handled", async () => {
  const captured = {};
  const p = createOpenAiCompatibleProvider({
    providerName: "kimi",
    baseUrl: "https://api.moonshot.ai/v1/",
    apiKey: "k",
    config: baseConfig,
    logger: silent,
    fetchImpl: okFetch(captured),
  });
  await p.generateStructuredJson({ systemPrompt: "s", prompt: "p", schema: { type: "object" } });
  assert.equal(captured.url, "https://api.moonshot.ai/v1/chat/completions");
});

test("openai-compatible: a non-ok response throws a classified LlmProviderHttpError (status + provider)", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    headers: { get: () => null },
    async json() {
      return { error: { code: "invalid_api_key" } };
    },
  });
  const p = createOpenAiCompatibleProvider({
    providerName: "kimi",
    baseUrl: "https://api.moonshot.ai/v1",
    apiKey: "bad",
    config: { ...baseConfig, maxRetries: 0 },
    logger: silent,
    fetchImpl,
  });
  await assert.rejects(
    () =>
      p.generateStructuredJson({
        systemPrompt: "s",
        prompt: "p",
        schema: { type: "object" },
      }),
    (err) => {
      assert.equal(err.status, 401);
      assert.equal(err.provider, "kimi");
      assert.match(err.message, /kimi request failed with HTTP 401/);
      return true;
    },
  );
});

test("openai-compatible: timeout covers a response body that stalls after headers", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    async json() {
      return new Promise(() => {});
    },
  });
  const p = createOpenAiCompatibleProvider({
    providerName: "openai",
    baseUrl: "https://api.openai.test/v1",
    apiKey: "test",
    config: { ...baseConfig, model: "gpt-5.6-luna", maxRetries: 0 },
    logger: silent,
    fetchImpl,
  });

  await assert.rejects(
    () =>
      p.generateStructuredJson({
        systemPrompt: "s",
        prompt: "p",
        schema: { type: "object" },
        timeoutMs: 20,
      }),
    (err) => {
      assert.equal(err.name, "AbortError");
      assert.match(err.message, /timed out/i);
      return true;
    },
  );
});

test("openai-compatible: 429 does not read a stalled error body", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 429,
    headers: { get: () => null },
    async json() {
      return new Promise(() => {});
    },
  });
  const p = createOpenAiCompatibleProvider({
    providerName: "openai",
    baseUrl: "https://api.openai.test/v1",
    apiKey: "test",
    config: { ...baseConfig, model: "gpt-5.6-luna", maxRetries: 0 },
    logger: silent,
    fetchImpl,
  });

  await assert.rejects(
    () =>
      p.generateStructuredJson({
        systemPrompt: "s",
        prompt: "p",
        schema: { type: "object" },
        timeoutMs: 20,
    }),
    (err) => {
      assert.equal(err.name, "LlmProviderHttpError");
      assert.equal(err.status, 429);
      assert.equal(err.code, "rate_limit");
      return true;
    },
  );
});

test("registry: kimi keyed from KIMI_API_KEY / MOONSHOT_API_KEY; base URL default + override", () => {
  assert.equal(getOpenAiCompatibleProviders({}).kimi.apiKey, "");
  assert.equal(
    getOpenAiCompatibleProviders({}).kimi.baseUrl,
    "https://api.moonshot.ai/v1",
  );
  assert.equal(getOpenAiCompatibleProviders({ KIMI_API_KEY: "k1" }).kimi.apiKey, "k1");
  assert.equal(
    getOpenAiCompatibleProviders({ MOONSHOT_API_KEY: "m1" }).kimi.apiKey,
    "m1",
  );
  assert.equal(
    getOpenAiCompatibleProviders({ KIMI_BASE_URL: "https://proxy/v1" }).kimi.baseUrl,
    "https://proxy/v1",
  );
});

test("config: a compat key alone is registered while test execution stays LLM-disabled", () => {
  const saved = { ...process.env };
  try {
    delete process.env.GROQ_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.LLM_ENABLED;
    delete process.env.KIMI_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    assert.equal(getLlmConfig().enabled, false, "no keys ⇒ disabled");
    process.env.KIMI_API_KEY = "k1";
    const cfg = getLlmConfig();
    assert.equal(
      cfg.enabled,
      false,
      "test execution keeps LLM calls disabled even with provider keys",
    );
    assert.equal(cfg.openAiCompatible.kimi.apiKey, "k1");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("toJsonSchema: normalizes gemini-style types + nullable", () => {
  const out = toJsonSchema({ type: "STRING", nullable: true, description: "x" });
  assert.deepEqual(out.type, ["string", "null"]);
  assert.equal(out.description, "x");
});
