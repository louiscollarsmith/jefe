import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldPageOnDependencyFailure,
  isTransientDbConnectionError,
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

test("isTransientDbConnectionError recognises engine/connection blips", () => {
  assert.equal(
    isTransientDbConnectionError(new Error("Engine is not yet connected")),
    true,
  );
  assert.equal(
    isTransientDbConnectionError({
      name: "PrismaClientInitializationError",
      message: "x",
    }),
    true,
  );
  assert.equal(
    isTransientDbConnectionError(new Error("Can't reach database server")),
    true,
  );
  assert.equal(isTransientDbConnectionError(new Error("undefined is not a function")), false);
  assert.equal(isTransientDbConnectionError(null), false);
});

test("shouldPageOnWorkerError suppresses only transient startup blips", () => {
  const transient = new Error("Engine is not yet connected");
  const realBug = new TypeError("cannot read properties of undefined");
  // transient + inside grace -> no page
  assert.equal(shouldPageOnWorkerError(transient, 5, {}), false);
  // transient + past grace -> page (something is actually wrong)
  assert.equal(shouldPageOnWorkerError(transient, 120, {}), true);
  // real bug -> always pages, even during startup
  assert.equal(shouldPageOnWorkerError(realBug, 5, {}), true);
});
