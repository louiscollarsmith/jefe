// Jefe internal observability panel.
//
// A SEPARATE, gated ops app — deliberately not part of the merchant-facing
// Shopify app, so cross-merchant data can never leak into a merchant's view.
// It renders the activity_events log (written by track() in apps/shopify) with
// filter-by-type / topic / merchant and full-text search over the summary.
//
// Config (env):
//   DATABASE_URL (or DATABASE_PUBLIC_URL) — read access to the Jefe Postgres.
//   OPS_PASSWORD — shared password for HTTP Basic auth. REQUIRED; without it the
//                  panel refuses every request (fail closed).
//   PORT — listen port (default 4000).
//
// v1 auth is a single shared password (fast, fine for an internal tool); Google
// SSO is a documented upgrade.

import http from "node:http";
import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL,
  max: 4,
});

const OPS_PASSWORD = process.env.OPS_PASSWORD || "";
// OPS_PUBLIC=true opens the panel with no login (temporary, founder's call).
// The password stays configured so re-gating later is a single flag flip.
const OPS_PUBLIC = process.env.OPS_PUBLIC === "true";
const PORT = Number(process.env.PORT) || 4000;
const WINDOWS = { "24": "24h", "168": "7d", "720": "30d", "2160": "90d" };

/** @param {string} value */
function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const CCY = { GBP: "£", USD: "$", EUR: "€", CAD: "C$", AUD: "A$" };
/** Money with the store's currency symbol (0 dp — these are portfolio-level). */
function money(n, ccy) {
  const sym = CCY[ccy] || (ccy ? `${ccy} ` : "");
  return `${sym}${Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

/** Human latency: ms under 1s, else seconds. */
function fmtMs(ms) {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** Timing-safe string compare. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function isAuthed(req) {
  if (!OPS_PASSWORD) return false; // fail closed until configured
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const password = decoded.slice(decoded.indexOf(":") + 1);
  return safeEqual(password, OPS_PASSWORD);
}

async function queryEvents(params) {
  const clauses = [];
  const values = [];
  let i = 1;
  if (params.type) {
    clauses.push(`type = $${i++}`);
    values.push(params.type);
  }
  if (params.topic) {
    clauses.push(`topic = $${i++}`);
    values.push(params.topic);
  }
  if (params.shop) {
    clauses.push(`shop_domain ILIKE $${i++}`);
    values.push(`%${params.shop}%`);
  }
  if (params.q) {
    clauses.push(`summary ILIKE $${i++}`);
    values.push(`%${params.q}%`);
  }
  const hours = WINDOWS[params.hours] ? Number(params.hours) : 168;
  clauses.push(`created_at >= now() - ($${i++}::int * interval '1 hour')`);
  values.push(hours);

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await pool.query(
    `SELECT created_at, type, topic, shop_domain, summary
       FROM activity_events ${where}
       ORDER BY created_at DESC
       LIMIT 500`,
    values,
  );
  const topics = await pool.query(
    `SELECT DISTINCT topic FROM activity_events WHERE topic IS NOT NULL ORDER BY topic`,
  );
  const types = await pool.query(
    `SELECT DISTINCT type FROM activity_events ORDER BY type`,
  );
  return {
    rows: rows.rows,
    topics: topics.rows.map((r) => r.topic),
    types: types.rows.map((r) => r.type),
    hours,
  };
}

function optionList(values, selected) {
  return values
    .map(
      (v) =>
        `<option value="${esc(v)}"${v === selected ? " selected" : ""}>${esc(v)}</option>`,
    )
    .join("");
}

/** Top-of-page funnel + engagement + cost snapshot. */
async function queryOverview() {
  const shops = (
    await pool.query(`
      SELECT count(*)::int total,
        count(*) FILTER (WHERE backfill_completed_at IS NOT NULL)::int backfilled,
        count(*) FILTER (WHERE onboarding_completed_at IS NOT NULL)::int onboarded,
        count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int installed_7d
      FROM shops`)
  ).rows[0];
  const active = (
    await pool.query(`
      SELECT count(DISTINCT shop_domain) FILTER (WHERE created_at >= now() - interval '24 hours')::int active_24h,
             count(DISTINCT shop_domain) FILTER (WHERE created_at >= now() - interval '7 days')::int active_7d
      FROM activity_events`)
  ).rows[0];
  const reliability = (
    await pool.query(`
      SELECT
        count(*) FILTER (WHERE (topic='reliability' OR type LIKE '%error' OR type LIKE '%failed') AND created_at >= now() - interval '24 hours')::int errors_24h,
        count(*) FILTER (WHERE (topic='reliability' OR type LIKE '%error' OR type LIKE '%failed') AND created_at >= now() - interval '7 days')::int fails_7d,
        count(*) FILTER (WHERE type IN ('backfill_completed','memory_rebuilt','insights_generated','goals_generated','plan_generated') AND created_at >= now() - interval '7 days')::int ok_7d
      FROM activity_events`)
  ).rows[0];
  const cost = (
    await pool.query(`
      SELECT coalesce(sum(cost_usd), 0)::float cost_7d, count(*)::int calls_7d
      FROM llm_usage_event WHERE created_at >= now() - interval '7 days'`)
  ).rows[0];
  const latency = (
    await pool.query(`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::int p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::int p95
      FROM llm_usage_event WHERE latency_ms IS NOT NULL AND created_at >= now() - interval '7 days'`)
  ).rows[0];
  const costTrend = (
    await pool.query(`
      SELECT coalesce(c.v, 0)::float v
        FROM generate_series(now()::date - interval '13 days', now()::date, interval '1 day') d
        LEFT JOIN (SELECT date_trunc('day', created_at)::date AS bucket, sum(cost_usd) v
                     FROM llm_usage_event WHERE created_at >= now()::date - interval '13 days' GROUP BY 1) c ON c.bucket = d::date
        ORDER BY d`)
  ).rows.map((r) => Number(r.v));
  const activityTrend = (
    await pool.query(`
      SELECT coalesce(e.cnt, 0)::int v
        FROM generate_series(now()::date - interval '13 days', now()::date, interval '1 day') d
        LEFT JOIN (SELECT date_trunc('day', created_at)::date AS bucket, count(*) cnt
                     FROM activity_events WHERE created_at >= now()::date - interval '13 days' GROUP BY 1) e ON e.bucket = d::date
        ORDER BY d`)
  ).rows.map((r) => r.v);
  return { ...shops, ...active, ...reliability, ...cost, ...latency, costTrend, activityTrend };
}

function renderOverview(o) {
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
  const jobTotal = (o.ok_7d || 0) + (o.fails_7d || 0);
  const successRate = jobTotal > 0 ? Math.round((o.ok_7d / jobTotal) * 100) : null;
  const tiles = [
    ["Shops", String(o.total), `${o.installed_7d} new · 7d`, false],
    ["Backfilled", String(o.backfilled), `${pct(o.backfilled, o.total)}% of shops`, false],
    ["Onboarded", String(o.onboarded), `${pct(o.onboarded, o.total)}% of shops`, false],
    ["Active 24h", String(o.active_24h), `${o.active_7d} · 7d`, false],
    ["LLM cost", `$${Number(o.cost_7d || 0).toFixed(4)}`, `${o.calls_7d} calls · 7d · est.`, false],
    ["LLM latency", `${fmtMs(o.p50)} / ${fmtMs(o.p95)}`, `p50 / p95 · 7d`, false],
    ["Job success", successRate == null ? "—" : `${successRate}%`, `${o.ok_7d || 0}/${jobTotal} · 7d`, false],
    ["Errors 24h", String(o.errors_24h || 0), o.errors_24h ? "reliability" : "clear", Boolean(o.errors_24h)],
  ];
  const tileHtml = tiles
    .map(
      ([label, value, sub, warn]) =>
        `<div class="tile${warn ? " tile-warn" : ""}"><div class="tv">${esc(value)}</div><div class="tl">${esc(label)}</div><div class="ts">${esc(sub)}</div></div>`,
    )
    .join("");
  const activityTotal = (o.activityTrend || []).reduce((a, b) => a + Number(b), 0);
  const costTotal = (o.costTrend || []).reduce((a, b) => a + Number(b), 0);
  const strip = `<div class="panels">
      <div class="panel"><div class="ph">Activity · 14d</div>${sparkline(o.activityTrend || [])}<div class="pn">${activityTotal} events</div></div>
      <div class="panel"><div class="ph">LLM cost · 14d</div>${sparkline(o.costTrend || [], { stroke: "#7c5cff" })}<div class="pn">$${costTotal.toFixed(4)} est.</div></div>
    </div>`;
  return `<div class="tiles">${tileHtml}</div>${strip}`;
}

function page(body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jefe · Activity</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif; background:#0f1115; color:#e6e6e6; }
  header { padding:14px 20px; border-bottom:1px solid #23262d; display:flex; gap:12px; align-items:baseline; }
  header h1 { font-size:15px; margin:0; letter-spacing:.02em; }
  header .muted { color:#8b909a; font-size:12px; }
  form { display:flex; flex-wrap:wrap; gap:8px; padding:12px 20px; border-bottom:1px solid #23262d; align-items:center; }
  input, select { background:#171a21; color:#e6e6e6; border:1px solid #2b2f38; border-radius:6px; padding:6px 8px; font:inherit; }
  input[type=search] { min-width:240px; }
  button { background:#2d6cdf; color:#fff; border:0; border-radius:6px; padding:7px 12px; font:inherit; cursor:pointer; }
  a.clear { color:#8b909a; text-decoration:none; align-self:center; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:8px 20px; border-bottom:1px solid #1c1f26; vertical-align:top; }
  th { color:#8b909a; font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.04em; position:sticky; top:0; background:#0f1115; }
  td.time { color:#8b909a; white-space:nowrap; font-variant-numeric:tabular-nums; }
  .pill { display:inline-block; padding:1px 8px; border-radius:999px; background:#1b2330; color:#a9c2ff; font-size:12px; }
  .warn { background:#3a1f22; color:#ffb4b4; }
  .empty { padding:40px 20px; color:#8b909a; }
  .tiles { display:flex; gap:12px; padding:14px 20px; flex-wrap:wrap; border-bottom:1px solid #23262d; }
  .tile { background:#171a21; border:1px solid #23262d; border-radius:8px; padding:10px 16px; min-width:110px; }
  .tile .tv { font-size:22px; font-weight:700; font-variant-numeric:tabular-nums; }
  .tile .tl { color:#8b909a; font-size:11px; text-transform:uppercase; letter-spacing:.05em; margin-top:2px; }
  .tile .ts { color:#6b7280; font-size:11px; margin-top:1px; }
  .muted { color:#8b909a; }
  a.mlink { color:#a9c2ff; text-decoration:none; }
  a.mlink:hover { text-decoration:underline; }
  .panels { display:flex; gap:12px; padding:14px 20px; flex-wrap:wrap; border-bottom:1px solid #23262d; }
  .panel { background:#171a21; border:1px solid #23262d; border-radius:8px; padding:10px 14px; min-width:180px; }
  .panel .ph { color:#8b909a; font-size:11px; text-transform:uppercase; letter-spacing:.05em; margin-bottom:6px; }
  .panel .pn { color:#6b7280; font-size:11px; margin-top:4px; font-variant-numeric:tabular-nums; }
  svg.spark { display:block; }
  table.mini td { padding:3px 0; border:0; font-size:12px; }
  table.mini td:nth-child(2), table.mini td:nth-child(3) { text-align:right; color:#a9c2ff; font-variant-numeric:tabular-nums; padding-left:14px; }
  .tile.tile-warn { border-color:#3a1f22; }
  .tile.tile-warn .tv { color:#ffb4b4; }
  .note { padding:8px 20px; color:#c9a15a; font-size:12px; border-bottom:1px solid #23262d; }
</style></head><body>${body}<script>(function(){
  // Auto-refresh: reload on an interval so the panel stays live without a manual
  // hard-reload. Only when the tab is visible (no background churn); scroll
  // position is preserved across the reload. Tune with ?refresh=<seconds>,
  // disable with ?refresh=0. Filters persist via the query string.
  var K = "jefe-ops-scroll";
  var y = sessionStorage.getItem(K);
  if (y) { window.scrollTo(0, parseInt(y, 10) || 0); sessionStorage.removeItem(K); }
  var secs = parseInt(new URLSearchParams(location.search).get("refresh") || "20", 10);
  if (secs > 0) {
    setInterval(function () {
      if (document.visibilityState === "visible") {
        sessionStorage.setItem(K, String(window.scrollY));
        location.reload();
      }
    }, secs * 1000);
  }
})();</script></body></html>`;
}

function renderDashboard(data, params) {
  const rows = data.rows
    .map((r) => {
      const warn =
        r.topic === "reliability" ||
        String(r.type).endsWith("_failed") ||
        String(r.type).endsWith("_error");
      const time = new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ");
      return `<tr>
        <td class="time">${esc(time)}</td>
        <td><span class="pill${warn ? " warn" : ""}">${esc(r.type)}</span></td>
        <td>${esc(r.topic ?? "")}</td>
        <td>${r.shop_domain ? `<a class="mlink" href="/merchant?shop=${encodeURIComponent(r.shop_domain)}">${esc(r.shop_domain)}</a>` : ""}</td>
        <td>${esc(r.summary ?? "")}</td>
      </tr>`;
    })
    .join("");

  const table = data.rows.length
    ? `<table><thead><tr><th>Time (UTC)</th><th>Type</th><th>Topic</th><th>Merchant</th><th>Summary</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<div class="empty">No events match these filters yet.</div>`;

  return page(`
    <header>
      <h1>Jefe · Activity</h1>
      <span class="muted">${data.rows.length} event${data.rows.length === 1 ? "" : "s"} · last ${WINDOWS[String(data.hours)] ?? data.hours + "h"}</span>
    </header>
    ${data.overview ? renderOverview(data.overview) : ""}
    <form method="get">
      <input type="search" name="q" placeholder="Search summary…" value="${esc(params.q ?? "")}">
      <select name="type"><option value="">All types</option>${optionList(data.types, params.type ?? "")}</select>
      <select name="topic"><option value="">All topics</option>${optionList(data.topics, params.topic ?? "")}</select>
      <input type="text" name="shop" placeholder="Merchant domain…" value="${esc(params.shop ?? "")}">
      <select name="hours">${Object.entries(WINDOWS)
        .map(([h, label]) => `<option value="${h}"${String(data.hours) === h ? " selected" : ""}>${label}</option>`)
        .join("")}</select>
      <button type="submit">Filter</button>
      <a class="clear" href="/">Clear</a>
    </form>
    ${table}`);
}

/** Tiny inline-SVG sparkline (self-contained; no external libs). */
function sparkline(values, opts = {}) {
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

/** One merchant's shop state, event timeline, LLM cost, and 14-day sparklines. */
async function queryMerchant(shopDomain) {
  const shop =
    (
      await pool.query(
        `SELECT id, merchant_id, status, setup_status, created_at,
                onboarding_completed_at, backfill_completed_at,
                cogs_completion_percentage, cogs_confidence_level,
                goals_completed, house_rules_completed
           FROM shops WHERE shop_domain = $1
           ORDER BY (platform = 'shopify') DESC, created_at ASC
           LIMIT 1`,
        [shopDomain],
      )
    ).rows[0] || null;
  const shopId = shop ? shop.id : null;

  const events = (
    await pool.query(
      `SELECT created_at, type, topic, summary
         FROM activity_events WHERE shop_domain = $1
         ORDER BY created_at DESC LIMIT 200`,
      [shopDomain],
    )
  ).rows;

  const cost = (
    await pool.query(
      `SELECT coalesce(sum(cost_usd), 0)::float total_cost,
              count(*)::int calls,
              coalesce(sum(total_tokens), 0)::float tokens,
              round(avg(latency_ms))::int avg_latency
         FROM llm_usage_event WHERE shop_id = $1`,
      [shopId],
    )
  ).rows[0];

  const costByFeature = shopId
    ? (
        await pool.query(
          `SELECT feature, coalesce(sum(cost_usd), 0)::float cost, count(*)::int calls
             FROM llm_usage_event WHERE shop_id = $1
             GROUP BY feature ORDER BY cost DESC LIMIT 8`,
          [shopId],
        )
      ).rows
    : [];

  const margin = (
    await pool.query(
      `WITH rev AS (SELECT coalesce(sum(total_price),0)::float revenue, count(*)::int orders FROM orders WHERE shop_id=$1),
            refunded AS (SELECT coalesce(sum(amount),0)::float refunds FROM refunds WHERE shop_id=$1),
            cogs AS (SELECT coalesce(sum(oli.quantity * v.unit_cost),0)::float cogs,
                            coalesce(sum(CASE WHEN v.unit_cost IS NOT NULL THEN oli.quantity*oli.unit_price ELSE 0 END),0)::float covered_rev,
                            coalesce(sum(oli.quantity*oli.unit_price),0)::float line_rev
                       FROM order_line_items oli LEFT JOIN variants v ON v.id=oli.variant_id WHERE oli.shop_id=$1),
            llm AS (SELECT coalesce(sum(cost_usd),0)::float llm_cost FROM llm_usage_event WHERE shop_id=$1)
       SELECT rev.revenue, rev.orders, refunded.refunds, cogs.cogs, cogs.covered_rev, cogs.line_rev, llm.llm_cost
         FROM rev, refunded, cogs, llm`,
      [shopId],
    )
  ).rows[0];

  const currency = shopId
    ? (
        await pool.query(
          `SELECT currency, count(*) n FROM orders WHERE shop_id=$1 GROUP BY currency ORDER BY n DESC LIMIT 1`,
          [shopId],
        )
      ).rows[0]?.currency || null
    : null;

  const eventSpark = (
    await pool.query(
      `SELECT coalesce(e.cnt, 0)::int v
         FROM generate_series(now()::date - interval '13 days', now()::date, interval '1 day') d
         LEFT JOIN (SELECT date_trunc('day', created_at)::date AS bucket, count(*) cnt
                      FROM activity_events
                     WHERE shop_domain = $1 AND created_at >= now()::date - interval '13 days'
                     GROUP BY 1) e ON e.bucket = d::date
         ORDER BY d`,
      [shopDomain],
    )
  ).rows.map((r) => r.v);

  const costSpark = shopId
    ? (
        await pool.query(
          `SELECT coalesce(c.v, 0)::float v
             FROM generate_series(now()::date - interval '13 days', now()::date, interval '1 day') d
             LEFT JOIN (SELECT date_trunc('day', created_at)::date AS bucket, sum(cost_usd) v
                          FROM llm_usage_event
                         WHERE shop_id = $1 AND created_at >= now()::date - interval '13 days'
                         GROUP BY 1) c ON c.bucket = d::date
             ORDER BY d`,
          [shopId],
        )
      ).rows.map((r) => Number(r.v))
    : new Array(14).fill(0);

  return { shop, events, cost, costByFeature, margin, currency, eventSpark, costSpark };
}

function renderMerchant(data, shopDomain) {
  const shop = data.shop;
  const fmtDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "—");
  const yesno = (d) => (d ? "yes" : "no");
  const tenure =
    shop && shop.created_at
      ? Math.max(0, Math.floor((Date.now() - new Date(shop.created_at).getTime()) / 86400000))
      : null;
  const churned = Boolean(shop && shop.status === "uninstalled");

  const statusTiles = shop
    ? [
        ["Status", churned ? "uninstalled" : String(shop.status ?? "—"), String(shop.setup_status ?? "")],
        ["Tenure", tenure != null ? `${tenure}d` : "—", `installed ${fmtDate(shop.created_at)}`],
        ["Onboarded", yesno(shop.onboarding_completed_at), fmtDate(shop.onboarding_completed_at)],
        ["Backfill", yesno(shop.backfill_completed_at), fmtDate(shop.backfill_completed_at)],
        ["Cost data", `${Number(shop.cogs_completion_percentage ?? 0).toFixed(0)}%`, String(shop.cogs_confidence_level ?? "")],
      ]
    : [["Shop", "no record", "activity only"]];

  const costTiles = [
    ["LLM cost", `$${Number(data.cost.total_cost || 0).toFixed(4)}`, `${data.cost.calls} calls · est.`],
    ["Tokens", Number(data.cost.tokens || 0).toLocaleString("en-US"), "in+out"],
    ["Avg latency", data.cost.avg_latency ? `${data.cost.avg_latency}ms` : "—", "per call"],
  ];

  // Unit economics (read-only): revenue - COGS - LLM cost, coverage-gated so a
  // shop with patchy unit-cost data isn't shown a falsely-precise margin.
  const m = data.margin || {};
  const ccy = data.currency || "GBP";
  const netRevenue = Number(m.revenue || 0) - Number(m.refunds || 0);
  const grossMargin = netRevenue - Number(m.cogs || 0) - Number(m.llm_cost || 0);
  const marginPct = netRevenue > 0 ? Math.round((grossMargin / netRevenue) * 100) : null;
  const coverage =
    Number(m.line_rev || 0) > 0
      ? Math.round((Number(m.covered_rev || 0) / Number(m.line_rev)) * 100)
      : 0;
  const marginTiles = [
    ["Revenue", money(netRevenue, ccy), `${m.orders || 0} orders · net`],
    ["COGS", money(m.cogs || 0, ccy), `${coverage}% cost coverage`],
    ["Margin", money(grossMargin, ccy), marginPct == null ? "—" : `${marginPct}%${coverage < 70 ? " · indicative" : ""}`],
  ];
  const coverageNote =
    netRevenue > 0 && coverage < 70
      ? `<div class="note">Margin is indicative — unit costs cover ${coverage}% of product revenue, so missing COGS understate true cost (real margin is lower). LLM cost uses placeholder pricing.</div>`
      : "";

  const tiles = [...statusTiles, ...costTiles, ...marginTiles]
    .map(
      ([label, value, sub]) =>
        `<div class="tile"><div class="tv">${esc(value)}</div><div class="tl">${esc(label)}</div><div class="ts">${esc(sub)}</div></div>`,
    )
    .join("");

  const featureRows = data.costByFeature.length
    ? data.costByFeature
        .map(
          (f) =>
            `<tr><td>${esc(f.feature)}</td><td>$${Number(f.cost).toFixed(4)}</td><td>${f.calls}</td></tr>`,
        )
        .join("")
    : `<tr><td class="muted">No LLM usage recorded.</td><td></td><td></td></tr>`;

  const eventRows = data.events.length
    ? data.events
        .map((r) => {
          const warn =
            r.topic === "reliability" ||
            String(r.type).endsWith("_failed") ||
            String(r.type).endsWith("_error");
          const time = new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ");
          return `<tr><td class="time">${esc(time)}</td><td><span class="pill${warn ? " warn" : ""}">${esc(r.type)}</span></td><td>${esc(r.topic ?? "")}</td><td>${esc(r.summary ?? "")}</td></tr>`;
        })
        .join("")
    : `<tr><td class="empty" colspan="4">No events for this merchant.</td></tr>`;

  const eventTotal = data.eventSpark.reduce((a, b) => a + Number(b), 0);
  const costTotal = data.costSpark.reduce((a, b) => a + Number(b), 0);

  return page(`
    <header>
      <h1>Jefe · Merchant</h1>
      <span class="muted">${esc(shopDomain)}${churned ? ' · <span class="pill warn">churned</span>' : ""}</span>
      <a class="clear" href="/" style="margin-left:auto">← All activity</a>
    </header>
    <div class="tiles">${tiles}</div>
    ${coverageNote}
    <div class="panels">
      <div class="panel"><div class="ph">Activity · 14d</div>${sparkline(data.eventSpark)}<div class="pn">${eventTotal} events</div></div>
      <div class="panel"><div class="ph">LLM cost · 14d</div>${sparkline(data.costSpark, { stroke: "#7c5cff" })}<div class="pn">$${costTotal.toFixed(4)} est.</div></div>
      <div class="panel"><div class="ph">Cost by feature</div><table class="mini"><tbody>${featureRows}</tbody></table></div>
    </div>
    <table><thead><tr><th>Time (UTC)</th><th>Type</th><th>Topic</th><th>Summary</th></tr></thead><tbody>${eventRows}</tbody></table>`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  // Never let this internal tool be search-indexed, even while it's open.
  res.setHeader("X-Robots-Tag", "noindex, nofollow");

  if (url.pathname === "/robots.txt") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("User-agent: *\nDisallow: /\n");
    return;
  }

  if (url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  if (!OPS_PUBLIC && !isAuthed(req)) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="Jefe Ops"',
      "Content-Type": "text/plain",
    });
    res.end(OPS_PASSWORD ? "Authentication required." : "OPS_PASSWORD is not configured.");
    return;
  }

  if (url.pathname === "/merchant") {
    const shopDomain = url.searchParams.get("shop") || "";
    if (!shopDomain) {
      res.writeHead(302, { Location: "/" });
      res.end();
      return;
    }
    try {
      const data = await queryMerchant(shopDomain);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(renderMerchant(data, shopDomain));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page(`<header><h1>Jefe · Merchant</h1></header><div class="empty">Could not load merchant: ${esc(error?.message ?? error)}</div>`));
    }
    return;
  }

  if (url.pathname !== "/") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  const params = {
    q: url.searchParams.get("q") || "",
    type: url.searchParams.get("type") || "",
    topic: url.searchParams.get("topic") || "",
    shop: url.searchParams.get("shop") || "",
    hours: url.searchParams.get("hours") || "168",
  };

  try {
    const [data, overview] = await Promise.all([
      queryEvents(params),
      queryOverview().catch(() => null),
    ]);
    data.overview = overview;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(renderDashboard(data, params));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page(`<header><h1>Jefe · Activity</h1></header><div class="empty">Could not load events: ${esc(error?.message ?? error)}</div>`));
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`jefe-ops listening on :${PORT}`);
});
