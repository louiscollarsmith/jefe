import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReplySubject,
  JEFE_IDENTITY_LINE,
  renderJefeReplyEmail,
} from "../app/lib/email/inbound/reply.server.js";

const BASE = {
  replyText: "You have 12 units of dead stock across 3 SKUs.",
  originalSubject: "Question about my stock",
  teamAddress: "team@mynamejefe.com",
  unsubscribeUrl: "https://app.mynamejefe.com/e/unsubscribe?t=tok",
};

test("buildReplySubject prefixes Re: without doubling it", () => {
  assert.equal(buildReplySubject("Hello"), "Re: Hello");
  assert.equal(buildReplySubject("Re: Hello"), "Re: Hello");
  assert.equal(buildReplySubject("RE: Hello"), "RE: Hello");
  assert.equal(buildReplySubject(""), "Re: your note to Jefe");
  assert.equal(buildReplySubject(null), "Re: your note to Jefe");
});

test("the reply self-identifies as the AI and signs — Jefe (never a human name)", () => {
  const { html, text } = renderJefeReplyEmail(BASE);
  assert.ok(text.startsWith(JEFE_IDENTITY_LINE), "text leads with the AI identity line");
  assert.ok(html.includes(JEFE_IDENTITY_LINE), "html carries the AI identity line");
  assert.ok(text.includes("— Jefe"), "text signs — Jefe");
  assert.ok(html.includes("— Jefe"), "html signs — Jefe");
});

test("the human door (Door B, team@) is always present in both parts", () => {
  const { html, text } = renderJefeReplyEmail(BASE);
  assert.ok(text.includes("team@mynamejefe.com"));
  assert.ok(html.includes("team@mynamejefe.com"));
  assert.match(text, /Talk to the Jefe team/);
});

test("the merchant's reply body is included and HTML-escaped", () => {
  const { html, text } = renderJefeReplyEmail({
    ...BASE,
    replyText: "1 < 2 & \"quotes\"",
  });
  assert.ok(text.includes('1 < 2 & "quotes"'));
  assert.ok(html.includes("1 &lt; 2 &amp; &quot;quotes&quot;"));
  assert.ok(!html.includes("1 < 2 &"), "raw unescaped body must not appear in html");
});

test("an unsubscribe link is included when provided, omitted otherwise", () => {
  const withUnsub = renderJefeReplyEmail(BASE);
  assert.ok(withUnsub.text.includes(BASE.unsubscribeUrl));
  assert.ok(withUnsub.html.includes(BASE.unsubscribeUrl));

  const withoutUnsub = renderJefeReplyEmail({ ...BASE, unsubscribeUrl: undefined });
  assert.ok(!withoutUnsub.text.includes("Turn off these emails"));
  assert.ok(!withoutUnsub.html.includes("Turn off these emails"));
});

test("the subject is a Re: of the original", () => {
  assert.equal(renderJefeReplyEmail(BASE).subject, "Re: Question about my stock");
});
