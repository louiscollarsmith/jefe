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
| Channels UI | Out of onboarding permanently → Settings panel, Slack-first (inbound-email lane) |
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
