import assert from "node:assert/strict";
import test from "node:test";
import { buildHealthPayload } from "../app/services/deployment-health.server.js";

test("deployment health reports the configured app environment", () => {
  assert.deepEqual(buildHealthPayload({ APP_ENV: "staging" }), {
    ok: true,
    environment: "staging",
  });
});

test("deployment health falls back to NODE_ENV and development", () => {
  assert.deepEqual(buildHealthPayload({ NODE_ENV: "production" }), {
    ok: true,
    environment: "production",
  });
  assert.deepEqual(buildHealthPayload({}), {
    ok: true,
    environment: "development",
  });
});
