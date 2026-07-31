import assert from "node:assert/strict";
import test from "node:test";
import {
  asBenchmarkPrior,
  BENCHMARK_PROVENANCE,
  compareToBenchmark,
  isSurfaceableBenchmark,
} from "../app/lib/merchant-memory/benchmark-priors.server.js";

test("asBenchmarkPrior stamps benchmark provenance + a hard isMerchantFact:false", () => {
  const p = asBenchmarkPrior({ key: "products.dead_stock_share", segment: "apparel_dtc", value: 30, unit: "percent", sampleSize: 120, source: "quiver_2026q3" });
  assert.equal(p.provenance, BENCHMARK_PROVENANCE);
  assert.equal(p.isMerchantFact, false); // a prior is never the merchant's own fact
  assert.equal(p.value, 30);
  assert.equal(p.segment, "apparel_dtc");
  assert.equal(p.sampleSize, 120);
});

test("isSurfaceableBenchmark gates on provenance, a real value, and cohort size", () => {
  assert.equal(isSurfaceableBenchmark(asBenchmarkPrior({ key: "k", value: 30, sampleSize: 50 })), true);
  assert.equal(isSurfaceableBenchmark(asBenchmarkPrior({ key: "k", value: 30, sampleSize: 5 })), false); // thin cohort
  assert.equal(isSurfaceableBenchmark(asBenchmarkPrior({ key: "k", value: NaN, sampleSize: 100 })), false); // no value
  // A raw merchant-shaped object (not constructed as a prior) is never surfaceable as a benchmark.
  assert.equal(isSurfaceableBenchmark(/** @type {any} */ ({ value: 30, sampleSize: 100, isMerchantFact: true })), false);
});

test("compareToBenchmark: direction + standing per metric; a thin benchmark isn't comparable", () => {
  // 45% dead stock vs a 30% benchmark — higher is WORSE.
  const ds = compareToBenchmark(45, asBenchmarkPrior({ key: "products.dead_stock_share", value: 30, sampleSize: 100 }), { higherIsBetter: false });
  assert.equal(ds.comparable, true);
  assert.equal(ds.direction, "above");
  assert.equal(ds.standing, "worse");
  assert.equal(ds.deltaPercent, 50); // 45 is 50% above 30
  assert.equal(ds.provenance, BENCHMARK_PROVENANCE);
  // AOV above the benchmark — higher is BETTER.
  assert.equal(compareToBenchmark(60, asBenchmarkPrior({ key: "aov", value: 50, sampleSize: 100 }), { higherIsBetter: true }).standing, "better");
  // A thin benchmark → not comparable, so we never show a misleading comparison.
  assert.equal(compareToBenchmark(45, asBenchmarkPrior({ key: "k", value: 30, sampleSize: 3 })).comparable, false);
});
