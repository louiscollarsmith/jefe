import assert from "node:assert/strict";
import test from "node:test";
import {
  churnReasonLabel,
  esc,
  fmtMs,
  formatAccessLog,
  money,
  optionList,
  safeEqual,
  sparkline,
} from "../format.mjs";

test("esc: escapes HTML metacharacters, ampersand first (no double-escape)", () => {
  assert.equal(esc('<a href="x">&'), "&lt;a href=&quot;x&quot;&gt;&amp;");
  // & must be escaped before <, else &lt; would become &amp;lt;
  assert.equal(esc("a & b < c"), "a &amp; b &lt; c");
});

test("esc: null/undefined become empty string, numbers stringify", () => {
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(0), "0");
  assert.equal(esc(42), "42");
});

test("money: currency symbol, 0 dp, thousands separators, rounding", () => {
  assert.equal(money(1234.5, "USD"), "$1,235");
  assert.equal(money(1000, "GBP"), "£1,000");
  assert.equal(money(1500000, "EUR"), "€1,500,000");
});

test("money: null/0 amount coerces to 0; unknown currency prefixes the code", () => {
  assert.equal(money(null, "EUR"), "€0");
  assert.equal(money(0), "0");
  assert.equal(money(50, "XYZ"), "XYZ 50");
});

test("fmtMs: null dash, ms under 1s, seconds at/above 1s", () => {
  assert.equal(fmtMs(null), "—");
  assert.equal(fmtMs(undefined), "—");
  assert.equal(fmtMs(0), "0ms");
  assert.equal(fmtMs(999), "999ms");
  assert.equal(fmtMs(1000), "1.0s");
  assert.equal(fmtMs(1500), "1.5s");
});

test("safeEqual: equal strings true, any difference false, length-mismatch false", () => {
  assert.equal(safeEqual("hunter2", "hunter2"), true);
  assert.equal(safeEqual("", ""), true);
  assert.equal(safeEqual("hunter2", "hunter3"), false);
  assert.equal(safeEqual("hunter2", "hunter22"), false);
});

test("optionList: marks the selected value and HTML-escapes values", () => {
  assert.equal(
    optionList(["a", "b"], "b"),
    '<option value="a">a</option><option value="b" selected>b</option>',
  );
  assert.equal(
    optionList(["<x>"], null),
    '<option value="&lt;x&gt;">&lt;x&gt;</option>',
  );
  assert.equal(optionList([], "x"), "");
});

test("sparkline: empty/nullish input renders nothing", () => {
  assert.equal(sparkline([]), "");
  assert.equal(sparkline(null), "");
  assert.equal(sparkline(undefined), "");
});

test("sparkline: renders a self-contained svg polyline", () => {
  const svg = sparkline([1, 2, 3, 2]);
  assert.match(svg, /^<svg class="spark"/);
  assert.match(svg, /<polyline points="[\d, ]+"/);
  // 4 values -> 4 "x,y" points
  const pts = svg.match(/points="([^"]+)"/)[1].trim().split(" ");
  assert.equal(pts.length, 4);
});

test("sparkline: single value does not divide by zero", () => {
  const svg = sparkline([5]);
  assert.match(svg, /<polyline points="0,\d+"/);
});

test("sparkline: honours width/height/stroke overrides", () => {
  const svg = sparkline([1, 2], { w: 100, h: 20, stroke: "#ff0000" });
  assert.match(svg, /width="100"/);
  assert.match(svg, /height="20"/);
  assert.match(svg, /stroke="#ff0000"/);
});

test("churnReasonLabel: known codes map to labels; unknown/empty fall back", () => {
  assert.equal(churnReasonLabel("too_early"), "Too early for us");
  assert.equal(churnReasonLabel("no_value"), "Didn't see the value");
  assert.equal(churnReasonLabel("too_complex"), "Too complex");
  assert.equal(churnReasonLabel("broke"), "Something broke");
  // Unknown code renders itself (forward-compatible), null/empty → em dash.
  assert.equal(churnReasonLabel("brand_new_reason"), "brand_new_reason");
  assert.equal(churnReasonLabel(null), "—");
  assert.equal(churnReasonLabel(""), "—");
});

test("formatAccessLog: PII-safe audit line, drops empty fields", () => {
  const parsed = JSON.parse(
    formatAccessLog({
      ts: "2026-07-31T00:00:00.000Z",
      outcome: "granted",
      method: "GET",
      path: "/merchant",
      shop: "jaspers-market.myshopify.com",
      ip: "203.0.113.7",
    }),
  );
  assert.equal(parsed.ev, "ops_access");
  assert.equal(parsed.outcome, "granted");
  assert.equal(parsed.path, "/merchant");
  assert.equal(parsed.shop, "jaspers-market.myshopify.com");
  assert.equal(parsed.ip, "203.0.113.7");
  // Empty fields are omitted (not emitted as ""), keeping the audit line lean.
  const denied = JSON.parse(
    formatAccessLog({ ts: "t", outcome: "denied", path: "/", shop: "", ip: "" }),
  );
  assert.equal(denied.outcome, "denied");
  assert.ok(!("shop" in denied) && !("ip" in denied));
});
