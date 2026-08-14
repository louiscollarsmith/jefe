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
/** @type {number[]} */
let clientNavigationRing = [];
let clientNavigationNext = 0;
/** @type {Map<string, { values: number[]; next: number }>} */
let routeRings = new Map();

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
 * Record one browser-observed navigation duration (ms). This is separate from
 * request latency: a React Router transition can be slow even when the server
 * response is quick, especially when a loader revalidates more than the click
 * actually needed.
 * @param {number} ms
 */
export function recordClientNavigationDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return;
  clientNavigationRing[clientNavigationNext] = ms;
  clientNavigationNext = (clientNavigationNext + 1) % CAPACITY;
}

/**
 * Record a bounded server route or route-phase duration. Names are fixed code
 * labels, never request paths or merchant input, so `/health` cannot leak data.
 * @param {string} name
 * @param {number} ms
 */
export function recordRouteDuration(name, ms) {
  if (!/^[a-z0-9._-]{1,96}$/i.test(name)) return;
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return;
  const ring = routeRings.get(name) ?? { values: [], next: 0 };
  ring.values[ring.next] = ms;
  ring.next = (ring.next + 1) % CAPACITY;
  routeRings.set(name, ring);
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
  return summarise(ring);
}

/** Explicit name for the historical `latency` metric recorded in entry.server. */
export function getSsrRenderLatencyPercentiles() {
  return getLatencyPercentiles();
}

/**
 * Browser-observed navigation percentiles over the sampled window.
 * @returns {{ count: number; p50: number; p95: number; p99: number; max: number }}
 */
export function getClientNavigationPercentiles() {
  return summarise(clientNavigationRing);
}

export function getRouteLatencyPercentiles() {
  return Object.fromEntries(
    [...routeRings.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, routeRing]) => [name, summarise(routeRing.values)]),
  );
}

/**
 * @param {number[]} values
 * @returns {{ count: number; p50: number; p95: number; p99: number; max: number }}
 */
function summarise(values) {
  const sampled = values.filter((v) => typeof v === "number");
  if (!sampled.length) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  return {
    count: sampled.length,
    p50: Math.round(percentile(sampled, 50)),
    p95: Math.round(percentile(sampled, 95)),
    p99: Math.round(percentile(sampled, 99)),
    max: Math.round(Math.max(...sampled)),
  };
}

/** Test helper: clear the sampled window. */
export function __resetPerf() {
  ring = [];
  next = 0;
  clientNavigationRing = [];
  clientNavigationNext = 0;
  routeRings = new Map();
}
