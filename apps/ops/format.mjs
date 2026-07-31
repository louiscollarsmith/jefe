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

// Built-for-Shopify admin-performance bar: each Core Web Vital's 75th percentile
// must clear Google's "good" threshold — LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1.
// These are our BFS targets; the p75/28d panel grades against them.
// NOTE: exact values + measurement basis (p75 / window / min-sample) are being
// confirmed with chat 6 (growth) — adjust HERE when they land; nothing else moves.
export const BFS_WEB_VITAL_TARGETS = { LCP: 2500, INP: 200, CLS: 0.1 };

/** Below this many samples a p75 isn't meaningful to grade — shown as "…". */
export const BFS_MIN_SAMPLES = 50;

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
