import assert from "node:assert/strict";
import test from "node:test";

import {
  formatChartValue,
  layoutChart,
  normaliseChartSpec,
} from "../app/lib/charts/chart-layout.js";

// Jefe holds plenty of things that are bad sentences and good pictures — order-value
// percentiles, revenue across windows, price bands. This is the deterministic half of
// drawing one: spec in, geometry out, no React and no DOM, so the maths is pinned rather
// than eyeballed in a browser.
//
// The properties that matter are honesty properties, not pixel ones: a chart of nothing must
// not be drawn, and the baseline must not lie.

test("a chart of nothing is not drawn", () => {
  // A chart with no data is a lie with axes on it — the caller should say it in words.
  assert.equal(layoutChart(null), null);
  assert.equal(layoutChart({}), null);
  assert.equal(layoutChart({ kind: "bar", points: [] }), null);
  assert.equal(layoutChart({ kind: "bar", points: [{ label: "Jan", value: 5 }] }), null,
    "one point is a number, not a chart");
  assert.equal(
    layoutChart({ kind: "bar", points: [{ label: "a", value: 0 }, { label: "b", value: 0 }] }),
    null,
    "all-zero draws a flat line that implies a measurement rather than an absence",
  );
});

test("junk points are dropped rather than drawn as zero", () => {
  const spec = normaliseChartSpec({
    kind: "bar",
    points: [
      { label: "Real", value: 10 },
      { label: "", value: 5 },
      { label: "NaN", value: Number.NaN },
      { label: "Missing" },
      { label: "Also real", value: 20 },
    ],
  });
  assert.equal(spec.points.length, 2);
  assert.deepEqual(spec.points.map((p) => p.label), ["Real", "Also real"]);
});

test("the baseline includes zero, so differences are not exaggerated", () => {
  // A bar chart whose baseline floats makes a 3% change look like a cliff — and a merchant
  // may price from this.
  const laid = layoutChart({
    kind: "bar",
    points: [
      { label: "a", value: 100 },
      { label: "b", value: 103 },
    ],
  });
  const [a, b] = laid.bars;
  // With a zero baseline the two bars are within a few percent of each other in height.
  const ratio = b.height / a.height;
  assert.ok(ratio > 0.95 && ratio < 1.1, `bars should look similar, got ratio ${ratio}`);
});

test("negative values hang below the baseline, not above it", () => {
  const laid = layoutChart({
    kind: "bar",
    points: [
      { label: "up", value: 40 },
      { label: "down", value: -20 },
    ],
  });
  const [up, down] = laid.bars;
  assert.ok(up.y < laid.baselineY, "a positive bar sits above the baseline");
  assert.equal(down.y, laid.baselineY, "a negative bar starts at the baseline and drops");
  assert.ok(down.height > 0);
});

test("geometry stays inside the canvas", () => {
  const laid = layoutChart({
    kind: "bar",
    points: Array.from({ length: 9 }, (_, i) => ({ label: `p${i}`, value: (i + 1) * 7 })),
  });
  for (const bar of laid.bars) {
    assert.ok(bar.x >= 0 && bar.x + bar.width <= laid.width, `bar ${bar.label} escapes horizontally`);
    assert.ok(bar.y >= 0 && bar.y + bar.height <= laid.height, `bar ${bar.label} escapes vertically`);
  }
});

test("an unreadable number of points is capped, not squeezed", () => {
  const laid = layoutChart({
    kind: "line",
    points: Array.from({ length: 40 }, (_, i) => ({ label: `d${i}`, value: i + 1 })),
  });
  assert.equal(laid.points.length, 12);
});

test("layout is deterministic — same spec, same numbers", () => {
  const spec = {
    kind: "bar",
    points: [
      { label: "p25", value: 18 },
      { label: "median", value: 34 },
      { label: "p75", value: 61 },
    ],
    unit: "currency",
    currency: "GBP",
  };
  assert.deepEqual(layoutChart(spec), layoutChart(spec));
});

test("values are formatted the way a person reads them", () => {
  const money = { kind: "bar", points: [], unit: "currency", currency: "GBP" };
  assert.match(formatChartValue(1250, money), /£1,250/);
  // Large money compacts, so an axis label doesn't run into the chart.
  assert.match(formatChartValue(96000, money), /£96K/i);

  const percent = { kind: "bar", points: [], unit: "percent" };
  assert.equal(formatChartValue(31.4, percent), "31%");
  // Sub-1% keeps a decimal rather than reading as a flat zero.
  assert.equal(formatChartValue(0.4, percent), "0.4%");

  const count = { kind: "bar", points: [], unit: "count" };
  assert.equal(formatChartValue(1234, count), "1,234");
});

test("a real distribution lays out sensibly", () => {
  // The actual shape Jefe holds: order value percentiles, which read badly as three
  // sentences and well as three bars.
  const laid = layoutChart({
    kind: "bar",
    title: "What your orders are worth",
    points: [
      { label: "p25", value: 18 },
      { label: "median", value: 34 },
      { label: "p75", value: 61 },
      { label: "p90", value: 122 },
    ],
    unit: "currency",
    currency: "GBP",
  });
  assert.equal(laid.title, "What your orders are worth");
  assert.equal(laid.bars.length, 4);
  assert.match(laid.bars[3].value, /£122/);
  // Taller value ⇒ taller bar, in order.
  const heights = laid.bars.map((b) => b.height);
  assert.deepEqual(heights, [...heights].sort((a, b) => a - b));
  assert.equal(laid.ticks.length, 3);
});
