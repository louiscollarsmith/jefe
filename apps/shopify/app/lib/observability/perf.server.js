// @ts-check

/**
 * In-memory request-latency sampler. A fixed-size ring buffer of recent request
 * durations (ms) with a p50/p95/p99 readout, surfaced on `/health`.
 *
 * Deliberately per-instance and non-durable: it costs nothing, needs no storage,
 * and gives a live latency signal for the instance answering the health check.
 * Cross-instance and historical percentiles are a heavier, later item — they
 * need a metrics store or the log drain (#9). LLM-call duration percentiles are
 * already durable (llm_usage_event.latency_ms) and surfaced in the ops panel.
 */

const CAPACITY = 512;
/** @type {number[]} */
let ring = [];
let next = 0;

/**
 * Record one request duration (ms). Silently ignores non-finite/negative input
 * so instrumentation can never throw into the request path.
 * @param {number} ms
 */
export function recordRequestDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return;
  ring[next] = ms;
  next = (next + 1) % CAPACITY;
}

/**
 * Linear-interpolated percentile. Pure; exported for testing.
 * @param {number[]} values
 * @param {number} p percentile in [0, 100]
 * @returns {number}
 */
export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/**
 * Current latency percentiles over the sampled window.
 * @returns {{ count: number; p50: number; p95: number; p99: number; max: number }}
 */
export function getLatencyPercentiles() {
  const values = ring.filter((v) => typeof v === "number");
  if (!values.length) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  return {
    count: values.length,
    p50: Math.round(percentile(values, 50)),
    p95: Math.round(percentile(values, 95)),
    p99: Math.round(percentile(values, 99)),
    max: Math.round(Math.max(...values)),
  };
}

/** Test helper: clear the sampled window. */
export function __resetPerf() {
  ring = [];
  next = 0;
}
