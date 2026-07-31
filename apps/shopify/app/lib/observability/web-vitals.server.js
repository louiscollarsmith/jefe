// @ts-check

/**
 * Core Web Vitals classification, server-side.
 *
 * The embedded app reports real-user Web Vitals via App Bridge
 * (`shopify.webVitals.onReport`); `/api/web-vitals` records them and this module
 * classifies each value into Google's good / needs-improvement / poor bands so we
 * can track LCP (and the rest) over time in the ops panel and alert when a metric
 * is genuinely bad. Pure — no I/O — so the bands are locked down with tests.
 */

/**
 * Upper bound of each band: `value <= good` → "good", `<= ni` →
 * "needs-improvement", above → "poor". LCP/FCP/TTFB/INP/FID are ms; CLS is
 * unitless. Thresholds are Google's published Core Web Vitals bands.
 * @type {Record<string, { good: number, ni: number }>}
 */
const THRESHOLDS = {
  LCP: { good: 2500, ni: 4000 },
  INP: { good: 200, ni: 500 },
  CLS: { good: 0.1, ni: 0.25 },
  FCP: { good: 1800, ni: 3000 },
  TTFB: { good: 800, ni: 1800 },
  FID: { good: 100, ni: 300 },
};

/** The three Core Web Vitals recorded as first-class perf events (vs. logged only). */
export const CORE_WEB_VITALS = ["LCP", "INP", "CLS"];

/**
 * @param {string} name
 * @returns {boolean} whether `name` is a metric we recognise + threshold.
 */
export function isKnownWebVital(name) {
  return Object.prototype.hasOwnProperty.call(THRESHOLDS, String(name).toUpperCase());
}

/**
 * @param {string} name
 * @param {number} value
 * @returns {"good" | "needs-improvement" | "poor" | "unknown"}
 */
export function classifyWebVital(name, value) {
  const t = THRESHOLDS[String(name).toUpperCase()];
  if (!t || typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "unknown";
  }
  if (value <= t.good) return "good";
  if (value <= t.ni) return "needs-improvement";
  return "poor";
}

/**
 * Human one-liner for a log line / activity summary. CLS shows 3 dp (it's a
 * ratio); the rest show integer milliseconds.
 * @param {string} name
 * @param {number} value
 * @returns {string}
 */
export function formatWebVital(name, value) {
  const n = String(name).toUpperCase();
  const shown =
    n === "CLS" ? Number(value).toFixed(3) : `${Math.round(Number(value))}ms`;
  return `${n} ${shown} · ${classifyWebVital(n, value)}`;
}
