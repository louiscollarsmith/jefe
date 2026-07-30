import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldPageOnDependencyFailure,
  shouldPageOnWorkerError,
} from "../app/services/deployment-health.server.js";

test("does not page inside the default startup grace window", () => {
  assert.equal(shouldPageOnDependencyFailure(0, {}), false);
  assert.equal(shouldPageOnDependencyFailure(59, {}), false);
});

test("pages once the grace window has elapsed", () => {
  assert.equal(shouldPageOnDependencyFailure(60, {}), true);
  assert.equal(shouldPageOnDependencyFailure(600, {}), true);
});

test("grace window is env-tunable", () => {
  const env = { READINESS_ALERT_GRACE_SECONDS: "120" };
  assert.equal(shouldPageOnDependencyFailure(90, env), false);
  assert.equal(shouldPageOnDependencyFailure(120, env), true);
});

test("falls back to 60s on invalid/empty env", () => {
  assert.equal(
    shouldPageOnDependencyFailure(59, { READINESS_ALERT_GRACE_SECONDS: "abc" }),
    false,
  );
  assert.equal(
    shouldPageOnDependencyFailure(60, { READINESS_ALERT_GRACE_SECONDS: "" }),
    true,
  );
});

test("shouldPageOnWorkerError pages only on a sustained failure streak", () => {
  // A single failed tick (any error) self-heals on the next one -> WARN, no page.
  assert.equal(shouldPageOnWorkerError(1, {}), false);
  assert.equal(shouldPageOnWorkerError(2, {}), false);
  // The 3rd consecutive failure (~45s at the 15s tick) is a real outage -> page.
  assert.equal(shouldPageOnWorkerError(3, {}), true);
  assert.equal(shouldPageOnWorkerError(10, {}), true);
});

test("worker page threshold is env-tunable, falls back to 3", () => {
  const env = { BACKFILL_LOOP_PAGE_AFTER: "5" };
  assert.equal(shouldPageOnWorkerError(4, env), false);
  assert.equal(shouldPageOnWorkerError(5, env), true);
  // invalid/empty env falls back to the default of 3
  assert.equal(shouldPageOnWorkerError(3, { BACKFILL_LOOP_PAGE_AFTER: "x" }), true);
});
