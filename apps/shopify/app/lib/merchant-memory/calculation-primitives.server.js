// @ts-check

/**
 * Shared deterministic calculation semantics for Merchant Memory derivations.
 * These helpers deliberately stay small; source selection remains in domain code.
 */

/** @param {unknown} value */
export function decimalNumber(value) {
  if (value === null || value === undefined) return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** @param {number[]} values */
export function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

/** @param {number[]} values */
export function average(values) {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

/** @param {number[]} values */
export function stddev(values) {
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

/**
 * Linear interpolation percentile over sorted numeric values.
 * @param {number[]} values
 * @param {number} p
 */
export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * clamp(p, 0, 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

/** @param {string} method */
export function percentileFor(method) {
  if (method === "p25") return 0.25;
  if (method === "p75") return 0.75;
  if (method === "p90") return 0.9;
  return 0.5;
}

/**
 * @param {number} numerator
 * @param {number} denominator
 * @param {{ zeroDenominator?: "null" | "zero" | "throw" }} [options]
 */
export function ratio(numerator, denominator, options = {}) {
  if (denominator === 0) {
    if (options.zeroDenominator === "throw") {
      throw new Error("Cannot calculate ratio with a zero denominator.");
    }
    return options.zeroDenominator === "zero" ? 0 : null;
  }
  return numerator / denominator;
}

/**
 * @template T
 * @param {T[]} rows
 * @param {(row: T) => string} keyFn
 * @param {(row: T) => number} valueFn
 */
export function sumBy(rows, keyFn, valueFn) {
  /** @type {Map<string, number>} */
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    map.set(key, (map.get(key) ?? 0) + valueFn(row));
  }
  return map;
}

/** @param {number} value */
export function roundMoney(value) {
  return roundNumber(value, 2);
}

/**
 * @param {number | null | undefined} value
 * @param {number} places
 */
export function roundNumber(value, places) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return value;
  }
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * @param {Date} start
 * @param {Date} end
 */
export function hoursBetween(start, end) {
  return Math.max(0, (end.getTime() - start.getTime()) / 3600000);
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
