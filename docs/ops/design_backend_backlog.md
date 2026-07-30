# Design ↔ backend backlog (Jefe Daily + future screens)

> Where the Claude-design surfaces show something the backend can't yet supply. Captured while wiring the **real** Daily Home (screen `5a`) to live data. Rule we're holding to: **render only what's real; never fabricate a merchant number.** Everything below is an honest empty/omitted state today, and a thing to build.
>
> Source of the gap analysis: the real-data map of `apps/shopify` (memory beliefs, Plan/Insight/Goal experiences, store metrics, the loader's `appMode:"memory"` branch).

## What IS real and wired today
Memory beliefs (statement, status observed/confirmed/corrected, confidence, provenance, evidence) · the single Plan **recommendation** (title, why-this / why-now, `executionSteps[]`, confidence, supporting beliefs, accept flow) · Insight **findings** (text, why-it-matters, confidence, confirm/correct) · Goal **horizons** (3/6/12-month title + description) · store counts (orders, products, variants, SKUs, customers) + all-time and trailing-30-day revenue.

---

## P1 — needed for the Daily Home (`5a`) to feel real

1. **Per-decision monetary value.** Cards show "£3,100", "£8,200". Backend has no numeric money field — `MerchantPlanRecommendation.expectedBenefit` is prose and `successSignal.target` is a nullable string; `MerchantInsightFinding` has none. → Add a structured `impactValue` (Decimal) + `impactKind` (revenue / cost-avoided / returns-%) to recommendations and findings, produced by the generator with provenance. Until then: show the prose benefit, no £ headline.
2. **"£X sitting in N decisions" hero.** Depends on (1) — it's the sum of per-decision values. Until then: an honest framing headline (store name + state), no aggregate £.
3. **Today vs prior-period stats.** Brief shows "41 orders · £1,880 · +12% vs last Tue". `getStoreMetrics` returns lifetime + trailing-30-day only. `Order.processedAt` is indexed, so this is one new query. → Add a today-vs-equivalent-prior-day metric. Until then: show lifetime/30-day reals, no daily delta.
4. **"While you slept" executed-action feed (with £ impact).** ✅ **BUILT — dark (2026-07-30).** Both former blockers are resolved: (a) the action-execution capability (`wireClearanceExecution` → `applyClearance`) and (b) the `action_executions` ledger with a measured outcome column (units moved / cash recovered / effectiveness) now exist. The Daily Home **"What Jefe did"** feed renders `getExecutedActionFeed`: each `applied` / `partially_applied` / `reverted` clearance with its measured outcome, honest per status (the applied count never the proposed; a reverted run shown as a rollback, never a success; failed omitted). The section **self-hides until there are executed rows** — i.e. until `CLEARANCE_EXECUTE_ENABLED` is on — so there's no fabricated activity in the advisory state. `app/components/daily-home.tsx` (`ExecutedActionFeed`), `app/routes/app._index.tsx` (loader). The memory/analysis-activity reframe is no longer needed for this item.
5. **Multiple recommendations + a queue.** `5a` shows 2 "Your call" cards + "N more in queue"; `2c`/`8a` show a full queue with waiting/handled/declined counters and per-row origin. Backend has **one** recommendation per `MerchantPlanRun` (1:1). → Multi-recommendation generation + a queue/prioritisation model + status counters. Until then: single card + honest "more coming".

## P2 — other Daily screens (future builds)

6. **Course-correction ("I got one wrong").** No outcome tracking on past recommendations, so no way to detect/report a miss. → Outcome/result capture + variance detection against the recommendation's `successSignal`.
7. **Horizon / seasonality (`5b`).** No seasonal-calendar engine (compute BFCM/Christmas cut-off/returns-wave from dates, never hardcoded) and no external-signal ingestion (supplier email, competitor pricing, weather). → Seasonal-date computation + external connectors, each tied to a specific SKU/lane.
8. **Tidy-up (`5c`).** No store-hygiene scanner (missing alt text, supplier-default descriptions, broken redirects, stale discount codes, duplicate collections, missing weights). → A tidy-up scan service + the auto-fix vs. ask-first split. (Flagged in the design as likely the strongest first-week feature.)
9. **Team & approvals / routing / autonomy (`3b`, `8`).** No team/roles/spend-limits/routing-rules/autonomy model. → Team + role + routing + per-category autonomy models; declines must carry a reason that reroutes.
10. **Integrations detection + read/act scopes (`4a`/`4b`).** No installed-app detection (Shopify can pre-detect Klaviyo/Recharge/ShipStation) and no per-integration OAuth (Gmail/Xero/Drive/etc.) with an explicit **Reads / Reads & acts** scope model + read-only permission sheet. → Detection + per-integration OAuth + scope model.
11. **Chat + unified queue with channel provenance (`2b`/`2c`/`6`/`8`).** No cross-channel thread ("one thread, each message tagged with its source"; Slack/WhatsApp/Teams as transports). → A conversation-thread model spanning channels (some `MerchantMemoryConversation` infra exists but isn't this).
12. **Developer / MCP + API keys (`3c`).** No merchant-facing MCP server or scoped API keys ("a key can never do more than its creator"). → MCP server + scoped key issuance.
13. **Goal targets & progress (`9a`).** `MerchantGoalHorizon` is title + description only — no numeric target or progress. → Target + progress fields + measurement against store metrics.
14. **Partner-rail "You asked for this" credits.** No linkage between a merchant's feature requests and shipped changelog items. → A feature-request record joined to changelog entries. ("New in Jefe" itself can already read the app CHANGELOG.)
15. **Thin / zero / broken states (`7`).** New-store-with-thin-data, empty queue, disconnected integration, failed ingestion. → Real empty/failure states (should be built alongside each surface, not after).

---

_Update this list as items are built. The `changelog-watcher` tool + `product_analytics_and_margin_spec.md` are adjacent internal tooling; this is the merchant-facing gap list._
