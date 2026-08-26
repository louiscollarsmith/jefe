# Remove bootstrap; gate the first recommendation on full backfill + full Memory refresh

Status: implemented 2026-08-26. Real dev-store validation (§10) pending — see Known Limitations.

## 1. Previous dual-path lifecycle

```
Install
├─ merchant_memory_bootstrap   (fast, ≤50 orders/90d, no email field → 0 customer linkage,
│                                restricted "bootstrap-safe" belief subset)
└─ shop_backfill_start         (full backfill: all orders in the real history window, full
                                 belief set, real customer linkage)
```

Both were enqueued **in parallel** at install (`queueInstallShopifyBackfill`). Bootstrap finished
first only because it did far less work. Root cause of the evidence discrepancy that triggered
this task: **two independent triggers existed for the same full-Memory-refresh chain**:

1. `handleFinalize()` — fired correctly, only once full backfill's products/orders/customers/
   inventory were all genuinely `complete`.
2. `learning-progress.server.js`'s `queueStoreUnderstanding()` — fired as soon as the bootstrap
   job succeeded and the merchant answered the onboarding priority question, which could be
   *minutes* before full backfill finished.

Both enqueued the same `MEMORY_REFRESH_JOB_TYPE` job (`@@unique([shopId, jobType])`); whichever
fired first won, and its completion unconditionally cascaded through
`ensureMerchantInsightsQueued` → `ensureMerchantGoalsQueued` → `ensureAgenticRecommendationQueued`
— already-idempotent, already-correct chaining that just needed to never fire on bootstrap-only
data. This is why one real run saw "50 orders / 0 linked customers" (bootstrap-only) and another
saw "254 known customers / 51 repeat" (post-full-backfill) for the same merchant.

## 2. Removed bootstrap components

**Deleted entirely:**
- `app/lib/onboarding/bootstrap.server.js` (864 lines — order/catalog fetch, evidence-contract
  eligibility, belief refresh at bootstrap-safe scope, retired generation stubs)
- `app/lib/onboarding/bootstrap-schema.server.js`, `bootstrap-prompt.server.js` (already-orphaned)
- `app/lib/onboarding/reconciliation.server.js` (`reconcileBootstrapRecommendationsAfterFullRefresh`
  — zero production callers, confirmed dead before this task)
- `app/lib/onboarding/recommendation-review.server.js` (`reviewDueRecommendations` — its only
  dispatch case already threw `"Legacy recommendation_review is retired..."`, confirmed dead
  before this task)
- Bootstrap-only Shopify queries in `queries.server.js` (`BOOTSTRAP_RECENT_ORDERS_QUERY` and 4
  siblings)
- The dedicated bootstrap worker lane in `shopify-backfill-worker.server.js` (`bootstrapPrisma`,
  `bootstrapTick`, its own polling interval), the `MERCHANT_BOOTSTRAP_JOB_TYPE`/
  `BOOTSTRAP_ALTERNATIVE_JOB_TYPE` dispatch cases, `markBootstrapFailed`/`safeBootstrapFailureCode`
- `MERCHANT_BOOTSTRAP_JOB_TYPE`, `BOOTSTRAP_ALTERNATIVE_JOB_TYPE`, `BOOTSTRAP_BACKFILL_DOMAIN`,
  `ensureMerchantBootstrapQueued`, `ensureBootstrapAlternativeQueued` (`shopify-backfill-status.server.js`)
- `BOOTSTRAP_SAFE_BELIEF_KEYS` (`merchant-memory/constants.server.js`) and the advisory-lock
  publication path it gated in `merchant-memory/service.server.js` (`isBootstrapSafeBelief`,
  `withBootstrapBeliefPublicationLock`) — its own purpose was "bootstrap's lane and the full lane
  might race to publish the same belief"; with one writer lane left, that race is impossible
- `getBootstrapJobHealth` (`deployment-health.server.js`, `health.tsx`, `ready.tsx`)
- The `derivationSourceMode === "bootstrap"` downgrade-guard branch in
  `merchant-memory/service.server.js` (dead: nothing ever sets that source mode again)

**Retained as documented legacy** (Part 12 — no runtime effect for new data, still correctly
handle historical rows):
- `MerchantMemoryBelief.derivationSourceMode` column and `MerchantPlanRecommendation.sourceMode`
  values of `"bootstrap"` — plain `String` columns, no migration needed; new writes are always
  `"full"`/`"agentic"`/`"home"`.
- `SOURCE_MODE_RANK`'s `bootstrap: 1` entry (`proposal-creation-invariant.server.js`) — keeps
  pre-existing bootstrap-sourced proposed actions losing correctly against a full/home duplicate.
- `ensureRecommendationReviewQueued`'s scheduling logic (unrelated to bootstrap; a separate,
  already-broken `recommendation_review` job-type retirement predates this task and is out of scope).

**Deliberately deferred, not removed** (documented tradeoff, see Known Limitations): the
`evidenceScope`-conditional data-scoping branches inside `merchant-memory/shopify-derivations.server.js`'s
`loadDerivationContext`/`bootstrapScopedOutcome`/`bootstrapConfidenceCap`/`bootstrapEvidenceCaveat`.
Confirmed dead (no surviving caller ever sets `evidenceScope`), but deeply woven through ~200
lines of the core, highest-traffic belief-derivation function used by every merchant's Memory
refresh. The blast radius of a mistake there (silently corrupting production Memory for every
merchant) vastly outweighs the benefit of deleting inert code, so it was left in place rather than
risked for a code-cleanliness win with zero functional upside.

## 3. New single onboarding lifecycle

```
OAuth / install completes
        ↓
queue full Shopify backfill only (queueInstallShopifyBackfill)
        ↓
products / orders / customers / inventory all complete + backfill_finalize succeeded
        ↓
handleFinalize() → enqueueMerchantMemoryRefresh (unchanged, already correct)
        ↓
full, unrestricted Merchant Memory refresh
        ↓
handleMerchantMemoryRebuild → ensureMerchantInsightsQueued (unchanged, already correct)
        ↓
ensureMerchantGoalsQueued → ensureAgenticRecommendationQueued (unchanged, already correct)
        ↓
first recommendation — creates the first 24h opportunity set (see Part 7 below)
```

No bootstrap job anywhere in this sequence.

## 4. Full-backfill readiness — one source of truth

`isFullBackfillComplete(statuses, jobs)`, new export in `shopify-backfill-status.server.js`:
every `INITIAL_COMMERCE_BACKFILL_DOMAINS` status `complete` AND a `backfill_finalize` job
`succeeded` — the exact definition `fast-onboarding.server.js`'s `shapeFullLearning` (UI copy) and
`learning-progress.server.js`'s new `fullBackfill` pipeline stage both now read, so the two
surfaces can never disagree about whether backfill is done.

Bootstrap completion, first-50-orders presence, partial product data, and onboarding UI step
completion (`Shop.onboardingCompletedAt`) no longer matter to recommendation eligibility — they
never gated `handleMerchantMemoryRebuild`'s automatic chain anyway; the only thing that was
gating incorrectly was `learning-progress.server.js`'s own `bootstrap` stage, now replaced.

## 5. Memory-refresh sequencing

Unchanged, because it was already correct: `handleFinalize` only calls
`enqueueMerchantMemoryRefresh` when `requiredComplete` is true; `handleMerchantMemoryRebuild` only
calls `ensureMerchantInsightsQueued` after `rebuildMerchantMemory` (the actual refresh) resolves.
The bug was never in this sequencing — it was that a *second*, premature caller
(`learning-progress.server.js`'s `queueStoreUnderstanding`) could also reach the same
`enqueueMerchantMemoryRefresh` call before backfill was done. `queueStoreUnderstanding` is now
only reachable once `resolveNextStage` has already confirmed `fullBackfill.state === "ready"`, so
it degrades to a safe, idempotent fallback re-trigger rather than the primary trigger.

## 6. Recommendation trigger

No new trigger was built. `handleMerchantMemoryRebuild` → `ensureMerchantInsightsQueued` →
`generateMerchantInsights` → `ensureMerchantGoalsQueued` → `generateMerchantGoals` →
`ensureAgenticRecommendationQueued` already existed, already fires unconditionally on any full
(`categories: []`) Memory rebuild, and each `ensure*Queued` is already idempotent (keyed on a
belief-snapshot hash, `@@unique([shopId, jobType])` on the underlying `BackfillJob`). The
one-recommendation-per-onboarding invariant, retry safety, and duplicate-finalization protection
required by Part 6/7 fall out of that existing idempotency for free — removing the premature
trigger was the entire fix.

## 7. 24h opportunity-set integration

No code changes needed. Bootstrap never independently produced a recommendation or opportunity
set — `generateBootstrapAlternative` was already a retired stub returning
`"retired_agentic_recommendation_only"`. The only way bootstrap could taint the opportunity-set
feature was via the premature-trigger race producing a first recommendation off thin data; once
discovery only ever runs after genuine full-backfill + full-Memory-refresh completion (§3), the
first opportunity set this merchant ever gets is created from real data, exactly as designed.

## 8. Deleted / retained legacy code

See §2 above for the full inventory. Prisma-level: no migration was needed anywhere in this task
— `BackfillJob.jobType` and `ShopBackfillStatus.domain` are plain `String` columns, so
`"merchant_memory_bootstrap"` / `"merchant_bootstrap_alternative"` / `"bootstrap"` are just string
values the application will simply stop writing.

## 9. Tests

- `tests/onboarding-learning-progress.test.mjs` — `bootstrap` stage fixtures replaced with
  `fullBackfill`; **added** the load-bearing regression test:
  *"context answered but full backfill not yet complete: pipeline stays gated, no memory refresh
  queued"* — proves, against a real database, that answering the onboarding priority question
  before full backfill completes queues nothing, and that completing full backfill afterward
  correctly unblocks the chain. This is the test that would have caught the original bug.
- `tests/fast-onboarding.test.mjs` — trimmed from 44 to 15 tests. Deleted: all
  `buildEvidenceContracts`/`parseBootstrapOutput`/bootstrap-fetch-pagination/bootstrap-worker-lane/
  `resolveBootstrapGenerationPhase`/`reconcileBootstrapIfFullMemoryReady`/advisory-lock-race tests
  (all asserted on now-deleted code or a now-impossible race). Kept and verified passing: generic
  UI-copy assertions, intent routing, `trackOnce`, recommendation-review *scheduling* (a different,
  still-live function unrelated to the deleted `reviewDueRecommendations`), recommendation
  rendering (agentic + legacy + first-run), full-backfill-failure retry targeting, priority-echo
  shaping, reinstall-epoch milestone dedup (repointed to `fullBackfillEpoch`), execution-status
  rendering, the agentic onboarding CTA flow, and tracked-recommendation workflow unlocking.
- `tests/deployment-health.test.mjs`, `tests/llm-provider-fallback.test.mjs`,
  `tests/shopify-ingestion.test.mjs`, `tests/onboarding-flow.test.mjs`,
  `tests/proposal-creation-invariant.test.mjs` — bootstrap-specific assertions removed/retargeted;
  `shopify-ingestion.test.mjs` gained an explicit "install queues full backfill, never bootstrap"
  assertion.
- `classifyFailure` (`fast-onboarding.server.js`) signature simplified from
  `(bootstrapStatus, bootstrapJob, experience)` to `(fullLearning, experience)` — the removed
  bootstrap-phase heuristic branches (`generation_failed`/`insufficient_evidence`/`awaiting_context`/
  `model_disabled` as raw ingestion-phase strings) are redundant with the already-present
  `latestPlanRun`/`learningPipelinePending` checks, which are the real, current signals.

Full regression pass: every test file that imports any file touched by this task (13 files) run
individually and confirmed passing (except one pre-existing, unrelated failure — see Known
Limitations). `npm run typecheck`: zero new errors versus baseline (diffed with line numbers
stripped — remaining differences are pre-existing errors at shifted line numbers only).

## 10. Real dev-store timeline

**Pending** — see Known Limitations. Part 15 asks to reset and re-onboard
`jefe-local-store.myshopify.com` against the shared local `jefe_dev` Postgres database. Before
doing that, this session re-checked for other active consumers of that database (as it already
had to once earlier this session) and found the `houston` Conductor workspace's `shopify app dev`
live again against the same database. Resetting shared onboarding state while another workspace
may be actively using it is exactly the kind of shared-blast-radius action this repo's own
history flags as a real, previously-hit failure mode (two `shopify app dev` processes racing to
claim the same jobs) — so this step was paused for a founder decision rather than silently
proceeding or unilaterally stopping another workspace's process a second time.

## 11. Resulting Merchant Memory evidence

Not yet captured (depends on §10). Expected, per the design in §1-6: once full backfill
completes and the automatic full Memory refresh runs, `customers.known_customer_count`/
`customers.repeat_customer_rate.all_time`/`customers.cohort_mix.all_stored_history` should reflect
this dev store's actual customer history (previously observed as 254 known customers / 51 repeat
/ 203 one-time on this same store), not a 50-order/0-linked bootstrap snapshot — because no
bootstrap snapshot can exist anymore.

## 12. Known limitations

- **`evidenceScope` dead code left in `shopify-derivations.server.js`** (§2) — a deliberate,
  documented risk/benefit tradeoff, not an oversight. Follow-up: remove it in its own small,
  carefully-reviewed change, isolated from any other work, given the blast radius of that file.
- **UI checklist granularity is coarser than before.** `ConnectScene`'s 4-row "reading your store"
  checklist previously stepped through bootstrap's fine-grained phase vocabulary
  (`checking_current_products` → `evidence_ready` → `choosing_first_move` → `ready`). Full
  backfill only exposes `learning`/`complete`/`failed`/`access_failure`, so the checklist now only
  distinguishes "still reading" from "done" — an intentional, disclosed loss of granularity per
  the brief's "do not redesign onboarding" instruction, not a regression to fix here.
- **One pre-existing, unrelated test failure**: `tests/fast-onboarding.test.mjs`'s "retrying a
  failed agentic recommendation creates a fresh run and requeues the worker with provenance" was
  already failing on `origin/main` before this task (confirmed via `git stash` + rerun, error:
  `prisma.merchantPlanRun.upsert is not a function`). It still fails today, now for an earlier
  reason in the same already-broken mock (`shopBackfillStatus.findMany` not mocked) — not a new
  regression, out of scope for this task.
- **A separate, already-broken `recommendation_review` job-type retirement** (`RECOMMENDATION_REVIEW_JOB_TYPE`
  dispatch throws `"Legacy recommendation_review is retired..."` unconditionally) predates this
  task and is unrelated to bootstrap; `ensureRecommendationReviewQueued` still enqueues jobs for
  it from `fast-onboarding.server.js`'s track-only approval path, which will always fail when
  picked up. Noticed during this task, not fixed — out of scope.
