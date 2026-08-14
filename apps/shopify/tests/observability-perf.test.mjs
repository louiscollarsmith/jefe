import assert from "node:assert/strict";
import test from "node:test";
import {
  getClientNavigationPercentiles,
  percentile,
  recordClientNavigationDuration,
  recordRequestDuration,
  recordRouteDuration,
  getLatencyPercentiles,
  getRouteLatencyPercentiles,
  getSsrRenderLatencyPercentiles,
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

test("client navigation percentiles are sampled separately from request latency", () => {
  __resetPerf();
  recordRequestDuration(5);
  recordClientNavigationDuration(100);
  recordClientNavigationDuration(300);

  assert.equal(getLatencyPercentiles().count, 1);
  const nav = getClientNavigationPercentiles();
  assert.equal(nav.count, 2);
  assert.equal(nav.p50, 200);
  assert.equal(nav.max, 300);
});

test("SSR render and named route timings are exposed separately", () => {
  __resetPerf();
  recordRequestDuration(7);
  recordRouteDuration("app-home.action-chats.action.auth", 20);
  recordRouteDuration("app-home.action-chats.action.auth", 40);
  recordRouteDuration("app-home.action-chats.action", 90);
  recordRouteDuration("invalid route label", 500);

  assert.deepEqual(getSsrRenderLatencyPercentiles(), {
    count: 1,
    p50: 7,
    p95: 7,
    p99: 7,
    max: 7,
  });
  assert.deepEqual(getRouteLatencyPercentiles(), {
    "app-home.action-chats.action": {
      count: 1,
      p50: 90,
      p95: 90,
      p99: 90,
      max: 90,
    },
    "app-home.action-chats.action.auth": {
      count: 2,
      p50: 30,
      p95: 39,
      p99: 40,
      max: 40,
    },
  });
});

test("the sampled window is bounded (ring buffer)", () => {
  __resetPerf();
  for (let i = 0; i < 600; i++) recordRequestDuration(i);
  assert.equal(getLatencyPercentiles().count, 512);
});
