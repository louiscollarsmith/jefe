// @ts-check

// Chart LAYOUT — the deterministic half of Jefe drawing something.
//
// Jefe holds plenty of things that are bad sentences and good pictures: order-value
// percentiles are a distribution, revenue at 7/30/90 days is a trend, price bands are a
// spread. Saying those one number at a time is worse than useless; drawing them is the
// natural form.
//
// This module turns a chart SPEC into geometry — positions, sizes, ticks, formatted labels —
// and stops there. No React, no SVG strings, no DOM. That split is deliberate:
//   - it is testable in plain node, so the maths is pinned rather than eyeballed;
//   - the same geometry can be drawn by the in-app chat, an email, or a PDF later;
//   - and the surface that renders it cannot accidentally change the numbers.
//
// ⛔ It never invents data. A spec with nothing in it lays out to null and the caller says
// something in words instead — a chart of no data is a lie with axes on it.

/**
 * @typedef {object} ChartPoint
 * @property {string} label
 * @property {number} value
 */

/**
 * @typedef {object} ChartSpec
 * @property {"bar" | "line"} kind
 * @property {string} [title]
 * @property {ChartPoint[]} points
 * @property {"currency" | "percent" | "count"} [unit]
 * @property {string} [currency]  ISO code; only read when unit is "currency".
 */

/** A chart with more bars than this is unreadable in a chat bubble; we keep the head. */
const MAX_POINTS = 12;
const WIDTH = 480;
const HEIGHT = 180;
const PAD = { top: 16, right: 12, bottom: 28, left: 48 };

/**
 * Format a value the way a person reads it, not the way it is stored.
 * @param {number} value
 * @param {ChartSpec} spec
 */
export function formatChartValue(value, spec) {
  if (!Number.isFinite(value)) return "";
  if (spec.unit === "percent") {
    // Sub-1% keeps a decimal so it never reads as a flat 0%.
    return value > 0 && value < 1 ? `${value.toFixed(1)}%` : `${Math.round(value)}%`;
  }
  if (spec.unit === "currency") {
    try {
      return new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency: spec.currency || "GBP",
        maximumFractionDigits: 0,
        notation: Math.abs(value) >= 10_000 ? "compact" : "standard",
      }).format(value);
    } catch {
      return String(Math.round(value));
    }
  }
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 }).format(value);
}

/**
 * Nothing worth drawing? Say so, rather than drawing nothing.
 * @param {any} spec
 * @returns {ChartSpec | null}
 */
export function normaliseChartSpec(spec) {
  if (!spec || typeof spec !== "object") return null;
  const kind = spec.kind === "line" ? "line" : spec.kind === "bar" ? "bar" : null;
  if (!kind) return null;
  const points = (Array.isArray(spec.points) ? spec.points : [])
    .filter(
      (/** @type {any} */ p) =>
        p && typeof p.label === "string" && p.label.trim() && typeof p.value === "number" && Number.isFinite(p.value),
    )
    .slice(0, MAX_POINTS)
    .map((/** @type {any} */ p) => ({ label: p.label.trim(), value: p.value }));
  // One point is a number, not a chart. Two is the minimum that shows a relationship.
  if (points.length < 2) return null;
  // All-zero data draws a flat line that implies a measurement rather than an absence.
  if (points.every((p) => p.value === 0)) return null;
  return {
    kind,
    title: typeof spec.title === "string" && spec.title.trim() ? spec.title.trim() : undefined,
    points,
    unit: ["currency", "percent", "count"].includes(spec.unit) ? spec.unit : "count",
    currency: typeof spec.currency === "string" ? spec.currency : undefined,
  };
}

/**
 * Turn a spec into drawable geometry. Pure: same spec in, same numbers out.
 *
 * The y-axis includes zero deliberately. A bar chart whose baseline is not zero exaggerates
 * differences — a 3% change looks like a cliff — and this is a chart a merchant may make a
 * pricing decision from.
 *
 * @param {any} rawSpec
 * @returns {null | { width: number; height: number; kind: "bar" | "line"; title?: string; bars: Array<{ label: string; value: string; x: number; y: number; width: number; height: number }>; points: Array<{ label: string; value: string; x: number; y: number }>; baselineY: number; ticks: Array<{ value: string; y: number }> }}
 */
export function layoutChart(rawSpec) {
  const spec = normaliseChartSpec(rawSpec);
  if (!spec) return null;

  const values = spec.points.map((p) => p.value);
  // Include zero so the baseline is honest in both directions.
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;

  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const yFor = (/** @type {number} */ v) => PAD.top + ((max - v) / span) * plotHeight;
  const baselineY = yFor(0);

  const slot = plotWidth / spec.points.length;
  const barWidth = Math.max(4, slot * 0.62);

  const bars = spec.points.map((p, i) => {
    const y = yFor(Math.max(p.value, 0));
    const height = Math.abs(yFor(p.value) - baselineY);
    return {
      label: p.label,
      value: formatChartValue(p.value, spec),
      x: PAD.left + i * slot + (slot - barWidth) / 2,
      y: p.value >= 0 ? y : baselineY,
      width: barWidth,
      height: Math.max(1, height),
    };
  });

  const points = spec.points.map((p, i) => ({
    label: p.label,
    value: formatChartValue(p.value, spec),
    x: PAD.left + i * slot + slot / 2,
    y: yFor(p.value),
  }));

  // Three ticks — top, zero-or-middle, bottom. More than that is clutter at this size.
  const tickValues = min < 0 ? [max, 0, min] : [max, max / 2, min];
  const ticks = tickValues.map((v) => ({
    value: formatChartValue(v, spec),
    y: yFor(v),
  }));

  return {
    width: WIDTH,
    height: HEIGHT,
    kind: spec.kind,
    title: spec.title,
    bars,
    points,
    baselineY,
    ticks,
  };
}
