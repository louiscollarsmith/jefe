import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyWebVital,
  formatWebVital,
  isKnownWebVital,
  CORE_WEB_VITALS,
  TRACKED_WEB_VITALS,
} from "../app/lib/observability/web-vitals.server.js";

test("classifyWebVital bands LCP (ms) at the good/poor boundaries", () => {
  assert.equal(classifyWebVital("LCP", 2000), "good");
  assert.equal(classifyWebVital("LCP", 2500), "good"); // inclusive good bound
  assert.equal(classifyWebVital("LCP", 3140), "needs-improvement"); // the current prod value
  assert.equal(classifyWebVital("LCP", 4000), "needs-improvement"); // inclusive ni bound
  assert.equal(classifyWebVital("LCP", 4001), "poor");
});

test("classifyWebVital handles CLS (ratio) and INP (ms)", () => {
  assert.equal(classifyWebVital("CLS", 0.05), "good");
  assert.equal(classifyWebVital("CLS", 0.2), "needs-improvement");
  assert.equal(classifyWebVital("CLS", 0.3), "poor");
  assert.equal(classifyWebVital("INP", 100), "good");
  assert.equal(classifyWebVital("INP", 40), "good"); // the current prod INP
  assert.equal(classifyWebVital("INP", 600), "poor");
});

test("classifyWebVital is case-insensitive and fails safe on junk", () => {
  assert.equal(classifyWebVital("lcp", 2000), "good");
  assert.equal(classifyWebVital("FOO", 10), "unknown");
  assert.equal(classifyWebVital("LCP", NaN), "unknown");
  assert.equal(classifyWebVital("LCP", -5), "unknown");
  assert.equal(classifyWebVital("LCP", "3000"), "unknown"); // non-number
});

test("isKnownWebVital recognises the reported metrics only", () => {
  for (const m of ["LCP", "inp", "CLS", "FCP", "TTFB", "FID"]) {
    assert.equal(isKnownWebVital(m), true, `${m} should be known`);
  }
  assert.equal(isKnownWebVital("DOMContentLoaded"), false);
  assert.equal(isKnownWebVital(""), false);
});

test("formatWebVital renders ms vs ratio and the band", () => {
  assert.equal(formatWebVital("LCP", 3140), "LCP 3140ms · needs-improvement");
  assert.equal(formatWebVital("CLS", 0.2), "CLS 0.200 · needs-improvement");
  assert.equal(formatWebVital("inp", 40), "INP 40ms · good");
});

test("CORE_WEB_VITALS is the LCP/INP/CLS trio", () => {
  assert.deepEqual([...CORE_WEB_VITALS].sort(), ["CLS", "INP", "LCP"]);
});

test("TRACKED_WEB_VITALS adds TTFB (the LCP diagnostic) but it isn't BFS-graded", () => {
  assert.deepEqual([...TRACKED_WEB_VITALS].sort(), ["CLS", "INP", "LCP", "TTFB"]);
  assert.ok(TRACKED_WEB_VITALS.includes("TTFB"));
  assert.ok(!CORE_WEB_VITALS.includes("TTFB"));
});
