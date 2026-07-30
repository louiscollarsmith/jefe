import assert from "node:assert/strict";
import test from "node:test";
import { isBenignStreamError } from "../app/lib/observability/stream-errors.server.js";

// Guards the benign-noise filter used by the streaming onError, handleError, and
// the Sentry beforeSend drop — so real render errors are never silently swallowed.

test("isBenignStreamError: true for client-disconnect / stream-closed errors", () => {
  const benign = [
    "The destination stream errored while writing data.",
    "Error [ERR_STREAM_PREMATURE_CLOSE]: Premature close",
    "premature close",
    "write after end",
    "The stream was destroyed",
    "stream closed",
    "write EPIPE",
    "read ECONNRESET",
  ];
  for (const msg of benign) {
    assert.equal(isBenignStreamError(new Error(msg)), true, `expected benign: ${msg}`);
  }
});

test("isBenignStreamError: accepts a bare string, not only an Error", () => {
  assert.equal(isBenignStreamError("destination stream errored"), true);
});

test("isBenignStreamError: false for real errors, a bare 'aborted', and junk", () => {
  const notBenign = [
    new Error("Cannot read properties of undefined (reading 'x')"),
    new TypeError("foo is not a function"),
    new Error("Database connection failed"),
    // "aborted" is deliberately NOT matched (too broad — the abort signal is the
    // real signal at the call site); asserting it documents that choice.
    new Error("Request aborted"),
    null,
    undefined,
    {},
    42,
  ];
  for (const e of notBenign) {
    assert.equal(isBenignStreamError(e), false, `expected NOT benign: ${String(e)}`);
  }
});
