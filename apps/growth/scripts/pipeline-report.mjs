#!/usr/bin/env node
// Design Partner pipeline report (internal / founder-facing).
//
// Reads waitlist_signups, scores each row for chase priority against the ICP
// checklist, and prints a ranked pipeline. Triage only — confirmed ICP fit
// (GMV band, single-vs-multi market, operator) is a human/enrichment step.
// See docs/growth/commercial-state.md §2 and docs/growth/growth-strategy.md.
//
//   cd apps/growth
//   npm install
//   npm run pipeline                 # formatted, lists leads (contains emails/PII)
//   npm run pipeline -- --counts     # PII-free tallies only (safe to share)
//   npm run pipeline -- --json       # machine-readable
//   npm run pipeline -- --limit=25   # cap the listed rows
//
// Reads DATABASE_URL (falls back to DATABASE_PUBLIC_URL). Point it at a
// READ-only credential for the Neon project that holds waitlist_signups. For
// prod, use the public proxy URL, not the internal host.

import {
  rankPipeline,
  summarize,
  formatPipeline,
} from "../src/icp-scoring.server.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(
    [
      "Usage: npm run pipeline -- [--counts] [--json] [--limit=N]",
      "",
      "  --counts   PII-free tallies only (no emails/store handles).",
      "  --json     Emit JSON instead of formatted text.",
      "  --limit=N  Cap the number of listed leads (full mode only).",
      "",
      "Reads DATABASE_URL (falls back to DATABASE_PUBLIC_URL).",
    ].join("\n"),
  );
  process.exit(0);
}

const countsOnly = args.includes("--counts");
const asJson = args.includes("--json");
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number.parseInt(limitArg.split("=")[1], 10) : undefined;

const DATABASE_URL = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
if (!DATABASE_URL) {
  console.error(
    "DATABASE_URL (or DATABASE_PUBLIC_URL) is required — point it at the Neon project that holds waitlist_signups (use a read-only credential).",
  );
  process.exit(1);
}

async function main() {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(DATABASE_URL);
  const rows = await sql`
    SELECT email, store_url, source, created_at
    FROM waitlist_signups
    ORDER BY created_at DESC
  `;

  const signups = rows.map((r) => ({
    email: r.email,
    storeUrl: r.store_url,
    source: r.source,
    createdAt: r.created_at,
  }));

  const pipeline = rankPipeline(signups);

  if (asJson) {
    const payload = countsOnly
      ? summarize(pipeline)
      : { ...summarize(pipeline), ranked: pipeline.ranked };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(formatPipeline(pipeline, { withEmails: !countsOnly, limit }));
}

main().catch((err) => {
  console.error("pipeline report failed:", err?.message ?? err);
  process.exit(1);
});
