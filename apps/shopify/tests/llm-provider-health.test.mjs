import assert from "node:assert/strict";
import test from "node:test";
import {
  recordLlmFallback,
  getLlmProviderHealth,
  __resetLlmProviderHealth,
} from "../app/lib/observability/llm-provider-health.server.js";

const WINDOW_MS = 15 * 60 * 1000;
const FROM = {
  fromProvider: "groq",
  fromModel: "openai/gpt-oss-120b",
  toProvider: "gemini",
  toModel: "gemini-3.1-flash-lite",
};

test("empty window before any fallback", () => {
  __resetLlmProviderHealth();
  const h = getLlmProviderHealth(1);
  assert.equal(h.fallbacksInWindow, 0);
  assert.equal(h.lastFallbackAgoMs, null);
  assert.equal(h.lastFallbackFrom, null);
  assert.equal(h.windowMs, WINDOW_MS);
});

test("counts transitions in the window + reports the last one", () => {
  __resetLlmProviderHealth();
  const t0 = 1_000_000;
  recordLlmFallback(FROM, t0);
  recordLlmFallback(FROM, t0 + 1000);
  const h = getLlmProviderHealth(t0 + 2000);
  assert.equal(h.fallbacksInWindow, 2);
  assert.equal(h.lastFallbackAgoMs, 1000);
  assert.equal(h.lastFallbackFrom, "groq:openai/gpt-oss-120b");
});

test("transitions older than the window drop off", () => {
  __resetLlmProviderHealth();
  const t0 = 5_000_000;
  recordLlmFallback(FROM, t0);
  const later = t0 + WINDOW_MS + 60_000; // just past the 15-min window
  recordLlmFallback(FROM, later);
  assert.equal(getLlmProviderHealth(later).fallbacksInWindow, 1); // only the recent one
});

test("recordLlmFallback never throws on malformed input", () => {
  __resetLlmProviderHealth();
  assert.doesNotThrow(() => recordLlmFallback(/** @type {any} */ ({}), 1));
  const h = getLlmProviderHealth(1);
  assert.equal(h.fallbacksInWindow, 1);
  assert.equal(h.lastFallbackFrom, "unknown:unknown");
});
