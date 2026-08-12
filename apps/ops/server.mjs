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
import pg from "pg";

import {
  actionProgressLabel,
  actionStatusLabel,
  actionStatusSeverity,
  bfsWebVitalStatus,
  churnReasonLabel,
  classifyMerchantHealth,
  esc,
  fmtMs,
  formatAccessLog,
  formatConversationSnippet,
  formatConversationContext,
  formatProposalSummary,
  formatStructuredOperation,
  formatSuccessSignal,
  formatVitalValue,
  formatWriteCounts,
  money,
  optionList,
  safeEqual,
  sparkline,
} from "./format.mjs";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL,
  max: 4,
});
let conversationMessageColumnPromise = null;

const OPS_PASSWORD = process.env.OPS_PASSWORD || "";
const PORT = Number(process.env.PORT) || 4000;
const WINDOWS = { "24": "24h", "168": "7d", "720": "30d", "2160": "90d" };
const ISSUE_WINDOW_SQL = "1 hour";

// ⛔ AUTH IS OFF — DELIBERATE, NOT AN OVERSIGHT.
//
// Founder's call (Matt, 2026-08-12, reaffirmed 2026-08-13): leave it open "for at least 2-3
// weeks". He has weighed the exposure; do not keep re-raising it, and do NOT quietly restore
// it as a tidy-up. Revisit ~early September.
//
// To restore: delete this constant and the branch below. That is the whole revert. Note the
// jefe-ops service does NOT auto-deploy — it needs `railway up --service jefe-ops` run from a
// standalone copy of apps/ops (from the repo root, Railpack finds no package.json and fails).
//
// What is actually exposed, so the decision can be re-made with the facts: this panel is
// CROSS-MERCHANT by design (see the file header) and admin.mynamejefe.com answers from the
// open internet. OPS_PASSWORD is still set in Railway, so restoring is a code change only.
const OPS_AUTH_DISABLED = true;

function isAuthed(req) {
  if (OPS_AUTH_DISABLED) return true;
  if (!OPS_PASSWORD) return false; // fail closed until configured
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const password = decoded.slice(decoded.indexOf(":") + 1);
  return safeEqual(password, OPS_PASSWORD);
}

/** Best-effort client IP: the proxy's forwarded-for chain head, else the socket. */
function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "";
}

/**
 * Audit-log one access to the panel (see formatAccessLog — PII-safe: who / what /
 * outcome / when, never the data or the password). Emitted for BOTH granted and
 * denied requests, so unauthorised attempts are visible too.
 */
function logOpsAccess(req, url, outcome) {
  process.stdout.write(
    formatAccessLog({
      ts: new Date().toISOString(),
      outcome,
      method: req.method,
      path: url.pathname,
      shop: url.searchParams.get("shop") || "",
      ip: clientIp(req),
    }) + "\n",
  );
}

async function getConversationMessageColumns() {
  if (!conversationMessageColumnPromise) {
    conversationMessageColumnPromise = pool
      .query(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'merchant_memory_conversation_messages'
            AND column_name IN ('structured_operation_json')`,
      )
      .then((result) => ({
        hasStructuredOperationJson: result.rows.some((row) => row.column_name === "structured_operation_json"),
      }));
  }
  return conversationMessageColumnPromise;
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
  const churn = (
    await pool.query(`
      SELECT count(*)::int total,
        count(*) FILTER (WHERE created_at >= now() - interval '30 days')::int churned_30d,
        coalesce(round(avg((properties->>'tenureDays')::numeric)), 0)::int avg_tenure,
        count(*) FILTER (WHERE (properties->>'reachedMemory')::boolean)::int reached_memory
      FROM activity_events WHERE type = 'shop_uninstalled'`)
  ).rows[0];

  // Uninstall-reason breakdown — the LATEST win-back-feedback answer per shop
  // (email scanners may pre-tap several links, so last write wins). Empty until
  // the farewell email (ENABLE_EMAIL) starts sending feedback links. (obs #17)
  const churnReasons = (
    await pool.query(`
      SELECT reason, count(*)::int n FROM (
        SELECT DISTINCT ON (shop_id) properties->>'reason' AS reason
          FROM activity_events
         WHERE type = 'shop_uninstall_feedback' AND shop_id IS NOT NULL
         ORDER BY shop_id, created_at DESC
      ) latest
      WHERE reason IS NOT NULL
      GROUP BY reason ORDER BY n DESC`)
  ).rows;

  // Portfolio LLM spend by feature · 7d — which features drive inference cost
  // (informs the provider-cost / margin lever). (obs #20)
  const costByFeature = (
    await pool.query(`
      SELECT feature, coalesce(sum(cost_usd), 0)::float cost, count(*)::int calls
        FROM llm_usage_event
       WHERE created_at >= now() - interval '7 days'
       GROUP BY feature ORDER BY cost DESC`)
  ).rows;

  // Margin per client (indicative): net revenue − COGS − LLM cost, with COGS
  // coverage so a shop with patchy unit costs isn't shown a falsely-precise
  // margin. Same shape as the per-merchant view, aggregated across shops. (obs #20)
  const marginList = (
    await pool.query(`
      WITH rev AS (SELECT shop_id, sum(total_price)::float revenue, count(*)::int orders FROM orders GROUP BY shop_id),
           refunded AS (SELECT shop_id, sum(amount)::float refunds FROM refunds GROUP BY shop_id),
           cogs AS (SELECT oli.shop_id,
                           sum(oli.quantity * v.unit_cost)::float cogs,
                           sum(CASE WHEN v.unit_cost IS NOT NULL THEN oli.quantity*oli.unit_price ELSE 0 END)::float covered_rev,
                           sum(oli.quantity*oli.unit_price)::float line_rev
                      FROM order_line_items oli LEFT JOIN variants v ON v.id = oli.variant_id
                     GROUP BY oli.shop_id),
           llm AS (SELECT shop_id, sum(cost_usd)::float llm_cost FROM llm_usage_event GROUP BY shop_id)
      SELECT s.shop_domain,
             coalesce(rev.revenue,0)::float revenue, coalesce(rev.orders,0)::int orders,
             coalesce(refunded.refunds,0)::float refunds,
             coalesce(cogs.cogs,0)::float cogs, coalesce(cogs.covered_rev,0)::float covered_rev,
             coalesce(cogs.line_rev,0)::float line_rev, coalesce(llm.llm_cost,0)::float llm_cost
        FROM shops s
        LEFT JOIN rev      ON rev.shop_id      = s.id
        LEFT JOIN refunded ON refunded.shop_id = s.id
        LEFT JOIN cogs     ON cogs.shop_id     = s.id
        LEFT JOIN llm      ON llm.shop_id      = s.id
       WHERE coalesce(rev.orders,0) > 0
       ORDER BY revenue DESC LIMIT 15`)
  ).rows;

  // Win-back email dispatch health · 7d — consumes chat 2's PII-free `email_sent`
  // event ({kind, delivered, disabled}). Zero until ENABLE_WINBACK_EMAIL flips;
  // ready to light up. (obs)
  const emailHealth = (
    await pool.query(`
      SELECT
        count(*) FILTER (WHERE (properties->>'delivered')::boolean)::int delivered,
        count(*) FILTER (WHERE (properties->>'disabled')::boolean)::int suppressed,
        count(*) FILTER (WHERE NOT coalesce((properties->>'delivered')::boolean, false)
                           AND NOT coalesce((properties->>'disabled')::boolean, false))::int failed
        FROM activity_events
       WHERE type = 'email_sent' AND created_at >= now() - interval '7 days'`)
  ).rows[0];

  // Core Web Vitals p75 over the BFS trailing window (28d), from the web_vital
  // events the embedded app beacons — graded against BFS_WEB_VITAL_TARGETS.
  const webVitalsBfs = (
    await pool.query(`
      SELECT upper(properties->>'metric') metric,
             percentile_cont(0.75) WITHIN GROUP (
               ORDER BY (properties->>'value')::float
             ) p75,
             count(*)::int n
        FROM activity_events
       WHERE type = 'web_vital'
         AND properties->>'value' ~ '^[0-9.]+$'
         AND created_at >= now() - interval '28 days'
       GROUP BY 1`)
  ).rows;

  // Live merchant triage: existing read-only ledgers, aggregated so the first
  // screen says whether the live estate needs attention before opening a shop.
  const liveTriage = (
    await pool.query(`
      WITH live AS (
        SELECT id, merchant_id, shop_domain, backfill_completed_at
          FROM shops
         WHERE status IS DISTINCT FROM 'uninstalled'
      ),
      belief_counts AS (
        SELECT shop_id, count(*)::int active_beliefs
          FROM merchant_memory_beliefs
         WHERE status IN ('inferred','merchant_confirmed','merchant_corrected')
         GROUP BY shop_id
      ),
      latest_memory AS (
        SELECT DISTINCT ON (shop_id) shop_id, status, updated_at, created_at
          FROM merchant_memory_refresh_runs
         WHERE shop_id IS NOT NULL
         ORDER BY shop_id, created_at DESC
      ),
      latest_generation AS (
        SELECT shop_id, status, updated_at, created_at FROM (
          SELECT DISTINCT ON (shop_id) shop_id, status, updated_at, created_at
            FROM merchant_insight_runs
           WHERE superseded_at IS NULL
           ORDER BY shop_id, created_at DESC
        ) i
        UNION ALL
        SELECT shop_id, status, updated_at, created_at FROM (
          SELECT DISTINCT ON (shop_id) shop_id, status, updated_at, created_at
            FROM merchant_goal_runs
           WHERE superseded_at IS NULL
           ORDER BY shop_id, created_at DESC
        ) g
        UNION ALL
        SELECT shop_id, status, updated_at, created_at FROM (
          SELECT DISTINCT ON (shop_id) shop_id, status, updated_at, created_at
            FROM merchant_plan_runs
           WHERE superseded_at IS NULL
           ORDER BY shop_id, created_at DESC
        ) p
      ),
      action_counts AS (
        SELECT shop_id,
               count(*) FILTER (WHERE status = 'proposed')::int proposed_actions,
               count(*) FILTER (WHERE status IN ('applied','partially_applied'))::int applied_actions,
               count(*) FILTER (WHERE status IN ('failed','partially_applied'))::int issue_actions,
               count(*) FILTER (WHERE outcome_status = 'measured')::int measured_actions
          FROM action_executions
         GROUP BY shop_id
      ),
      write_counts AS (
        SELECT ae.shop_id,
               count(*) FILTER (WHERE aew.status = 'failed')::int failed_action_writes,
               count(*) FILTER (WHERE aew.status = 'skipped_drift')::int drift_action_writes
          FROM action_executions ae
          JOIN action_execution_writes aew ON aew.execution_id = ae.id
         GROUP BY ae.shop_id
      ),
      reliability_shops AS (
        SELECT DISTINCT l.id
          FROM live l
          JOIN activity_events e ON (e.shop_id = l.id OR e.shop_domain = l.shop_domain)
         WHERE (e.topic = 'reliability' OR e.type LIKE '%error' OR e.type LIKE '%failed')
           AND e.created_at >= now() - interval '24 hours'
      ),
      memory_issue_shops AS (
        SELECT l.id
          FROM live l
          LEFT JOIN latest_memory lm ON lm.shop_id = l.id
          LEFT JOIN belief_counts bc ON bc.shop_id = l.id
         WHERE lm.status = 'failed'
            OR (lm.status = 'running' AND lm.updated_at < now() - interval '${ISSUE_WINDOW_SQL}')
            OR (l.backfill_completed_at IS NOT NULL AND coalesce(bc.active_beliefs, 0) = 0)
      ),
      generation_issue_shops AS (
        SELECT DISTINCT l.id
          FROM live l
          JOIN latest_generation lg ON lg.shop_id = l.id
         WHERE lg.status = 'failed'
            OR (lg.status IN ('queued','running') AND lg.updated_at < now() - interval '${ISSUE_WINDOW_SQL}')
      )
      SELECT
        (SELECT count(*)::int FROM live) live_shops,
        (SELECT count(*)::int FROM reliability_shops) shops_with_reliability_24h,
        (SELECT count(*)::int FROM memory_issue_shops) shops_with_memory_issues,
        (SELECT count(*)::int FROM generation_issue_shops) shops_with_generation_issues,
        coalesce(sum(ac.proposed_actions), 0)::int proposed_actions,
        coalesce(sum(ac.applied_actions), 0)::int applied_actions,
        coalesce(sum(ac.issue_actions), 0)::int issue_actions,
        coalesce(sum(ac.measured_actions), 0)::int measured_actions,
        coalesce(sum(wc.failed_action_writes), 0)::int failed_action_writes,
        coalesce(sum(wc.drift_action_writes), 0)::int drift_action_writes
      FROM live l
      LEFT JOIN action_counts ac ON ac.shop_id = l.id
      LEFT JOIN write_counts wc ON wc.shop_id = l.id`)
  ).rows[0];

  const liveTriageRows = (
    await pool.query(`
      WITH live AS (
        SELECT id, merchant_id, shop_domain, backfill_completed_at
          FROM shops
         WHERE status IS DISTINCT FROM 'uninstalled'
      )
      SELECT l.shop_domain,
             coalesce(rel.reliability_events_24h, 0)::int reliability_events_24h,
             coalesce(a.failed_actions, 0)::int failed_actions,
             coalesce(a.partial_actions, 0)::int partial_actions,
             coalesce(a.proposed_actions, 0)::int proposed_actions,
             coalesce(w.failed_action_writes, 0)::int failed_action_writes,
             coalesce(w.drift_action_writes, 0)::int drift_action_writes,
             mem.status AS memory_status,
             mem.updated_at AS memory_updated_at,
             coalesce(b.active_beliefs, 0)::int active_beliefs,
             gen.issue_count::int AS generation_issue_count
        FROM live l
        LEFT JOIN LATERAL (
          SELECT count(*)::int reliability_events_24h
            FROM activity_events e
           WHERE (e.shop_id = l.id OR e.shop_domain = l.shop_domain)
             AND (e.topic = 'reliability' OR e.type LIKE '%error' OR e.type LIKE '%failed')
             AND e.created_at >= now() - interval '24 hours'
        ) rel ON TRUE
        LEFT JOIN LATERAL (
          SELECT status, updated_at
            FROM merchant_memory_refresh_runs
           WHERE shop_id = l.id
           ORDER BY created_at DESC
           LIMIT 1
        ) mem ON TRUE
        LEFT JOIN LATERAL (
          SELECT count(*)::int active_beliefs
            FROM merchant_memory_beliefs
           WHERE shop_id = l.id
             AND status IN ('inferred','merchant_confirmed','merchant_corrected')
        ) b ON TRUE
        LEFT JOIN LATERAL (
          SELECT count(*)::int issue_count
            FROM (
              SELECT status, updated_at FROM (
                SELECT DISTINCT ON (shop_id) shop_id, status, updated_at
                  FROM merchant_insight_runs
                 WHERE shop_id = l.id AND superseded_at IS NULL
                 ORDER BY shop_id, created_at DESC
              ) i
              UNION ALL
              SELECT status, updated_at FROM (
                SELECT DISTINCT ON (shop_id) shop_id, status, updated_at
                  FROM merchant_goal_runs
                 WHERE shop_id = l.id AND superseded_at IS NULL
                 ORDER BY shop_id, created_at DESC
              ) g
              UNION ALL
              SELECT status, updated_at FROM (
                SELECT DISTINCT ON (shop_id) shop_id, status, updated_at
                  FROM merchant_plan_runs
                 WHERE shop_id = l.id AND superseded_at IS NULL
                 ORDER BY shop_id, created_at DESC
              ) p
            ) runs
           WHERE status = 'failed'
              OR (status IN ('queued','running') AND updated_at < now() - interval '${ISSUE_WINDOW_SQL}')
        ) gen ON TRUE
        LEFT JOIN LATERAL (
          SELECT count(*) FILTER (WHERE status = 'failed')::int failed_actions,
                 count(*) FILTER (WHERE status = 'partially_applied')::int partial_actions,
                 count(*) FILTER (WHERE status = 'proposed')::int proposed_actions
            FROM action_executions
           WHERE shop_id = l.id
        ) a ON TRUE
        LEFT JOIN LATERAL (
          SELECT count(*) FILTER (WHERE aew.status = 'failed')::int failed_action_writes,
                 count(*) FILTER (WHERE aew.status = 'skipped_drift')::int drift_action_writes
            FROM action_executions ae
            JOIN action_execution_writes aew ON aew.execution_id = ae.id
           WHERE ae.shop_id = l.id
        ) w ON TRUE
       WHERE coalesce(rel.reliability_events_24h, 0) > 0
          OR mem.status = 'failed'
          OR (mem.status = 'running' AND mem.updated_at < now() - interval '${ISSUE_WINDOW_SQL}')
          OR (l.backfill_completed_at IS NOT NULL AND coalesce(b.active_beliefs, 0) = 0)
          OR coalesce(gen.issue_count, 0) > 0
          OR coalesce(a.failed_actions, 0) > 0
          OR coalesce(a.partial_actions, 0) > 0
          OR coalesce(w.failed_action_writes, 0) > 0
          OR coalesce(w.drift_action_writes, 0) > 0
       ORDER BY reliability_events_24h DESC, generation_issue_count DESC, failed_actions DESC, partial_actions DESC, l.shop_domain
       LIMIT 12`)
  ).rows;

  return { ...shops, ...active, ...reliability, ...cost, ...latency, churn, churnReasons, costByFeature, marginList, emailHealth, webVitalsBfs, costTrend, activityTrend, liveTriage, liveTriageRows };
}

function overviewIssueSummary(row) {
  const parts = [];
  if (Number(row.reliability_events_24h || 0) > 0) {
    parts.push(`${row.reliability_events_24h} reliability event${Number(row.reliability_events_24h) === 1 ? "" : "s"}`);
  }
  if (row.memory_status === "failed") parts.push("memory failed");
  if (row.memory_status === "running" && row.memory_updated_at) parts.push("memory still running");
  if (Number(row.active_beliefs || 0) === 0) parts.push("no active memory beliefs");
  if (Number(row.generation_issue_count || 0) > 0) {
    parts.push(`${row.generation_issue_count} generation issue${Number(row.generation_issue_count) === 1 ? "" : "s"}`);
  }
  if (Number(row.proposed_actions || 0) > 0) parts.push(`${row.proposed_actions} proposed action${Number(row.proposed_actions) === 1 ? "" : "s"}`);
  if (Number(row.failed_actions || 0) > 0) parts.push(`${row.failed_actions} failed action${Number(row.failed_actions) === 1 ? "" : "s"}`);
  if (Number(row.partial_actions || 0) > 0) parts.push(`${row.partial_actions} partial action${Number(row.partial_actions) === 1 ? "" : "s"}`);
  if (Number(row.failed_action_writes || 0) > 0) parts.push(`${row.failed_action_writes} failed write${Number(row.failed_action_writes) === 1 ? "" : "s"}`);
  if (Number(row.drift_action_writes || 0) > 0) parts.push(`${row.drift_action_writes} drift skip${Number(row.drift_action_writes) === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "No issue details recorded.";
}

function fmtDate(d) {
  return d ? new Date(d).toISOString().slice(0, 10) : "—";
}

function fmtDateTime(d) {
  return d ? new Date(d).toISOString().slice(0, 16).replace("T", " ") : "—";
}

function isStalledRun(row) {
  if (!row || !["queued", "running"].includes(String(row.status))) return false;
  const t = new Date(row.updated_at || row.created_at || 0).getTime();
  return Number.isFinite(t) && Date.now() - t > 60 * 60 * 1000;
}

function isIssueRun(row) {
  if (!row) return false;
  return row.status === "failed" || isStalledRun(row);
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function horizonLabel(horizon) {
  if (horizon === "threeMonths") return "3 months";
  if (horizon === "sixMonths") return "6 months";
  if (horizon === "twelveMonths") return "12 months";
  return String(horizon || "goal");
}

function conversationTopicLabel(topic) {
  if (topic === "onboarding_plan") return "Onboarding plan";
  if (String(topic || "").startsWith("action:")) return `Action chat ${String(topic).slice(7, 19)}`;
  return String(topic || "Conversation");
}

function conversationMatchesPlan(conversation, plan) {
  const recommendationId = String(plan?.recommendation_id || "").trim();
  if (!recommendationId) return false;
  const topic = String(conversation?.topic || "");
  const topicId = topic.startsWith("action:") ? topic.slice("action:".length).trim() : "";
  const context = asRecord(conversation?.context_json);
  return topicId === recommendationId || String(context.recommendationId || "").trim() === recommendationId;
}

function pill(text, severity = "info") {
  const cls =
    severity === "warn" ? " warn"
    : severity === "good" ? " good"
    : severity === "muted" ? " muted-pill"
    : "";
  return `<span class="pill${cls}">${esc(text)}</span>`;
}

function issueCountFromWrites(writeCounts) {
  const rows = Array.isArray(writeCounts) ? writeCounts : [];
  return rows.reduce(
    (total, row) =>
      total + (row?.status === "failed" || row?.status === "skipped_drift" ? Number(row.n || 0) : 0),
    0,
  );
}

function actionTitle(action) {
  const summary = asRecord(action.proposal_summary);
  const source = asRecord(summary.sourceRecommendation);
  return source.title || action.action_kind || action.action_type || "Action";
}

function lifecycleProgress(data) {
  const shop = data.shop;
  const hasAction = data.actions.length > 0;
  const hasAppliedAction = data.actions.some((a) => ["applied", "partially_applied", "reverted", "failed"].includes(String(a.status)));
  const hasMeasuredOutcome = data.actions.some((a) => a.outcome_status === "measured");
  return [
    ["Install", Boolean(shop), shop ? fmtDate(shop.created_at) : "No shop record"],
    ["Backfill", Boolean(shop?.backfill_completed_at), fmtDate(shop?.backfill_completed_at)],
    ["Memory", Boolean(data.latestMemoryRun?.status === "completed" || data.activeBeliefCount > 0), data.latestMemoryRun?.status || "not recorded"],
    ["Insights", data.latestInsightRun?.status === "completed", data.latestInsightRun?.status || "not recorded"],
    ["Goals", data.goals.length > 0, data.completedGoalRun?.completed_at ? fmtDate(data.completedGoalRun.completed_at) : "not recorded"],
    ["Plan", Boolean(data.latestPlan?.recommendation_id), data.latestPlan?.review_status || data.latestPlan?.run_status || "not recorded"],
    ["Action", hasAction, hasAppliedAction ? "store write attempted" : hasAction ? "proposal recorded" : "not recorded"],
    ["Outcome", hasMeasuredOutcome, hasMeasuredOutcome ? "measured" : "not recorded"],
  ];
}

function renderLifecycle(data) {
  const steps = lifecycleProgress(data)
    .map(
      ([label, done, detail]) =>
        `<div class="step${done ? " step-done" : ""}"><div class="step-dot"></div><div><strong>${esc(label)}</strong><span>${esc(detail)}</span></div></div>`,
    )
    .join("");
  return `<div class="section"><div class="section-title">Lifecycle progress</div><div class="steps">${steps}</div></div>`;
}

function renderOverview(o) {
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
  const jobTotal = (o.ok_7d || 0) + (o.fails_7d || 0);
  const successRate = jobTotal > 0 ? Math.round((o.ok_7d / jobTotal) * 100) : null;
  const lt = o.liveTriage || {};
  const liveIssueTotal =
    Number(lt.shops_with_reliability_24h || 0) +
    Number(lt.shops_with_memory_issues || 0) +
    Number(lt.shops_with_generation_issues || 0) +
    Number(lt.issue_actions || 0) +
    Number(lt.failed_action_writes || 0) +
    Number(lt.drift_action_writes || 0);
  const tiles = [
    ["Shops", String(o.total), `${o.installed_7d} new · 7d`, false],
    ["Live shops", String(lt.live_shops ?? "—"), "active installs", false],
    ["Live issues", String(liveIssueTotal), liveIssueTotal ? "needs attention" : "clear", liveIssueTotal > 0],
    ["Backfilled", String(o.backfilled), `${pct(o.backfilled, o.total)}% of shops`, false],
    ["Onboarded", String(o.onboarded), `${pct(o.onboarded, o.total)}% of shops`, false],
    ["Active 24h", String(o.active_24h), `${o.active_7d} · 7d`, false],
    ["Actions", String(lt.proposed_actions || 0), `${lt.applied_actions || 0} applied · ${lt.measured_actions || 0} measured`, false],
    ["LLM cost", `$${Number(o.cost_7d || 0).toFixed(4)}`, `${o.calls_7d} calls · 7d · est.`, false],
    ["LLM latency", `${fmtMs(o.p50)} / ${fmtMs(o.p95)}`, `p50 / p95 · 7d`, false],
    ["Job success", successRate == null ? "—" : `${successRate}%`, `${o.ok_7d || 0}/${jobTotal} · 7d`, false],
    ["Errors 24h", String(o.errors_24h || 0), o.errors_24h ? "reliability" : "clear", Boolean(o.errors_24h)],
    ["Churned", String(o.churn?.total || 0), `${o.churn?.churned_30d || 0} · 30d`, false],
    ["Tenure@churn", o.churn && o.churn.total ? `${o.churn.avg_tenure}d` : "—", o.churn && o.churn.total ? `${pct(o.churn.reached_memory, o.churn.total)}% reached memory` : "no churn yet", false],
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

  // Portfolio LLM spend by feature · 7d + uninstall-reason breakdown (obs #20/#17).
  const featureRows = (o.costByFeature || []).length
    ? o.costByFeature
        .map(
          (f) =>
            `<tr><td>${esc(f.feature)}</td><td>$${Number(f.cost).toFixed(4)}</td><td>${f.calls}</td></tr>`,
        )
        .join("")
    : `<tr><td class="muted">No LLM usage · 7d.</td><td></td><td></td></tr>`;
  const reasonTotal = (o.churnReasons || []).reduce((a, r) => a + Number(r.n), 0);
  const reasonRows = reasonTotal
    ? o.churnReasons
        .map(
          (r) => `<tr><td>${esc(churnReasonLabel(r.reason))}</td><td>${r.n}</td></tr>`,
        )
        .join("")
    : `<tr><td class="muted">No uninstall feedback yet.</td><td></td></tr>`;
  const eh = o.emailHealth || {};
  const emailAny =
    Number(eh.delivered || 0) + Number(eh.suppressed || 0) + Number(eh.failed || 0);
  const emailRows = emailAny
    ? `<tr><td>Sent</td><td>${eh.delivered || 0}</td></tr><tr><td>Failed</td><td>${eh.failed || 0}</td></tr><tr><td>Suppressed</td><td>${eh.suppressed || 0}</td></tr>`
    : `<tr><td class="muted">No win-back emails yet.</td><td></td></tr>`;
  const bfsByMetric = Object.fromEntries(
    (o.webVitalsBfs || []).map((r) => [String(r.metric).toUpperCase(), r]),
  );
  const bfsRows = (o.webVitalsBfs || []).length
    ? ["LCP", "INP", "CLS"]
        .map((m) => {
          const r = bfsByMetric[m];
          const st = bfsWebVitalStatus(m, r ? r.p75 : null, r ? r.n : 0);
          const badge =
            st.state === "pass" ? "✅" : st.state === "fail" ? "🔴" : "·";
          return `<tr><td>${m}</td><td>${formatVitalValue(m, st.p75)} / ${formatVitalValue(m, st.target)} ${badge} <span class="muted">n=${st.n}</span></td></tr>`;
        })
        .join("")
    : `<tr><td class="muted">No Web Vitals yet — accumulating.</td><td></td></tr>`;
  const breakdown = `<div class="panels">
      <div class="panel"><div class="ph">LLM cost by feature · 7d</div><table class="mini"><tbody>${featureRows}</tbody></table></div>
      <div class="panel"><div class="ph">Why they left · latest per shop</div><table class="mini"><tbody>${reasonRows}</tbody></table></div>
      <div class="panel"><div class="ph">Win-back email · 7d</div><table class="mini"><tbody>${emailRows}</tbody></table></div>
      <div class="panel"><div class="ph">Web Vitals · BFS (p75 · 28d)</div><table class="mini"><tbody>${bfsRows}</tbody></table></div>
    </div>`;

  const triageRows = (o.liveTriageRows || []).length
    ? o.liveTriageRows
        .map(
          (r) => `<tr><td><a class="mlink" href="/merchant?shop=${encodeURIComponent(r.shop_domain)}">${esc(r.shop_domain)}</a></td><td>${esc(overviewIssueSummary(r))}</td></tr>`,
        )
        .join("")
    : `<tr><td class="empty" colspan="2">No live merchants need attention right now.</td></tr>`;
  const triage = `<div class="section">
      <div class="section-title">Live merchant triage</div>
      <table><thead><tr><th>Merchant</th><th>Current issue</th></tr></thead><tbody>${triageRows}</tbody></table>
    </div>`;

  // Margin per client (indicative) — net revenue − COGS − LLM cost, coverage-gated (obs #20).
  let anyIndicative = false;
  const marginRows = (o.marginList || []).length
    ? o.marginList
        .map((r) => {
          const netRev = Number(r.revenue || 0) - Number(r.refunds || 0);
          const coverage =
            Number(r.line_rev || 0) > 0
              ? Math.round((Number(r.covered_rev || 0) / Number(r.line_rev)) * 100)
              : 0;
          const margin = netRev - Number(r.cogs || 0) - Number(r.llm_cost || 0);
          const marginPct = netRev > 0 ? Math.round((margin / netRev) * 100) : null;
          if (coverage < 70) anyIndicative = true;
          const flag = coverage < 70 ? "*" : "";
          const n0 = (x) => Number(x).toLocaleString("en-US", { maximumFractionDigits: 0 });
          return `<tr><td><a class="mlink" href="/merchant?shop=${encodeURIComponent(r.shop_domain)}">${esc(r.shop_domain)}</a></td><td>$${n0(netRev)}</td><td>${r.orders}</td><td>${coverage}%</td><td>$${Number(r.llm_cost || 0).toFixed(4)}</td><td>$${n0(margin)}${flag}${marginPct == null ? "" : ` <span class="muted">${marginPct}%</span>`}</td></tr>`;
        })
        .join("")
    : `<tr><td class="empty" colspan="6">No merchants with orders yet.</td></tr>`;
  const marginTable = `<div style="color:#8b909a;font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin:18px 0 6px">Margin by client · indicative</div>
    <table><thead><tr><th>Client</th><th>Net rev.</th><th>Orders</th><th>COGS cov.</th><th>LLM cost</th><th>Margin</th></tr></thead><tbody>${marginRows}</tbody></table>
    ${anyIndicative ? `<div class="note">* COGS coverage &lt; 70% — margin is overstated (missing unit costs make true cost lower than shown); LLM cost uses placeholder pricing.</div>` : ""}`;

  return `<div class="tiles">${tileHtml}</div>${strip}${breakdown}${triage}${marginTable}`;
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
  .pill.good { background:#173226; color:#8ee0b1; }
  .pill.muted-pill { background:#202329; color:#8b909a; }
  .empty { padding:40px 20px; color:#8b909a; }
  .empty.compact { padding:10px 0; }
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
  .section { padding:14px 20px; border-bottom:1px solid #23262d; }
  .section-title { color:#8b909a; font-size:11px; text-transform:uppercase; letter-spacing:.05em; margin-bottom:8px; }
  .attention { background:#130f10; }
  .attention ul, .clean-list { margin:0; padding-left:18px; }
  .attention li { margin:3px 0; color:#ffcece; }
  .state-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:12px; }
  .panel.wide { min-width:280px; }
  .bigline { font-size:22px; font-weight:700; margin:2px 0 4px; }
  .note-inline { margin-top:8px; color:#ffb4b4; font-size:12px; }
  .card-stack { display:grid; gap:8px; margin-top:8px; }
  .cardlet { border-top:1px solid #23262d; padding-top:8px; }
  .cardlet p { margin:4px 0; }
  .row-head { display:flex; justify-content:space-between; gap:10px; align-items:center; }
  .pill-row { display:flex; gap:6px; align-items:center; flex-wrap:wrap; justify-content:flex-end; }
  .chat-stack { display:grid; gap:8px; margin-top:10px; }
  .chat-context { margin-top:6px; color:#a9c2ff; font-size:12px; }
  .chat-row { border-top:1px solid #23262d; padding-top:8px; }
  .chat-meta { color:#8b909a; font-size:11px; text-transform:uppercase; letter-spacing:.04em; margin-bottom:2px; }
  .chat-op { color:#6b7280; font-size:12px; margin-top:3px; }
  .steps { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; }
  .step { display:flex; gap:8px; align-items:flex-start; color:#8b909a; min-height:42px; }
  .step strong { display:block; color:#e6e6e6; }
  .step span { display:block; font-size:12px; color:#6b7280; }
  .step-dot { width:9px; height:9px; border-radius:50%; background:#3a1f22; margin-top:6px; flex:0 0 auto; }
  .step-done .step-dot { background:#2d6cdf; }
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

  // Latest uninstall-feedback reason for this shop (if they answered the
  // farewell email) — folded onto the churn record in the header. (obs #17)
  const churnReason = shopId
    ? (
        await pool.query(
          `SELECT properties->>'reason' AS reason
             FROM activity_events
            WHERE type = 'shop_uninstall_feedback' AND shop_id = $1
            ORDER BY created_at DESC LIMIT 1`,
          [shopId],
        )
      ).rows[0]?.reason || null
    : null;
  const conversationMessageColumns = shopId
    ? await getConversationMessageColumns()
    : { hasStructuredOperationJson: false };
  const structuredOperationSelect = conversationMessageColumns.hasStructuredOperationJson
    ? "structured_operation_json"
    : "NULL::json AS structured_operation_json";

  const [
    latestMemoryRunRows,
    memoryStatusRows,
    memoryCategoryRows,
    openQuestionRows,
    insightRows,
    latestGoalRunRows,
    goalRows,
    planRows,
    actionRows,
    policyRows,
    reliabilityRows,
    conversationRows,
  ] = shopId
    ? await Promise.all([
        pool.query(
          `SELECT id, refresh_type, status, last_error, started_at, completed_at, failed_at, created_at, updated_at
             FROM merchant_memory_refresh_runs
            WHERE shop_id = $1
            ORDER BY created_at DESC
            LIMIT 1`,
          [shopId],
        ),
        pool.query(
          `SELECT status, count(*)::int n
             FROM merchant_memory_beliefs
            WHERE shop_id = $1
            GROUP BY status
            ORDER BY n DESC`,
          [shopId],
        ),
        pool.query(
          `SELECT category, count(*)::int n
             FROM merchant_memory_beliefs
            WHERE shop_id = $1
              AND status IN ('inferred','merchant_confirmed','merchant_corrected')
            GROUP BY category
            ORDER BY n DESC, category
            LIMIT 8`,
          [shopId],
        ),
        pool.query(
          `SELECT count(*) OVER()::int total_open, category, question, reason, priority, created_at
             FROM merchant_memory_open_questions
            WHERE shop_id = $1
              AND status = 'open'
            ORDER BY priority ASC, created_at ASC
            LIMIT 5`,
          [shopId],
        ),
        pool.query(
          `WITH latest AS (
             SELECT id, status, safe_error_code, last_error, completed_at, failed_at, created_at, updated_at
               FROM merchant_insight_runs
              WHERE shop_id = $1
                AND superseded_at IS NULL
              ORDER BY created_at DESC
              LIMIT 1
           )
           SELECT l.id AS run_id, l.status AS run_status, l.safe_error_code, l.last_error,
                  l.completed_at AS run_completed_at, l.failed_at AS run_failed_at,
                  l.created_at AS run_created_at, l.updated_at AS run_updated_at,
                  f.id AS finding_id, f.title, f.finding, f.why_it_matters,
                  f.confidence, f.category, f.caveat, f.review_status,
                  f.corrected_at, f.reviewed_at, f.order_index
             FROM latest l
             LEFT JOIN merchant_insight_findings f ON f.run_id = l.id
            ORDER BY f.order_index ASC NULLS LAST`,
          [shopId],
        ),
        pool.query(
          `SELECT id, status, safe_error_code, last_error, completed_at, failed_at, created_at, updated_at
             FROM merchant_goal_runs
            WHERE shop_id = $1
              AND superseded_at IS NULL
            ORDER BY created_at DESC
            LIMIT 1`,
          [shopId],
        ),
        pool.query(
          `WITH latest_completed AS (
             SELECT id, status, completed_at, created_at, updated_at
               FROM merchant_goal_runs
              WHERE shop_id = $1
                AND status = 'completed'
                AND superseded_at IS NULL
              ORDER BY completed_at DESC NULLS LAST, created_at DESC
              LIMIT 1
           )
           SELECT lc.id AS run_id, lc.status AS run_status, lc.completed_at AS run_completed_at,
                  lc.created_at AS run_created_at, lc.updated_at AS run_updated_at,
                  gh.id AS goal_id, gh.horizon, gh.title, gh.description,
                  gh.supporting_belief_ids, gh.memory_belief_id, gh.order_index
             FROM latest_completed lc
             LEFT JOIN merchant_goal_horizons gh ON gh.run_id = lc.id
            ORDER BY gh.order_index ASC NULLS LAST`,
          [shopId],
        ),
        pool.query(
          `SELECT pr.id AS run_id, pr.status AS run_status, pr.safe_error_code, pr.last_error,
                  pr.completed_at AS run_completed_at, pr.failed_at AS run_failed_at,
                  pr.created_at AS run_created_at, pr.updated_at AS run_updated_at,
                  rec.id AS recommendation_id, rec.title, rec.summary, rec.primary_goal_id,
                  rec.why_this_action, rec.why_now, rec.start_today,
                  rec.success_signal_json, rec.expected_benefit, rec.confidence,
                  rec.assumption, rec.caveat, rec.review_status,
                  rec.accepted_at, rec.rejected_at, rec.completed_at AS recommendation_completed_at,
                  rec.supporting_goal_ids, rec.supporting_insight_ids
             FROM merchant_plan_runs pr
             LEFT JOIN merchant_plan_recommendations rec ON rec.run_id = pr.id
            WHERE pr.shop_id = $1
              AND pr.superseded_at IS NULL
            ORDER BY pr.created_at DESC
            LIMIT 1`,
          [shopId],
        ),
        pool.query(
          `SELECT ae.id, ae.run_id, ae.action_type, ae.action_kind, ae.status,
                  ae.merchant_setting, ae.resolved_mode, ae.eligibility_json,
                  ae.confidence, ae.approved_by, ae.approved_at, ae.applied_at,
                  ae.reverted_at, ae.outcome_status, ae.outcome_measured_at,
                  ae.proposal_summary, ae.preview_json, ae.outcome_json, ae.error,
                  ae.created_at, ae.updated_at,
                  coalesce(w.write_counts, '[]'::json) AS write_counts
             FROM action_executions ae
             LEFT JOIN LATERAL (
               SELECT json_agg(json_build_object('status', c.status, 'n', c.n) ORDER BY c.status) AS write_counts
                 FROM (
                   SELECT status, count(*)::int n
                     FROM action_execution_writes
                    WHERE execution_id = ae.id
                    GROUP BY status
                 ) c
             ) w ON TRUE
            WHERE ae.shop_id = $1
            ORDER BY ae.created_at DESC
            LIMIT 12`,
          [shopId],
        ),
        pool.query(
          `SELECT action_type, mode, policy, updated_at
             FROM action_autonomy_policies
            WHERE merchant_id = $1
            ORDER BY action_type`,
          [shop.merchant_id],
        ),
        pool.query(
          `SELECT created_at, type, topic, summary
             FROM activity_events
            WHERE (shop_id = $1 OR shop_domain = $2)
              AND (topic = 'reliability' OR type LIKE '%error' OR type LIKE '%failed')
              AND created_at >= now() - interval '24 hours'
            ORDER BY created_at DESC
            LIMIT 8`,
          [shopId, shopDomain],
        ),
        pool.query(
          `SELECT c.id AS conversation_id, c.topic, c.status AS conversation_status,
                  c.context_json, c.updated_at AS conversation_updated_at,
                  m.id AS message_id, m.role, m.content, m.safe_summary,
                  m.structured_operation_json, m.operation_status,
                  m.created_at AS message_created_at
             FROM (
               SELECT id, topic, status, context_json, updated_at
                 FROM merchant_memory_conversations
                WHERE merchant_id = $1
                  AND shop_id = $2
                  AND (topic = 'onboarding_plan' OR topic LIKE 'action:%')
                ORDER BY updated_at DESC
                LIMIT 4
             ) c
             LEFT JOIN LATERAL (
               SELECT id, role, content, safe_summary, ${structuredOperationSelect}, operation_status, created_at
                 FROM merchant_memory_conversation_messages
                WHERE conversation_id = c.id
                ORDER BY created_at DESC
                LIMIT 12
             ) m ON TRUE
            ORDER BY c.updated_at DESC, c.topic ASC, m.created_at ASC NULLS LAST`,
          [shop.merchant_id, shopId],
        ),
      ])
    : [{ rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }];

  const latestMemoryRun = latestMemoryRunRows.rows[0] || null;
  const memoryStatusCounts = Object.fromEntries(memoryStatusRows.rows.map((r) => [r.status, Number(r.n || 0)]));
  const activeBeliefCount =
    Number(memoryStatusCounts.inferred || 0) +
    Number(memoryStatusCounts.merchant_confirmed || 0) +
    Number(memoryStatusCounts.merchant_corrected || 0);
  const openQuestionTotal = openQuestionRows.rows[0]?.total_open || 0;
  const latestInsightRun = insightRows.rows[0]
    ? {
        id: insightRows.rows[0].run_id,
        status: insightRows.rows[0].run_status,
        safe_error_code: insightRows.rows[0].safe_error_code,
        last_error: insightRows.rows[0].last_error,
        completed_at: insightRows.rows[0].run_completed_at,
        failed_at: insightRows.rows[0].run_failed_at,
        created_at: insightRows.rows[0].run_created_at,
        updated_at: insightRows.rows[0].run_updated_at,
      }
    : null;
  const insightFindings = insightRows.rows
    .filter((r) => r.finding_id)
    .map((r) => ({
      id: r.finding_id,
      title: r.title,
      finding: r.finding,
      why_it_matters: r.why_it_matters,
      confidence: r.confidence,
      category: r.category,
      caveat: r.caveat,
      review_status: r.review_status,
      corrected_at: r.corrected_at,
      reviewed_at: r.reviewed_at,
    }));
  const latestGoalRun = latestGoalRunRows.rows[0] || null;
  const completedGoalRun = goalRows.rows[0]
    ? {
        id: goalRows.rows[0].run_id,
        status: goalRows.rows[0].run_status,
        completed_at: goalRows.rows[0].run_completed_at,
        created_at: goalRows.rows[0].run_created_at,
        updated_at: goalRows.rows[0].run_updated_at,
      }
    : null;
  const goals = goalRows.rows
    .filter((r) => r.goal_id)
    .map((r) => ({
      id: r.goal_id,
      horizon: r.horizon,
      title: r.title,
      description: r.description,
      supporting_belief_ids: r.supporting_belief_ids || [],
      memory_belief_id: r.memory_belief_id,
    }));
  const latestPlan = planRows.rows[0] || null;
  const planConversationsById = new Map();
  for (const row of conversationRows.rows) {
    if (!planConversationsById.has(row.conversation_id)) {
      planConversationsById.set(row.conversation_id, {
        id: row.conversation_id,
        topic: row.topic,
        context_json: row.context_json,
        status: row.conversation_status,
        updated_at: row.conversation_updated_at,
        messages: [],
      });
    }
    if (row.message_id) {
      planConversationsById.get(row.conversation_id).messages.push({
        id: row.message_id,
        role: row.role,
        content: row.content,
        safe_summary: row.safe_summary,
        structured_operation_json: row.structured_operation_json,
        operation_status: row.operation_status,
        created_at: row.message_created_at,
      });
    }
  }

  return {
    shop,
    events,
    cost,
    costByFeature,
    margin,
    currency,
    eventSpark,
    costSpark,
    churnReason,
    latestMemoryRun,
    memoryStatusCounts,
    activeBeliefCount,
    memoryCategoryCounts: memoryCategoryRows.rows,
    openQuestionTotal,
    openQuestions: openQuestionRows.rows,
    latestInsightRun,
    insightFindings,
    latestGoalRun,
    completedGoalRun,
    goals,
    latestPlan,
    actions: actionRows.rows,
    policies: policyRows.rows,
    reliabilityEvents: reliabilityRows.rows,
    planConversations: [...planConversationsById.values()],
  };
}

function renderMerchant(data, shopDomain) {
  const shop = data.shop;
  const yesno = (d) => (d ? "yes" : "no");
  const tenure =
    shop && shop.created_at
      ? Math.max(0, Math.floor((Date.now() - new Date(shop.created_at).getTime()) / 86400000))
      : null;
  const churned = Boolean(shop && shop.status === "uninstalled");
  const ccy = data.currency || "GBP";
  const latestPlanRun = data.latestPlan
    ? {
        status: data.latestPlan.run_status,
        updated_at: data.latestPlan.run_updated_at,
        created_at: data.latestPlan.run_created_at,
      }
    : null;
  const failedGenerationRuns = [data.latestInsightRun, data.latestGoalRun, latestPlanRun].filter(isIssueRun).length;
  const stalledMemory = isStalledRun(data.latestMemoryRun);
  const failedMemoryRuns =
    data.latestMemoryRun?.status === "failed" || stalledMemory ? 1 : 0;
  const failedActions = data.actions.filter((a) => ["failed", "partially_applied"].includes(String(a.status))).length;
  const failedActionWrites = data.actions.reduce((total, action) => total + issueCountFromWrites(action.write_counts), 0);
  const health = classifyMerchantHealth({
    shop,
    reliabilityEvents24h: data.reliabilityEvents.length,
    failedGenerationRuns,
    failedMemoryRuns,
    failedActions,
    failedActionWrites,
    staleMemory: stalledMemory,
    activeBeliefCount: data.activeBeliefCount,
  });

  const statusTiles = shop
    ? [
        ["State", health.label, health.summary, health.severity === "warn"],
        ["Status", churned ? "uninstalled" : String(shop.status ?? "—"), String(shop.setup_status ?? "")],
        ["Tenure", tenure != null ? `${tenure}d` : "—", `installed ${fmtDate(shop.created_at)}`],
        ["Onboarded", yesno(shop.onboarding_completed_at), fmtDate(shop.onboarding_completed_at)],
        ["Backfill", yesno(shop.backfill_completed_at), fmtDate(shop.backfill_completed_at)],
        ["Cost data", `${Number(shop.cogs_completion_percentage ?? 0).toFixed(0)}%`, String(shop.cogs_confidence_level ?? "")],
      ]
    : [["State", health.label, health.summary, health.severity === "warn"], ["Shop", "no record", "activity only"]];

  const costTiles = [
    ["LLM cost", `$${Number(data.cost.total_cost || 0).toFixed(4)}`, `${data.cost.calls} calls · est.`],
    ["Tokens", Number(data.cost.tokens || 0).toLocaleString("en-US"), "in+out"],
    ["Avg latency", data.cost.avg_latency ? `${data.cost.avg_latency}ms` : "—", "per call"],
  ];

  // Unit economics (read-only): revenue - COGS - LLM cost, coverage-gated so a
  // shop with patchy unit-cost data isn't shown a falsely-precise margin.
  const m = data.margin || {};
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
      ([label, value, sub, warn]) =>
        `<div class="tile${warn ? " tile-warn" : ""}"><div class="tv">${esc(value)}</div><div class="tl">${esc(label)}</div><div class="ts">${esc(sub)}</div></div>`,
    )
    .join("");

  const attentionItems = [];
  if (health.state !== "healthy") attentionItems.push(health.summary);
  if (churned && data.churnReason) attentionItems.push(`Merchant said: ${churnReasonLabel(data.churnReason)}`);
  for (const event of data.reliabilityEvents) {
    attentionItems.push(`${fmtDateTime(event.created_at)} ${event.type}: ${event.summary || event.topic || "Reliability event"}`);
  }
  if (!data.latestMemoryRun && shop?.backfill_completed_at) {
    attentionItems.push("Backfill completed but no Merchant Memory refresh run was found.");
  } else if (data.latestMemoryRun?.status === "failed") {
    attentionItems.push(`Merchant Memory failed: ${data.latestMemoryRun.last_error || "no safe error recorded"}`);
  } else if (stalledMemory) {
    attentionItems.push("Merchant Memory has been running for over 1 hour.");
  }
  if (shop?.backfill_completed_at && data.activeBeliefCount === 0) {
    attentionItems.push("No active Merchant Memory beliefs found after backfill.");
  }
  const runIssues = [
    ["Insights", data.latestInsightRun],
    ["Goals", data.latestGoalRun],
    ["Plan", data.latestPlan ? { ...latestPlanRun, last_error: data.latestPlan.last_error } : null],
  ];
  for (const [label, run] of runIssues) {
    if (!run) continue;
    if (run.status === "failed") attentionItems.push(`${label} generation failed: ${run.last_error || "no safe error recorded"}`);
    else if (isStalledRun(run)) attentionItems.push(`${label} generation is still ${run.status} after 1 hour.`);
  }
  for (const action of data.actions.filter((a) => ["failed", "partially_applied"].includes(String(a.status))).slice(0, 4)) {
    attentionItems.push(`${actionTitle(action)}: ${actionProgressLabel({ status: action.status, outcomeStatus: action.outcome_status, outcome: action.outcome_json, error: action.error }, ccy)}`);
  }
  for (const action of data.actions.filter((a) => issueCountFromWrites(a.write_counts) > 0).slice(0, 4)) {
    attentionItems.push(`${actionTitle(action)} writes: ${formatWriteCounts(action.write_counts)}`);
  }
  const attentionHtml = `<div class="section attention">
      <div class="section-title">Needs attention</div>
      ${
        attentionItems.length
          ? `<ul>${attentionItems.slice(0, 12).map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`
          : `<div class="empty compact">No live issues detected for this merchant.</div>`
      }
    </div>`;

  const memoryStatusRows = Object.entries(data.memoryStatusCounts || {}).length
    ? Object.entries(data.memoryStatusCounts)
        .map(([status, count]) => `<tr><td>${esc(status)}</td><td>${count}</td></tr>`)
        .join("")
    : `<tr><td class="muted">No beliefs recorded.</td><td></td></tr>`;
  const memoryCategoryRows = data.memoryCategoryCounts.length
    ? data.memoryCategoryCounts
        .map((r) => `<tr><td>${esc(r.category)}</td><td>${r.n}</td></tr>`)
        .join("")
    : `<tr><td class="muted">No active categories.</td><td></td></tr>`;
  const openQuestionRows = data.openQuestions.length
    ? data.openQuestions
        .map((q) => `<li><strong>${esc(q.category)}</strong> ${esc(q.question)} <span class="muted">${esc(q.reason)}</span></li>`)
        .join("")
    : `<li class="muted">No open memory questions.</li>`;
  const insightStatus = data.latestInsightRun
    ? `${data.latestInsightRun.status} · ${fmtDateTime(data.latestInsightRun.completed_at || data.latestInsightRun.failed_at || data.latestInsightRun.updated_at)}`
    : "No insight run recorded.";
  const insightCards = data.insightFindings.length
    ? data.insightFindings
        .slice(0, 5)
        .map(
          (finding) => `<div class="cardlet"><div class="row-head"><strong>${esc(finding.title)}</strong>${pill(finding.review_status || "unreviewed", finding.review_status === "corrected" ? "warn" : "info")}</div><p>${esc(finding.finding)}</p><div class="muted">${esc(finding.category)} · ${esc(finding.confidence)} confidence${finding.caveat ? ` · ${esc(finding.caveat)}` : ""}</div></div>`,
        )
        .join("")
    : `<div class="empty compact">No generated insights recorded yet.</div>`;
  const memoryHtml = `<div class="section">
      <div class="section-title">Memory & learning</div>
      <div class="state-grid">
        <div class="panel wide">
          <div class="ph">Merchant Memory</div>
          <div class="bigline">${esc(data.latestMemoryRun?.status || "not recorded")}</div>
          <div class="muted">Latest refresh ${fmtDateTime(data.latestMemoryRun?.completed_at || data.latestMemoryRun?.failed_at || data.latestMemoryRun?.updated_at)} · ${data.activeBeliefCount} active beliefs · ${data.openQuestionTotal} open questions</div>
          ${data.latestMemoryRun?.last_error ? `<div class="note-inline">${esc(data.latestMemoryRun.last_error)}</div>` : ""}
          <table class="mini"><tbody>${memoryStatusRows}</tbody></table>
        </div>
        <div class="panel">
          <div class="ph">Active belief categories</div>
          <table class="mini"><tbody>${memoryCategoryRows}</tbody></table>
        </div>
        <div class="panel wide">
          <div class="ph">Open memory questions</div>
          <ul class="clean-list">${openQuestionRows}</ul>
        </div>
        <div class="panel wide">
          <div class="ph">Latest insights</div>
          <div class="muted">${esc(insightStatus)}</div>
          <div class="card-stack">${insightCards}</div>
        </div>
      </div>
    </div>`;

  const goalCards = data.goals.length
    ? data.goals
        .map(
          (goal) => `<div class="cardlet"><div class="row-head"><strong>${esc(horizonLabel(goal.horizon))}</strong>${goal.memory_belief_id ? pill("in memory", "good") : pill("not linked", "muted")}</div><p>${esc(goal.title)}</p>${goal.description ? `<div class="muted">${esc(goal.description)}</div>` : ""}</div>`,
        )
        .join("")
    : `<div class="empty compact">No completed generated goals recorded yet.</div>`;
  const plan = data.latestPlan;
  const planHtml = plan?.recommendation_id
    ? `<div class="cardlet plan-card">
        <div class="row-head"><strong>${esc(plan.title)}</strong>${pill(plan.review_status || "proposed", plan.review_status === "rejected" ? "warn" : plan.review_status === "completed" ? "good" : "info")}</div>
        <p>${esc(plan.summary)}</p>
        <div class="muted">Run ${esc(plan.run_status)} · generated ${fmtDateTime(plan.run_completed_at || plan.run_updated_at)} · accepted ${fmtDateTime(plan.accepted_at)} · completed ${fmtDateTime(plan.recommendation_completed_at)}</div>
        <table class="mini"><tbody>
          <tr><td>Why now</td><td>${esc(plan.why_now || "Not recorded.")}</td></tr>
          <tr><td>Success signal</td><td>${esc(formatSuccessSignal(plan.success_signal_json))}</td></tr>
          <tr><td>Expected benefit</td><td>${esc(plan.expected_benefit || "Not recorded.")}</td></tr>
        </tbody></table>
      </div>`
    : `<div class="empty compact">No plan recommendation recorded yet${plan ? ` · latest run ${esc(plan.run_status)}` : ""}.</div>`;
  const goalsHtml = `<div class="section">
      <div class="section-title">Goals & plan</div>
      <div class="state-grid">
        <div class="panel wide">
          <div class="ph">Generated goals</div>
          <div class="muted">Latest run ${esc(data.latestGoalRun?.status || "not recorded")} · completed ${fmtDateTime(data.completedGoalRun?.completed_at)}</div>
          <div class="card-stack">${goalCards}</div>
        </div>
        <div class="panel wide">
          <div class="ph">Current plan</div>
          ${planHtml}
        </div>
      </div>
    </div>`;

  const conversationCards = data.planConversations.length
    ? data.planConversations
        .map((conversation) => {
          const isCurrentPlanChat = conversationMatchesPlan(conversation, plan);
          const messages = conversation.messages.length
            ? conversation.messages
                .map(
                  (message) => {
                    const operation = formatStructuredOperation(message.structured_operation_json);
                    const snippetMax = String(message.role || "").toLowerCase() === "assistant" ? 900 : 420;
                    return `<div class="chat-row">
                      <div class="chat-meta">${esc(fmtDateTime(message.created_at))} · ${esc(message.role || "unknown")}${message.operation_status ? ` · ${esc(message.operation_status)}` : ""}</div>
                      <div>${esc(formatConversationSnippet(message, snippetMax))}</div>
                      ${operation ? `<div class="chat-op">${esc(operation)}</div>` : ""}
                    </div>`;
                  },
                )
                .join("")
            : `<div class="empty compact">No messages recorded in this conversation.</div>`;
          return `<div class="panel wide">
            <div class="row-head"><div class="ph">${esc(conversationTopicLabel(conversation.topic))}</div><div class="pill-row">${isCurrentPlanChat ? pill("current plan", "good") : ""}${pill(conversation.status || "active", conversation.status === "active" ? "good" : "muted")}</div></div>
            <div class="muted">Updated ${fmtDateTime(conversation.updated_at)}</div>
            <div class="chat-context">${esc(formatConversationContext(conversation.context_json, conversation.topic))}</div>
            <div class="chat-stack">${messages}</div>
          </div>`;
        })
        .join("")
    : `<div class="empty compact">No plan or action chat messages recorded yet.</div>`;
  const conversationHtml = `<div class="section">
      <div class="section-title">Plan/action chat</div>
      <div class="state-grid">${conversationCards}</div>
    </div>`;

  const policyRows = data.policies.length
    ? data.policies
        .map((p) => `<tr><td>${esc(p.action_type)}</td><td>${esc(p.mode)}</td><td>${fmtDateTime(p.updated_at)}</td></tr>`)
        .join("")
    : `<tr><td class="muted">No autonomy policies set.</td><td></td><td></td></tr>`;
  const actionRows = data.actions.length
    ? data.actions
        .map((action) => {
          const severity = actionStatusSeverity(action.status);
          return `<tr>
            <td>${esc(fmtDateTime(action.applied_at || action.approved_at || action.created_at))}</td>
            <td>${pill(actionStatusLabel(action.status), severity)}</td>
            <td><strong>${esc(actionTitle(action))}</strong><div class="muted">${esc(formatProposalSummary(action.proposal_summary, ccy))}</div></td>
            <td>${esc(action.merchant_setting || "default")} -> ${esc(action.resolved_mode || "unknown")}</td>
            <td>${esc(actionProgressLabel({ status: action.status, outcomeStatus: action.outcome_status, outcome: action.outcome_json, error: action.error }, ccy))}</td>
            <td>${esc(formatWriteCounts(action.write_counts))}</td>
          </tr>`;
        })
        .join("")
    : `<tr><td class="empty" colspan="6">No action executions recorded yet.</td></tr>`;
  const actionsHtml = `<div class="section">
      <div class="section-title">Actions & progress</div>
      <div class="state-grid">
        <div class="panel">
          <div class="ph">Autonomy policies</div>
          <table class="mini"><tbody>${policyRows}</tbody></table>
        </div>
        <div class="panel wide">
          <div class="ph">Action ledger</div>
          <table><thead><tr><th>Time</th><th>Status</th><th>Action</th><th>Mode</th><th>Progress</th><th>Writes</th></tr></thead><tbody>${actionRows}</tbody></table>
        </div>
      </div>
    </div>`;

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
      <span class="muted">${esc(shopDomain)} · ${pill(health.label, health.severity)}${churned && data.churnReason ? ` · said: ${esc(churnReasonLabel(data.churnReason))}` : ""}</span>
      <a class="clear" href="/" style="margin-left:auto">← All activity</a>
    </header>
    <div class="tiles">${tiles}</div>
    ${coverageNote}
    ${attentionHtml}
    ${renderLifecycle(data)}
    ${memoryHtml}
    ${goalsHtml}
    ${conversationHtml}
    ${actionsHtml}
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

  if (!isAuthed(req)) {
    logOpsAccess(req, url, "denied");
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="Jefe Ops"',
      "Content-Type": "text/plain",
    });
    res.end(OPS_PASSWORD ? "Authentication required." : "OPS_PASSWORD is not configured.");
    return;
  }
  logOpsAccess(req, url, "granted");

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
