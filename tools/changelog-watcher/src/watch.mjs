#!/usr/bin/env node
// changelog-watcher — polls upstream API / MCP changelogs, reports what is NEW
// since the last run, and triages each new entry into:
//   🔧 adapt        — touches something Jefe uses; likely needs code/config work
//   💡 opportunity  — a new capability Jefe doesn't use yet but might want
//   ·  ignore       — irrelevant
//
// Triage uses Gemini (same provider as the app) when GEMINI_API_KEY is set,
// and falls back to keyword flags otherwise. Zero dependencies. Node ESM.
//
//   node src/watch.mjs              # poll all enabled sources, triage, report
//   node src/watch.mjs --init       # baseline: record current state, don't alert
//   node src/watch.mjs --source shopify,mcp-spec
//   node src/watch.mjs --no-llm     # skip the LLM pass (keyword flags only)
//   node src/watch.mjs --json | --dry-run

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SOURCES_PATH = path.join(ROOT, "sources.json");
const OUT_DIR = path.join(ROOT, "output");
const STATE_PATH = path.join(OUT_DIR, "state.json");

const LLM_MODEL = process.env.LLM_MODEL || "gemini-3.1-flash-lite";

const DEFAULT_BREAKING = [
  "deprecat", "breaking", "removed", "will be removed", "sunset", "retire",
  "end of life", "eol", "no longer", "must migrate", "required", "legacy",
  "unsupported", "discontinu", "shut down", "shutting down", "action required",
];

const DEFAULT_JEFE_CONTEXT = `Jefe is a Shopify embedded app (React Router v7, Prisma/Postgres, Polaris) that builds "Merchant Memory" about a store.
It uses:
- Shopify GraphQL Admin API (version 2026-07): orders, products, variants, refunds, customers, inventory levels, locations.
- Shopify OAuth, session tokens, and access scopes: read/write products, orders, customers, inventory, locations.
- Shopify webhooks: orders, products, refunds, inventory, app/uninstalled, GDPR (customer/shop redact).
- LLM: Google Gemini via @google/genai (model gemini-3.1-flash-lite).
- Channels: Slack (OAuth, chat:write) is live; WhatsApp via the Meta/WhatsApp Cloud API is "coming soon".
- Planned/conceptual integrations, not built yet: Klaviyo, Meta Ads, Recharge, ShipStation.
- Deployed on Railway; uses MCP servers for internal agent tooling.
Jefe does NOT do: POS, checkout extensions, Shopify Functions, themes/Liquid, storefront API, payments, shipping-label printing.`;

const args = parseArgs(process.argv.slice(2));

main().catch((err) => {
  console.error("changelog-watcher failed:", err?.message || err);
  process.exit(1);
});

async function main() {
  const config = loadJson(SOURCES_PATH, null);
  if (!config || !Array.isArray(config.sources)) {
    throw new Error(`No sources configured — add them to ${SOURCES_PATH}`);
  }
  const breaking = (config.relevanceKeywords || DEFAULT_BREAKING).map((k) => k.toLowerCase());
  const only = args.source ? String(args.source).split(",").map((s) => s.trim()) : null;
  const list = config.sources.filter((s) => s.enabled !== false && (!only || only.includes(s.id)));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const state = loadJson(STATE_PATH, {});
  const results = [];

  for (const src of list) {
    process.stderr.write(`• ${src.id} … `);
    try {
      const entries = (await fetchEntries(src)).slice(0, src.max || 20);
      const prev = state[src.id] || { seen: [] };
      const baseline = !prev.seen || prev.seen.length === 0;
      const seen = new Set(prev.seen || []);
      const fresh = entries
        .filter((e) => !seen.has(e.id))
        .map((e) => ({ ...e, sourceId: src.id, sourceName: src.name, relevant: isRelevant(e, src, breaking) }));
      const nextSeen = dedupe([...entries.map((e) => e.id), ...(prev.seen || [])]).slice(0, 500);
      state[src.id] = { seen: nextSeen, lastChecked: new Date().toISOString(), entryCount: entries.length };
      results.push({ id: src.id, name: src.name, url: src.url, baseline, total: entries.length, fresh });
      process.stderr.write(`${entries.length} entries · ${fresh.length} new${baseline ? " (baseline)" : ""}\n`);
    } catch (err) {
      results.push({ id: src.id, name: src.name, url: src.url, error: err?.message || String(err), fresh: [] });
      process.stderr.write(`ERROR: ${err?.message || err}\n`);
    }
  }

  if (!args["dry-run"]) saveJson(STATE_PATH, state);

  // ---- triage: LLM if we have a key, else keyword fallback ----
  const allFresh = results.flatMap((r) => r.fresh);
  const apiKey = process.env.GEMINI_API_KEY;
  if (allFresh.length && apiKey && !args["no-llm"]) {
    process.stderr.write(`\nTriaging ${allFresh.length} new entries with ${LLM_MODEL} …\n`);
    try {
      const verdicts = await llmTriage(allFresh, config.jefeContext || DEFAULT_JEFE_CONTEXT, apiKey);
      for (const e of allFresh) {
        const v = verdicts[e.id];
        if (v) { e.class = v.class; e.reason = v.reason; e.action = v.action; }
      }
    } catch (err) {
      process.stderr.write(`  LLM triage failed (${err?.message || err}); falling back to keyword flags\n`);
    }
  } else if (allFresh.length && !apiKey) {
    process.stderr.write(`\n(no GEMINI_API_KEY — using keyword flags; set it for LLM adapt/opportunity triage)\n`);
  }
  for (const e of allFresh) if (!e.class) e.class = e.relevant ? "adapt" : "ignore";

  const report = buildReport(results);
  if (args.json) console.log(JSON.stringify(results, null, 2));
  else console.log("\n" + report);

  if (!args["dry-run"]) {
    const file = path.join(OUT_DIR, `report-${nowStamp()}.md`);
    fs.writeFileSync(file, report);
    process.stderr.write(`\nReport: ${path.relative(process.cwd(), file)}\n`);
  }
}

// ---------- LLM triage (Gemini REST, zero-dep) ----------

async function llmTriage(entries, context, apiKey) {
  const items = entries.map((e, i) => ({ i, source: e.sourceName, title: e.title, summary: e.summary || "" }));
  const prompt =
`You triage upstream changelog entries for the engineering team behind "Jefe".

WHAT JEFE USES:
${context}

For each entry, decide exactly one class:
- "adapt": it touches something Jefe already uses (an API/scope/webhook/field/SDK above); we likely need code or config changes to keep working or comply.
- "opportunity": Jefe doesn't use this yet, but it's a capability we might want to adopt in future.
- "ignore": irrelevant to Jefe (e.g. POS, themes, checkout, payments, storefront).

Return ONLY a JSON array, one object per entry:
[{"i": <index>, "class": "adapt|opportunity|ignore", "reason": "<=16 words, concrete", "action": "<short next step, or empty>"}]

ENTRIES:
${JSON.stringify(items)}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${LLM_MODEL}:generateContent?key=${apiKey}`;
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 4000 },
    }),
  }, 40000);
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("") || "[]";
  const arr = JSON.parse(text);
  const map = {};
  for (const r of arr) {
    if (typeof r.i === "number" && entries[r.i]) {
      map[entries[r.i].id] = { class: normClass(r.class), reason: r.reason || "", action: r.action || "" };
    }
  }
  return map;
}

function normClass(c) {
  const s = String(c || "").toLowerCase();
  return s === "adapt" || s === "opportunity" ? s : "ignore";
}

// ---------- fetch + parse per source type ----------

async function fetchEntries(src) {
  if (src.type === "rss" || src.type === "atom") return parseFeed(await httpText(src.url));
  if (src.type === "github-releases") return parseGithub(await httpJson(ghReleasesUrl(src.url)), src.url);
  if (src.type === "html") return [await htmlSnapshot(src)];
  throw new Error(`unknown source type "${src.type}"`);
}

function parseFeed(xml) {
  const out = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks) {
    const title = clean(getTag(b, "title"));
    let link = getTag(b, "link");
    if (!link) {
      const href = b.match(/<link\b[^>]*\bhref\s*=\s*"([^"]+)"/i);
      if (href) link = href[1];
    }
    const date = getTag(b, "pubDate") || getTag(b, "updated") || getTag(b, "published") || "";
    const id = clean(getTag(b, "guid")) || clean(getTag(b, "id")) || link || title;
    const summary = shorten(stripHtml(getTag(b, "description") || getTag(b, "summary") || getTag(b, "content")));
    out.push({ id: (id || "").trim(), title, link: (link || "").trim(), date: date.trim(), summary });
  }
  return out;
}

function parseGithub(releases, repo) {
  if (!Array.isArray(releases)) return [];
  return releases.filter((r) => !r.draft).map((r) => ({
    id: `${repo}#${r.id ?? r.tag_name}`,
    title: `${repo} ${r.tag_name || r.name || ""}`.trim(),
    link: r.html_url,
    date: r.published_at || r.created_at || "",
    summary: shorten(stripHtml(r.body || "")),
  }));
}

async function htmlSnapshot(src) {
  const html = await httpText(src.url);
  const text = stripHtml(html).replace(/\s+/g, " ").trim();
  const hash = crypto.createHash("sha1").update(text).digest("hex").slice(0, 12);
  return {
    id: `${src.id}:${hash}`,
    title: `${src.name} page changed`,
    link: src.url,
    date: new Date().toISOString(),
    summary: shorten(text, 220),
  };
}

// ---------- relevance (keyword fallback) ----------

function isRelevant(entry, src, breaking) {
  const hay = `${entry.title} ${entry.summary || ""}`.toLowerCase();
  if (breaking.some((k) => hay.includes(k))) return true;
  return (src.watch || []).map((w) => String(w).toLowerCase()).some((w) => hay.includes(w));
}

// ---------- report ----------

function buildReport(results) {
  const all = results.flatMap((r) => r.fresh);
  const adapt = all.filter((e) => e.class === "adapt");
  const opp = all.filter((e) => e.class === "opportunity");
  const other = all.length - adapt.length - opp.length;
  const errored = results.filter((r) => r.error);
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

  const lines = [];
  lines.push(`# Changelog watch — ${stamp}`);
  lines.push("");
  lines.push(`**${all.length} new** across ${results.length} sources · 🔧 **${adapt.length}** to adapt · 💡 **${opp.length}** opportunities · ${other} other`);
  lines.push("");
  if (errored.length) {
    lines.push(`> ⚠️ fetch errors: ${errored.map((r) => `\`${r.id}\` (${r.error})`).join("; ")}`);
    lines.push("");
  }
  section(lines, "🔧 Needs adaptation", adapt);
  section(lines, "💡 Worth a look", opp);
  if (all.length && !adapt.length && !opp.length) lines.push(`_${all.length} new entries, none triaged as relevant to Jefe._`);
  if (!all.length && !errored.length) lines.push("_No new changelog entries since last run._");
  return lines.join("\n");
}

function section(lines, heading, entries) {
  if (!entries.length) return;
  lines.push(`## ${heading} (${entries.length})`);
  for (const e of entries.slice(0, 30)) {
    lines.push(`- **${e.title}** _(${e.sourceName})_${e.date ? " · " + e.date : ""}`);
    if (e.reason) lines.push(`  ${e.reason}`);
    if (e.action) lines.push(`  → ${e.action}`);
    if (e.link) lines.push(`  ${e.link}`);
  }
  if (entries.length > 30) lines.push(`  _…and ${entries.length - 30} more_`);
  lines.push("");
}

// ---------- http ----------

async function httpText(url) {
  const res = await fetchWithTimeout(url, { headers: { "user-agent": "jefe-changelog-watcher/0.1" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}
async function httpJson(url) {
  const headers = { "user-agent": "jefe-changelog-watcher/0.1", accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetchWithTimeout(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}
async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal, redirect: "follow" });
  } finally {
    clearTimeout(t);
  }
}
function ghReleasesUrl(repo) {
  return `https://api.github.com/repos/${repo}/releases?per_page=10`;
}

// ---------- helpers ----------

function getTag(block, name) {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  if (!m) return "";
  return m[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}
function stripHtml(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function clean(s) {
  return String(s || "").replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}
function shorten(s, n = 180) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
}
function dedupe(arr) { return [...new Set(arr)]; }
function nowStamp() { return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19); }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (!tok.startsWith("--")) continue;
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}
function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}
function saveJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}
