import assert from "node:assert/strict";
import test from "node:test";
import { isBenignForSentry } from "../app/lib/observability/sentry.server.js";

// The drop decision behind Sentry's beforeSend. The dangerous failure mode is an
// over-broad filter silently swallowing real errors, so the "kept" cases matter
// as much as the "dropped" ones.

test("drops handled SSR stream aborts (matched on the error message)", () => {
  assert.equal(isBenignForSentry(new Error("premature close")), true);
  assert.equal(isBenignForSentry(new Error("write after end")), true);
  // A real connection reset surfaces the code in the message, e.g. "read ECONNRESET".
  assert.equal(isBenignForSentry(new Error("read ECONNRESET")), true);
  // Deliberately conservative: a bare "socket hang up" (code only, no matching
  // message) is NOT suppressed — the detector matches messages, not .code.
  assert.equal(
    isBenignForSentry(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })),
    false,
  );
});

test("drops 4xx route responses (bot POSTs, 404/405/429)", () => {
  assert.equal(isBenignForSentry({ status: 400 }), true);
  assert.equal(isBenignForSentry({ status: 404 }), true);
  assert.equal(isBenignForSentry({ status: 429 }), true);
  assert.equal(isBenignForSentry({ status: 499 }), true); // upper 4xx boundary
});

test("KEEPS real 5xx faults — the errors Sentry exists to catch", () => {
  assert.equal(isBenignForSentry({ status: 500 }), false);
  assert.equal(isBenignForSentry({ status: 502 }), false);
  assert.equal(isBenignForSentry({ status: 503 }), false);
});

test("KEEPS ordinary errors that carry no HTTP status", () => {
  assert.equal(isBenignForSentry(new TypeError("x is not a function")), false);
  assert.equal(isBenignForSentry(new Error("kaboom")), false);
});

test("KEEPS when there is no original exception, and on status boundaries", () => {
  assert.equal(isBenignForSentry(undefined), false);
  assert.equal(isBenignForSentry(null), false);
  assert.equal(isBenignForSentry({}), false);
  assert.equal(isBenignForSentry({ status: 399 }), false); // just below 4xx
  assert.equal(isBenignForSentry({ status: "not-a-number" }), false);
});
