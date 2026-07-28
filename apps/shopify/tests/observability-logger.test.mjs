import assert from "node:assert/strict";
import test from "node:test";
import {
  createLogger,
  resolveFormat,
  resolveLevel,
  serializeError,
} from "../app/lib/observability/logger.server.js";

const FIXED = new Date("2026-07-28T12:00:00.000Z");

/**
 * Build a logger that captures its output as parsed JSON records.
 */
function captureLogger(overrides = {}) {
  const lines = [];
  const logger = createLogger({
    level: "debug",
    format: "json",
    now: () => FIXED,
    sink: (_level, line) => lines.push(line),
    ...overrides,
  });
  return { logger, records: () => lines.map((l) => JSON.parse(l)), lines };
}

test("emits one JSON record per call with level, time and msg", () => {
  const { logger, records } = captureLogger();
  logger.info("hello", { shopDomain: "jaspers-market.myshopify.com" });
  const [record] = records();
  assert.equal(record.level, "info");
  assert.equal(record.time, "2026-07-28T12:00:00.000Z");
  assert.equal(record.msg, "hello");
  assert.equal(record.shopDomain, "jaspers-market.myshopify.com");
});

test("respects the minimum level", () => {
  const { logger, records } = captureLogger({ level: "warn" });
  logger.debug("d");
  logger.info("i");
  logger.warn("w");
  logger.error("e");
  const levels = records().map((r) => r.level);
  assert.deepEqual(levels, ["warn", "error"]);
});

test("redacts sensitive context before writing", () => {
  const { logger, records } = captureLogger();
  logger.info("auth", {
    accessToken: "secret",
    phoneNumber: "+15551234567",
    email: "a@b.com",
    note: "x@y.io ok",
  });
  const [record] = records();
  // Credential + phone keys are redacted wholesale.
  assert.equal(record.accessToken, "[redacted]");
  assert.equal(record.phoneNumber, "[redacted]");
  // Email-shaped values are scrubbed wherever they appear (key name or free text).
  assert.equal(record.email, "[redacted-email]");
  assert.equal(record.note, "[redacted-email] ok");
});

test("serialises an Error passed as the context", () => {
  const { logger, records } = captureLogger();
  logger.error("boom", new Error("kaboom"));
  const [record] = records();
  assert.equal(record.err.name, "Error");
  assert.equal(record.err.message, "kaboom");
  assert.ok(typeof record.err.stack === "string");
});

test("serialises an err/error field inside the context", () => {
  const { logger, records } = captureLogger();
  const err = new Error("bad");
  logger.warn("failed", { err, topic: "orders/create" });
  const [record] = records();
  assert.equal(record.err.message, "bad");
  assert.equal(record.topic, "orders/create");
});

test("child loggers merge bindings into every record", () => {
  const { logger, records } = captureLogger();
  const child = logger.child({ requestId: "req-1" });
  child.info("scoped", { path: "/health" });
  const [record] = records();
  assert.equal(record.requestId, "req-1");
  assert.equal(record.path, "/health");
});

test("silent level suppresses all output", () => {
  const { logger, lines } = captureLogger({ level: "silent" });
  logger.error("nope");
  assert.equal(lines.length, 0);
});

test("serializeError preserves typed error fields and cause", () => {
  const err = new Error("outer");
  err.status = 503;
  err.cause = new Error("inner");
  const out = serializeError(err);
  assert.equal(out.message, "outer");
  assert.equal(out.status, 503);
  assert.equal(out.cause.message, "inner");
  assert.equal(serializeError("not-an-error"), "not-an-error");
});

test("resolveLevel and resolveFormat honour env with sensible defaults", () => {
  assert.equal(resolveLevel({ LOG_LEVEL: "warn" }), "warn");
  assert.equal(resolveLevel({ NODE_ENV: "production" }), "info");
  assert.equal(resolveLevel({ NODE_ENV: "development" }), "debug");
  assert.equal(resolveLevel({ LOG_LEVEL: "bogus" }), "debug");
  assert.equal(resolveFormat({ NODE_ENV: "production" }), "json");
  assert.equal(resolveFormat({ NODE_ENV: "development" }), "pretty");
  assert.equal(resolveFormat({ LOG_FORMAT: "json", NODE_ENV: "development" }), "json");
});

test("pretty format renders a single human-readable line", () => {
  const lines = [];
  const logger = createLogger({
    level: "debug",
    format: "pretty",
    now: () => FIXED,
    sink: (_l, line) => lines.push(line),
  });
  logger.info("started", { port: 3000 });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("INFO"));
  assert.ok(lines[0].includes("started"));
  assert.ok(lines[0].includes('"port":3000'));
});

test("forwards only error-level records to onError", () => {
  const alerted = [];
  const logger = createLogger({
    level: "debug",
    format: "json",
    now: () => FIXED,
    sink: () => {},
    onError: (record) => alerted.push(record),
  });
  logger.info("fine");
  logger.warn("careful");
  logger.error("boom", { path: "/x" });
  assert.equal(alerted.length, 1);
  assert.equal(alerted[0].msg, "boom");
  assert.equal(alerted[0].path, "/x");
});

test("a throwing onError never breaks logging", () => {
  const lines = [];
  const logger = createLogger({
    level: "debug",
    format: "json",
    now: () => FIXED,
    sink: (_l, line) => lines.push(line),
    onError: () => {
      throw new Error("alert failed");
    },
  });
  assert.doesNotThrow(() => logger.error("still logs"));
  assert.equal(lines.length, 1);
});
