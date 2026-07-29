import assert from "node:assert/strict";
import test from "node:test";
import { shouldPageOnDependencyFailure } from "../app/services/deployment-health.server.js";

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
