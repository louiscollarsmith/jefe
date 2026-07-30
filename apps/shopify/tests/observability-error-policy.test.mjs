import assert from "node:assert/strict";
import test from "node:test";
import { shouldReportServerError } from "../app/lib/observability/error-policy.server.js";

// react-router's isRouteErrorResponse duck-types on { status, statusText,
// internal, data } — so a plain object of that shape stands in for a thrown
// route response without pulling in RR internals.
const routeError = (status) => ({ status, statusText: "x", internal: false, data: null });

test("skips aborted requests (client disconnected) — even a would-be 5xx", () => {
  assert.equal(shouldReportServerError(new Error("boom"), { aborted: true }), false);
  assert.equal(shouldReportServerError(routeError(500), { aborted: true }), false);
});

test("skips 4xx route responses (bot 404s, stray 405s, 403s)", () => {
  for (const s of [400, 403, 404, 405, 429, 499]) {
    assert.equal(shouldReportServerError(routeError(s)), false, `${s} should skip`);
  }
});

test("REPORTS 5xx route responses and genuine exceptions", () => {
  for (const s of [500, 502, 503]) {
    assert.equal(shouldReportServerError(routeError(s)), true, `${s} should report`);
  }
  assert.equal(shouldReportServerError(new Error("kaboom")), true);
  assert.equal(shouldReportServerError(new TypeError("x is not a function")), true);
});

test("reports unclassified errors (fail open — better than silently dropping)", () => {
  assert.equal(shouldReportServerError("weird string error"), true);
  assert.equal(shouldReportServerError(null), true);
  assert.equal(shouldReportServerError(undefined), true);
});
