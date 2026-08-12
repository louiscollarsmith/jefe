# Reclaim Arbitration — 2026-08-12

Standing record of the architecture arbitration after the human-takeover resync.
Authored by the architecture-II lane; rulings ratified against `origin/main` code and
Matt's founder decisions (relayed via the repo-review lane). Update in place as
dispositions resolve.

## Context (re-baseline)

- `origin/main` advanced **17 commits, all human** (Louis Collar-Smith, PRs #65–79,
  2026-08-06→08-11) from the last agent commit `a75017c`.
- **Good + additive:** a governed action-chat commerce analyst
  (`commerce-analyst.server.js`), tenant-scoped commerce calculations
  (`commerce-calculations.server.js`), a shared context retriever
  (`context-retriever.server.js`), plan-evidence snapshots. The belief / action /
  autonomy spine is untouched and still runs.
- **LLM provider changed:** Groq GPT-OSS primary, Gemini fallback (`a6cc108`).
- **The cost:** PR #75 rewrote `daily-home.tsx` into a self-contained single-column
  brief / action-chat home and dropped the `AppHome13a` render, orphaning the 13a
  surface (autonomy roster, memory-correction controls, Horizon near-term, hygiene
  queue). Loader still computed some of it and discarded it.

## Gate ruling — APPROVED (Matt)

Retire the architecture-review gate as a **blocking pre-merge** requirement. With a
human holding merge authority (PRs), a Claude-session sign-off is un-routable — and
PR #75's self-attested "gate cleared" (no reviewer) proved it. Architecture review
becomes **advisory**: PR review + periodic spine audit (this) + reclaim arbitration.
Human holds merge authority. Drop the hollow self-attested checkbox. Claude sessions
push reversible work to `main` directly (pathspec commits; re-run preflight after
rebase). AGENTS.md:85 rewrite tracked separately.

## Flag & doc truth (verified against Railway prod)

| Flag | Prod | Note |
|---|---|---|
| `CLEARANCE_EXECUTE_ENABLED` | **true** (live) | HANDOVER.md still says "dark" → stale, fix |
| `ENABLE_EMAIL` | **true** | win-back sending; see Email below |
| `ENABLE_WINBACK_EMAIL` | **true** | opt-out exists in-email (one-click unsubscribe) |
| `ENABLE_TOOL_STACK_DETECTION` | **false** | I turned it off (disarmed the orchestrator trap) |
| `ENABLE_MORNING_BRIEF` / `ENABLE_WINBACK_CAMPAIGN` / `PRODUCT_STATUS_EXECUTE_ENABLED` / `ENABLE_PUBLIC_CHANGELOG` | unset (dark) | — |

Doc-truth pass (tracked): HANDOVER.md (clearance is live, not dark); `.env.example`
(the 7 flags above are undocumented — add with prod-truth); CLAUDE.md (Channels is
leaving onboarding + onboarding becoming an animation — the "Connect→…" flow line is
stale); `app-home-13a.tsx:6-10` comment (renders `DailyHome`, not `AppHome13a`).
`product_status_change` is absent from `ACTION_REGISTRY`, so `PRODUCT_STATUS_EXECUTE_ENABLED`
is doubly inert. Scopes: Matt keeps `write_orders`/`write_customers`/`write_inventory`
("we know we need them"); chat 6 reconciles the privacy claims to the scopes (no revert).

## Spine rulings

### 1. Metric duplication → belief is canonical (highest-value)
Two live paths compute stock cover / velocity / trapped capital with **different
windows, floors and sales-gates** — the action-chat analyst (`commerce-calculations`)
vs the memory beliefs (`shopify-derivations`) — so they can quote **contradictory
numbers to the same merchant**. Sharpest: "trapped capital" — belief counts
dead-stock-only (~£12k), analyst sums all stock (~£100k), same phrase.
**Ruling (chat 9, ratified):** the belief is canonical; action chat is a consumer and
must never assert a figure contradicting the belief it discusses.
- **(b) surface the belief's number where one exists — ships first** (cheap, kills the
  contradiction; number-neutral).
- **(a) shared domain primitives** (velocity/cover/trapped w/ the belief's window+floor)
  — `calculation-primitives.server.js` has only generic math today, so this is
  add-then-adopt. Belief-side adoption is number-neutral (golden test). **Analyst-side
  changes merchant-visible numbers → product-gated, not a silent refactor** (label the
  window; split `trapped_capital` into `dead_stock_trapped_capital` vs
  `trapped_capital_all_stock`). Owner: memory/ontology lane.

### 2. Belief-read path (#3)
`service.getBeliefsForMerchant` is the single front door. The shopId difference is
**correct by purpose** — the service is a merchant-wide read (incl. shopId=null rows);
the retriever needs a **shop-scoped** read. Do NOT force shopId onto the merchant-wide
method. `supersededAt` is redundant-not-divergent today (invariant holds via app code);
unify onto one rule. Owner: memory/ontology lane.

### 3. Tenant-scoping (#5) — CONFIRMED BUG, ranked high
`context-retriever`'s `shopId ?? undefined` (7 sites: 434, 452, 477, 495, 514, 532, 600)
**drops the Prisma filter** → all-shops read → cross-shop belief bleed in
`loadBeliefsWithExpansion` (keys repeat per shop). Not live-reachable today (sole caller
passes `shop.id`) but a supported-contract footgun. **Fix is per-model** (successor's
correction — a blanket `shopId: input.shopId` would silently drop merchant-wide beliefs):
- `MerchantMemoryBelief` (shopId nullable, 434/452): `OR: [{ shopId }, { shopId: null }]`.
- Goal/Insight/Plan/ActionExecution (NOT NULL, 477/495/514/532/600): plain equality.
- All 7: **fail-closed on a missing shopId** (hard-reject, matching
  `commerce-calculations:317-341`). Owner: memory/ontology lane.

### 4. Duplicated helpers (#4) — two jobs
- **`safeText` is the real finding (rank #1):** 4 variants with **different redaction**
  (analyst copy redacts nothing; retriever copy strips email+phone) — a live redaction
  trap on the prompt-build path. Split into `normalizeText` (no redact) + `redactText`;
  migrate call sites deliberately.
- **Mechanical batch (safe):** `safePromptText` (byte-identical, security boundary),
  `allContextBlocks`, `number`, `round`, `clampInteger`, `normalizeWindow` → consolidate
  (numeric → `calculation-primitives`; `safePromptText` co-located with `redact`).
- `uniqueStrings` (3 variants) + `asRecord` (belief-registry copy drops the
  `!Array.isArray` guard = latent bug) → reviewed, not mechanical.

### 5. Write-on-read (#6) — both FIRM safe fixes
- `loadOrBackfillPlanEvidenceSnapshot`: `getMerchantContextForQuestion` (a named read
  feeding the LLM context) does a DB INSERT on cache-miss — breaks read-replica (throws;
  try/catch swallows → **silent evidence loss**), caching, and it races. Fix: make the
  read pure (return the `missing_unavailable` status it already models); move the
  backfill to the write path + a one-off legacy job. Owner: memory/ontology lane.
- `holdQueuedBackfillJobs`: test affordance on the prod job-completion path, inert in
  prod. Move behind a generic `onJobSettled` hook; delete the prod branch. Owner: obs lane.

### 6. Obsolete-op / `memory.forget` — bug CONFIRMED, forget is authoritative
`markBeliefObsolete` sets `status: obsolete` (not in `ACTIVE`), so the next full rebuild
re-creates the belief as `inferred` → **a merchant forget is silently resurrected**
(violates "merchant corrections supersede inference"). **Ruling:** forget is
authoritative — new status `merchant_retracted` in `AUTHORITATIVE_BELIEF_STATUSES` but
NOT `ACTIVE`; widen `upsertDerivedBelief`'s `existing` lookup to `ACTIVE ∪
{merchant_retracted}` so it's found + skipped (durable, never surfaced). Also: extend the
revert allowlist + `merchant_*` changedBy (undoable); shop-scope `markBeliefObsolete`; a
`merchantObsoletable` capability flag (never let a merchant "forget" an observed Shopify
fact); `requiresConfirmation:true` unconditional. Fix the primitive before wiring the
conversational op. Open (don't build yet): re-surface on a strong new signal.
(This is the architecture lane's call, not a Matt one-way-door — it applies an existing
principle.) Owner: memory/ontology lane.

## Reclaim map — RE-HOME, NOT DELETE (Matt, this cycle)

Home stays **Louis's brief permanently this cycle** ("sleeker and cleaner and just a
chat log") — nothing added back to it. Orphaned features **re-home to a new left-hand
settings area** (Integrations · Channels · Settings · autonomy roster; chat 11 owns the
nav shape — watch it doesn't resurrect the global Polaris left-nav `0acdf68` removed).

| Item | Disposition |
|---|---|
| Wasted home-loader compute: `getActionMode` roster loop, `getOpenQuestions`*, `changelog` prop | **STOP on the home loader** (feeds nothing rendered). *`getOpenQuestions` SEEDS via `ensureInitialOpenQuestions` — confirm seeding on the memory-view path first. `whats-new.server.js` untouchable (public page source). |
| `getLatestHorizon` | **KEEP** — `horizonWatching` is live in DailyHome; only `horizon.near` is dead |
| Autonomy roster / dial | **CONFIRMED RESTORE** → Settings → Autonomy panel (landed `7e48f3f`). Approve / execute / autonomous. |
| Memory correction controls | **CONFIRMED RESTORE** → into `merchant-memory-view.tsx` (middle path). Not a 13a restore. |
| Channels UI | Out of onboarding permanently → Settings panel, Slack-first (inbound-email lane). `ChannelsStep` + `channelProviderUrl` in `app._index.tsx` are now genuinely orphaned (nothing renders `ChannelsStep`, no `activeStep==="channels"`; Channels live at `/app/settings?panel=channels`). **PENDING DELETION** — trigger: once the Settings channels panel is confirmed the sole path (Slack callbacks already fixed, `1c9909c`/`68f949f`). Correctly not deleted yet (re-home-not-delete). |
| Email prefs control (`notification.set`) | KEEP → new Settings panel. Restore-priority (win-back sending; opt-out exists in-email). |
| AppHome13a shell + superseded section exports (Brief/Goals/Queue) | **PENDING DELETION** — held this cycle. Trigger: delete only once every re-home has a surface AND the residue is provably dead; 13a only if Matt un-parks it ("we can come back to"). |
| Unreachable action/memory handlers | Landing points if RESTORE; delete with their sections if LET-GO — held. |

**Critical-path dependency:** the new `app.settings`/`app.integrations` routes don't
exist yet; the roster, channels, and integrations panels are blocked behind chat 11's
nav scaffold.

## Tool-stack (integrations panel)

Flag `ENABLE_TOOL_STACK_DETECTION` **off** (orchestrator `detectAndRecordToolStack` has
zero callers — the armed trap). The merchant-facing beliefs come from the **unflagged
DB-derivation** (`toolStack` in `shopify-derivations`), signature-safe. Verified prod:
**0 `business.tool_stack` beliefs written** (no signature matched the 2 stores) → the
false-positive risk is not realized. Signature-quality review done: registry trustworthy
for firm detections (app-specific metafield namespaces + gateways + distinctive
fulfillment handles); the ≥0.7 `surfaceable` gate enforces firm-only. **Two tightenings
(architecture lane, registry):** drop Recharge's generic `/subscription/i` order-tag;
tighten Amazon-MCF's broad `["amazon"]` fulfillment substring (load-bearing — needs a
real MCF store to pin; conservative + first-detection spot-check backstop). Panel: GREEN
to build + surface firm detections; hold surfacing to a real merchant until the two
tightenings + a first-detection spot-check. New seed signatures are unverified-by-default
via the confidence ladder.

## Action outcomes (Observe→Learn) — measure, don't yet learn

Measurement **exists + runs** (`clearance-outcome.server.js`: effectiveness/revenue/units;
worker-wired; fed to memory; shown in the feed). Two gaps (architecture lane):
- **(a)** measurement is clearance-hardcoded — no per-primitive contract. Define the
  Observe→Learn twin of `ACTION_REGISTRY`: per action type register
  `measure(run)→outcome` + `verdict(outcome, baseline)→good|underperformed|neutral`.
- **(b)** the loop doesn't close — the proposal reads the outcome only to display it,
  never to adjust; no good/not-good verdict. Close it: the proposal consumes the prior
  verdict. Surface the verdict as a message in the shape-B conversation home.

## Owner map

- **Architecture-II lane (this):** gate rewrite; doc-truth pass; tool-stack registry
  tightenings + go-live; action outcome-measurement + verdict contract; `da2ff0c` scope
  review (resolved: kept, claims reconciled by chat 6); this doc.
- **Memory/ontology lane (successor to chat 9):** metric canonical-number (a+b);
  belief-read single front door; tenant-scoping per-model fix; write-on-read snapshot
  purity; obsolete-op fix + conversational op; tool-stack read `surfaceable` wiring +
  detected-tools data.
- **Observability lane:** `holdQueuedBackfillJobs` test seam; LLM cost read → apps/ops.
- **chat 11 (app redesign):** the new settings-area nav shape (critical-path).
- **chat 2 (onboarding):** onboarding-as-animation rebuild.
- **inbound-email lane:** Channels → Settings panel (Slack-first).
- **composer lane:** email-prefs control → Settings panel; shape-B conversation home.
- **chat 6 (growth):** reconcile privacy claims to the kept scopes.
- **model-testing / Quiver lane:** corpus loader (separate DB isolation; scope to
  reasoning, not Shopify-IO).

## Onboarding fast-sample (recent-window backfill) — routed 2026-08-12

Matt's onboarding ruling: "animate the waiting, keep the asking real." Insights ("what
stands out") must generate from a **bounded fast sample (~5k recent orders, seconds)**,
not the full backfill, so a large merchant gets findings immediately. Split three ways
(this fell through an archive gap once — recorded here so it can't again):
- **Piece 1 (chat 2):** `onboarding/steps.js:72` gates Insights on `backfillComplete`;
  needs a second concept — "enough data to say something useful."
- **Piece 2 (architecture-II):** no recent-first sample exists (the worker orders *jobs*,
  not *orders*). **Ruled Option 1 — a recent-window PHASE in the backfill** (Phase A: last
  ~5k orders processedAt DESC → Insights gate on Phase A; Phase B: older history to
  complete; date-partitioned, idempotent per order id) — one ingestion path, never stale
  vs the backfill. NOT a separate fetch. Flows through the honesty primitive
  (`shopify-derivations:1166-1170` historyKind / storedOrderCount / earliestStoredOrderAt)
  so Insights state real scope, honest by construction. Downstream of the storyboard —
  not urgent.
- **Piece 3 (chat 2 + architecture-II):** Insights consume `historyKind` honestly, once
  the storyboard is approved.

## Founder rulings — standing principles (Phase 2, 2026-08-12)

### The door rule (two-way vs one-way)
The gate's operating test, ruled by Matt and now the fleet default:
- **Two-way door** (reversible / internal / no external side-effect) → **ship it**, no ask.
- **One-way door** (public / legal / scopes / auth / flag-flip-to-go-live / architecture /
  anything touching a real merchant) → **ask Matt first.**
- **Contracts are two-way UNTIL they shape stored data or merchant-visible behaviour.**
  Define / publish / iterate freely; the moment a contract writes beliefs or changes what a
  merchant sees, it's a one-way door.
- ⚠️ The distinction is *consequence*, not *diff size*. "Reversible in code, irreversible in
  the merchant's inbox" (win-back, below) is the canonical trap.

### Autonomy: two modes permanently + runtime eligibility
- **Two merchant-selectable modes, permanently: `approve_execute` and `autonomous`.** No
  third. Saved across all sessions.
- **Eligibility is decided by the system at runtime, per-run — NOT a declared field.** The
  merchant's mode is the ceiling, not the trigger.

### `recommend` retirement — retire the CHOICE, keep the engine OUTCOME
Against a literal reading of "remove recommend from `ACTION_MODES`", which would regress
consent on a live-write flag (`CLEARANCE_EXECUTE_ENABLED=true`):
- Retire `recommend` from the **surface only** — AutonomyPanel picker, the schema comment
  for *selectable* modes, context-11's merchant-choice list.
- **KEEP `"recommend"` in `ACTION_MODES`** (`isValidActionMode` true) — else stored recommend
  rows fall through to `approve_execute` = silent consent promotion to propose-and-execute.
- **KEEP the fail-closed guards** (wire-clearance:60, clearance-adapter:238,
  product-status-adapter:126) + executable gates (action-resolution:322,:383) + the immutable
  `ActionExecution.resolvedMode` ledger.
- **Principle:** recommend retires as a merchant *choice* but survives as an engine
  *outcome* — it is the name of the part-9 fallback state (eligibility says "don't execute"
  → raise it with steps). Removing the engine's handling breaks the part-9 invariant.
- **Migration of existing recommend rows = Matt's call, sized by a prod count** (`mode='recommend'`).
  The silent-promotion danger is already neutralised by keeping the value; the count only
  decides grandfather-vs-migrate. Routed to the data lane.

### Context-specificity: agnostic in reach, specific in judgement
Matt's standing principle — works for any Shopify merchant (lipstick DTC / gardening POS+DTC
/ medical sales / Tesla), gives advice that could only apply to *this* one.
- **Verified gap:** `business.*` has store_name/currency/history/activity/tool_stack/engagement/
  decline — **nothing describing the nature of the business.** A lipstick DTC brand and a Tesla
  dealership are structurally identical to the ontology; only the numbers differ. Every
  recommendation is generic *by construction* — a representation problem, not prompt-tuning.
- **Belief side — a "business shape" tranche** (memory/ontology lane, contract held here):
  **dimensional beliefs** — channel mix (DTC/POS/wholesale), cadence, price band, catalogue
  size, considered-vs-impulse. Inferred from unused signals: product types/vendor, order
  `sourceName`/channel, shipping countries, price distribution, repeat interval.
  `systemInference` precedence + merchant correction. This is what the memory surface is *for*
  — where specificity gets acquired; it gives `beliefConfirmPriority` far better questions.
- ⛔ **NO vertical enum.** Wrong at the edges immediately (gardening = POS *and* DTC *and*
  wholesale) and it violates "agnostic". A Tesla dealer and a medical-device seller share
  "high price band / considered / low frequency" with no shared label — advice keys on the
  dimension, not the category.

## The action-ontology contract — a well-formed action type
As the ontology expands from one (clearance) to N, every action type declares these parts;
runtime eligibility decides per-run whether it fires.
1. **Trigger** — a belief OR a query-derived condition. (Belief-only is too narrow.)
2. **Intent** — the LLM action-intent shape → `proposeActionFromIntent`.
3. **Reversible adapter** — typed, real inverse; writes the `action_executions` /
   `action_execution_writes` ledger.
4. **Autonomy policy** — resolved against the **two** modes + runtime eligibility.
5. **Required scopes** — declared, checked before propose.
6. **Measurement** — an `outcome` FIELD on the registry entry (NOT a parallel
   `OUTCOME_REGISTRY`): metric, window, threshold, baseline. One shared executor runs it.
7. **Verdict** — did it work; consumed by the propose path so the loop *learns*, not just
   measures (today clearance-hardcoded — the open gap, #20).
8. **Applicability** — which businesses it suits, **dimensional** (per context-specificity),
   as a trigger qualifier. Clearance-markdown suits perishable/impulse, not a car dealer.
9. **Fallback-instruction-path** — if Jefe can't/shouldn't execute, it tells the merchant how
   to do it themselves. **No action type is ever a dead end.** The discarded
   `resolveAutonomyMode().reason` + `applyAutonomyPolicy().policyViolations` are the *content*
   of this raise and must be persisted (today they evaporate in `maybeEmitPlanAction`).

**Targeting separation (ruled):** the trigger belief is *trigger + narrative*; the primitive
**resolves its own targets by query at execution time** (`dead-stock-clearance` never reads the
`dead_stock` belief — it queries variant/inventoryLevel/orderLineItem directly, 114/128/132).
So new actions are NOT blocked on the memory lane for targeting — they need a trigger condition
+ their own resolver.

**Spine generalisation LANDED (`2539c4c`, ratified):** `RESOLVERS` → a **primitive binding table**.
Registry = WHAT (metadata); binding = HOW this layer runs the type. Bound per type (all were
clearance-hardcoded): `resolve()→{preview,summary,magnitude}`, `caps` (was persisting
`DEFAULT_CLEARANCE_CAPS` regardless — recorded limits it did not enforce), `computeEligibility`,
`actionKindFor`, and the presenters. **Every field is required and asserted at module load — a
partial binding throws** (ratified hard, not soft: inheriting-by-omission was the wrong-flag /
wrong-caps bug). Three sites stopped speaking for unknown types (null suggested-action, neutral
executed line, scope-check-before-resolve). `proposal.totalTrappedCapital`→summary (the proposal's
money must match the products it lists; cost-floor-refused items aren't in the action). Note:
`ActionExecution.caps` rows written before `2539c4c` record clearance caps for every run — no row
is wrong (only clearance ran), but don't read that column as evidence of a non-clearance action's
enforced caps.

## Action outcome contract — measure, don't ask (parts 6–7; DEFINED, co-proposing to Matt)
Matt's hard constraint: value is **actively measured against a baseline from real outcome data**,
never a 👍/👎. With chat 5 (decline half). Tracked #20.
- **`ActionOutcome` = discriminated union `measured | declined | reverted`.**
  - `measured`: `verdict ∈ {good, underperformed, neutral}` computed from commerce data.
  - `declined`: `reasonCategory` + `reasonText`, captured conversationally in action-chat (no widget).
  - `reverted`: its own kind (`revertedAt`, `reason?`) — a revert supersedes measurement (the effect
    didn't stand; it's feedback, not performance).
- **One generic executor; two per-type binding functions.** `snapshotBaseline(execution)` captures
  the **item-level** baseline at EXECUTE time (clearance: the variant's trailing sell-through the
  moment the markdown lands — measuring after the action would measure its own footprint).
  `observeOutcome(execution, resolvedWindow)` reads the post-action metric. `verdictForOutcome`
  is already generic (reads the per-type `outcome` registry spec).
- **Business-relative (hard requirement).** The registry `outcome` spec holds DEFAULT
  window/threshold; the executor resolves them **shape-adjusted from Merchant Memory** before
  observing (a 3-day sell-through is a win for lipstick, meaningless for a car dealer). Executor
  stays generic — it reads *resolved* values. Decline reasons ("cars don't clear that fast") feed
  the SAME shape model. Learning is consumed **per-merchant-shape**, not per-type-global.

## Business-shape tranche — dimensional, provenance-tagged (contract held here)
Per [[jefe-context-specificity-principle]] — "agnostic in reach, specific in judgement". The gap:
`business.*` has no representation of the *nature* of the business. Fill it with **dimensional
beliefs, never a vertical enum** (a Tesla dealer and a medical-device seller share "high price band
/ considered / low frequency" with no shared label):
- **Channel mix — FIRST-CLASS** (Matt): Shopify / in-store / POS / TikTok / Amazon, via order
  `sourceName` (already ingested + selected). A belief, not a per-question re-derivation; and an
  available breakdown wherever `currency` is. (Confirm the backfill persists `sourceName` for POS
  and marketplace orders — the likely-thin bit.)
- Retention window / repurchase interval (derivable; **governs what "good" means** for an action —
  see the outcome contract's business-relative window; this is the same property).
- Customer-base shape (new-vs-returning, concentration, geography); goals-connection.
- **Provenance tag per dimension:** `derivable-from-Shopify` / `askable` /
  `derivable-from-a-connected-integration`. The third is Matt's CAC correction — Meta/Google ads
  make CAC/ROAS available once connected, which reframes the **integrations panel as a source of
  belief**, not just a connector list. Tagging keeps `systemInference` precedence honest and tells
  the memory surface which questions are worth asking; never fill a gap with a plausible guess.

## Currency contract — CORRECTED 2026-08-12: stored revenue is base-currency and summable
⚠️ **This replaces an earlier version of this section that enshrined a wrong premise.** The
"multi-currency can't be totalled" framing — my stop-gap `bfc2b4c` AND the model-testing lane's
`9241e8d` — was misdiagnosed. Verified against the ingestion:
- **Every stored money AMOUNT is `shopMoney`** = the shop's single base currency, summable across
  orders (`canonical.server.js:174-219`; GraphQL query `queries.server.js:155-239` fetches only
  `shopMoney`, never `presentmentMoney`).
- **`order.currency` is the PRESENTMENT currency** (top-level `Order.currencyCode`,
  `queries.server.js:139`) — the customer's currency, varying per order. It does NOT describe the
  amount beside it. A shop has exactly one base currency, so the field that varies is presentment by
  construction (that is why one store showed "20 currencies").
- **The belief layer already had it right:** `shopBaseCurrency()` (`shopify-derivations.server.js:2949`)
  — "every stored money amount is Shopify shopMoney… summable regardless of the customer's presentment
  currency… revenue beliefs must not skip on it." Revenue beliefs sum shopMoney and report one total.
  `9241e8d` made the analyst *contradict* the correct belief = spine-issue #1, live.

**Corrected contract:**
- **Revenue/money totals are summable, always.** Amounts are base-currency shopMoney; never refuse
  for "multiple currencies". Match the belief layer.
- **Label totals with the shop BASE currency** — `shopMoney.currencyCode` (already fetched at
  `:158/:164`) or `shopBaseCurrency()`. The presentment label is actively misleading (£144 shown as
  "EUR 144").
- **No per-presentment-currency money "breakdown"** — it buckets base-currency amounts by an
  unrelated label. A real "revenue in the customer's currency" lens needs `presentmentMoney` AMOUNTS,
  which are not ingested — impossible today without a query/ingestion change.
- **`currency` stays a coverage signal only** ("which presentment currencies customers pay in" —
  `business.multi_currency_order_share` already does this), NOT a money-bucketing axis.
- **Owner:** model-testing lane correct-forwards `9241e8d` (sum + base label); architecture gates.
  ~113/222 merchants affected in live analyst output → fast follow. Tracked as task #23.
- **FX to Matt — reframed:** stored revenue needs NO FX (it is all base currency). FX/presentment
  data would only enable a "revenue in the customer's currency" lens, which needs presentmentMoney
  amounts we do not fetch — a fetch/ingestion decision, not a rates provider.

## Fleet infra rulings (2026-08-12)
- **node_modules-empty hazard (dangerous — induces a wrong fix):** the main checkout's
  `apps/shopify/node_modules` can be empty; symlinked worktrees resolve to nothing, `npx prisma`
  pulls 7.9.1 and rejects the correct 6.x schema with `P1012 datasource url`. Reads exactly like a
  broken `schema.prisma`. **Discriminator:** `npx prisma --version` (6.x → trust the schema; 7.x →
  your install is gone). **Fix:** `rm -f node_modules && npm ci` per worktree.
- **Gate throughput at ~15 lanes (ruled, reversible):** shrink the pre-push HOOK to a fast subset
  (typecheck + lint + changed-file unit tests — no build, no full-DB) so the ref-lock race window
  drops ~3min→~30s. On a lost ref-lock race the re-run is **risk-based, not blanket** (refines the
  AGENTS.md:70 hard rider): `git diff --name-only HEAD@{1} HEAD` (what the rebase pulled in) vs
  `git diff --name-only <merge-base> HEAD` (what you changed) — file/module overlap → **full gate**;
  no overlap → **fast subset suffices**. Targets the actual semantic-conflict risk (red main blocks
  15 lanes ≫ 3 min) rather than the calendar. Mandate `&&` not `;` in every preflight-then-push
  snippet. The larger "feature branches / merge queue vs direct-to-main" change is a ways-of-working
  call for Matt — flag the rebase relaxation to him in the same envelope, since "green preflight"
  means something slightly weaker afterwards.
- **No pinned Node → local runtimes drift from CI (fixed):** `.nvmrc`=`20` added at repo root to
  match CI (`engines` permits 20/22/24, CI runs 20, no pin existed → a session could pass preflight
  on a runtime CI never exercises; it already happened). Moving CI to 22 + pinning there is a
  defensible one-way-ish call for Matt; the range stays permissive, the pin says what we use.
- **db-tests flake (observability lane):** connection exhaustion on shared `jefe-shopify-postgres`
  at 8+ sessions. Cap each run's Prisma `connection_limit` (demand) first, `max_connections=200` in
  `db:up` (supply) at next quiet recreate, schema-isolation held unless row-contention shows.

## Fleet infra STRUCTURE — founder-mandated (Matt 2026-08-12: "build some kind of structure")
Escalated from "record it" to "build it" after the substrate failures cost hours and took main red
via a plausible-wrong-fix. Design held here; a dedicated plumbing lane builds the rest.
- **Anchor SHIPPED (`c87d321`): `scripts/env-check.sh` as preflight's first step.** Distinguishes
  "your environment is broken" from "your change is broken" — the confusion that burns the hours.
  HARD-fails a missing/incomplete `node_modules` and a non-6.x Prisma (the P1012 trap) with the exact
  one-line fix and "do NOT edit schema/types to satisfy this"; node-drift warns. This is the
  highest-value single piece (it would have caught tonight's red-main-that-slipped-through).
- **Remaining (plumbing lane, to this spec):** worktrees self-sufficient via `npm ci` not symlink
  (Conductor-guaranteed); test-isolation (chat 8's `connection_limit` cap + schema-per-run if
  row-contention appears); one documented push ritual with `&&` not `;` + the risk-based rebase rule.
- **Root cause is a ways-of-working call for Matt:** 15 lanes on one tree + direct-to-main. The
  structure must not fix the symptoms so well the question never gets asked (worktree-isolation +
  merge-queue, or fewer concurrent lanes). Shared state (main's `node_modules`) needs an OWNER — it
  broke for hours because it belonged to no lane; repaired `npm ci` (589 entries, prisma 6.19.3).

## Door-rule worked example — win-back campaign
The canonical "reversible in code, irreversible in the merchant's inbox": flipping the parked
win-back campaign is a trivial flag flip, but the live Day-0 goodbye email already promised churned
merchants *"no emails after this one"* — and they are exactly the campaign's targets. Not fixable
with new copy; the promise is already sent. Ruling: honest single "why did you go?" + founder booking
for the already-churned cohort; full campaign for future churn only. One-way risk lives in
*consequence already incurred*, not in the diff.
