// Pure formatting / HTML / render helpers for the ops panel.
//
// Extracted from server.mjs so they can be unit-tested without importing
// server.mjs (which opens a Postgres pool and starts the HTTP listener on
// import). Everything here is pure: no DB, no env, no I/O — same input, same
// output — which is exactly what makes it safe to lock down with tests.

import crypto from "node:crypto";

/**
 * HTML-escape a value for safe interpolation into markup.
 * @param {unknown} value
 */
export function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const CCY = { GBP: "£", USD: "$", EUR: "€", CAD: "C$", AUD: "A$" };

/** Money with the store's currency symbol (0 dp — these are portfolio-level). */
export function money(n, ccy) {
  const sym = CCY[ccy] || (ccy ? `${ccy} ` : "");
  return `${sym}${Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

/** Human latency: ms under 1s, else seconds. */
export function fmtMs(ms) {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** Timing-safe string compare (used by HTTP Basic auth). */
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** `<option>` list for a `<select>`, values + labels HTML-escaped. */
export function optionList(values, selected) {
  return values
    .map(
      (v) =>
        `<option value="${esc(v)}"${v === selected ? " selected" : ""}>${esc(v)}</option>`,
    )
    .join("");
}

/** Tiny inline-SVG sparkline (self-contained; no external libs). */
export function sparkline(values, opts = {}) {
  const w = opts.w ?? 170;
  const h = opts.h ?? 34;
  const stroke = opts.stroke ?? "#2d6cdf";
  if (!values || !values.length) return "";
  const max = Math.max(...values.map(Number), 1);
  const n = values.length;
  const dx = n > 1 ? w / (n - 1) : 0;
  const pts = values
    .map((v, idx) => {
      const x = Math.round(idx * dx);
      const y = Math.round(h - 2 - (Number(v) / max) * (h - 4));
      return `${x},${y}`;
    })
    .join(" ");
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

// Uninstall-feedback reason codes → labels. MIRROR of FEEDBACK_REASONS in
// apps/shopify/app/lib/email/feedback.server.js — the codes are LOCKED and
// shared (farewell-email template ↔ this ops readback). Edit both together,
// never one alone.
const CHURN_REASON_LABELS = {
  too_early: "Too early for us",
  no_value: "Didn't see the value",
  too_complex: "Too complex",
  broke: "Something broke",
};

/**
 * Human label for an uninstall-feedback reason code. Unknown/empty codes fall
 * back to the raw code (or an em dash) so a newly-added code still renders
 * something rather than blanking out.
 */
export function churnReasonLabel(code) {
  return CHURN_REASON_LABELS[code] || code || "—";
}

// Built-for-Shopify admin-performance bar (confirmed against the BFS checklist,
// 2026-07-31 via growth): each Core Web Vital's 75th percentile must clear
// Google's "good" threshold — LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1 — measured at
// p75 over a trailing 28-day window with ≥100 measurements ("Pass with 100+
// calls"). p75 ≤ threshold ≡ "≥75% of loads good"; BFS-qualifying = all three
// p75 within good AND ≥100 samples.
export const BFS_WEB_VITAL_TARGETS = { LCP: 2500, INP: 200, CLS: 0.1 };

/** BFS grades on 28d data with 100+ calls; below that a p75 isn't gradeable. */
export const BFS_MIN_SAMPLES = 100;

/**
 * Grade a Core Web Vital's p75 against the BFS target (lower is better for all
 * three). Returns a state: "pass" (p75 ≤ target, enough samples), "fail" (over),
 * "insufficient" (too few samples / no data), or "unknown" (not a graded metric).
 *
 * @param {string} metric
 * @param {number | null | undefined} p75
 * @param {number} [n] sample size
 * @returns {{ metric: string, target: number | null, p75: number | null, n: number, state: "pass" | "fail" | "insufficient" | "unknown" }}
 */
export function bfsWebVitalStatus(metric, p75, n = 0) {
  const key = String(metric).toUpperCase();
  const target = BFS_WEB_VITAL_TARGETS[key] ?? null;
  const samples = Number(n) || 0;
  if (target == null) return { metric: key, target: null, p75: null, n: samples, state: "unknown" };
  // null/undefined = no data (Number(null) is 0, which is finite — guard first);
  // a real 0 (e.g. perfect CLS) stays gradeable.
  const value = p75 == null ? NaN : Number(p75);
  if (!Number.isFinite(value) || samples < BFS_MIN_SAMPLES) {
    return { metric: key, target, p75: Number.isFinite(value) ? value : null, n: samples, state: "insufficient" };
  }
  return { metric: key, target, p75: value, n: samples, state: value <= target ? "pass" : "fail" };
}

/** Display a CWV value: CLS as a 3-dp ratio, the rest as integer milliseconds. */
export function formatVitalValue(metric, value) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return String(metric).toUpperCase() === "CLS"
    ? Number(value).toFixed(3)
    : `${Math.round(Number(value))}ms`;
}

/** @param {unknown} v */
function n(v) {
  const value = Number(v ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/** @param {unknown} value */
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/**
 * Classify one merchant for the ops header. The inputs are already aggregate,
 * PII-free counts from read-only SQL.
 *
 * @param {{
 *   shop?: { status?: string | null, onboarding_completed_at?: unknown, onboardingCompletedAt?: unknown, backfill_completed_at?: unknown, backfillCompletedAt?: unknown } | null,
 *   reliabilityEvents24h?: number,
 *   failedGenerationRuns?: number,
 *   failedMemoryRuns?: number,
 *   failedActions?: number,
 *   failedActionWrites?: number,
 *   staleMemory?: boolean,
 *   activeBeliefCount?: number
 * }} input
 */
export function classifyMerchantHealth(input = {}) {
  const shop = input.shop ?? null;
  if (!shop) {
    return {
      state: "no_record",
      label: "no record",
      severity: "muted",
      summary: "No shop record found; showing activity only.",
    };
  }
  if (shop.status === "uninstalled") {
    return {
      state: "churned",
      label: "churned",
      severity: "warn",
      summary: "Shop is uninstalled.",
    };
  }

  const failures =
    n(input.reliabilityEvents24h) +
    n(input.failedGenerationRuns) +
    n(input.failedMemoryRuns) +
    n(input.failedActions) +
    n(input.failedActionWrites);
  const missingMemory =
    (shop.backfill_completed_at || shop.backfillCompletedAt) && n(input.activeBeliefCount) === 0;
  if (failures > 0 || input.staleMemory || missingMemory) {
    return {
      state: "needs_attention",
      label: "needs attention",
      severity: "warn",
      summary: failures > 0
        ? `${failures} live issue${failures === 1 ? "" : "s"} detected.`
        : input.staleMemory
          ? "Merchant Memory has not refreshed recently."
          : "Backfill finished but no active Merchant Memory beliefs were found.",
    };
  }

  if (!(shop.onboarding_completed_at || shop.onboardingCompletedAt) || !(shop.backfill_completed_at || shop.backfillCompletedAt)) {
    return {
      state: "not_ready",
      label: "not ready",
      severity: "info",
      summary: "Install is still moving through onboarding or evidence backfill.",
    };
  }

  return {
    state: "healthy",
    label: "healthy",
    severity: "good",
    summary: "No live issues detected.",
  };
}

const ACTION_STATUS_LABELS = {
  proposed: "Proposed",
  approved: "Approved",
  applied: "Applied",
  partially_applied: "Partially applied",
  reverted: "Reverted",
  failed: "Failed",
  superseded: "Superseded",
  rejected: "Rejected",
};

/** @param {string | null | undefined} status */
export function actionStatusLabel(status) {
  if (!status) return "Unknown";
  return ACTION_STATUS_LABELS[status] || String(status).replaceAll("_", " ");
}

/** @param {string | null | undefined} status */
export function actionStatusSeverity(status) {
  if (status === "failed" || status === "partially_applied") return "warn";
  if (status === "applied") return "good";
  if (status === "reverted" || status === "rejected" || status === "superseded") return "muted";
  return "info";
}

/**
 * @param {{ status?: string | null, outcomeStatus?: string | null, outcome?: unknown, error?: string | null }} action
 * @param {string} [currency]
 */
export function actionProgressLabel(action = {}, currency = "GBP") {
  const status = action.status ?? "unknown";
  if (status === "proposed") return "Proposed - waiting for approval or autonomy.";
  if (status === "approved") return "Approved - waiting for execution.";
  if (status === "failed") {
    return action.error ? `Failed - ${String(action.error).slice(0, 120)}` : "Failed.";
  }
  if (status === "rejected") return "Rejected by merchant; no store write made.";
  if (status === "superseded") return "Superseded by a newer proposal.";
  if (status === "reverted") return "Reverted; previous values restored where recorded.";
  if (status === "applied" || status === "partially_applied") {
    const outcome =
      action.outcomeStatus === "measured"
        ? formatActionOutcome(action.outcome, currency)
        : "No measured outcome recorded yet.";
    return `${actionStatusLabel(status)} - ${outcome}`;
  }
  return actionStatusLabel(status);
}

/**
 * Compact, honest display for a plan success signal.
 * @param {unknown} signal
 */
export function formatSuccessSignal(signal) {
  const sig = record(signal);
  if (!sig) return "No success signal recorded.";
  const description = typeof sig.description === "string" ? sig.description.trim() : "";
  const target = typeof sig.target === "string" ? sig.target.trim() : "";
  const timeframe = typeof sig.timeframe === "string" ? sig.timeframe.trim() : "";
  const parts = [];
  if (description) parts.push(description);
  if (target) parts.push(`target: ${target}`);
  if (timeframe) parts.push(timeframe);
  return parts.length ? parts.join(" · ") : "No success signal recorded.";
}

/**
 * Compact display for an action outcome. Returns an explicit empty state when
 * the ledger has not measured the action yet.
 * @param {unknown} outcome
 * @param {string} [currency]
 */
export function formatActionOutcome(outcome, currency = "GBP") {
  const out = record(outcome);
  if (!out) return "No measured outcome recorded yet.";
  const variantsCleared = n(out.variantsCleared);
  const variantsSold = n(out.variantsSold);
  const unitsMoved = n(out.unitsMoved);
  const recovered = n(out.revenueRecovered);
  const effectiveness = n(out.effectivenessRatePercent);
  const parts = [];
  if (variantsCleared || variantsSold) {
    parts.push(`${variantsSold} of ${variantsCleared} cleared product${variantsCleared === 1 ? "" : "s"} sold`);
  }
  if (unitsMoved) parts.push(`${unitsMoved} unit${unitsMoved === 1 ? "" : "s"} moved`);
  if (recovered) parts.push(`${money(recovered, currency)} recovered`);
  if (effectiveness) parts.push(`${Math.round(effectiveness)}% effectiveness`);
  return parts.length ? parts.join(" · ") : "No measured outcome recorded yet.";
}

/**
 * Compact display for the persisted proposal snapshot. It never re-computes the
 * opportunity; it only reports the values saved with the action row.
 * @param {unknown} summary
 * @param {string} [currency]
 */
export function formatProposalSummary(summary, currency = "GBP") {
  const s = record(summary);
  if (!s) return "No proposal summary recorded.";
  const variants = n(s.variantCount);
  const markdown = Number(s.markdownPercent);
  const trapped = n(s.totalTrappedCapital);
  const recovery = n(s.totalProjectedRecovery);
  const parts = [];
  if (variants) parts.push(`${variants} product${variants === 1 ? "" : "s"}`);
  if (Number.isFinite(markdown)) parts.push(`-${Math.round(markdown)}%`);
  if (trapped) parts.push(`${money(trapped, currency)} tied up`);
  if (recovery) parts.push(`${money(recovery, currency)} projected recovery`);
  return parts.length ? parts.join(" · ") : "No proposal summary recorded.";
}

/**
 * Display action_execution_writes grouped counts.
 * @param {Array<{ status?: string | null, n?: number | string | null }> | Record<string, unknown> | null | undefined} counts
 */
export function formatWriteCounts(counts) {
  /** @type {Record<string, number>} */
  const byStatus = {};
  if (Array.isArray(counts)) {
    for (const row of counts) {
      const status = row?.status ? String(row.status) : "unknown";
      byStatus[status] = (byStatus[status] ?? 0) + n(row?.n);
    }
  } else if (counts && typeof counts === "object") {
    for (const [status, value] of Object.entries(counts)) byStatus[status] = n(value);
  }
  const labels = [
    ["pending", "pending"],
    ["applied", "applied"],
    ["skipped_drift", "drift skipped"],
    ["failed", "failed"],
    ["unknown", "unknown"],
  ];
  const parts = labels
    .filter(([status]) => byStatus[status] > 0)
    .map(([status, label]) => `${byStatus[status]} ${label}`);
  return parts.length ? parts.join(" · ") : "No writes recorded.";
}

/**
 * Render a bounded conversation snippet for Ops. Merchant turns prefer the
 * server-written safe summary; assistant turns prefer the actual saved reply,
 * since summaries for action chat replies often only say "LLM action-scoped
 * reply" and hide the operator-relevant answer.
 * @param {{ role?: string | null, safe_summary?: string | null, safeSummary?: string | null, content?: string | null } | null | undefined} message
 * @param {number} [max]
 */
const GENERIC_ACTION_REPLY_SUMMARIES = new Set([
  "llm action-scoped reply.",
  "fallback action-scoped reply.",
]);

/** @param {unknown} value */
function isGenericActionReplySummary(value) {
  return GENERIC_ACTION_REPLY_SUMMARIES.has(String(value ?? "").trim().toLowerCase());
}

export function formatConversationSnippet(message, max = 320) {
  const isAssistant = String(message?.role || "").toLowerCase() === "assistant";
  const summary = message?.safe_summary ?? message?.safeSummary;
  const content = message?.content;
  const text = String(
    (isAssistant || isGenericActionReplySummary(summary)) && content
      ? content
      : summary ?? content ?? "",
  )
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "No message content recorded.";
  const limit = Number.isFinite(Number(max)) && Number(max) > 20 ? Number(max) : 320;
  return text.length > limit ? `${text.slice(0, limit - 3).trimEnd()}...` : text;
}

/**
 * Shorten stable IDs enough for an operator to compare rows without turning the
 * chat card into a UUID dump. Full IDs remain in the DB and URL params.
 * @param {unknown} value
 */
export function shortRef(value) {
  const s = String(value ?? "").trim();
  if (!s) return "";
  return s.length > 12 ? s.slice(0, 12) : s;
}

/** @param {unknown} value */
function stringField(value) {
  const s = typeof value === "string" ? value.trim() : "";
  return s || "";
}

/**
 * Format the indirect plan/action chat association stored on
 * merchant_memory_conversations.context_json. Action chats are keyed by topic,
 * while the resolved recommendation/action IDs are persisted in context_json.
 *
 * @param {unknown} context
 * @param {string} [topic]
 */
export function formatConversationContext(context, topic = "") {
  const ctx = record(context) || {};
  const topicText = String(topic || "");
  const parts = [];
  if (topicText === "onboarding_plan") parts.push("Onboarding plan thread");
  if (topicText.startsWith("action:")) {
    const topicId = topicText.slice("action:".length).trim();
    if (topicId) parts.push(`Thread key ${shortRef(topicId)}`);
  }

  const recommendationId = stringField(ctx.recommendationId);
  const actionRunId = stringField(ctx.actionRunId) || stringField(ctx.currentActionRunId);
  const planEvidenceSnapshotId = stringField(ctx.planEvidenceSnapshotId);
  if (recommendationId) parts.push(`Recommendation ${shortRef(recommendationId)}`);
  if (actionRunId) parts.push(`Action run ${shortRef(actionRunId)}`);
  if (planEvidenceSnapshotId) parts.push(`Evidence snapshot ${shortRef(planEvidenceSnapshotId)}`);

  return parts.length ? parts.join(" · ") : "No chat context recorded.";
}

/**
 * Format assistant structured_operation_json for Ops. This intentionally keeps
 * the detailed analysis packet out of the UI; it only shows the safe linkage and
 * reply source needed to audit the conversation state.
 *
 * @param {unknown} operation
 */
export function formatStructuredOperation(operation) {
  const op = record(operation);
  if (!op) return "";
  const parts = [];
  const operationType = stringField(op.operationType) || stringField(op.type);
  const source = stringField(op.source);
  const recommendationId = stringField(op.recommendationId);
  const actionRunId = stringField(op.actionRunId);
  if (operationType) parts.push(operationType.replaceAll("_", " "));
  if (source) parts.push(`source ${source}`);
  if (recommendationId) parts.push(`Recommendation ${shortRef(recommendationId)}`);
  if (actionRunId) parts.push(`Action run ${shortRef(actionRunId)}`);
  return parts.join(" · ");
}

/**
 * One structured access-log line for the ops panel (which serves merchant data).
 * PII-safe BY CONSTRUCTION: it records only WHO (source IP), WHAT (request path +
 * the `shop` filter), the outcome (granted/denied) and WHEN — never the panel's
 * data and never the password. Emitted as a single JSON line to stdout so
 * Railway's log drain is the "log access to PII" audit trail the App Store
 * Data-protection attestation needs. Empty fields are dropped to keep lines lean.
 *
 * @param {{ ts: string, outcome: string, method?: string, path?: string, shop?: string, ip?: string }} entry
 */
export function formatAccessLog(entry) {
  const line = { ev: "ops_access", ts: entry.ts, outcome: entry.outcome };
  if (entry.method) line.method = entry.method;
  if (entry.path) line.path = entry.path;
  if (entry.shop) line.shop = entry.shop;
  if (entry.ip) line.ip = entry.ip;
  return JSON.stringify(line);
}
