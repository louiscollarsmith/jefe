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
</style></head><body>${body}</body></html>`;
}

function renderDashboard(data, params) {
  const rows = data.rows
    .map((r) => {
      const warn = r.type === "job_failed" || String(r.type).endsWith("_failed");
      const time = new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ");
      return `<tr>
        <td class="time">${esc(time)}</td>
        <td><span class="pill${warn ? " warn" : ""}">${esc(r.type)}</span></td>
        <td>${esc(r.topic ?? "")}</td>
        <td>${esc(r.shop_domain ?? "")}</td>
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  if (!isAuthed(req)) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="Jefe Ops"',
      "Content-Type": "text/plain",
    });
    res.end(OPS_PASSWORD ? "Authentication required." : "OPS_PASSWORD is not configured.");
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
    const data = await queryEvents(params);
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
