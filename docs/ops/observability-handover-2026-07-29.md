# Observability — session handover (2026-07-29)

Resume-state for the next observability session. Built across "Jefe chat 3" on
2026-07-28→29. Everything below is **live in prod** unless marked.

## Chat 8 update (2026-07-30, overnight) — autonomous top-5 shipped

Continuation under an explicit overnight mandate ("deploy two-way doors + turn
on; build one-way doors but hold for the morning"). Everything here is **live in
prod** (jefe via `main`, ops panel via `railway up --service jefe-ops`) unless
marked HELD. Commits authored `Jefe Agent`.

**Shipped + deployed (two-way doors):**
- **LLM metering completed** — all **7** call sites now record to `llm_usage_event` (added `conversation` + `store_understanding` via `safeCreateLlmProvider(logger, usage)`, plus `insight_correction` + `goals_document`). Margin is honest end-to-end now. Pricing still PLACEHOLDER (see gotchas).
- **Bug #13 fixed** (the duplicate-`app/uninstalled` reactivation flagged out-of-scope on 07-29): `app/uninstalled` is handled BEFORE the dedupe short-circuit — churn captured once (gated on `created`), `markShopifyInstallInactive` ALWAYS re-asserted (idempotent). Regression test added. `Shop.uninstalledAt` added (migration `20260729130000`, verified absent in prod first).
- **/health diagnostics** — `buildWorkerHealth` (backfill-loop liveness via an in-memory heartbeat: ok/stale/starting/disabled + lastTickAgoMs) + `buildDependencyHealth` (env-only email/slack/llm flags, no network). `/health` now exposes `checks.worker`, dep flags, and `latency` p50/p95/p99. Live-verified.
- **Alert-noise (streaming aborts)** — `stream-errors.server.js`: benign client-abort / premature-close / ECONNRESET stream errors downgrade to WARN (were paging as "Streaming render error").
- **Churn & retention view** in the ops panel (Churned + Tenure@churn tiles).
- **#17 churn-reason consumed** — overview "Why they left" breakdown + merchant drill-down reason (latest `shop_uninstall_feedback` per shop; last-write-wins per the e.feedback contract). **Empty until `ENABLE_WINBACK_EMAIL` sends farewell-email feedback links** (`ENABLE_EMAIL` is already ON for welcome emails — the win-back farewell is separately gated by `ENABLE_WINBACK_EMAIL`, still dark) — build-ahead, ready. (ops `e5114c1`)
- **#20 portfolio economics** — overview "LLM cost by feature · 7d" + coverage-gated "Margin by client" table (each row links to the drill-down). (ops `e5114c1`)
- **#19 ops-panel tests** — extracted pure helpers to `apps/ops/format.mjs` (esc/money/fmtMs/safeEqual/optionList/sparkline/churnReasonLabel) + 12 `node --test` cases; `apps/ops` had zero tests before. (ops `6e54085`)
- **Schema-drift guard** — non-blocking `prisma migrate diff` step in `ci.yml` (`89f68af`). Obs #4 audit found NO app drift (only a rogue `waitlist_signups` marketing table, out of scope).
- **Sentry → #jefe-slack** — high-priority-issues alert rule routes to Slack (member/email action removed). Via the Sentry UI (no token handled).

**Founder-side / external (Matt, 07-30):**
- **#8 uptime** — Better Stack (free tier) monitor **live** on `https://app.mynamejefe.com/ready` (GET, 3-min checks, SSL verify on, multi-region). Advised: set **Confirmation period → 3 min** (2 failed checks) so a deploy blip doesn't page. **Slack routing still to do**: Integrations → Slack → Quiver → #jefe-slack (currently email-to-founder only; push notifs need a paid upgrade — skip).

**HELD (one-way doors — do NOT turn on without Matt):** `ENABLE_WINBACK_EMAIL` (real farewell/win-back sends — also the switch that starts populating #17's "Why they left"; note `ENABLE_EMAIL` is already ON for welcome emails), `ENABLE_EVENT_RETENTION` (deletes old events).

**Noise source found (flagged, not fixed — needs a decision):** transient Shopify GraphQL HTTP errors during backfill page #jefe-slack once per failed job (3 pages for one blip on the dev store at ~01:03Z, then quiet). The grace/transient logic only downgrades transient *DB* errors; extending it to retryable Shopify API errors (429/5xx/network) needs a transient-classification call — spawned as a follow-up task.

**Morning follow-ups:**
- **Flip the CI drift guard to blocking** — drop `continue-on-error` in `ci.yml` once a first green run confirms no definition-level drift. Deferred overnight because `gh` was unavailable to read the run.
- Finish Better Stack → Slack integration (above).
- When `ENABLE_EMAIL` goes on, #17's "Why they left" + per-merchant reason populate automatically.

## Chat 8 update (2026-07-29, late) — remaining roadmap shipped

Chat 8 worked the top-ten remaining list; **all code-side items shipped to prod**
(commits on `main`; ops panel via `railway up --service jefe-ops`):

- **#3 client-side Sentry** — `app/entry.client.tsx` + `app/lib/observability/sentry.client.ts`; `VITE_SENTRY_DSN` set on jefe. Browser errors now captured.
- **#11 churn** — `shop_uninstalled` event + PII-free snapshot in the uninstall webhook (`app/services/analytics/churn.server.js`). Event-only; **`Shop.uninstalledAt` deferred** (another session was live-editing `schema.prisma`, adding `Order.sourceName` — avoided the collision).
- **#5 / #10 / #6 / #7 ops panel** (`apps/ops/server.mjs`) — per-merchant drill-down (event timeline + LLM cost + 14-day sparklines); coverage-gated **margin** (revenue − COGS − LLM cost, "indicative" on thin cost data); overview metrics (active-7d, LLM p50/p95, job success-rate, errors-24h, activity/cost trend sparklines).
- **#7 request latency** — in-memory p50/p95/p99 on `/health` (`app/lib/observability/perf.server.js`).
- **#9 retention** — opt-in `app/services/analytics/retention.server.js` (`ENABLE_EVENT_RETENTION`, off by default), run from the worker's daily guard. No new scheduler.
- **Alert-noise fixes (from real prod pages tonight):** post-deploy grace window (`READINESS_ALERT_GRACE_SECONDS`, default 60s) so readiness/health/worker DB blips log WARN not page; the worker proactively `$connect()`s its Prisma client; `handleError` now skips 4xx (bot `POST /` 405s no longer page). New helpers in `deployment-health.server.js`: `shouldPageOnDependencyFailure`, `shouldPageOnWorkerError`, `isTransientDbConnectionError`.

**Left = infra / founder-gated → see `observability-followups.md`:** external uptime monitor (#8), Railway log drain (#9 remainder), ops-panel re-gate (`OPS_PUBLIC=false`) + read-only DB role, Sentry→#jefe-slack native integration (needs founder OAuth), #12 Slack MCP **closed as superseded**.

**Pre-existing bug found & flagged (out of scope):** a duplicate `app/uninstalled` delivery reactivates an uninstalled shop (via `ensureShopifyTenant`) before the dedupe short-circuit returns, so it's left `active` — ordering bug in `processShopifyWebhook` (`webhooks.server.js`).

## What's live (shipped)

- **Structured logging** — `app/lib/observability/logger.server.js` (levelled `LOG_LEVEL`, JSON in prod, `child()` bindings, Error serialisation) with **redaction** (`redact.server.js`: secret/PII keys → `[redacted]`, email-shaped values → `[redacted-email]`, phone keys). Server-only; never import into the client bundle.
- **Error capture** — `handleError` in `entry.server.tsx` + root `ErrorBoundary` in `root.tsx`.
- **Sentry (server-side)** — `app/lib/observability/sentry.server.js`, wired into `handleError` + streaming `onError`. Inert unless `SENTRY_DSN` set (it IS set on the `jefe` Railway service). PII-scrubbed in `beforeSend`. Project is "JavaScript React" (fine — DSN is platform-agnostic). **Client-side (@sentry/react) capture is NOT done yet** — the remaining half of roadmap #3.
- **Health/readiness** — `/health` (liveness, always 200 + version/uptime/DB probe) and `/ready` (fails closed 503 when DB down; Railway healthcheck points here). `services/deployment-health.server.js`.
- **Alerting** — error-level logs → Slack `#jefe-slack` webhook via the logger's `onError` hook (`alerting.server.js`), rate-limited, redacted, no-op unless `ALERT_WEBHOOK_URL` set (it IS set). **Proven on a real prod signal tonight.**
- **Correlation IDs** — `context.server.js` (AsyncLocalStorage); the backfill worker wraps each job so its logs share a `correlationId`; `handleError` tags errors too.
- **Event log** — `activity_events` table + `track()` / `listRecentActivity` (`services/analytics/event-log.server.js`). Fire-and-forget, PII-free. Writers: worker (memory_rebuilt / insights_generated / goals_generated / plan_generated / backfill_completed / job_failed), `shop_installed` (afterAuth), `server_error` + `worker_error` (error paths, topic `reliability`).
- **LLM cost ledger** — `llm_usage_event` table + `usage-recorder.server.js` + `pricing.server.js`. `createLlmProvider({ usage })` records tokens/cost/latency per call; wired into insights/goals/plan generators. ⚠️ **Pricing is PLACEHOLDER** (`gemini-3.1-flash-lite` $0.10/$0.40 per 1M, marked `verified:false`) — Lewis has the real Gemini rates (~next week); update the single map in `pricing.server.js`.
- **Ops panel** — `apps/ops/` (separate Node+pg app, its own Railway service `jefe-ops`), live at **https://admin.mynamejefe.com** (+ jefe-ops-production.up.railway.app). **Currently PUBLIC / no login** (`OPS_PUBLIC=true`; founder's call), `noindex`+robots so it's not searchable. Event feed with filter (type/topic/merchant) + full-text search + a funnel/engagement/LLM-cost **overview**. Reads the jefe DB read-only. Not on GitHub auto-deploy — deploy with `cd apps/ops && railway up --service jefe-ops --detach -y`.
- **Alerts readable from DB** — instead of a Slack MCP (Matt didn't want Slack fiddling), alert-worthy errors (`server_error`/`worker_error`/`job_failed`, topic `reliability`) land in `activity_events`. Read them at the panel (filter reliability) or `SELECT ... FROM activity_events WHERE topic='reliability' ORDER BY created_at DESC`.

## Roadmap status (task list #1–#12 + churn)

Done: #1 backend events, #2 cost ledger, #3 Sentry **server-side**, #4 alerting (digest deliberately gated OFF — see gotchas), #5 panel **overview** (funnel/cost tiles), #12 alerts-in-DB.
Remaining:
- **#3 client-side** — `@sentry/react` init in `entry.client.tsx` + client `ErrorBoundary` capture (browser errors still vanish). `@sentry/node` already a dep.
- **#5** — per-merchant drill-down (one shop's timeline + its LLM cost) + time-series sparklines. Also: re-gate the panel (SSO/password) + a read-only DB user when public is no longer wanted.
- **#6 metrics/rollups** — DAU/WAU, success-rate + cost trends; daily rollup tables (premature at current volume — on-the-fly is fine for now).
- **#7 tracing/perf** — latency/slow-query/LLM-duration p50/p95 off the correlation IDs.
- **#8 uptime/SLOs** — external synthetic checks + SLO breach alerts.
- **#9 retention/hygiene** — event retention policy, a log drain (Railway logs are ephemeral), PII-in-events audit.
- **#10 margin** — **UNBLOCKED**: chat 4 shipped `Variant.unitCost` (migration `20260729090000`). Margin-per-client = revenue − COGS (`Variant.unitCost`) − LLM cost (ledger). **Surface cost-coverage** (chat 4 exposes `products.cost_coverage`) so margin isn't shown precise on thin cost data. Benchmark cluster to revisit when spend accrues: current provider vs Sciforium vs Model Fusion (see `future_considerations.md`).
- **#11 churn capture** — `shop_uninstalled` event + `uninstalledAt` + a churn snapshot captured in the webhook path BEFORE teardown; surface in panel/usage. Sequence schema migration after chat 4's. Reason comes from chat 2's win-back email.
- **#12 (optional)** — Slack MCP (korotovsky `slack-mcp-server`, `SLACK_MCP_XOXB_TOKEN`, read-only) if the raw channel is ever wanted; superseded by alerts-in-DB.

## Env vars (Railway `jefe` service unless noted)

Set: `SENTRY_DSN`, `ALERT_WEBHOOK_URL`. On `jefe-ops`: `DATABASE_URL` (=jefe's), `OPS_PASSWORD` (generated, in Railway), `OPS_PUBLIC=true`.
Optional/unset: `ACTIVITY_WEBHOOK_URL` (digest channel, falls back to ALERT_), `ENABLE_DAILY_DIGEST` (=true to re-enable the daily digest — but fix the durable guard first), `LOG_LEVEL`, `APP_VERSION`, `SLACK_MCP_XOXB_TOKEN`.

## Gotchas

- **Shared working tree, shared git index** — 6 sessions on `/Users/mb/Claude/jefe`. ALWAYS `git add <explicit paths>` then `git commit -F - -- <explicit paths>` (pathspec; new files need `git add` first — pathspec-commit skips untracked). Codified in AGENTS.md "Shared Working Tree". (Two sweeps happened on 2026-07-28 before this.)
- **Daily digest gated OFF** — it re-posted to Slack on every deploy (in-memory once-per-day guard + frequent deploys), and full-feed-to-Slack was off-direction (panel = feed, Slack = alerts). Re-enable needs a DURABLE (DB-backed) guard, not the in-memory one.
- **Worker "backfill loop failed" alerts** — transient; coincide with deploys (preDeploy `npm run migrate` → first-tick DB blip → self-heals). Now logged under `err` so the message shows.
- **Placeholder LLM pricing** — see cost ledger above; don't treat absolute costs as real until Lewis confirms.
- **jefe-ops deploys via `railway up`** (not GitHub auto-deploy) — remember to `railway up` after editing `apps/ops`.
- **Local typecheck vs Railway** — Railway runs `npx prisma generate` first; a locally-stale Prisma client (missing a new model) shows false `tsc` errors locally. Run `npx prisma generate` before trusting local typecheck.

## Coordination (other live sessions)

chat 2 (onboarding/channels) wires UI-side events (channel_connected, onboarding_*, memory_viewed) + will ping when in `app.tsx` for the client `page_viewed` beacon. chat 4 (memory/COGS) owns `Variant.unitCost` + margin beliefs. chat 5 (triage) routes observability/analytics/ops bugs here + reads alerts from the DB. chat 6 (growth) owns `docs/growth/*`. Ping before editing another session's files.
