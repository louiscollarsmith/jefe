import assert from "node:assert/strict";
import test from "node:test";
import { getLlmConfig } from "../app/lib/llm/config.server.js";
import { LlmDisabledError } from "../app/lib/llm/errors.server.js";
import { externalLlmCallsDisabled } from "../app/lib/llm/external-call-guard.server.js";
import { createGeminiProvider } from "../app/lib/llm/providers/gemini.server.js";
import { createGroqProvider } from "../app/lib/llm/providers/groq.server.js";
import { transcribeVoiceNote } from "../app/lib/llm/transcribe-voice.server.js";
import { embedMerchantMemoryText } from "../app/lib/merchant-memory/embedding.server.js";

const config = {
  enabled: true,
  provider: "groq",
  model: "openai/gpt-oss-120b",
  fallbackProvider: "gemini",
  fallbackModel: "gemini-3.5-flash-lite",
  groqApiKey: "must-not-be-used",
  geminiApiKey: "must-not-be-used",
  timeoutMs: 1000,
  maxInputTokens: 6000,
  maxOutputTokens: 64,
  maxRetries: 0,
};

const request = {
  systemPrompt: "system",
  prompt: "merchant",
  schema: { type: "OBJECT", properties: {} },
};

test("Node test execution disables configured LLM and embedding providers", () => {
  assert.equal(externalLlmCallsDisabled(), true);
  assert.equal(getLlmConfig().enabled, false);
});

test("Groq cannot use its real network transport from a test", async () => {
  const provider = createGroqProvider({ config, logger: quietLogger() });
  await assert.rejects(
    provider.generateStructuredJson(request),
    LlmDisabledError,
  );
});

test("Gemini cannot use its real network transport from a test", async () => {
  const provider = createGeminiProvider({
    config: { ...config, provider: "gemini", model: "gemini-3.5-flash-lite" },
    logger: quietLogger(),
  });
  await assert.rejects(
    provider.generateStructuredJson(request),
    LlmDisabledError,
  );
});

test("embedding falls back locally instead of calling Gemini from a test", async () => {
  const result = await embedMerchantMemoryText("merchant memory", {
    config: {
      enabled: true,
      apiKey: "must-not-be-used",
      model: "gemini-embedding-2",
      dimensions: 768,
      timeoutMs: 1000,
    },
  });
  assert.equal(result?.errorCode, "external_calls_disabled");
});

test("voice transcription cannot reach Gemini from a test", async () => {
  await assert.rejects(
    transcribeVoiceNote({ audioBase64: "dGVzdA==", mimeType: "audio/webm" }),
    /LLM is not configured/,
  );
});

function quietLogger() {
  return { info() {}, warn() {}, error() {} };
}
