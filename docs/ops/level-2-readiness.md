# Shopify Protected Customer Data — Level 2 readiness

The submission-gate checklist for Shopify's **Protected Customer Data Level 2** commitments (required because Jefe processes customer-derived data — orders, customer identities). Each requirement maps to its status, owner, and the concrete next action. Companion docs: `docs/ops/incident-response.md` (IR runbook), `docs/growth/shopify-app-store-launch.md` (the launch plan), `docs/growth/privacy-policy-draft.md`.

**Status key:** ✅ done · 🟡 partial / needs a decision · 🔴 gap / blocker · ⏳ needs founder/legal confirmation.

| # | Requirement | Status | Owner | Next action |
|---|---|---|---|---|
| 1 | Encryption at rest | ✅ | infra | Neon-managed Postgres (encrypted at rest). Document; no action. |
| 2 | Encryption in transit | ✅ | arch | **Done** — `sslmode=require` is pinned on the Railway `DATABASE_URL` (verified in prod 2026-07-31); Neon enforces TLS and the pin is the explicit auditable control. |
| 3 | Data minimization | ✅ | — | Always-on log redaction; PII-free lifecycle events (hashed emails, no raw PII); belief registry rejects customer PII in business-level beliefs; insight/goal/plan snapshots exclude raw Shopify PII. |
| 4 | Retention + deletion | ✅ | arch | **Done 2026-07-31** — `ENABLE_EVENT_RETENTION=true` in prod with a **180-day** window on both telemetry logs (`EVENT_RETENTION_ACTIVITY_DAYS`/`EVENT_RETENTION_USAGE_DAYS=180`); `pruneOldEvents` runs on the worker tick, deleting only `activity_events` + `llm_usage_event` (telemetry, not Merchant Memory). Customer-level deletion is covered by the redact webhook (#7). |
| 5 | Access controls + logging | ✅ | chat 8 | **Done 2026-07-31** (chat 8, commit `0bf4f04`) — `OPS_PUBLIC` removed (ops panel `admin.mynamejefe.com` is now authenticated) + PII-safe access logging added. |
| 6 | Incident response | ✅ | arch (founder-confirmed) | **Done 2026-07-31** — `incident-response.md` finalized with founder-confirmed inputs: responsible party = **the Directors of Quiver Solutions Ltd** (role, not a personal name); breach notification **without undue delay after becoming aware** (matches live DPA §7); Shopify ≤24h; postmortem ≤3 business days; annual review. Lead authority: UK ICO (UK-registered). |
| 7 | GDPR compliance webhooks | ✅ | arch | **Done** — the `[webhooks.privacy_compliance]` block is in `shopify.app.toml`; the three mandatory webhooks (`customers/redact`, `customers/data_request`, `shop/redact`) registered via `shopify app deploy` (jefe-7); routes + logic built, tested, HMAC-verified. |
| 8 | Test / prod separation | ✅ | arch | **Verified 2026-07-31** — prod customer data lives in a dedicated **Neon** Postgres (`*.neon.tech`, jefe service `DATABASE_URL`); dev/test uses a **local** Postgres (persistence tests skip unless `DATABASE_URL` is local). Separate DBs. |
| 9 | Scope minimization (least privilege) | ✅ | arch | Trimmed to 7 (reads + `write_products`); unused `write_*` dropped; scopes added per-action as each write ships (`context/13`). |
| 10 | Privacy policy accuracy | 🟡 | chat 6 + founder | `privacy-policy-draft.md` exists; needs an accuracy pass vs what the app actually collects/does — especially the autonomy-from-day-one **execution** framing (Jefe writes to the store on the merchant's authority). |

## Blocker status (2026-07-31) — both former hard blockers cleared

1. **#7 — compliance webhooks: ✅ DONE** (registered via `shopify app deploy` jefe-7; the `[webhooks.privacy_compliance]` block is in `shopify.app.toml`). The original verification note follows: Founder: check the Partner Dashboard's "GDPR mandatory webhooks" (or the app's compliance-topic subscriptions). If they point at our routes (`/webhooks/customers/redact`, `/webhooks/customers/data_request`, `/webhooks/shop/redact`), we're covered; if not, architecture adds the `[webhooks.privacy_compliance]` block to `shopify.app.toml` and it ships on the pre-submit deploy.
2. **#6 — IR runbook: ✅ DONE.** Level 2 requires a documented incident-response process. The runbook is finalized (2026-07-31) with founder-confirmed inputs — responsible party = the Directors of Quiver Solutions Ltd, breach notification without undue delay after becoming aware (matches DPA §7): (notification deadlines — commonly "without undue delay" / 24h to Shopify, 72h GDPR controller-notify — and named roles) to be authoritative.

## What's already solid (evidence)

- **Minimization + redaction** — `lib/observability` redacts on every log record; the event log is PII-free by construction (`analytics/event-log.server.js`, `track` redacts + defaults nulls); belief/insight/goal snapshots are PII-bounded (tested).
- **Deletion machinery** — the redact webhooks erase exactly the target customer/shop and never persist the request body (tested: "customers/redact erases exactly one customer", "compliance webhooks never persist the request body").
- **Least privilege** — 7 scopes, per-action growth.
- **Observability** — structured logging + error capture + `/health` · `/ready`, so an incident is detectable.

## Notes

- This doc is the map, not the authority — the founder owns the security posture and the legal substance; architecture documents state + closes the technical gaps (#7 toml, #4 enablement).
- Re-review annually (Level 2 requires it) and after any SEV-1/2 (see the IR runbook).
