import assert from "node:assert/strict";
import test from "node:test";
import {
  actionProgressLabel,
  actionStatusLabel,
  actionStatusSeverity,
  bfsWebVitalStatus,
  churnReasonLabel,
  classifyMerchantHealth,
  esc,
  fmtMs,
  formatActionOutcome,
  formatAccessLog,
  formatConversationContext,
  formatConversationSnippet,
  formatProposalSummary,
  formatStructuredOperation,
  formatSuccessSignal,
  formatVitalValue,
  formatWriteCounts,
  money,
  optionList,
  safeEqual,
  sparkline,
} from "../format.mjs";

test("esc: escapes HTML metacharacters, ampersand first (no double-escape)", () => {
  assert.equal(esc('<a href="x">&'), "&lt;a href=&quot;x&quot;&gt;&amp;");
  // & must be escaped before <, else &lt; would become &amp;lt;
  assert.equal(esc("a & b < c"), "a &amp; b &lt; c");
});

test("esc: null/undefined become empty string, numbers stringify", () => {
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(0), "0");
  assert.equal(esc(42), "42");
});

test("money: currency symbol, 0 dp, thousands separators, rounding", () => {
  assert.equal(money(1234.5, "USD"), "$1,235");
  assert.equal(money(1000, "GBP"), "£1,000");
  assert.equal(money(1500000, "EUR"), "€1,500,000");
});

test("money: null/0 amount coerces to 0; unknown currency prefixes the code", () => {
  assert.equal(money(null, "EUR"), "€0");
  assert.equal(money(0), "0");
  assert.equal(money(50, "XYZ"), "XYZ 50");
});

test("fmtMs: null dash, ms under 1s, seconds at/above 1s", () => {
  assert.equal(fmtMs(null), "—");
  assert.equal(fmtMs(undefined), "—");
  assert.equal(fmtMs(0), "0ms");
  assert.equal(fmtMs(999), "999ms");
  assert.equal(fmtMs(1000), "1.0s");
  assert.equal(fmtMs(1500), "1.5s");
});

test("safeEqual: equal strings true, any difference false, length-mismatch false", () => {
  assert.equal(safeEqual("hunter2", "hunter2"), true);
  assert.equal(safeEqual("", ""), true);
  assert.equal(safeEqual("hunter2", "hunter3"), false);
  assert.equal(safeEqual("hunter2", "hunter22"), false);
});

test("optionList: marks the selected value and HTML-escapes values", () => {
  assert.equal(
    optionList(["a", "b"], "b"),
    '<option value="a">a</option><option value="b" selected>b</option>',
  );
  assert.equal(
    optionList(["<x>"], null),
    '<option value="&lt;x&gt;">&lt;x&gt;</option>',
  );
  assert.equal(optionList([], "x"), "");
});

test("sparkline: empty/nullish input renders nothing", () => {
  assert.equal(sparkline([]), "");
  assert.equal(sparkline(null), "");
  assert.equal(sparkline(undefined), "");
});

test("sparkline: renders a self-contained svg polyline", () => {
  const svg = sparkline([1, 2, 3, 2]);
  assert.match(svg, /^<svg class="spark"/);
  assert.match(svg, /<polyline points="[\d, ]+"/);
  // 4 values -> 4 "x,y" points
  const pts = svg.match(/points="([^"]+)"/)[1].trim().split(" ");
  assert.equal(pts.length, 4);
});

test("sparkline: single value does not divide by zero", () => {
  const svg = sparkline([5]);
  assert.match(svg, /<polyline points="0,\d+"/);
});

test("sparkline: honours width/height/stroke overrides", () => {
  const svg = sparkline([1, 2], { w: 100, h: 20, stroke: "#ff0000" });
  assert.match(svg, /width="100"/);
  assert.match(svg, /height="20"/);
  assert.match(svg, /stroke="#ff0000"/);
});

test("churnReasonLabel: known codes map to labels; unknown/empty fall back", () => {
  assert.equal(churnReasonLabel("too_early"), "Too early for us");
  assert.equal(churnReasonLabel("no_value"), "Didn't see the value");
  assert.equal(churnReasonLabel("too_complex"), "Too complex");
  assert.equal(churnReasonLabel("broke"), "Something broke");
  // Unknown code renders itself (forward-compatible), null/empty → em dash.
  assert.equal(churnReasonLabel("brand_new_reason"), "brand_new_reason");
  assert.equal(churnReasonLabel(null), "—");
  assert.equal(churnReasonLabel(""), "—");
});

test("formatAccessLog: PII-safe audit line, drops empty fields", () => {
  const parsed = JSON.parse(
    formatAccessLog({
      ts: "2026-07-31T00:00:00.000Z",
      outcome: "granted",
      method: "GET",
      path: "/merchant",
      shop: "jaspers-market.myshopify.com",
      ip: "203.0.113.7",
    }),
  );
  assert.equal(parsed.ev, "ops_access");
  assert.equal(parsed.outcome, "granted");
  assert.equal(parsed.path, "/merchant");
  assert.equal(parsed.shop, "jaspers-market.myshopify.com");
  assert.equal(parsed.ip, "203.0.113.7");
  // Empty fields are omitted (not emitted as ""), keeping the audit line lean.
  const denied = JSON.parse(
    formatAccessLog({ ts: "t", outcome: "denied", path: "/", shop: "", ip: "" }),
  );
  assert.equal(denied.outcome, "denied");
  assert.ok(!("shop" in denied) && !("ip" in denied));
});

test("bfsWebVitalStatus grades p75 against the BFS target (pass/fail/insufficient)", () => {
  assert.equal(bfsWebVitalStatus("LCP", 2000, 100).state, "pass");
  assert.equal(bfsWebVitalStatus("LCP", 2500, 100).state, "pass"); // inclusive target
  assert.equal(bfsWebVitalStatus("LCP", 3140, 100).state, "fail"); // current prod value
  assert.equal(bfsWebVitalStatus("INP", 150, 100).state, "pass");
  assert.equal(bfsWebVitalStatus("CLS", 0.05, 100).state, "pass");
  assert.equal(bfsWebVitalStatus("CLS", 0.3, 100).state, "fail");
});

test("bfsWebVitalStatus needs enough samples + a known metric", () => {
  assert.equal(bfsWebVitalStatus("LCP", 2000, 10).state, "insufficient"); // too few
  assert.equal(bfsWebVitalStatus("LCP", null, 100).state, "insufficient"); // no data
  assert.equal(bfsWebVitalStatus("FCP", 1000, 100).state, "unknown"); // not a graded CWV
  const ok = bfsWebVitalStatus("lcp", 2000, 100);
  assert.equal(ok.target, 2500); // case-insensitive + carries the target
});

test("bfsWebVitalStatus enforces the BFS 100-sample minimum at the boundary", () => {
  assert.equal(bfsWebVitalStatus("LCP", 2000, 99).state, "insufficient"); // < 100 calls
  assert.equal(bfsWebVitalStatus("LCP", 2000, 100).state, "pass"); // exactly 100 grades
});

test("formatVitalValue: CLS as ratio, others as ms, junk as em dash", () => {
  assert.equal(formatVitalValue("LCP", 3140), "3140ms");
  assert.equal(formatVitalValue("CLS", 0.2), "0.200");
  assert.equal(formatVitalValue("INP", 40), "40ms");
  assert.equal(formatVitalValue("LCP", null), "—");
});

test("classifyMerchantHealth: healthy, churned, missing and not-ready states", () => {
  assert.equal(classifyMerchantHealth({ shop: null }).state, "no_record");
  assert.equal(classifyMerchantHealth({ shop: { status: "uninstalled" } }).state, "churned");
  assert.equal(
    classifyMerchantHealth({ shop: { status: "active", backfill_completed_at: null } }).state,
    "not_ready",
  );
  assert.equal(
    classifyMerchantHealth({
      shop: {
        status: "active",
        onboarding_completed_at: "2026-08-11T10:00:00Z",
        backfill_completed_at: "2026-08-11T10:00:00Z",
      },
      activeBeliefCount: 12,
    }).state,
    "healthy",
  );
});

test("classifyMerchantHealth: live failures and stale or missing memory need attention", () => {
  const readyShop = {
    status: "active",
    onboarding_completed_at: "2026-08-11T10:00:00Z",
    backfill_completed_at: "2026-08-11T10:00:00Z",
  };
  assert.equal(
    classifyMerchantHealth({ shop: readyShop, failedGenerationRuns: 1, activeBeliefCount: 12 }).state,
    "needs_attention",
  );
  assert.equal(
    classifyMerchantHealth({ shop: readyShop, failedActions: 1, activeBeliefCount: 12 }).state,
    "needs_attention",
  );
  assert.equal(
    classifyMerchantHealth({ shop: readyShop, staleMemory: true, activeBeliefCount: 12 }).state,
    "needs_attention",
  );
  assert.equal(
    classifyMerchantHealth({ shop: readyShop, activeBeliefCount: 0 }).state,
    "needs_attention",
  );
});

test("action status helpers label known statuses and assign severity", () => {
  assert.equal(actionStatusLabel("proposed"), "Proposed");
  assert.equal(actionStatusLabel("partially_applied"), "Partially applied");
  assert.equal(actionStatusLabel("brand_new_status"), "brand new status");
  assert.equal(actionStatusSeverity("applied"), "good");
  assert.equal(actionStatusSeverity("failed"), "warn");
  assert.equal(actionStatusSeverity("rejected"), "muted");
});

test("actionProgressLabel covers every action execution state and missing outcome", () => {
  assert.match(actionProgressLabel({ status: "proposed" }), /waiting for approval/);
  assert.match(actionProgressLabel({ status: "approved" }), /waiting for execution/);
  assert.match(actionProgressLabel({ status: "applied" }), /No measured outcome recorded yet/);
  assert.match(
    actionProgressLabel({
      status: "applied",
      outcomeStatus: "measured",
      outcome: { variantsCleared: 4, variantsSold: 2, unitsMoved: 5, revenueRecovered: 200, effectivenessRatePercent: 50 },
    }),
    /2 of 4 cleared products sold/,
  );
  assert.match(actionProgressLabel({ status: "partially_applied" }), /Partially applied/);
  assert.match(actionProgressLabel({ status: "failed", error: "Shopify rejected it" }), /Failed - Shopify rejected it/);
  assert.match(actionProgressLabel({ status: "reverted" }), /Reverted/);
  assert.match(actionProgressLabel({ status: "rejected" }), /Rejected by merchant/);
  assert.match(actionProgressLabel({ status: "superseded" }), /Superseded/);
});

test("formatSuccessSignal handles valid, partial and malformed values", () => {
  assert.equal(
    formatSuccessSignal({ description: "Clear old stock", target: "20 units", timeframe: "30 days" }),
    "Clear old stock · target: 20 units · 30 days",
  );
  assert.equal(formatSuccessSignal({ target: "£1,000 recovered" }), "target: £1,000 recovered");
  assert.equal(formatSuccessSignal("not-json"), "No success signal recorded.");
  assert.equal(formatSuccessSignal({}), "No success signal recorded.");
});

test("formatActionOutcome and formatProposalSummary report stored data only", () => {
  assert.equal(formatActionOutcome(null), "No measured outcome recorded yet.");
  assert.equal(
    formatActionOutcome({ variantsCleared: 3, variantsSold: 1, unitsMoved: 2, revenueRecovered: 99.5, effectivenessRatePercent: 33.2 }, "GBP"),
    "1 of 3 cleared products sold · 2 units moved · £100 recovered · 33% effectiveness",
  );
  assert.equal(formatProposalSummary(null), "No proposal summary recorded.");
  assert.equal(
    formatProposalSummary({ variantCount: 2, markdownPercent: 30, totalTrappedCapital: 800, totalProjectedRecovery: 560 }, "USD"),
    "2 products · -30% · $800 tied up · $560 projected recovery",
  );
});

test("formatWriteCounts supports row arrays, records and empty inputs", () => {
  assert.equal(
    formatWriteCounts([
      { status: "applied", n: 2 },
      { status: "failed", n: "1" },
      { status: "skipped_drift", n: 1 },
    ]),
    "2 applied · 1 drift skipped · 1 failed",
  );
  assert.equal(formatWriteCounts({ pending: 3, applied: 1 }), "3 pending · 1 applied");
  assert.equal(formatWriteCounts([]), "No writes recorded.");
});

test("new ops helper output is escaped by the render boundary", () => {
  const rawSignal = formatSuccessSignal({ description: "<script>alert(1)</script>" });
  assert.equal(esc(rawSignal), "&lt;script&gt;alert(1)&lt;/script&gt;");
  const rawFailure = actionProgressLabel({ status: "failed", error: "<b>bad</b>" });
  assert.equal(esc(rawFailure), "Failed - &lt;b&gt;bad&lt;/b&gt;");
});

test("formatConversationSnippet prefers safe merchant summaries, falls back to content and caps length", () => {
  assert.equal(
    formatConversationSnippet({ role: "merchant", safe_summary: "Asked about markdown scope", content: "Longer raw message" }),
    "Asked about markdown scope",
  );
  assert.equal(
    formatConversationSnippet({ content: "Can you explain why this plan uses a 30% markdown?" }),
    "Can you explain why this plan uses a 30% markdown?",
  );
  assert.equal(formatConversationSnippet({ content: "" }), "No message content recorded.");
  assert.equal(formatConversationSnippet({ content: "a ".repeat(100) }, 30), "a a a a a a a a a a a a a a...");
});

test("formatConversationSnippet shows the saved assistant reply over generic operation summaries", () => {
  assert.equal(
    formatConversationSnippet({
      role: "assistant",
      safe_summary: "LLM action-scoped reply.",
      content: "Jefe chose the 30% markdown because these products have held stock for 90 days with no recent sales.",
    }),
    "Jefe chose the 30% markdown because these products have held stock for 90 days with no recent sales.",
  );
  assert.equal(
    formatConversationSnippet({
      safe_summary: "LLM action-scoped reply.",
      content: "Order 6 units of each product if you want 60 days of cover.",
    }),
    "Order 6 units of each product if you want 60 days of cover.",
  );
});

test("formatConversationSnippet output is escaped by the render boundary", () => {
  assert.equal(
    esc(formatConversationSnippet({ content: "Why <b>these</b> products?" })),
    "Why &lt;b&gt;these&lt;/b&gt; products?",
  );
});

test("formatConversationContext visualises plan/action chat linkage", () => {
  assert.equal(formatConversationContext({}, "onboarding_plan"), "Onboarding plan thread");
  assert.equal(
    formatConversationContext(
      {
        recommendationId: "rec-1234567890abcdef",
        actionRunId: "run-abcdef1234567890",
        planEvidenceSnapshotId: "snap-1234567890",
      },
      "action:rec-1234567890abcdef",
    ),
    "Thread key rec-12345678 · Recommendation rec-12345678 · Action run run-abcdef12 · Evidence snapshot snap-1234567",
  );
  assert.equal(formatConversationContext(null, ""), "No chat context recorded.");
});

test("formatStructuredOperation visualises assistant action-chat metadata", () => {
  assert.equal(formatStructuredOperation(null), "");
  assert.equal(
    formatStructuredOperation({
      operationType: "action_chat_reply",
      source: "llm",
      recommendationId: "rec-1234567890abcdef",
      actionRunId: "run-abcdef1234567890",
    }),
    "action chat reply · source llm · Recommendation rec-12345678 · Action run run-abcdef12",
  );
});

test("chat linkage helpers are escaped by the render boundary", () => {
  assert.equal(
    esc(formatConversationContext({ recommendationId: "<script>" }, "action:<bad>")),
    "Thread key &lt;bad&gt; · Recommendation &lt;script&gt;",
  );
  assert.equal(
    esc(formatStructuredOperation({ operationType: "<b>reply</b>", source: "<img>" })),
    "&lt;b&gt;reply&lt;/b&gt; · source &lt;img&gt;",
  );
});
