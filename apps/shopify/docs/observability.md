# Observability & Error Logging

The observability layer for the Shopify app: structured logs (stdout/stderr JSON,
collected by Railway's log drain), a central server-side error hook, a user-facing
error boundary, a health/readiness split, **Sentry** error tracking (server +
client), and **Slack alerting** for both runtime errors and CI failures. An
external uptime monitor (Better Stack) pings the app and pages #jefe-slack, and an
internal ops panel (`admin.mynamejefe.com`, `apps/ops`) reads the same signals
from the DB for a human-driven view.

## Structured logger

`app/lib/observability/logger.server.js` exports a process-wide `logger` and a
`createLogger()` factory.

```js
import { logger } from "../lib/observability/logger.server.js";

logger.info("Shopify webhook processed", { topic, shopDomain });
logger.error("Welcome email dispatch failed", { err: error, shopDomain });

const scoped = logger.child({ component: "llm" }); // persistent context
```

- **Server-only.** Import it in `*.server.js` / `*.server.ts` / `entry.server`
  modules. Never import it into code that ships to the browser bundle.
- **Levels:** `debug | info | warn | error | silent`, controlled by `LOG_LEVEL`
  (default: `debug` in development, `info` in production).
- **Format:** JSON in production, human-readable in development. Override with
  `LOG_FORMAT=json|pretty`.
- **Call shape:** `logger.<level>(message, context?)`. `context` may be a plain
  object, or an `Error` (passed directly or as `{ err }` / `{ error }`), which is
  serialised with its name, message, stack, own fields and `cause`.
- **`Pick<Console, "info" | "warn" | "error">`-compatible**, so it can be
  injected wherever a `console` was previously accepted (e.g. the LLM provider).

### Redaction — logs must never leak secrets or customer PII

Every context payload passes through `redact()`
(`app/lib/observability/redact.server.js`) before it is written:

- keys that look like credentials or PII (`*token*`, `*secret*`, `*password*`,
  `authorization`, `cookie`, `*phone*`, …) → `"[redacted]"`;
- email-shaped substrings in **any** string value → `"[redacted-email]"`;
- high-confidence secret shapes in free text (Shopify `shpat_…`, Stripe
  `sk_live_…`, GitHub `ghp_…`, `Bearer`/`Basic`/`Token` values) →
  `"[redacted-secret]"` — catches a token embedded in an error message or URL that
  the key-based rule can't see;
- `Error` values are serialised (name/message/stack/own fields) at **any** nesting
  depth, with the message/stack scrubbed — so a nested error can't slip a
  token/email through, nor vanish to `{}`;
- recursion is depth- and cycle-bounded; long strings are truncated.

This is intentionally conservative — it would rather hide an operational field
than let a token or customer email reach stdout. Even so, **do not deliberately
log request bodies or prompt/response contents.** Log identifiers and metadata
(topic, shop domain, webhook id, token counts, durations), not payloads.

## Server error hook — `handleError`

`app/entry.server.tsx` exports `handleError`, which React Router calls for every
uncaught error thrown while handling a request (loaders, actions, rendering). It
is the one place guaranteed to see server errors: it logs them via the logger,
captures them to Sentry (`captureError`), and records them to the activity log
(topic `reliability`) so they're readable from the ops panel and DB, not only via
the Slack push. Which errors are **reported** vs. skipped as expected non-faults is
decided by the pure, unit-tested `shouldReportServerError`
(`app/lib/observability/error-policy.server.js`): **aborted requests** (client
disconnects) and **4xx route responses** (bot 404s, stray 405 POSTs, 403s) are
skipped; 5xx and genuine exceptions report.

## Root error boundary

`app/root.tsx` exports an `ErrorBoundary` that renders a clean, self-contained
fallback (no raw stack trace) for any error not caught by a nested route
boundary. The embedded `app/*` routes keep their own Shopify-aware boundary; the
root one is the top-level net for everything else. It is free of server-only
imports; server-side logging of these errors is handled by `handleError`.

## Sentry — error tracking

`app/lib/observability/sentry.server.js` (server) and `sentry.client.ts` (client)
add grouping, regression and release tracking on top of the logs. **Inert unless
the DSN is set** — the server reads `SENTRY_DSN`, the client reads
`VITE_SENTRY_DSN` (both are set in prod).

- **PII posture:** `sendDefaultPii: false`; request cookies/body/headers are
  dropped; extra context runs through `redact()` before send. We capture `Error`
  objects, not payloads.
- **Noise filter:** `beforeSend` drops already-handled benign events via the pure,
  tested `isBenignForSentry` — client mid-stream disconnects
  (`isBenignStreamError`) and 4xx route responses — so a real 5xx stands out.
  Filtering at the SDK level (not only in `handleError`) also catches Sentry's own
  auto-instrumentation, which can capture before `handleError` runs.
- Issues route to **#jefe-slack** via Better Stack's Sentry integration.

## Health endpoint — `/health`

`GET /health` is the **liveness** check (Railway uses it as the service health
check). It always returns `200` when the process can serve, with a body of:

```json
{
  "ok": true,
  "environment": "production",
  "version": "<APP_VERSION or RAILWAY_GIT_COMMIT_SHA>",
  "deployment": { "region": "europe-west4-drams3a" },
  "timestamp": "2026-07-28T12:00:00.000Z",
  "uptimeSeconds": 1234,
  "checks": {
    "database": {
      "status": "ok",
      "latencyMs": 3,
      "pooledEndpoint": true
    }
  },
  "ssrRenderLatency": { "count": 10, "p50": 3, "p95": 8, "p99": 9, "max": 9 },
  "routeLatency": {
    "app-home.action-chats.action": {
      "count": 4,
      "p50": 80,
      "p95": 120,
      "p99": 120,
      "max": 120
    }
  },
  "clientNavigation": { "count": 10, "p50": 140, "p95": 240, "p99": 250, "max": 250 }
}
```

The database probe (`SELECT 1`, short timeout) is **informational**: a failure is
logged server-side but does **not** flip the status code, so a transient DB blip
cannot cause Railway to recycle an otherwise-healthy instance. The raw DB error
is never included in the public response — only logged. For dependency-aware
gating, see `/ready` below.

`deployment.region` is Railway's running replica region, not a preferred-region
setting. `checks.database.pooledEndpoint` reports only whether `DATABASE_URL` is
a Neon `-pooler` URL; it never exposes connection details. Use these two fields
after every production deploy to confirm that the app, database region and
runtime connection mode are the intended ones.

Latency is split by vantage point:

- `ssrRenderLatency` measures React's server render only. The legacy `latency`
  field remains as a temporary alias for this value.
- `routeLatency` measures authenticated loaders/actions and their fixed phases
  (`auth`, `tenant`, domain reads and mutation persistence). Each request also
  produces one structured timing log correlated with Railway's request ID.
- `clientNavigation` starts in the browser and includes the round trip,
  revalidation and render, so it is the merchant-facing navigation measure.

Route timing labels are constants from code. Logs contain durations and request
correlation metadata only—never URL query values, form data or customer data.

## Readiness endpoint — `/ready`

`GET /ready` is the **readiness** check and is what Railway's healthcheck points
at (`railway.json` → `healthcheckPath: "/ready"`). Unlike `/health`, it **fails
closed**: it returns `503` when the database probe fails and `200` (with
`ready: true`) otherwise. This stops Railway from promoting a deploy — or routing
traffic to an instance — that cannot do real work. Liveness (`/health`) and
readiness (`/ready`) are deliberately split so a transient blip degrades
readiness without triggering a liveness restart loop.

The health payload also includes `checks.episodicEmbedding`: whether embeddings
are configured, the model, recent provider failure count/reason, indexing counts
by state and up to five recent failed episode IDs/reason codes. It never exposes
conversation text, embedding values or prompt content; lexical retrieval remains
available when embedding health is degraded.

## Merchant wait — the clock starts when they say yes or press enter

**Every timing here is anchored on the merchant's own action, never on the
internal boundary that happens to be convenient.** Model-call latency
(`llm_usage_event.latency_ms`, one row per call) cannot answer "how long did that
take": one turn is several model calls plus retrieval plus two writes, so the
calls both understate the wait and can't explain it.

`app/lib/observability/chat-turn-latency.server.js` measures a whole turn from
two vantage points, and keeps two kinds of wait apart:

| vantage | measured | where |
| --- | --- | --- |
| `server` | Jefe's own share, split into `intakeMs` / `decisionMs` / `retrievalMs` / `generationMs` / `persistMs` | around `sendGeneralChatMessage` |
| `client` | the merchant's action → result on screen, including the round trip and the re-render | `ChatTurnReporter` → `POST /api/chat-turn` |

| kind | starts | stops |
| --- | --- | --- |
| `message` | enter on a message (composer, suggestion chip, Try again) | Jefe's reply is last in the thread |
| `approval` | yes to a proposed move | the navigation settles on the outcome |

Both write a PII-free `chat_turn` activity event (durations only, never message
text) and sample an in-process ring. Read them:

- **`/health` → `chatTurns`** — live p50/p95/p99 for this instance, no query on
  the health path. Answers "is Jefe slow right now".
- **Ops panel → "Merchant wait · 7d"** — durable percentiles per vantage and kind,
  plus the average server split. Answers "is Jefe getting slower, and where does
  the time go".

Read the vantages together: identical server timings with a worse felt number
means the cost moved into the navigation, not into Jefe thinking. The server share
also lands in the assistant message's own `metadata_json.latency`, beside the
reply it describes — `totalMsAtReply` there stops short of that write, because a
row cannot time its own insert.

**In the LLM ledger, the same rule holds from the ask.** `withUsageRecording`
times from the moment the caller asked, so:

- a failover records the **whole** wait on the row that answered, not just the
  call that happened to succeed;
- the failed primary attempt carries its own `latency_ms` (`failedAfterMs`)
  instead of a null, so the time burned failing over stays visible;
- when both providers fail, the two error rows sum to the wait rather than
  double-counting it, and an ordinary failed call is recorded with what it cost.

⚠️ Rows written before 2026-08-13 have `latency_ms = NULL` on every error and
under-report failovers — treat older percentiles as a floor.

## Correlation IDs

`app/lib/observability/context.server.js` provides an `AsyncLocalStorage`-based
context. Anything run inside `runWithContext(bindings, fn)` has those bindings
(e.g. `correlationId`, `jobId`, `shopDomain`) automatically merged into every log
line the logger emits within that async call tree — no id argument threading.

Established today at:

- **Background jobs** — each claimed backfill/memory/insight/goal/plan job runs
  inside a context with a fresh `correlationId` + `jobId` + `shopDomain`, so all
  of that job run's logs (including the memory rebuild and any LLM calls it makes)
  share one id.
- **Server errors** — `handleError` tags each error with a `correlationId` (the
  inbound `x-request-id` if the proxy set one, otherwise a minted id).

The context propagates across `await`s but **not** across process/queue
boundaries — an id minted for a web request does not (yet) travel into the
DB-persisted job it enqueues. Full request→job propagation, and automatic
per-request web context (which needs React Router middleware), are follow-ups.

## Alerting

`app/lib/observability/alerting.server.js` forwards **error-level** log records to
a Slack-compatible incoming webhook (`ALERT_WEBHOOK_URL`) so failures reach a
human, not just the log stream. It is wired into the default logger's `onError`
hook. Properties:

- **Disabled unless `ALERT_WEBHOOK_URL` is set** (a no-op otherwise).
- **Never throws, never blocks** — the POST is fire-and-forget and swallows
  errors, so alerting can't break a request or a log call.
- **Rate limited** — identical failures are de-duplicated within a cooldown
  (default 5 min) and a per-minute cap bounds alert storms.
- Records arrive **already redacted** by the logger, so no secrets/PII are sent.

### Other alert routes

- **CI failures → #jefe-slack.** `.github/workflows/ci.yml` posts to the same
  `ALERT_WEBHOOK_URL` (also stored as a GH Actions secret) on any failed run, so a
  red build reaches Slack, not just email.
- **Uptime (Better Stack) → #jefe-slack.** An external monitor pings the app and
  pages Slack on downtime — the outside-in check the internal signals can't give.
- **Sentry → #jefe-slack** via Better Stack's Sentry integration (see _Sentry_
  above).
- **Ops panel** (`admin.mynamejefe.com`, `apps/ops`) reads the reliability +
  economics signals from the DB for a human-driven view alongside the push alerts.

## Adopting the logger elsewhere

When touching a server module that still uses `console.*`, prefer the logger and
attach a `component` binding, e.g.
`const log = logger.child({ component: "shopify-backfill" })`. Keep context to
identifiers and metrics; rely on redaction as a safety net, not as permission to
log payloads.
