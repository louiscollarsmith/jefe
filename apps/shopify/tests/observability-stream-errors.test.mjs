import assert from "node:assert/strict";
import test from "node:test";
import { isBenignStreamError } from "../app/lib/observability/stream-errors.server.js";

test("isBenignStreamError flags client-disconnect stream errors", () => {
  assert.equal(
    isBenignStreamError(
      new Error("The destination stream errored while writing data."),
    ),
    true,
  );
  assert.equal(isBenignStreamError(new Error("ERR_STREAM_PREMATURE_CLOSE")), true);
  assert.equal(isBenignStreamError(new Error("premature close")), true);
  assert.equal(isBenignStreamError(new Error("write after end")), true);
  assert.equal(isBenignStreamError({ message: "read ECONNRESET" }), true);
  assert.equal(isBenignStreamError(new Error("write EPIPE")), true);
});

test("isBenignStreamError does not flag real render errors", () => {
  assert.equal(
    isBenignStreamError(
      new Error("Cannot read properties of undefined (reading 'map')"),
    ),
    false,
  );
  assert.equal(isBenignStreamError(new Error("Element type is invalid")), false);
  assert.equal(isBenignStreamError(null), false);
  assert.equal(isBenignStreamError("some string"), false);
});
