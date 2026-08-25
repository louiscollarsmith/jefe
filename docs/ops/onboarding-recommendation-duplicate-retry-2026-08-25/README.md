# Onboarding recommendation "duplicate run" — lineage and automatic-retry investigation

## Answer up front

```text
DID THE FOUNDER TRIGGER ONE RECOMMENDATION ATTEMPT OR MULTIPLE?
ONE. A single onboarding completion event ("goals ready") queued exactly one recommendation
attempt.

HOW MANY MerchantPlanRuns DID THE SYSTEM CREATE FROM THAT ONE ONBOARDING FLOW?
ONE — 2d8f34ab-3b2d-4041-be7c-443f3553202f. There is no duplicate-row bug: this is the only
MerchantPlanRun for this shop, attemptNumber 1, retryOfRunId null.

WHICH COMPONENT CREATED "ANOTHER RUN"?
No component created another MerchantPlanRun row. What the founder observed as "another attempt"
is the SAME row being silently re-processed 3 times by the generic backfill-job retry loop
(runClaimedBackfillJob in shopify-backfill-worker.server.js), which retries ANY job failure up to
job.maxAttempts (3) regardless of whether the error is the kind that could ever succeed on retry.

WAS AN AUTOMATIC RETRY INTENTIONAL?
Retrying in general is intentional (it exists for real transient infra failures). Retrying THIS
specific, deterministic failure — an LlmInputLimitError, "Estimated 83445 input tokens exceeds
80000" — was not: recommendation-llm-retry.server.js's own shared classifier
(isRetryableLlmInfrastructureError) already says this class of error must never be retried, and
the job-level retry loop simply didn't consult it.

CAN TWO RETRY/ENQUEUE MECHANISMS CURRENTLY BOTH REACT TO THE SAME FAILURE?
YES, but as two STACKED layers on the same call, not two racing enqueue paths. Layer 1
(recommendation-llm-retry.server.js, inside one job attempt) correctly refuses to retry this
error. Layer 2 (the generic backfill-job attempt/maxAttempts loop, wrapping the whole job) does
not know that, and retried the whole job — including a fresh call into layer 1, which correctly
refused again — two more times.

IS THE UI'S "TRY AGAIN" STATE APPEARING WHILE A RETRY IS ALREADY HAPPENING AUTOMATICALLY?
NO, not for this incident. MerchantPlanRun.status stays "running" across all 3 job-level attempts
(each attempt's start re-writes startedAt but not status), and fast-onboarding.server.js's
classifyFailure() only returns a failure/"Try again" state when latestPlanRun.status is
failed/insufficientData/modelDisabled/no_actionable_opportunity. The founder saw one long,
uninterrupted "still working" state for ~3 minutes, then "Try again" appeared once, after the
job's 3rd and final attempt. The perception of "it tried again on its own" is accurate — it did,
silently, at the job-retry layer — but the UI itself does not show two overlapping states.

PRIMARY ROOT CAUSE:
runClaimedBackfillJob's catch block decides whether to give up using only
`job.attemptCount + 1 >= job.maxAttempts` — it never inspects the error itself, so a permanently
non-retryable LLM failure for the agentic_recommendation_generate job type consumed all 3 attempts
(with 60s/120s backoff between them) before the run was ever marked failed.

FIX:
`app/services/shopify-backfill-worker.server.js` — new `isBackfillJobFailurePermanent(job, error)`,
scoped to `AGENTIC_RECOMMENDATION_JOB_TYPE`, consulting the same shared classifier
(`isRetryableLlmInfrastructureError`) the LLM-call retry layer already uses. A regression test
(`tests/backfill-job-permanent-failure-classification.test.mjs`) proves an input-limit error is now
permanent on attempt 1, a transient error for the same job type still gets the normal 3-attempt
budget, and other job types are unaffected.
```

## 1. Lineage table — every MerchantPlanRun for this shop, this onboarding session

| Run | Created by | Parent/retry-of | Trigger | Started | Final status | LLM calls (this run) | Why another run was created |
| --- | --- | --- | --- | --- | --- | ---: | --- |
| `2d8f34ab-3b2d-4041-be7c-443f3553202f` | `ensureAgenticRecommendationQueued` (called from `merchant-goals/service.server.js` on Goals completion) | none (`attemptNumber: 1`, `retryOfRunId: null`) | `merchant_goals_ready` (the `MerchantGoalRun` job `7ca70012-...` succeeded at 19:26:47.192 UTC and its own completion path called `ensureAgenticRecommendationQueued`) | 19:26:47.124 UTC (queued) | `failed` (`safe_error_code: agentic_recommendation_failed`) | 3 zero-token `error` events (below) | **No second run was created.** This is the only row. |

There is exactly one row because there was exactly one onboarding-completion trigger
(`merchant_goals_generate`'s success handler), and `ensureAgenticRecommendationQueued`'s own dedup
guard (an existing, non-terminal `backfillJob` for `agentic_recommendation_generate` blocks a
second enqueue — see `04-enqueue-dedup.md`) means nothing else could have created a second row even
if it had tried.

## 2. What actually repeated — the backfill job's own 3 attempts (all against the one run above)

| Attempt | `attempt_count` after claim | Started (worker claim) | `llm_usage_event` timestamp | Latency | Outcome | Gap since previous attempt |
| ---: | ---: | --- | --- | ---: | --- | --- |
| 1 | 1 | ~19:26:47.1 | 19:26:47.536 | 8ms | `error`, 0 tokens | — (first attempt, immediately after the run was queued) |
| 2 | 2 | ~19:27:51.9 | 19:27:51.974 | 17ms | `error`, 0 tokens | 64.4s — matches `retryAfter(attemptCount=1) = min(5,2)*60s = 120s` target minus jitter/processing, i.e. the schedule after attempt 1 |
| 3 | 3 | ~19:29:55.5 | 19:29:56.335 | 33ms | `error`, 0 tokens → `failedPermanently` (3 ≥ maxAttempts 3) | 125.0s — matches `retryAfter(attemptCount=2) = min(5,3)*60s`, capped/jittered |

`retryAfter(attemptCount)` (`shopify-backfill-worker.server.js`) = `min(5, attemptCount+1) * 60_000` ms — 60s after attempt 1, 120s after attempt 2. The observed 64s/125s gaps match this schedule almost exactly. **This confirms the 3-minute gap was the generic backfill-job backoff schedule, not three independent founder-visible "runs."**

All three `llm_usage_event` rows share `run_id = 2d8f34ab-3b2d-4041-be7c-443f3553202f` and
`run_type = MerchantPlanRun` — directly, in the database, ruling out a second run row.

## 3. Correlating the zero-token errors

Both errors the founder's screenshot showed (8ms at 19:26:47, 17ms at 19:27:51), plus a third
(33ms at 19:29:56, past the screenshot's capture time) are **the same `LlmInputLimitError` thrown
three times** — not three different failures. Full trace in `05-error-correlation.md`.

**These are true `LlmUsageEvent` rows for a local, pre-provider rejection.** `openai-compatible.
server.js`'s provider wrapper estimates input size before making an HTTP call and throws
`LlmProviderInputLimitError` (a subclass of `LlmInputLimitError`) if the estimate exceeds
`maxInputTokens` (80,000, per `generateAgenticShopifyRecommendation`'s call). No request ever
reaches OpenAI — that's why latency is single-digit-to-low-double-digit milliseconds and every
token count is 0. This is recorded as an `LlmUsageEvent` (feature: `agentic_recommendation`,
`status: error`) deliberately, for cost/health observability — not a bug in the logging itself; see
`05` for why the low latency proves this classification rather than merely suggesting it.

## 4. Answering the "who created it" question directly

`ensureAgenticRecommendationQueued` (`recommendation-service.server.js`) has 8 call sites across the
codebase (`fast-onboarding.server.js` ×2, `merchant-goals/service.server.js`, `merchant-plan/
service.server.js`, `home-proposal-generation.server.js`, `app._index.tsx` ×2, `learning-progress.
server.js`). For this incident, the one that fired was `merchant-goals/service.server.js`'s
post-success hook, triggered once, by the real completion of the `merchant_goals_generate` job at
19:26:47.192 UTC (source_mode `agentic`, reason `merchant_goals_ready` in the enqueued job's
payload — captured directly from the `backfill_jobs.payload_json` row). None of the other 7 call
sites fired during this window — confirmed by there being only one `backfillJob` row for
`agentic_recommendation_generate` for this shop and only one `MerchantPlanRun` row. Full call-site
audit in `03-caller-trace.md`.

## 5. Root cause and fix

`app/services/shopify-backfill-worker.server.js`'s `runClaimedBackfillJob` decided whether to give
up on a failed job using only `job.attemptCount + 1 >= job.maxAttempts` — a pure counter, blind to
*why* the job failed. `recommendation-llm-retry.server.js` (the LLM-call-level retry wrapper used
inside a single job attempt) already has exactly the right classifier for this
(`isRetryableLlmInfrastructureError`, which correctly refuses to retry `LlmInputLimitError`) — the
job-level loop simply never consulted it, so a failure that layer 1 correctly gave up on
immediately still cost the merchant two more full attempts and ~3 minutes of silent waiting at
layer 2.

**Fix**: `isBackfillJobFailurePermanent(job, error)`, scoped to `AGENTIC_RECOMMENDATION_JOB_TYPE`
only (this classifier is written for LLM-call errors specifically and must not be applied to other
job types' non-LLM failure modes, e.g. a Shopify permission error during a backfill sync, where the
existing generic 3-attempt budget is correct and unchanged). One-line call-site change; the
retry-classification logic itself is entirely reused, not reinvented.

**Regression test**: `tests/backfill-job-permanent-failure-classification.test.mjs` — 4 cases:
an input-limit error is permanent on attempt 1 (not attempt 3); a provider-specific input-limit
error is likewise immediate; a genuinely transient error (429, timeout) for the *same* job type
still gets the normal 3-attempt budget; the classifier has zero effect on a different job type
given the identical error. Full affected suite (backfill worker + onboarding + recommendation +
merchant-memory + merchant-goals/insights/plan + clearance/proposal-creation/gap-questions/
worker-heartbeat, 226 tests across 14 files) passes; one unrelated, pre-existing failure
(`fast-onboarding.test.mjs`, `prisma.merchantPlanRun.upsert is not a function` — a test-fixture mock
gap) was confirmed present on a clean checkout before any of this session's changes via `git
stash`, and is out of scope for this fix.

## Document set

- `02-run-identification.md` — the run and job rows, in full, with every column.
- `03-caller-trace.md` — every `ensureAgenticRecommendationQueued` call site, which one fired and
  why, and the enqueue-dedup guard that would have stopped a real second enqueue.
- `04-enqueue-dedup.md` — why "two retry/enqueue mechanisms both reacting" did *not* produce two
  rows, and exactly where the guard lives.
- `05-error-correlation.md` — the two (three) zero-token events, exact stack/call path, and proof
  they never reached OpenAI.
- `raw/` — the exact SQL and its output this investigation ran.
