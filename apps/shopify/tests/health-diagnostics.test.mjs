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
    LLM_PROVIDER: "gemini",
  });
  assert.equal(on.email.configured, true);
  assert.equal(on.slack.configured, true);
  assert.equal(on.llm.enabled, true);
  assert.equal(on.llm.provider, "gemini");

  const off = buildDependencyHealth({});
  assert.equal(off.email.configured, false);
  assert.equal(off.slack.configured, false);
  assert.equal(off.llm.enabled, false);
});

test("buildDependencyHealth: llm enabled via GEMINI_API_KEY, explicit false wins", () => {
  assert.equal(buildDependencyHealth({ GEMINI_API_KEY: "k" }).llm.enabled, true);
  assert.equal(
    buildDependencyHealth({ LLM_ENABLED: "false", GEMINI_API_KEY: "k" }).llm.enabled,
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
