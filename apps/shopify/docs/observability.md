# Observability & Error Logging

This is the baseline observability layer for the Shopify app: structured logs, a
central server-side error hook, a user-facing error boundary, and a health
endpoint that reports version and dependency status. It has no external
dependency — logs are written to stdout/stderr as JSON, which Railway's log
drain collects. Adding an error-tracking SaaS (e.g. Sentry) later is possible
but was deliberately out of scope; it would egress error payloads to a third
party and needs a founder decision.

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
- recursion is depth- and cycle-bounded; long strings are truncated.

This is intentionally conservative — it would rather hide an operational field
than let a token or customer email reach stdout. Even so, **do not deliberately
log request bodies or prompt/response contents.** Log identifiers and metadata
(topic, shop domain, webhook id, token counts, durations), not payloads.

## Server error hook — `handleError`

`app/entry.server.tsx` exports `handleError`, which React Router calls for every
uncaught error thrown while handling a request (loaders, actions, rendering). It
is the one place guaranteed to see server errors, and logs them via the logger.
It skips two expected, non-actionable cases: client disconnects (aborted
requests) and 404s.

## Root error boundary

`app/root.tsx` exports an `ErrorBoundary` that renders a clean, self-contained
fallback (no raw stack trace) for any error not caught by a nested route
boundary. The embedded `app/*` routes keep their own Shopify-aware boundary; the
root one is the top-level net for everything else. It is free of server-only
imports; server-side logging of these errors is handled by `handleError`.

## Health endpoint — `/health`

`GET /health` is the **liveness** check (Railway uses it as the service health
check). It always returns `200` when the process can serve, with a body of:

```json
{
  "ok": true,
  "environment": "production",
  "version": "<APP_VERSION or RAILWAY_GIT_COMMIT_SHA>",
  "timestamp": "2026-07-28T12:00:00.000Z",
  "uptimeSeconds": 1234,
  "checks": { "database": { "status": "ok", "latencyMs": 3 } }
}
```

The database probe (`SELECT 1`, short timeout) is **informational**: a failure is
logged server-side but does **not** flip the status code, so a transient DB blip
cannot cause Railway to recycle an otherwise-healthy instance. The raw DB error
is never included in the public response — only logged. A stricter readiness gate
(failing the endpoint when a dependency is down) is a separate, deliberate
decision and is not implemented here.

## Adopting the logger elsewhere

When touching a server module that still uses `console.*`, prefer the logger and
attach a `component` binding, e.g.
`const log = logger.child({ component: "shopify-backfill" })`. Keep context to
identifiers and metrics; rely on redaction as a safety net, not as permission to
log payloads.
