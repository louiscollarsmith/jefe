# Every `ensureAgenticRecommendationQueued` call site, and which one fired

`ensureAgenticRecommendationQueued` (`app/lib/shopify/agentic-runtime/recommendation-service.server.js:88`)
is the single function that creates-or-reuses a `MerchantPlanRun` row and enqueues the
`agentic_recommendation_generate` backfill job. Every code path that wants a recommendation goes
through it — there is no other function that creates this job type or this run type.

| Call site | Trigger | `resetAttempts` | Fired for this incident? |
| --- | --- | --- | --- |
| `merchant-goals/service.server.js:384` | Automatic, on `MerchantGoalRun` success (onboarding pipeline continuation: goals → plan) | `true` (unconditional) | **YES — this is the one.** |
| `fast-onboarding.server.js:284` (`requestOnboardingAlternative`) | Merchant clicks "show a different recommendation" | `true` | No |
| `fast-onboarding.server.js:527` (`retryFastOnboarding`, `target: "merchant_plan"`) | Merchant clicks "Try again" — gated on `progress.recommendation?.state` already being `failed`/`missing`/`blocked` | `true` | No |
| `merchant-plan/service.server.js:730` | (Legacy/plan-service path) | — | No |
| `home-proposal-generation.server.js:285` | Home screen's own proposal-generation trigger | — | No |
| `app._index.tsx:1319`, `:1345` | App home route action(s) | — | No |
| `learning-progress.server.js:109` | Learning-progress polling helper | — | No |

Confirmed which one fired directly from data: the enqueued job's own payload records
`"reason": "merchant_goals_ready"` (`04-enqueue-dedup.md`/`02`), which is the literal string
`ensureAgenticRecommendationQueued` writes into the payload only when it found a `previousRun`
(none here) vs. not — actually written unconditionally as `previousRun ? "merchant_plan_retry" :
"merchant_goals_ready"`. Since no prior run existed (`retryOfRunId: null`), the reason resolves to
`"merchant_goals_ready"` regardless of *which* call site invoked it with `resetAttempts: true` and
no prior terminal run — but combined with the timing (queued at 19:26:47.124, 68ms after the
`merchant_goals_generate` job's own `completed_at` of 19:26:47.192... actually queued *before* that
timestamp by 68ms, consistent with the job's success handler enqueuing the recommendation just
before its own `backfillJob.updateMany` marks itself `succeeded`) and the absence of any founder
action logged in this window, `merchant-goals/service.server.js:384` is the only call site whose
trigger condition (a `MerchantGoalRun` completing) actually occurred.

## A secondary observation, flagged but not proven causal for this incident

`merchant-goals/service.server.js`'s call passes `resetAttempts: true` **unconditionally** — not
gated on any merchant action, unlike the two `fast-onboarding.server.js` call sites (one is
merchant-initiated by definition; the other is gated on the recommendation already being in a
known-bad state). Per `ensureAgenticRecommendationQueued`'s own logic
(`recommendation-service.server.js:118-137`), the check that refuses to enqueue a second job while
one is already active (`ACTIVE_RUN_STATUSES.includes(run.status)` + an existing non-terminal
`backfillJob`) is only reached **when `!input.resetAttempts`** — passing `resetAttempts: true`
skips that guard entirely.

This did not cause a problem in this incident (the goals job only completed once, so this call site
only fired once). But it means: if `merchant_goals_generate` were ever to complete twice for the
same merchant in quick succession (e.g. a goals-regeneration path this investigation did not
trace), its unconditional `resetAttempts: true` would bypass the active-job dedup check both times,
and — depending on `prepareAgenticRecommendationRun`'s own upsert-by-snapshot-hash keying, not
audited in this pass — could plausibly enqueue a second, genuinely independent job/run pair. Flagged
here as a real, structural gap worth its own targeted look; not fixed in this pass because it is
not what caused the incident under investigation, and this task's fix policy is to fix only the
narrow, conclusively-proven bug.
