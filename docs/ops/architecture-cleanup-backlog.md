# Architecture cleanup & consistency backlog

Persisted from the chat 7 architecture / consistency review (2026-07-29) so it survives the session instead of living in one chat. Grouped by kind; each item carries a disposition, owner, and status. **Update in place as items land** — this is the durable tracker.

Legend: ✅ done · ▶ in progress · ⏳ open · ⏸ deferred · 👤 founder decision needed · 🔒 blocked-external

## Dead code / config

| Item | Location | Disposition | Owner | Status |
|---|---|---|---|---|
| Shepherd MCP + hooks (unused, token not inherited) | `.mcp.json`, `~/.claude/settings.json` | delete | chat 7 | ✅ |
| Unreferenced prompt sketches | `prompts/` → `docs/archive/prompts/` | archive | chat 7 | ✅ |
| `normalizedEmail` dead column (0 prod reads) | `prisma/schema.prisma` | delete (destructive migration) | chat 4 | ✅ (dropped 77efb3a) |
| `operational_messages` capability (declared, no sender) | `lib/channels/service.server.js:227,565` | build or drop — **confirmed a dead capability *string* (no sender, no reads), not a DB object; dropping it is two-way, but build-vs-drop is a product call** | 👤 founder | ⏳ |
| Slack `incoming-webhook` scope (granted, unused) | Slack app config | verify-only (additive-only manifest tool can't remove; app may be collaborator-owned) | 🔒 | ⏳ |

## Observability consistency (invariant I2)

| Item | Location | Disposition | Owner | Status |
|---|---|---|---|---|
| Bare `console.*` in a normal-ops server path | `lib/email/resend.server.js:78,84,97` | swap → structured logger | chat 7 | ✅ (24168ca; also a PII win — recipient now redacted in logs) |
| `?? console` / `\|\| console` logger defaults (10 files, 12 occ) | changelog-watcher · backfill-worker · backfill · store-understanding · memory/insights/goals/plan services · gemini · admin-graphql | swap default → `baseLogger.child({component})` (pattern: `provider.server.js:30`); **fully scoped + safe (logging-default only, no `.log()` calls anywhere, gate-clean) — deferred to a *monitored* batch (low prod impact: defaults only fire when no logger is injected)** | chat 7 | ⏳ (scoped, ready) |
| Health signals for external deps (only DB probed) | Resend / Slack / Gemini / worker-loop | add non-gating `/health` diagnostics | chat 8 | ▶ |
| `LlmUsageEvent` — 4 of 7 LLM call sites unmetered | conversation / store-understanding / insight-correction / goals-doc | thread `usage:` context | chat 8 | ▶ |

## Refactoring

| Item | Location | Disposition | Owner | Status |
|---|---|---|---|---|
| ~4,663-line monolith (worst merge-collision surface; I1) | `app/routes/app._index.tsx` | perf-first decomposition. **Move 1 (DailyHome → `lazy`) SHIPPED `2921e73`: route chunk 85.8→51.5 kB raw / 21.8→13.9 kB gz.** Move 2 (onboarding steps, chat 2 zone) + Move 3 (extract inline `MerchantMemoryView`, chat 4 zone) both need inline-code extraction first → coordinating before touching (not safe solo on the most-rebased file) | chat 7 (coordinate chat 2 / 4) | ▶ |
| 3-way insights/goals/plan duplication | `lib/merchant-{insights,goals,plan}` | extract shared `advisory-run` module | chat 7 | ⏳ |
| In-process worker on the single web dyno (biggest scaling risk) | `shopify.server.ts` + backfill worker | design dedicated worker service / distributed lock | 👤 founder greenlight | ⏳ |
| LLM provider lock-in (8 Gemini-dialect schemas) | `lib/llm/*` | provider abstraction (enables Sciforium cost benchmark). Quick sub-item: ledger-label fix (`provider.server.js` / `usage-recorder.server.js` hardcode `"gemini"` — correct today since Gemini is the only provider) — deferred (groundwork; Sciforium not a current focus per founder) | chat 7 / chat 8 | ⏳ |

## Doc coherence

| Item | Location | Disposition | Owner | Status |
|---|---|---|---|---|
| Architecture stub → real as-built map | `context/07_architecture.md` | seed from map | chat 7 | ✅ |
| Deployment drift (`/health`→`/ready`, false SESSION_SECRET line) | `docs/ops/deployment_staging_railway_neon.md` | fix | chat 7 | ✅ |
| Materially stale state doc (margin/COGS + product-perf shipped) | `apps/shopify/docs/merchant-memory-state.md` | refresh | chat 7 | ⏳ |
| Actions/autonomy stub (north-star frontier undocumented) | `context/11_actions_and_autonomy.md` | draft rung-1 typed-adapter design | chat 7 (founder review) | ⏳ |

## Correctness (surfaced by the as-built map)

| Item | Location | Disposition | Owner | Status |
|---|---|---|---|---|
| Duplicate `app/uninstalled` → shop stuck active | `lib/ingestion/shopify/webhooks.server.js` | idempotent re-inactivate | chat 8 | ✅ (early-handle restructure ⏸ deferred, companion to schema-drift pass) |
| Slack reply race (wrong reply on concurrent DMs) | `lib/channels/service.server.js` | fetch the just-produced turn, not latest-by-time | — | ⏳ |
| No inbound rate limit on Slack DM path | `lib/channels/service.server.js` | rate-limit inbound (unbounded LLM spend) | — | ⏳ |
| Standalone auth X-Forwarded-Host trust + per-mode CSP | `lib/auth/auth-mode.server.js`, `app.tsx` | harden (fails safe today) | P2 | ⏸ (post-activation fast-follows) |
</content>
