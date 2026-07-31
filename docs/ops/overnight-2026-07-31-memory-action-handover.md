# Handover — memory + action-engine lane (chat 9) — 2026-07-31

Session context ran to ~99%; this is the durable handover for the next session in this lane.
Companion records: `docs/ops/overnight-2026-07-31-architecture.md` (chat 10 / architecture),
`docs/integrations/tool-stack-phase2.md` (the belief-wiring recipe chat 10 wrote for me).

## Lane identity

This lane owns **client-facing memory/action surfaces + the action-engine**: the belief model as
the merchant sees it, and the typed/reversible action ontology (clearance is the first verb).
It does NOT own: the integrations *detection engine*, ingestion pipeline internals, or growth.

## Shipped this session (all on origin/main, gate green)

- **Plan-rec action emit** — LLM plan-rec emits an optional `actionIntent` →
  `proposeActionFromIntent` → a `proposed` ActionExecution row (money totals persisted as
  `proposalSummary`). `getActiveSuggestedAction` reads the latest proposed row → a render-ready
  `SuggestedAction` with server-side money formatting. `reviseAction` (re-propose + supersede).
  `rejectAction` reason split into `reasonCategory` + `reasonText`.
  Files: `app/lib/actions/action-resolution.server.js`, `action-intent.server.js`,
  `action-autonomy-policy.server.js`, `app/lib/merchant-plan/{schema,prompt,service}.server.js`.
- **Observe→Learn loop close** — `measureAndRecordClearanceOutcomes` (clearance-outcome.server.js) +
  daily worker tick (`ENABLE_CLEARANCE_OUTCOME_JOB`, default-on) → `clearanceEffectiveness` +
  `actionDeclineSignal` derivations → two deterministic beliefs
  (`business.clearance_effectiveness.all_time`, `business.action_decline_signal.all_time`).
  `adaptMarkdownFromMemory` eases default markdown after `too_aggressive` declines.
- **Chat 11 Memory-view fields** — `beliefAuthorship` / `beliefConfirmState` / `beliefSourceLine`
  in service.server.js (+ `memory-view-fields.test.mjs`); `getOpenQuestions` for the "still
  guessing" group; `getExecutedActionFeed` + headline/outcome formatters.
- **Autonomy policy** — `getActionPolicy` / `setActionPolicy` / `applyAutonomyPolicy`
  (degrades over-cap `autonomous` → `approve_execute`); `policy Json?` column.
- **Benchmark priors scaffold** — `benchmark-priors.server.js` (`isMerchantFact:false`,
  `compareToBenchmark`, `isSurfaceableBenchmark` ≥20 cohort). No data yet — gated on the Quiver read.

## LIVE + staged

- Clearance execute is **LIVE in prod** (`CLEARANCE_EXECUTE_ENABLED=true`). Test store
  `jefe-store-6u7nfi71` was granted `write_products`; 4 costed dead-stock variants seeded; first
  proposal generated (**runId `4a059156`**). **HELD for a WATCHED execute** with Matt (chat 10's
  call per the "don't fire unwatched" rule). Not this lane's to fire.

## Integrations — DECISION (2026-07-31, Matt: "you decide")

**BUILD, not BUY. No paid detection API.** Rationale + full detail in memory
`jefe-integrations-tool-stack-decision` and below.

- Shopify gives no "list installed apps" API, but fingerprints ARE inspectable: metafield
  namespaces + gateways + tags (chat 10's phase-2 feeder already reads these on scopes we hold);
  ScriptTags/theme-assets expose front-end tools but need an added scope + re-consent (deferred).
- The paid API was only for front-end-visible tools (GA/Meta/Klaviyo) — equally visible in the
  **public storefront HTML**, which we fetch for **free, no scope, no re-consent** (we know the
  shop domain from install). So: Admin-signals feeder (built) + free storefront-fetch feeder
  (replaces the "buy" plan) → one curated signature registry (optionally seeded from an OSS
  Wappalyzer fingerprint fork, license-checked).

**Ownership:** chat 10 = detection engine (built + dark, `ENABLE_TOOL_STACK_DETECTION`) + the
storefront-fetch feeder + registry. **THIS lane (not started):**
1. Wire the injected `recordBelief` seam → **`business.tool_stack` belief** per the recipe in
   `docs/integrations/tool-stack-phase2.md` (mind the belief-count guard).
2. **`connect_integration` action-intent** — detected-but-unconnected tool → `proposeActionFromIntent`
   (typed/reversible/approval-gated, same as clearance) → "You use Klaviyo — connect it?" offer.

**Go-live gate:** verify seed signatures vs 1–2 real stores before flipping the flag (wrong
signature = false detection, worse than a miss).

## Pending / deferred for Matt (see scratchpad QUESTIONS-FOR-MATT.md)

- Autonomy-cap settings UX (where the merchant sets per-action dials + blast-radius caps).
- Quiver benchmark DB read → populates `benchmark-priors` (cohort ≥20 to surface).
- Plain-English per-belief `statement` rendering pass (substantial; this lane's to own).
- Scope re-consent in-app prompt + email (value-first framing) — built? verify state before more.

## Flags (do NOT flip without the named go-live steps)

- `CLEARANCE_EXECUTE_ENABLED=true` (LIVE). `ENABLE_CLEARANCE_OUTCOME_JOB` default-on.
- `ENABLE_TOOL_STACK_DETECTION` — OFF; needs the seed-signature verification first.
- `PRODUCT_STATUS_EXECUTE_ENABLED`, `ENABLE_WINBACK_EMAIL`, winback-campaign flags — see
  `docs/ops/overnight-2026-07-31-architecture.md` + email memory before touching.

## Update — Matt directive (2026-07-31, later): BUILD IT ALL + surface + flag ON

- **`ENABLE_TOOL_STACK_DETECTION` is now `true` on prod** (Matt: "no users yet, let it run then test" —
  the seed-signature check becomes a live/watched step, not a pre-gate). **BUT verified inert:**
  `detectAndRecordToolStack` has **zero callers** — flag alone is a no-op until wired.
- **Build target (Matt): "serve up what we know their current tools are, in onboarding + an
  integrations page."** The full chain, by owner:
  1. **Detection actually runs** (chat 10): wire a CALLER for `detectAndRecordToolStack` (backfill
     worker tick or an onboarding loader) + the free public-storefront-fetch feeder + signature registry.
  2. **Belief** (this lane): recordBelief seam → `business.tool_stack` belief (recipe:
     `docs/integrations/tool-stack-phase2.md`).
  3. **Surface** (surfaces lane — chat 11/chat 2): onboarding "here's what we can see you use
     (Klaviyo/GA/Meta…)" + a dedicated **integrations page** listing detected tools, each with a connect CTA.
  4. **Connect path DEFERRED** (Matt: "then decide a path forwards re integrations to these channels")
     — decide the actual connect mechanism (OAuth per-tool vs. Alloy gateway) AFTER it's built + we see
     real detections. My `connect_integration` action-intent is the hook, not the decision.
- Not started here (session at context end). Handed to lanes via memory + chat 10 message.
