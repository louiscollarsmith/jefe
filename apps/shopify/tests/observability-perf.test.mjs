import assert from "node:assert/strict";
import test from "node:test";
import {
  percentile,
  recordRequestDuration,
  getLatencyPercentiles,
  __resetPerf,
} from "../app/lib/observability/perf.server.js";

test("percentile handles empty, single, and interpolated cases", () => {
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([5], 50), 5);
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(v, 0), 1);
  assert.equal(percentile(v, 50), 5.5);
  assert.equal(percentile(v, 100), 10);
  assert.ok(Math.abs(percentile(v, 95) - 9.55) < 1e-9);
});

test("getLatencyPercentiles summarises the sampled window", () => {
  __resetPerf();
  for (let i = 1; i <= 10; i++) recordRequestDuration(i);
  const s = getLatencyPercentiles();
  assert.equal(s.count, 10);
  assert.equal(s.p50, 6); // round(5.5)
  assert.equal(s.p95, 10); // round(9.55)
  assert.equal(s.max, 10);
});

test("recordRequestDuration ignores invalid input", () => {
  __resetPerf();
  recordRequestDuration(Number.NaN);
  recordRequestDuration(-1);
  recordRequestDuration(Number.POSITIVE_INFINITY);
  // @ts-expect-error — wrong type is defended against at runtime
  recordRequestDuration("nope");
  assert.equal(getLatencyPercentiles().count, 0);
});

test("the sampled window is bounded (ring buffer)", () => {
  __resetPerf();
  for (let i = 0; i < 600; i++) recordRequestDuration(i);
  assert.equal(getLatencyPercentiles().count, 512);
});
