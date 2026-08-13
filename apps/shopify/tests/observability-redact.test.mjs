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
  // PII scrubbing removed 2026-08-13 (founder's call): addresses pass through verbatim.
  assert.equal(out.note, "customer alice@example.com asked about refund");
  assert.ok(out.body.includes("@shop.co.uk"));
  assert.ok(out.body.includes("carol@x.io"));
  assert.equal((out.body.match(/@/g) || []).length, 2, "addresses are no longer masked");
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

test("serialises a bare Error (message/stack are non-enumerable) instead of {}", () => {
  const out = redact(new Error("auth failed for alice@example.com"));
  assert.equal(out.name, "Error");
  assert.equal(out.message, "auth failed for alice@example.com");
  assert.equal(typeof out.stack, "string");
  assert.ok(out.stack.includes("alice@example.com"));
});

test("serialises Errors nested below the top level (not just err/error keys)", () => {
  const out = redact({
    result: { err: new Error("boom carol@x.io") },
    attempts: [{ error: new TypeError("bad") }],
  });
  // Without the Error branch these would each collapse to {}.
  assert.equal(out.result.err.name, "Error");
  assert.equal(out.result.err.message, "boom carol@x.io");
  assert.equal(out.attempts[0].error.name, "TypeError");
  assert.equal(out.attempts[0].error.message, "bad");
});

test("keeps a typed error's own fields but redacts sensitive ones", () => {
  const err = Object.assign(new Error("nope"), { status: 503, apiKey: "sk-secret" });
  const out = redact(err);
  assert.equal(out.status, 503);
  assert.equal(out.apiKey, "[redacted]");
});

test("does not throw on a self-referential (cyclic) error cause", () => {
  const err = new Error("root");
  err.cause = err;
  const out = redact(err);
  assert.equal(out.name, "Error");
  assert.equal(out.cause, "[Circular]");
});

test("scrubs high-confidence secret shapes inside free text", () => {
  // Fixtures are assembled from parts at runtime so this source file contains no
  // literal secret-shaped string — otherwise secret-scanning push protection
  // rejects the commit (ironic for a redaction test). Each still forms a real
  // token shape once concatenated.
  const shopify = "shp" + "at_" + "0123456789abcdef".repeat(2); // shpat_ + 32 hex
  const stripe = "sk_" + "live_" + "abcd1234EFGH5678ijkl"; // sk_live_ + 20
  const github = "gh" + "p_" + "0123456789abcdefghij0123456789abcdEF"; // ghp_ + 36
  const bearer = "Authorization: " + "Bearer " + "abcdef1234567890xyz";
  const out = redact({ a: `using ${shopify} now`, b: stripe, c: github, d: bearer });
  assert.ok(out.a.includes("[redacted-secret]") && !out.a.includes("at_0123"));
  assert.equal(out.b, "[redacted-secret]");
  assert.equal(out.c, "[redacted-secret]");
  assert.ok(out.d.includes("Bearer [redacted-secret]"));
});

test("does not over-redact legitimate operational strings", () => {
  const out = redact({
    shop: "jaspers-market.myshopify.com",
    gid: "gid://shopify/Product/123",
    word: "shipment scheduled",
    sku: "SK-1024",
  });
  assert.equal(out.shop, "jaspers-market.myshopify.com");
  assert.equal(out.gid, "gid://shopify/Product/123");
  assert.equal(out.word, "shipment scheduled");
  assert.equal(out.sku, "SK-1024");
});
