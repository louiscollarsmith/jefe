import assert from "node:assert/strict";
import test from "node:test";
import {
  getContext,
  newCorrelationId,
  runWithContext,
} from "../app/lib/observability/context.server.js";
import { createLogger } from "../app/lib/observability/logger.server.js";

test("getContext is empty outside any context", () => {
  assert.deepEqual(getContext(), {});
});

test("runWithContext exposes bindings to getContext and returns fn result", () => {
  const result = runWithContext({ correlationId: "abc" }, () => {
    assert.equal(getContext().correlationId, "abc");
    return 42;
  });
  assert.equal(result, 42);
  // Context does not leak out of the run.
  assert.deepEqual(getContext(), {});
});

test("nested runWithContext merges onto the parent context", () => {
  runWithContext({ correlationId: "abc", jobType: "orders" }, () => {
    runWithContext({ shopDomain: "s.myshopify.com" }, () => {
      const ctx = getContext();
      assert.equal(ctx.correlationId, "abc");
      assert.equal(ctx.jobType, "orders");
      assert.equal(ctx.shopDomain, "s.myshopify.com");
    });
  });
});

test("context propagates across awaits", async () => {
  await runWithContext({ correlationId: "async-1" }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(getContext().correlationId, "async-1");
  });
});

test("the structured logger merges the ambient context into every record", () => {
  const lines = [];
  const logger = createLogger({
    level: "debug",
    format: "json",
    now: () => new Date("2026-07-28T12:00:00.000Z"),
    sink: (_l, line) => lines.push(line),
  });
  runWithContext({ correlationId: "cid-9", jobId: "job-1" }, () => {
    logger.info("inside job", { step: "rebuild" });
  });
  const record = JSON.parse(lines[0]);
  assert.equal(record.correlationId, "cid-9");
  assert.equal(record.jobId, "job-1");
  assert.equal(record.step, "rebuild");
});

test("newCorrelationId returns distinct ids", () => {
  assert.notEqual(newCorrelationId(), newCorrelationId());
});
