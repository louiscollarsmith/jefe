import assert from "node:assert/strict";
import test from "node:test";
import { renderMorningBriefEmail } from "../app/lib/email/morning-brief.server.js";
import { formatMetricLine, resolveBriefReplyTo } from "../app/lib/notifications/morning-brief-sender.server.js";

const base = {
  storeName: "Everdew",
  appUrl: "https://app.mynamejefe.com/?shop=everdew.myshopify.com",
  unsubscribeUrl: "https://app.mynamejefe.com/e/unsubscribe?t=tok",
  humanEmail: "hola@mynamejefe.com",
};

test("brief renders the move + reply loop + human door; signs — Jefe (never a person's name)", () => {
  const r = renderMorningBriefEmail({
    ...base,
    move: { headline: "Mark down 4 dead-stock variants to clear £310", why: "£310 tied up, no sale in 60+ days" },
  });
  assert.match(r.text, /Mark down 4 dead-stock variants to clear £310/);
  assert.match(r.text, /£310 tied up/);
  assert.match(r.text, /— Jefe/);
  assert.match(r.text, /hola@mynamejefe\.com/); // human door
  assert.match(r.text, /unsubscribe\?t=tok/);
  assert.match(r.html, /Mark down 4 dead-stock variants/);
  assert.ok(r.headers["List-Unsubscribe"]); // RFC 8058 one-click headers present
});

test("with no move, the brief is honestly 'all clear' — no fabricated action", () => {
  const r = renderMorningBriefEmail({ ...base, move: null });
  assert.match(r.text, /Nothing needs a decision from you today/);
  assert.match(r.subject, /all clear/);
});

test("merchant-derived content is HTML-escaped", () => {
  const r = renderMorningBriefEmail({ ...base, move: { headline: "A & B <script>", why: null } });
  assert.match(r.html, /A &amp; B &lt;script&gt;/);
  assert.ok(!r.html.includes("<script>"));
});

test("resolveBriefReplyTo points at the AI address ONLY once inbound is live (#15 constraint)", () => {
  // inbound dark → human reply-to
  assert.equal(resolveBriefReplyTo({ RESEND_REPLY_TO: "matt@x.com" }), "matt@x.com");
  // inbound live + AI address configured → the Door-A AI address
  assert.equal(
    resolveBriefReplyTo({ RESEND_REPLY_TO: "matt@x.com", ENABLE_INBOUND_EMAIL: "true", INBOUND_AI_ADDRESS: "jefe@x.com" }),
    "jefe@x.com",
  );
  // inbound flag on but no AI address yet → fall back to human (never point at a missing MX)
  assert.equal(
    resolveBriefReplyTo({ RESEND_REPLY_TO: "matt@x.com", ENABLE_INBOUND_EMAIL: "true" }),
    "matt@x.com",
  );
});

test("formatMetricLine states real 30-day orders/revenue and omits gracefully", () => {
  assert.equal(
    formatMetricLine({ orders: 46, revenue: 2762, currency: "GBP" }),
    "46 orders and £2,762 in the last 30 days",
  );
  // singular order + zero revenue omitted
  assert.equal(formatMetricLine({ orders: 1, revenue: 0, currency: "GBP" }), "1 order in the last 30 days");
  // no orders → nothing honest to say
  assert.equal(formatMetricLine({ orders: 0, revenue: 500, currency: "GBP" }), null);
  // missing revenue → orders only
  assert.equal(formatMetricLine({ orders: 12, revenue: null, currency: "USD" }), "12 orders in the last 30 days");
  assert.match(formatMetricLine({ orders: 3, revenue: 1500, currency: "USD" }), /\$1,500/);
});
