import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkerHealth,
  buildDependencyHealth,
} from "../app/services/deployment-health.server.js";
import {
  recordWorkerTick,
  getWorkerLastTickAt,
  __resetHeartbeat,
} from "../app/lib/observability/heartbeat.server.js";

const NOW = 1_000_000_000_000;

test("buildWorkerHealth: disabled when the loop is off", () => {
  assert.deepEqual(buildWorkerHealth(null, { enabled: false }), {
    status: "disabled",
    lastTickAgoMs: null,
  });
});

test("buildWorkerHealth: starting before the first tick", () => {
  assert.deepEqual(buildWorkerHealth(null, { now: NOW }), {
    status: "starting",
    lastTickAgoMs: null,
  });
});

test("buildWorkerHealth: ok when recent, stale past the window", () => {
  assert.deepEqual(
    buildWorkerHealth(NOW - 20_000, { now: NOW, staleMs: 90_000 }),
    { status: "ok", lastTickAgoMs: 20_000 },
  );
  assert.deepEqual(
    buildWorkerHealth(NOW - 120_000, { now: NOW, staleMs: 90_000 }),
    { status: "stale", lastTickAgoMs: 120_000 },
  );
});

test("buildDependencyHealth reflects env flags, no network calls", () => {
  const on = buildDependencyHealth({
    ENABLE_EMAIL: "true",
    ALERT_WEBHOOK_URL: "https://hooks.slack.com/x",
    LLM_ENABLED: "true",
    OPENAI_API_KEY: "openai-key",
    LLM_PROVIDER: "openai",
    LLM_MODEL: "gpt-5.6-luna",
    LLM_FALLBACK_PROVIDER: "",
    LLM_FALLBACK_MODEL: "",
    LLM_CHAT_PROVIDER: "openai",
    LLM_CHAT_MODEL: "gpt-5.6-luna",
    LLM_CHAT_FALLBACK_PROVIDER: "",
    LLM_CHAT_FALLBACK_MODEL: "",
  });
  assert.equal(on.email.configured, true);
  assert.equal(on.slack.configured, true);
  assert.equal(on.llm.enabled, true);
  assert.equal(on.llm.provider, "openai");
  assert.equal(on.llm.model, "gpt-5.6-luna");
  assert.equal(on.llm.fallbackProvider, "");
  assert.equal(on.llm.fallbackModel, "");
  assert.equal(on.llm.chatProvider, "openai");
  assert.equal(on.llm.chatModel, "gpt-5.6-luna");
  assert.equal(on.llm.chatFallbackProvider, "");
  assert.equal(on.llm.chatFallbackModel, "");
  assert.equal(on.llm.openAiConfigured, true);

  const off = buildDependencyHealth({});
  assert.equal(off.email.configured, false);
  assert.equal(off.slack.configured, false);
  assert.equal(off.llm.enabled, false);
  assert.equal(off.llm.provider, "openai");
  assert.equal(off.llm.chatProvider, "openai");
});

test("buildDependencyHealth surfaces which provider keys are present (silent-substitution guard)", () => {
  // Groq selected + only a Gemini key present: the provider layer silently serves
  // Gemini for 100% of traffic while `provider` still reads "groq". The key-presence
  // fields make that visible so /health can't advertise a provider that isn't serving.
  const substituting = buildDependencyHealth({
    LLM_PROVIDER: "groq",
    GEMINI_API_KEY: "g",
  });
  assert.equal(substituting.llm.provider, "groq");
  assert.equal(substituting.llm.groqConfigured, false);
  assert.equal(substituting.llm.geminiConfigured, true);
  assert.equal(substituting.llm.providerKeyPresent, false); // groq claimed, no groq key
  assert.equal(substituting.llm.enabled, true); // enabled:true + providerKeyPresent:false = substitution

  // Groq selected + Groq key present: actually serving what it claims.
  const healthy = buildDependencyHealth({ LLM_PROVIDER: "groq", GROQ_API_KEY: "k" });
  assert.equal(healthy.llm.groqConfigured, true);
  assert.equal(healthy.llm.providerKeyPresent, true);
});

test("buildDependencyHealth: llm enabled via API keys, explicit false wins", () => {
  assert.equal(buildDependencyHealth({ OPENAI_API_KEY: "k" }).llm.enabled, true);
  assert.equal(buildDependencyHealth({ GROQ_API_KEY: "k" }).llm.enabled, true);
  assert.equal(buildDependencyHealth({ GEMINI_API_KEY: "k" }).llm.enabled, true);
  assert.equal(
    buildDependencyHealth({
      LLM_ENABLED: "false",
      GROQ_API_KEY: "k",
      GEMINI_API_KEY: "k",
    }).llm.enabled,
    false,
  );
});

test("heartbeat records + reads the last worker tick", () => {
  __resetHeartbeat();
  assert.equal(getWorkerLastTickAt(), null);
  recordWorkerTick(NOW);
  assert.equal(getWorkerLastTickAt(), NOW);
  recordWorkerTick(NOW + 15_000);
  assert.equal(getWorkerLastTickAt(), NOW + 15_000);
  __resetHeartbeat();
  assert.equal(getWorkerLastTickAt(), null);
});
