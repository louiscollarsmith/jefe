import { test } from "node:test";
import assert from "node:assert/strict";

import {
  emailDomain,
  classifyEmail,
  normalizeStore,
  scoreSignup,
  rankPipeline,
  summarize,
  formatPipeline,
} from "../src/icp-scoring.server.js";

test("emailDomain extracts a lowercased domain, else empty", () => {
  assert.equal(emailDomain("Founder@Acme.com"), "acme.com");
  assert.equal(emailDomain("nope"), "");
  assert.equal(emailDomain("a@localhost"), "");
  assert.equal(emailDomain("@acme.com"), "");
});

test("classifyEmail: branded vs freemail vs invalid", () => {
  assert.equal(classifyEmail("jo@acme.com"), "branded");
  assert.equal(classifyEmail("jo@gmail.com"), "freemail");
  assert.equal(classifyEmail("jo@ICLOUD.com"), "freemail");
  assert.equal(classifyEmail("garbage"), "invalid");
});

test("normalizeStore handles the messy real inputs", () => {
  assert.deepEqual(normalizeStore("").kind, "none");
  assert.deepEqual(normalizeStore(null).kind, "none");

  const bare = normalizeStore("acme");
  assert.equal(bare.kind, "myshopify");
  assert.equal(bare.domain, "acme.myshopify.com");
  assert.equal(bare.handle, "acme");

  const ms = normalizeStore("Acme.myshopify.com");
  assert.equal(ms.kind, "myshopify");
  assert.equal(ms.handle, "acme");

  const custom = normalizeStore("https://www.Acme.com/collections/all?x=1");
  assert.equal(custom.kind, "custom");
  assert.equal(custom.domain, "acme.com");

  assert.equal(normalizeStore("not a domain !!").kind, "invalid");
});

test("scoreSignup: custom domain + aligned operator email = hot", () => {
  const r = scoreSignup({ email: "jo@acme.com", storeUrl: "acme.com" });
  assert.equal(r.tier, "hot");
  assert.ok(r.score >= 5);
  assert.ok(r.signals.some((s) => s.code === "aligned:email-matches-store"));
  // even a hot lead still needs the human-qualified ICP facts
  assert.ok(r.needs.includes("confirm-gmv-1to20m"));
  assert.ok(r.needs.includes("confirm-single-market"));
});

test("scoreSignup: myshopify + branded (non-matching) email = warm", () => {
  const r = scoreSignup({ email: "jo@acmebrand.com", storeUrl: "acme.myshopify.com" });
  assert.equal(r.tier, "warm");
});

test("scoreSignup: myshopify + freemail = low", () => {
  const r = scoreSignup({ email: "jo@gmail.com", storeUrl: "acme" });
  assert.equal(r.tier, "low");
});

test("scoreSignup: no store = needs_info regardless of email", () => {
  const branded = scoreSignup({ email: "jo@acme.com", storeUrl: "" });
  assert.equal(branded.tier, "needs_info");
  assert.ok(branded.needs.includes("get-store-url"));
});

test("rankPipeline orders by tier then score, and tallies byTier", () => {
  const pipeline = rankPipeline([
    { email: "c@gmail.com", storeUrl: "c" },              // low
    { email: "a@acme.com", storeUrl: "acme.com" },        // hot (aligned)
    { email: "b@brand.com", storeUrl: "shop.myshopify.com" }, // warm
    { email: "d@acme.com", storeUrl: "" },                // needs_info
  ]);
  assert.equal(pipeline.total, 4);
  assert.deepEqual(
    pipeline.ranked.map((r) => r.tier),
    ["hot", "warm", "low", "needs_info"],
  );
  assert.equal(pipeline.byTier.hot, 1);
  assert.equal(pipeline.byTier.warm, 1);
  assert.equal(pipeline.byTier.low, 1);
  assert.equal(pipeline.byTier.needs_info, 1);
});

test("summarize is PII-free (no emails) and counts correctly", () => {
  const pipeline = rankPipeline([
    { email: "a@acme.com", storeUrl: "acme.com" },
    { email: "b@gmail.com", storeUrl: "b" },
  ]);
  const sum = summarize(pipeline);
  const json = JSON.stringify(sum);
  assert.ok(!json.includes("@"), "summary must not contain emails");
  assert.equal(sum.total, 2);
  assert.equal(sum.stores.customDomain, 1);
  assert.equal(sum.stores.myshopify, 1);
  assert.equal(sum.email.branded, 1);
  assert.equal(sum.email.freemail, 1);
});

test("formatPipeline: counts mode omits emails; full mode lists them", () => {
  const pipeline = rankPipeline([{ email: "a@acme.com", storeUrl: "acme.com" }]);
  const counts = formatPipeline(pipeline, { withEmails: false });
  assert.ok(!counts.includes("a@acme.com"));
  const full = formatPipeline(pipeline, { withEmails: true });
  assert.ok(full.includes("a@acme.com"));
});
