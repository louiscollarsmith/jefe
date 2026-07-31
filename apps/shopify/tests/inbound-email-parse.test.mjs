import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyDoor,
  evaluateInboundAuth,
  extractEmailAddress,
  htmlToText,
  parseInboundEmail,
  stripQuotedReply,
} from "../app/lib/email/inbound/parse.server.js";

test("extractEmailAddress handles plain, display-name and object shapes", () => {
  assert.equal(extractEmailAddress("Merchant@Example.com"), "merchant@example.com");
  assert.equal(extractEmailAddress("Jane Doe <jane@shop.com>"), "jane@shop.com");
  assert.equal(extractEmailAddress({ address: "x@y.com", name: "X" }), "x@y.com");
  assert.equal(extractEmailAddress({ email: "z@y.com" }), "z@y.com");
  assert.equal(extractEmailAddress("not-an-email"), "");
  assert.equal(extractEmailAddress(null), "");
});

test("parseInboundEmail normalises a Resend-style payload (data wrapper, array to, header id)", () => {
  const res = parseInboundEmail({
    type: "email.received",
    data: {
      from: "Jane <jane@shop.com>",
      to: ["jefe@reply.mynamejefe.com"],
      subject: "Question about my stock",
      text: "How much dead stock do I have?",
      headers: [{ name: "Message-ID", value: "<abc@mail>" }],
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.email.from, "jane@shop.com");
  assert.equal(res.email.to, "jefe@reply.mynamejefe.com");
  assert.equal(res.email.subject, "Question about my stock");
  assert.equal(res.email.text, "How much dead stock do I have?");
  assert.equal(res.email.messageId, "<abc@mail>");
});

test("parseInboundEmail prefers an explicit email_id, and works without a data wrapper", () => {
  const res = parseInboundEmail({
    from: "a@b.com",
    to: "team@mynamejefe.com",
    subject: "hi",
    text: "hello",
    email_id: "re_123",
  });
  assert.equal(res.ok, true);
  assert.equal(res.email.messageId, "re_123");
  assert.equal(res.email.to, "team@mynamejefe.com");
});

test("parseInboundEmail falls back to HTML when there is no text part", () => {
  const res = parseInboundEmail({
    data: { from: "a@b.com", to: "jefe@mynamejefe.com", html: "<p>Hello <b>there</b></p>" },
  });
  assert.equal(res.ok, true);
  assert.equal(res.email.text, "Hello there");
});

test("parseInboundEmail rejects missing sender / recipient", () => {
  assert.deepEqual(parseInboundEmail({ data: { to: "x@y.com" } }), { ok: false, reason: "no_sender" });
  assert.deepEqual(parseInboundEmail({ data: { from: "x@y.com" } }), { ok: false, reason: "no_recipient" });
  assert.deepEqual(parseInboundEmail(null), { ok: false, reason: "malformed_payload" });
});

test("htmlToText strips tags and collapses whitespace", () => {
  assert.equal(htmlToText("<div>Hi<br>there</div><p>friend</p>"), "Hi\nthere\nfriend");
});

test("stripQuotedReply keeps only the new text above the quoted history", () => {
  const body = [
    "Thanks, that helps!",
    "",
    "On Mon, Jul 31, Jefe wrote:",
    "> This is Jefe, your AI eCommerce manager.",
    "> Here is your answer.",
  ].join("\n");
  assert.equal(stripQuotedReply(body), "Thanks, that helps!");
});

test("stripQuotedReply keeps the original if trimming would empty it", () => {
  assert.equal(stripQuotedReply("> only quoted"), "> only quoted");
});

test("evaluateInboundAuth passes on SPF or DKIM pass, fails closed otherwise", () => {
  assert.equal(evaluateInboundAuth({ spf: "pass", dkim: null, dmarc: null, source: "fields" }).pass, true);
  assert.equal(evaluateInboundAuth({ spf: null, dkim: "pass", dmarc: null, source: "fields" }).pass, true);
  assert.equal(evaluateInboundAuth({ spf: "pass", dkim: null, dmarc: "fail", source: "fields" }).pass, false);
  assert.equal(evaluateInboundAuth({ spf: "fail", dkim: "fail", dmarc: "fail", source: "fields" }).reason, "auth_fail");
  assert.deepEqual(evaluateInboundAuth({ spf: null, dkim: null, dmarc: null, source: "none" }), {
    pass: false,
    reason: "auth_unknown",
  });
});

test("auth results can come from the Authentication-Results header", () => {
  const res = parseInboundEmail({
    data: {
      from: "a@b.com",
      to: "jefe@mynamejefe.com",
      text: "hi",
      headers: [
        { name: "Authentication-Results", value: "mx.google.com; spf=pass smtp.mailfrom=b.com; dkim=pass; dmarc=pass" },
      ],
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.email.auth.source, "authentication-results");
  assert.equal(evaluateInboundAuth(res.email.auth).pass, true);
});

test("classifyDoor routes by configured address then by local-part", () => {
  const env = {
    INBOUND_AI_ADDRESS: "jefe@reply.mynamejefe.com",
    INBOUND_TEAM_ADDRESS: "team@mynamejefe.com",
  };
  assert.equal(classifyDoor("jefe@reply.mynamejefe.com", env), "ai");
  assert.equal(classifyDoor("team@mynamejefe.com", env), "team");
  // local-part fallback tolerates a different subdomain than configured
  assert.equal(classifyDoor("jefe@mail.mynamejefe.com", env), "ai");
  assert.equal(classifyDoor("humans@mynamejefe.com", env), "team");
  assert.equal(classifyDoor("sales@somewhere.com", env), "unknown");
  assert.equal(classifyDoor("not-an-email", env), "unknown");
});
