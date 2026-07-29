# Observability — follow-ups & ops runbook (chat 8, 2026-07-29)

The code-side observability roadmap is shipped (see `observability-handover-2026-07-29.md`).
What's left is **infra / founder-gated** — no new app machinery, just steps to
run when wanted. Grouped by roadmap item.

## New env vars introduced (chat 8)

On the `jefe` service (Railway):
- `VITE_SENTRY_DSN` — **set** (= `SENTRY_DSN`). Build-time inlined so client-side
  Sentry activates. A DSN is a public client identifier.
- `READINESS_ALERT_GRACE_SECONDS` — optional, default `60`. A DB/readiness/worker
  blip within this many seconds of process start logs WARN (no page); after it,
  ERROR (pages). Tune if deploys take longer than 60s to warm the DB pool.
- `ENABLE_EVENT_RETENTION` — optional, default off. `true` turns on daily pruning
  of `activity_events` / `llm_usage_event`.
- `EVENT_RETENTION_ACTIVITY_DAYS` / `EVENT_RETENTION_USAGE_DAYS` — optional,
  default `365`.

## #8 Uptime / SLOs (founder / infra)

Auto-recovery already exists: Railway's healthcheck points at `/ready`, which
fails closed (503) when the DB is unreachable, so a broken instance is not kept
in rotation. What's missing is **external** synthetic monitoring (Railway can't
tell you the whole service is down).

- **External synthetic check**: point an uptime monitor (Better Uptime,
  UptimeRobot, Pingdom — free tiers fine) at `https://jefe-production.up.railway.app/ready`
  (or `app.mynamejefe.com/ready`), interval 1–5 min, alert channel = #jefe-slack.
  `/ready` returns 200 JSON when healthy, 503 when the DB is down.
- **SLO targets to start with** (revisit as volume grows): availability 99.5%
  monthly on `/ready`; job success-rate ≥ 99% weekly (visible on the ops panel
  overview → "Job success"); LLM p95 latency < 8s (ops overview → "LLM latency").
- Internal error-budget tracking (rolling error-rate alerting) is deliberately
  **not built** — premature at current volume; the ops panel + Sentry + Slack
  alerts cover it. Add later if the SLOs above start slipping.

## #9 Retention / hygiene — remaining

- **Retention**: shipped as opt-in (`retention.server.js`, gated on
  `ENABLE_EVENT_RETENTION`). Turn on when the tables grow. No-op today.
- **Event PII-safety audit**: enforced in code — `track()` runs every event's
  `properties` through `redact()`, and writers only pass counts/ids/short
  summaries (never customer data). Covered by `analytics-event-log.test.mjs`
  (redaction) and `analytics-churn.test.mjs` (PII-free snapshot). Writers:
  worker success/fail events, `shop_installed`, `shop_uninstalled`,
  `server_error` / `worker_error`. Keep this invariant when adding new events.
- **Log drain** (infra): Railway logs are ephemeral. To keep history / run
  percentiles over request + query latency, add a Railway **Log Drain** (Settings
  → Logs → Drains) to a sink (Better Stack / Datadog / an S3+Loki setup). Until
  then, cross-instance/historical latency percentiles aren't available; the
  per-instance live readout on `/health` (`latency`) is the interim signal.

## Ops panel — re-gate + read-only DB user

The panel (`admin.mynamejefe.com`) is intentionally **public** right now
(`OPS_PUBLIC=true`, founder's call; `noindex` + robots block).

- **Re-secure**: it's a single flag flip — `railway variables --service jefe-ops
  --set OPS_PUBLIC=false`. `OPS_PASSWORD` is already set, so HTTP Basic auth
  (fail-closed) takes over immediately. (SSO is a larger future upgrade.)
- **Read-only DB role** (defence in depth — the ops app only ever SELECTs). Create
  a read-only Neon role and point `jefe-ops`'s `DATABASE_URL` at it:

  ```sql
  CREATE ROLE jefe_ops_ro LOGIN PASSWORD '<generated>';
  GRANT CONNECT ON DATABASE <db> TO jefe_ops_ro;
  GRANT USAGE ON SCHEMA public TO jefe_ops_ro;
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO jefe_ops_ro;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO jefe_ops_ro;
  ```

  Then set `jefe-ops` `DATABASE_URL` to that role's connection string. Needs DB
  admin, so it's a founder step.

## #12 Slack MCP — closed (superseded)

Optional raw-channel Slack MCP (korotovsky `slack-mcp-server`) is **not being
built**. Superseded by alerts-in-DB: alert-worthy errors land in `activity_events`
(topic `reliability`), readable at the panel (filter reliability) or by SQL, and
error-level logs already push to #jefe-slack via `alerting.server.js`
(`ALERT_WEBHOOK_URL`). Revisit only if a live raw Slack feed is ever wanted.

## Sentry → #jefe-slack (founder OAuth)

Founder wants Sentry issues in #jefe-slack, not email. Server errors already reach
#jefe-slack via `alerting.server.js`; the gap is **client/browser** Sentry issues.

1. Sentry → Settings → Integrations → **Slack** → Add to Slack → authorize for the
   workspace (this OAuth grant must be done by the founder).
2. Sentry → Alerts → create/modify an issue alert → action **Send a Slack
   notification** to `#jefe-slack` (route new + high-priority issues).
3. Turn off personal **email** notifications (or scope them down).

Claude can drive the browser for steps 2–3 once the founder has done the OAuth in
step 1.
