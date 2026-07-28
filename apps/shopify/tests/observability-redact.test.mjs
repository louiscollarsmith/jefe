import assert from "node:assert/strict";
import test from "node:test";
import { isSensitiveKey, redact } from "../app/lib/observability/redact.server.js";

test("redacts values under sensitive keys regardless of type", () => {
  const out = redact({
    password: "hunter2",
    apiKey: "sk-123",
    access_token: "abc",
    authorization: "Bearer xyz",
    sessionSecret: "s3cr3t",
    shopDomain: "jaspers-market.myshopify.com",
    count: 5,
  });
  assert.equal(out.password, "[redacted]");
  assert.equal(out.apiKey, "[redacted]");
  assert.equal(out.access_token, "[redacted]");
  assert.equal(out.authorization, "[redacted]");
  assert.equal(out.sessionSecret, "[redacted]");
  // Non-sensitive operational fields survive untouched.
  assert.equal(out.shopDomain, "jaspers-market.myshopify.com");
  assert.equal(out.count, 5);
});

test("redacts sensitive keys nested in objects and arrays", () => {
  const out = redact({
    outer: { inner: { secret: "leak", ok: "keep" } },
    list: [{ token: "t1" }, { token: "t2", label: "keep" }],
  });
  assert.equal(out.outer.inner.secret, "[redacted]");
  assert.equal(out.outer.inner.ok, "keep");
  assert.equal(out.list[0].token, "[redacted]");
  assert.equal(out.list[1].token, "[redacted]");
  assert.equal(out.list[1].label, "keep");
});

test("scrubs email-shaped substrings inside free-text values", () => {
  const out = redact({
    note: "customer alice@example.com asked about refund",
    body: "contact: bob.smith+tag@shop.co.uk and carol@x.io",
  });
  assert.equal(out.note, "customer [redacted-email] asked about refund");
  assert.ok(!out.body.includes("@shop.co.uk"));
  assert.ok(!out.body.includes("carol@x.io"));
  assert.equal((out.body.match(/\[redacted-email\]/g) || []).length, 2);
});

test("handles circular references without throwing", () => {
  const node = { name: "a" };
  node.self = node;
  const out = redact(node);
  assert.equal(out.name, "a");
  assert.equal(out.self, "[Circular]");
});

test("truncates very long strings", () => {
  const long = "x".repeat(5000);
  const out = redact({ blob: long }, { maxString: 100 });
  assert.ok(out.blob.startsWith("x".repeat(100)));
  assert.ok(out.blob.includes("truncated"));
  assert.ok(out.blob.length < 200);
});

test("stops descending past max depth", () => {
  const deep = { a: { b: { c: { d: { e: "deep" } } } } };
  const out = redact(deep, { maxDepth: 2 });
  assert.equal(out.a.b, "[Object: max depth]");
});

test("serialises dates and leaves primitives intact", () => {
  const out = redact({ when: new Date("2026-07-28T00:00:00.000Z"), n: 1, b: true });
  assert.equal(out.when, "2026-07-28T00:00:00.000Z");
  assert.equal(out.n, 1);
  assert.equal(out.b, true);
});

test("isSensitiveKey matches common credential shapes", () => {
  for (const key of ["password", "API_KEY", "clientSecret", "refresh_token", "hmac"]) {
    assert.equal(isSensitiveKey(key), true, `${key} should be sensitive`);
  }
  for (const key of ["shopDomain", "count", "topic", "durationMs"]) {
    assert.equal(isSensitiveKey(key), false, `${key} should not be sensitive`);
  }
});
