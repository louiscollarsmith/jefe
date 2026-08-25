# Persist and reuse the recommendation opportunity queue for 24h

Status: implemented, 2026-08-25. See `apps/shopify/CHANGELOG.md` (2026-08-25, "Changed") for the
merchant-facing summary and `apps/shopify/app/lib/shopify/agentic-runtime/opportunity-set.server.js`
for the implementation.

## 1. Current discovery/run architecture (before this change)

Recommendation generation runs through `runCandidateDrivenRecommendation`
(`candidate-pipeline.server.js`): one `discoverCandidates` LLM call (~70k tokens observed live)
produces a ranked `candidateQueue`, then each candidate is investigated in rank order via
`generateAgenticShopifyRecommendation({ focusCandidate })` until one recommends or the queue (plus
an optional rescue-discovery pass) is exhausted. This whole pipeline runs inside one
`MerchantPlanRun` row (`recommendation-service.server.js`).

The critical fact driving this task: `candidateQueue` and `discoveryLog` are **transient in-memory
arrays for the duration of one pipeline call**. They're flattened into
`MerchantPlanRun.result.diagnostics` (a JSON column) only once, at the very end of a run — there is
no partially-built, resumable state. `diagnostics`, `retryOfRunId`, `baseSnapshotHash`, etc. are not
Prisma columns; they're keys inside the `result` Json blob.

"Generate another proposal" (Home's button, onboarding's "show me something else", and the initial
post-goals kickoff) all call `ensureAgenticRecommendationQueued(prisma, { resetAttempts: true })`.
Before this change, `resetAttempts: true` always set `forceFreshRun: true` (when a previous run
existed), which always `prisma.merchantPlanRun.create`s a **brand-new run** and always reruns
`discoverCandidates` from zero — there was no queue-resume logic anywhere.

## 2. Opportunity-set persistence design

**Two new Prisma models** (`prisma/schema.prisma`), a dedicated child table rather than reusing
`MerchantPlanRun.diagnostics` JSON (the brief's "Option B"):

```
MerchantOpportunitySet        — one 24h discovery event (id, merchantId, shopId, createdAt,
                                 expiresAt, sourceRunId, sourceMode, discoveryLog, llmCallCount)
MerchantOpportunityCandidate  — one discovered candidate: immutable discovery fields (rank,
                                 candidateId, diagnosedProblem, businessEvidenceRefs,
                                 mechanismHypothesis, possibleIntervention, relevantFamilyId,
                                 confidence, rescue) + mutable consumption fields (status,
                                 finalDisposition, reason, investigatedByRunId, recommendationId,
                                 claimedAt, resolvedAt)
```

**Why a child table, not JSON-on-`MerchantPlanRun`:** `MerchantPlanRun` has a hard 1:1 unique
relation to `MerchantPlanRecommendation`, and its `result` JSON is written wholesale, once, at run
completion — every existing write to it is a full-object `update`. Part 8's concurrency
requirement ("exactly one request claims candidate #4") needs per-row atomic claiming; retrofitting
that onto one shared JSON blob would mean concurrent partial-JSON writes racing on a single row. A
real row per candidate instead reuses, unchanged, the atomic-claim idiom this codebase already uses
for `BackfillJob` (`shopify-backfill-worker.server.js`):

```js
const claimed = await prisma.merchantOpportunityCandidate.updateMany({
  where: { id: candidate.id, status: candidate.status },
  data: { status: "IN_PROGRESS", investigatedByRunId: runId, claimedAt: now },
});
if (claimed.count !== 1) /* someone else claimed it, or it moved on */
```

No new locking primitive, no advisory lock at this layer (an advisory lock already exists one layer
up — see §6.

## 3. Immutable discovery representation

`rank`, `candidateId`, `diagnosedProblem`, `businessEvidenceRefs`, `mechanismHypothesis`,
`possibleIntervention`, `relevantFamilyId`, `confidence`, `rescue` are written once, at
`persistFreshOpportunitySet` / row insert, and never updated afterward. This is enforced by
convention (no code path ever calls `.update()` on those fields), not a DB constraint — matching
this codebase's existing style (e.g. `MerchantPlanRun.snapshotHash` is likewise immutable by
convention).

Only `status`, `finalDisposition`, `reason`, `investigatedByRunId`, `recommendationId`, `claimedAt`,
`resolvedAt` mutate as a candidate is claimed and investigated.

## 4. Candidate consumption state

Per the brief's "keep it simple": `QUEUED | IN_PROGRESS | REJECTED | RECOMMENDED`
(`CANDIDATE_CONSUMPTION_STATUS` in `opportunity-set.server.js`). `IN_PROGRESS` was added (the
brief flagged it as "potentially" needed) because it's what makes worker-retry-safety and
concurrent-claim-safety possible — see §5.

The existing 13-value fine-grained disposition taxonomy (`candidate-disposition-taxonomy.server.js`,
e.g. `SCOPE_NOT_GRANTED`, `INPUT_MISSING`) is **not lost** — it's preserved in the `finalDisposition`
text column alongside the coarse `status`, so no diagnostic granularity regresses relative to
today's in-memory-only `candidateQueue`.

Every candidate persists: `rank` (discovery order), `candidateId`, `status`, `investigatedByRunId`
(which run investigated it), `finalDisposition`/`reason` (final disposition/reason), and
`recommendationId` (set if it produced one).

## 5. Retry semantics

Four distinct retry concepts, mapped to this codebase's actual call sites:

- **Provider retry** (`recommendation-llm-retry.server.js`, `withRecommendationLlmRetry`) — wraps
  individual `provider.generateStructuredJson` calls for transient infra errors (429s, timeouts).
  Same run, same in-memory state, **never touches the opportunity-set table at all**. Unchanged by
  this task.
- **Worker retry** — the same `MerchantPlanRun` job is re-dispatched after a crash/timeout
  (`loadPreparedAgenticRecommendationRun` when `run.status` is `queued`/`running`). In reuse mode,
  `claimNextCandidate` first checks whether *this exact `runId`* already has a candidate
  `IN_PROGRESS`; if so it resumes that same candidate rather than claiming a new one. This is the
  literal implementation of Part 7's "must not advance queue merely because infrastructure failed."
- **Explicit retry / "Generate another proposal"** — in this codebase these are **the same call
  site**: `ensureAgenticRecommendationQueued(prisma, { resetAttempts: true })` is invoked
  identically by Home's button, onboarding's "show me something else"
  (`requestOnboardingAlternative`), a plan-refinement retry (`merchant-plan/service.server.js`), and
  `app._index.tsx`'s `plan.retry` intent — there is no separate "retry this failed run" affordance
  distinct from "continue down the queue" in the current UI. Both semantics are satisfied by the
  same behavior: a fresh call always continues the existing 24h opportunity set (or starts a new
  one if none/expired) rather than restarting from candidate #1, which is the correct behavior for
  every one of these call sites today.
- **Abandoned-claim reclaim** (not explicitly named in the brief, added for correctness): a
  candidate `IN_PROGRESS` under a run that has since reached a terminal-non-completed status
  (`failed`, `insufficient_data`, `model_disabled`, `no_actionable_opportunity`,
  `opportunity_set_exhausted`) is treated as abandoned and is reclaimable by a later run —
  otherwise a single worker crash mid-investigation would permanently strand that candidate as
  perpetually "in progress." A run that *completes* (produces a recommendation) never leaves a
  candidate `IN_PROGRESS` — it resolves it to `RECOMMENDED` in the same step — so `completed` is
  deliberately excluded from the abandoned-status list.

## 6. Concurrency / locking

Two layers, one already existing and one new (the new one is what actually satisfies the brief's
literal "exactly one claims candidate #4" test at the persistence layer):

- **Existing, upstream**: `requestHomeProposalGeneration` already wraps the entire
  "check eligibility → queue" sequence in a Postgres advisory transaction lock
  (`pg_advisory_xact_lock`, keyed `merchantId:shopId:home_proposal_generation`), and
  `AGENTIC_RECOMMENDATION_JOB_TYPE` jobs are constrained by `BackfillJob`'s
  `@@unique([shopId, jobType])` — so two genuinely simultaneous Home button clicks for the same
  merchant already can't both create a run today. This is why true double-generation is rare in
  practice.
- **New, defense-in-depth** (`claimNextCandidate` in `opportunity-set.server.js`): an atomic
  `updateMany({ where: { id, status: expectedStatus } })` per candidate. Verified in
  `tests/opportunity-set.test.mjs` ("still-active owner" test): two claim calls for the same set
  never both succeed on the same row — the loser falls through to the next `QUEUED` candidate in
  rank order rather than independently investigating the one it lost, matching the brief's "the
  second request may... safely claim the next candidate" option.

## 7. Expiry semantics

Exact duration, not calendar day: `OPPORTUNITY_SET_TTL_MS = 24 * 60 * 60 * 1000`,
`expiresAt = createdAt + 24h`. `loadActiveOpportunitySet` filters `expiresAt: { gt: now } }` — tested
at the exact boundary (`tests/opportunity-set.test.mjs`, "not calendar-based": 23h59m reuses,
24h00m does not). No background refresh at expiry — expiry is only evaluated when a proposal is
actually requested, per the brief.

## 8. Onboarding integration

No onboarding-specific code changes were needed. `generateMerchantGoals`'s initial
`ensureAgenticRecommendationQueued({ resetAttempts: true })` call (the very first recommendation
generation for a new merchant) and `requestOnboardingAlternative`'s identical call both route
through the same updated function and inherit reuse/exhaustion semantics automatically — this
single choke point is what makes the Part 11 acceptance scenario work without touching onboarding
code at all.

## 9. Home / "Generate another proposal" integration

`requestHomeProposalGeneration` (`home-proposal-generation.server.js`) is unchanged except for one
addition: `"opportunity_set_exhausted"` was added to `TERMINAL_NON_PROPOSAL_STATUSES`, so
`getHomeProposalGenerationState`'s existing `terminalStatus` surfacing picks it up automatically —
no new UI copy, per the brief's explicit instruction not to redesign UI in this task. The
`ok:false, reason:"opportunity_set_exhausted"` response also falls out for free from the existing
generic `reason: status === "queued" ? null : status === "reused" ? "nothing_new" : status`
fallback in `requestHomeProposalGeneration`.

## 10. Observability

Every run persists into `MerchantPlanRun.result` (alongside the existing `retryOfRunId`,
`baseSnapshotHash`, etc.): `opportunitySetId`, `opportunitySetCreatedAt`, `opportunitySetExpiresAt`,
`discoveryReused`, `startingCandidateRank`, `endingCandidateRank`. `result.diagnostics.opportunitySet`
carries the full candidate list (rank, candidateId, diagnosedProblem, status, finalDisposition,
reason, investigatedByRunId, recommendationId) for **every** outcome — recommended, no-action, or
exhausted — via `loadOpportunitySetSummary`, so "why did this proposal start at candidate #4?" is
answerable directly from a run's persisted `result` without reading code. When discovery is reused,
`PROGRESS_STATE.discoveryReused` (`"DISCOVERY_REUSED"`) is pushed to `progressLog` instead of
`DISCOVERING_CANDIDATES`, so a trace can never be misread as a second discovery having happened.

## 11. Tests

- `tests/opportunity-set.test.mjs` (12 tests) — unit coverage of the persistence module itself:
  fresh/reuse/expiry/not-calendar-based boundary, the Part 11 resume scenario (1/2 rejected, 3
  recommended → next claim is rank 4), exhaustion, worker-retry resume, abandoned-claim reclaim,
  still-active-owner non-reclaim (concurrency), observability summary, and recommendation
  attachment.
- `tests/candidate-pipeline.test.mjs` (+3 tests, 15 total, all pre-existing tests still pass
  unchanged) — integration coverage through `runCandidateDrivenRecommendation` itself: discover
  mode persists a correctly-ranked opportunity set (including untouched `QUEUED` tail candidates);
  reuse mode skips discovery entirely (asserted via a provider that throws if discovery is called)
  and resumes from the correct rank; an exhausted set returns `OPPORTUNITY_SET_EXHAUSTED` without
  ever calling the LLM.
- `tests/ensure-agentic-recommendation-opportunity-set.test.mjs` (2 tests) — the service-layer
  short-circuit: an exhausted, unexpired set never reaches `prepareAgenticRecommendationRun` (no
  run, no job created); a not-yet-exhausted set proceeds normally.
- Full regression pass across every test file that imports `recommendation-service.server.js`,
  `candidate-pipeline.server.js`, or `home-proposal-generation.server.js` (14 files, ~150 tests):
  all pass unchanged. One pre-existing, unrelated failure
  (`tests/fast-onboarding.test.mjs`, "retrying a failed agentic recommendation...") was confirmed
  present on `origin/main` before this change (`git stash` + re-run) — not a regression, not
  touched by this task.

## 12. Real validation (Part 11 acceptance scenario)

Reproduced directly in `tests/opportunity-set.test.mjs` using the exact 7-candidate onboarding
fixture from the task brief:

```
1 activate remaining draft products      → REJECTED
2 restore repeat purchase path           → REJECTED
3 increase multi-product baskets         → RECOMMENDED
4 capture margin inputs                  → QUEUED
5 address high-return products           → QUEUED
6 reconcile stale inventory              → QUEUED
7 revive declining range                 → QUEUED
```

`claimNextCandidate` on a second run against this set returns rank 4 (`cand-4`), with
`prisma._candidateCount()` asserted to remain exactly 7 — proving no rediscovery occurred. The same
scenario is exercised end-to-end (real `runCandidateDrivenRecommendation` call, scripted LLM
provider, real reuse-mode claim/resolve/persist path, not just the persistence-layer unit test) in
`tests/candidate-pipeline.test.mjs`'s "reuse mode" test, which additionally asserts
`provider.calls.filter(p => p.mode === "candidate_discovery").length === 0`.

## 13. Token savings

Analytical, based on the task brief's own cited real numbers (no live LLM credentials in this
environment to re-measure against a production merchant):

| | Before | After |
|---|---|---|
| Proposal #1 (fresh) | ~70k discovery + investigations #1–#3 | ~70k discovery + investigations #1–#3 (unchanged — first request always discovers) |
| Proposal #2 (within 24h) | ~70k discovery again + investigations | **0 discovery tokens** + investigation starting at #4 |
| Proposal #3, #4... (within 24h) | ~70k discovery each time | **0 discovery tokens** each time |

For a merchant who clicks "Generate another proposal" N times within a 24h window, discovery cost
drops from `N × ~70k` tokens to a single `~70k` (or `~70k + rescue-pass tokens` if rescue discovery
ran) regardless of N. The investigation cost per candidate (the per-candidate
`generateAgenticShopifyRecommendation` call, unrelated to discovery) is unchanged — this task
deliberately does not touch investigation cost or candidate discovery/ranking itself.

## 14. Known limitations

- **A worker crash during fresh discovery still loses that in-flight discovery** — the
  `candidateQueue` for a "discover" mode run is only persisted once, at the very end (success or
  `NO_ACTIONABLE_OPPORTUNITY`), matching today's existing all-in-memory behavior for that phase.
  This is unchanged from before this task, not a new regression — a crashed fresh-discovery run
  already required a fresh generate request before this change too.
- **Persistence failures are swallowed, by design** (`maybePersistFreshOpportunitySet` catches and
  logs): if writing the opportunity set fails, the recommendation is still delivered; the only
  consequence is that the next "Generate another proposal" re-discovers instead of resuming — a
  safe degradation, not a correctness bug, consistent with the "no dead ends" product invariant.
- **`resetAttempts: false` callers are untouched** (e.g. `learning-progress.server.js`'s passive
  onboarding-stage progression) — they keep their existing snapshotHash-dedup behavior and never
  create or check an opportunity set. This is intentional: those callers were never the source of
  repeated-discovery cost this task addresses.
- **No cross-set carryover**: a candidate rejected in a now-expired set is not "remembered" by the
  next set's fresh discovery — the brief's explicit non-goals list rules out both snapshot/webhook
  invalidation and Action-history duplicate detection, which is where that concern would belong
  (a separate, later task per the brief).
- **Rescue discovery is unchanged and only ever runs during a "discover" mode pass** — it is not a
  second per-24h discovery event; it's part of the single discovery event that produces the
  persisted set (first-pass candidates followed by rescue candidates, if the first pass exhausts
  without a recommendation), matching the "discover the opportunity landscape once" framing.
