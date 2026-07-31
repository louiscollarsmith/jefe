// @ts-check

// Benchmark priors — cross-merchant / external REFERENCE values ("stores like yours
// typically hold 30% dead stock"). A DISTINCT provenance class from Merchant Memory:
// a prior is NEVER the merchant's own observed or confirmed fact. It exists only for
//   (a) cold-start context — a brand-new store with thin first-party data, and
//   (b) comparison — "your dead-stock share is 45% vs a 30% benchmark".
// and it is always surfaced labelled as a benchmark, never as "your number".
//
// Aggregate + PII-safe BY CONSTRUCTION: a prior describes a segment/cohort, never a
// single store and never a customer — end-customer PII must never cross into the
// cross-merchant layer (only aggregates do). `isMerchantFact` is hard-false so no
// surface or LLM prompt can mistake a prior for the merchant's reality, and merchant
// corrections can never "correct" a prior (it isn't theirs to correct).
//
// GATED: the actual prior VALUES come from the benchmark DB (Quiver) once its contents
// are read + confirmed aggregate-safe (founder call — see the questions list). This
// module is the typed scaffolding + the comparison/provenance RULES; it ships with NO
// data and no consumer wired, so it's inert until priors are sourced.

/** The provenance tag every benchmark prior carries — the discipline that keeps it distinct from a merchant fact. */
export const BENCHMARK_PROVENANCE = "benchmark_prior";

/**
 * @typedef {Object} BenchmarkPrior
 * @property {string} key        The belief key this benchmarks (e.g. "products.dead_stock_share").
 * @property {string} segment    The cohort it describes (e.g. "apparel_dtc", "all"). NEVER a single store.
 * @property {number} value      The aggregate reference value.
 * @property {string} unit       "percent" | "currency" | "count" | "ratio".
 * @property {number} [sampleSize]  Stores the aggregate is over (drives confidence + a min-cohort gate).
 * @property {string} source     Provenance/audit label; never a merchant id.
 * @property {string} provenance Always BENCHMARK_PROVENANCE.
 * @property {false} isMerchantFact  Hard-false — a prior is not the merchant's own fact.
 */

/**
 * The ONLY constructor for a benchmark prior — stamps the provenance + the hard
 * `isMerchantFact:false` guard so a prior can never be confused with a merchant fact.
 * Coerces to the typed shape; drops nothing silently that would misrepresent it.
 * @param {{ key?: unknown; segment?: unknown; value?: unknown; unit?: unknown; sampleSize?: unknown; source?: unknown }} prior
 * @returns {BenchmarkPrior}
 */
export function asBenchmarkPrior(prior) {
  const sampleSize = Number(prior?.sampleSize);
  return {
    key: String(prior?.key ?? ""),
    segment: String(prior?.segment ?? "all"),
    value: Number(prior?.value),
    unit: String(prior?.unit ?? "ratio"),
    sampleSize: Number.isFinite(sampleSize) && sampleSize >= 0 ? sampleSize : undefined,
    source: String(prior?.source ?? "unknown"),
    provenance: BENCHMARK_PROVENANCE,
    isMerchantFact: false,
  };
}

/** Minimum cohort size before a prior is trustworthy enough to show — a thin benchmark misleads. */
export const MIN_BENCHMARK_SAMPLE = 20;

/**
 * Whether a prior is trustworthy enough to surface: correctly provenanced, a real value,
 * and over a large-enough cohort. A prior that fails this is kept internal, never shown.
 * @param {BenchmarkPrior} prior
 */
export function isSurfaceableBenchmark(prior) {
  return (
    prior?.provenance === BENCHMARK_PROVENANCE &&
    prior?.isMerchantFact === false &&
    Number.isFinite(Number(prior?.value)) &&
    Number(prior?.sampleSize ?? 0) >= MIN_BENCHMARK_SAMPLE
  );
}

/** @param {number} value */
function round1(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10) / 10;
}

/**
 * Compare a merchant's OWN value to a benchmark prior — the comparison use case
 * ("your dead-stock share is 45%, vs 30% for stores like yours"). Pure; NEVER merges
 * the two — the merchant's fact stays theirs, the prior stays a prior. `higherIsBetter`
 * sets the good/bad reading per metric (revenue: higher good; dead stock: higher bad).
 * Returns `{ comparable:false }` when the prior isn't surfaceable or the maths is
 * undefined (never a misleading comparison against a thin/absent benchmark).
 * @param {number} merchantValue  the merchant's own (observed/confirmed) value
 * @param {BenchmarkPrior} prior
 * @param {{ higherIsBetter?: boolean }} [options]
 */
export function compareToBenchmark(merchantValue, prior, options = {}) {
  const benchmark = Number(prior?.value);
  const mine = Number(merchantValue);
  if (!isSurfaceableBenchmark(prior) || !Number.isFinite(mine) || benchmark === 0) {
    return { comparable: false, key: prior?.key };
  }
  const deltaPercent = round1(((mine - benchmark) / benchmark) * 100);
  const direction = mine > benchmark ? "above" : mine < benchmark ? "below" : "at";
  const higherIsBetter = options.higherIsBetter !== false; // default: higher is better
  const standing =
    direction === "at" ? "on_par" : (direction === "above") === higherIsBetter ? "better" : "worse";
  return {
    comparable: true,
    key: prior.key,
    segment: prior.segment,
    merchantValue: mine,
    benchmarkValue: benchmark,
    deltaPercent,
    direction, // above | below | at
    standing, // better | worse | on_par — relative to peers
    provenance: BENCHMARK_PROVENANCE, // the result is a benchmark comparison, not a merchant fact
  };
}
