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
