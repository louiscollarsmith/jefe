# Shopify Protected Customer Data — Level 2 readiness

The submission-gate checklist for Shopify's **Protected Customer Data Level 2** commitments (required because Jefe processes customer-derived data — orders, customer identities). Each requirement maps to its status, owner, and the concrete next action. Companion docs: `docs/ops/incident-response.md` (IR runbook), `docs/growth/shopify-app-store-launch.md` (the launch plan), `docs/growth/privacy-policy-draft.md`.

**Status key:** ✅ done · 🟡 partial / needs a decision · 🔴 gap / blocker · ⏳ needs founder/legal confirmation.

| # | Requirement | Status | Owner | Next action |
|---|---|---|---|---|
| 1 | Encryption at rest | ✅ | infra | Neon-managed Postgres (encrypted at rest). Document; no action. |
| 2 | Encryption in transit | 🟡 | founder | Pin `sslmode=require` on the Railway `DATABASE_URL` (Neon negotiates TLS already; pin it explicitly as the auditable control). |
| 3 | Data minimization | ✅ | — | Always-on log redaction; PII-free lifecycle events (hashed emails, no raw PII); belief registry rejects customer PII in business-level beliefs; insight/goal/plan snapshots exclude raw Shopify PII. |
| 4 | Retention + deletion | 🟡 | founder + arch | `pruneOldEvents` exists but is opt-in (`ENABLE_EVENT_RETENTION` unset). Decide the window, enable it; customer-level deletion is covered by the redact webhook (#7). |
| 5 | Access controls + logging | 🔴 | chat 8 | The internal ops panel (`admin.mynamejefe.com`) needs access logging + `OPS_PUBLIC` removed (no unauthenticated access to a panel that reads merchant data). |
| 6 | Incident response | ⏳ | founder/legal | `incident-response.md` is structurally complete; the `[FOUNDER/LEGAL — CONFIRM]` items (notification timelines, named roles, regulator obligations) must be confirmed before it's authoritative. |
| 7 | GDPR compliance webhooks | 🔴 | founder → arch | **Mandatory + the scariest gap.** Routes + logic for `customers/redact`, `customers/data_request`, `shop/redact` are built + tested, but there's **no `[webhooks.privacy_compliance]` block in `shopify.app.toml`** — confirm they're registered in the Partner Dashboard; if not, add the block (ready to write). An unregistered mandatory webhook fails review. |
| 8 | Test / prod separation | ⏳ | founder | Confirm the live topology — prod and any test/dev data are separate environments/DBs. |
| 9 | Scope minimization (least privilege) | ✅ | arch | Trimmed to 7 (reads + `write_products`); unused `write_*` dropped; scopes added per-action as each write ships (`context/13`). |
| 10 | Privacy policy accuracy | 🟡 | chat 6 + founder | `privacy-policy-draft.md` exists; needs an accuracy pass vs what the app actually collects/does — especially the autonomy-from-day-one **execution** framing (Jefe writes to the store on the merchant's authority). |

## The two hard blockers (do these before submit)

1. **#7 — compliance webhooks.** Every app touching customer data must handle the three mandatory GDPR webhooks. The code is done; **registration** is unverified. Founder: check the Partner Dashboard's "GDPR mandatory webhooks" (or the app's compliance-topic subscriptions). If they point at our routes (`/webhooks/customers/redact`, `/webhooks/customers/data_request`, `/webhooks/shop/redact`), we're covered; if not, architecture adds the `[webhooks.privacy_compliance]` block to `shopify.app.toml` and it ships on the pre-submit deploy.
2. **#6 — IR runbook confirmation.** Level 2 requires a documented incident-response process. The runbook is written; it needs the founder/legal `[CONFIRM]` items filled (notification deadlines — commonly "without undue delay" / 24h to Shopify, 72h GDPR controller-notify — and named roles) to be authoritative.

## What's already solid (evidence)

- **Minimization + redaction** — `lib/observability` redacts on every log record; the event log is PII-free by construction (`analytics/event-log.server.js`, `track` redacts + defaults nulls); belief/insight/goal snapshots are PII-bounded (tested).
- **Deletion machinery** — the redact webhooks erase exactly the target customer/shop and never persist the request body (tested: "customers/redact erases exactly one customer", "compliance webhooks never persist the request body").
- **Least privilege** — 7 scopes, per-action growth.
- **Observability** — structured logging + error capture + `/health` · `/ready`, so an incident is detectable.

## Notes

- This doc is the map, not the authority — the founder owns the security posture and the legal substance; architecture documents state + closes the technical gaps (#7 toml, #4 enablement).
- Re-review annually (Level 2 requires it) and after any SEV-1/2 (see the IR runbook).
