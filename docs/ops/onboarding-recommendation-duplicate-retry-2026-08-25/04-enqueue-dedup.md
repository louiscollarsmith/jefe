# Why "two mechanisms reacting to the same failure" did not produce two rows

## The two stacked retry layers, precisely

**Layer 1 — `withRecommendationLlmRetry`** (`app/lib/shopify/agentic-runtime/recommendation-llm-retry.server.js`),
wraps one `provider.generateStructuredJson(...)` call inside a single job attempt. On catch, it
calls the shared classifier:

```js
if (!isRetryableLlmInfrastructureError(error)) throw error;
```

`isRetryableLlmInfrastructureError` (`app/lib/llm/errors.server.js:90`) explicitly returns `false`
for `LlmInputLimitError` — this layer correctly refuses to retry and immediately re-throws. No
backoff, no wait, confirmed by the 8ms/17ms/33ms latencies (a real retry-with-backoff at this layer
would show a multi-second gap **inside** one `llm_usage_event`, not across three separate events
minutes apart).

**Layer 2 — the generic backfill-job retry** (`runClaimedBackfillJob`'s catch block,
`app/services/shopify-backfill-worker.server.js`), wraps the *entire job handler* — including the
one `withRecommendationLlmRetry` call that layer 1 already gave up on. Before this fix, its only
question was `job.attemptCount + 1 >= job.maxAttempts`; it never asked *why* the job failed. This is
the layer that actually produced the 3 attempts and the 60s/120s gaps (`retryAfter()`).

**These are not two independent enqueue paths racing** — they are one job attempt, wrapped by two
retry loops with different scopes and different (in this case, contradictory) opinions about
whether to try again. Layer 1's correctness was silently undone by layer 2.

## Why this could not have produced a second `MerchantPlanRun` row

Even setting aside that only one thing actually triggered a recommendation this session
(`03-caller-trace.md`), two structural guards would have stopped a genuine second enqueue attempt
from creating a second row:

1. **`backfill_jobs_shop_id_job_type_key`** — a unique constraint on `(shop_id, job_type)`.
   `enqueueBackfillJob` upserts against it; a second enqueue call for the same job type updates the
   same row rather than inserting a new one.
2. **`ensureAgenticRecommendationQueued`'s active-job check** (when `!input.resetAttempts`):
   ```js
   if (!input.resetAttempts && ACTIVE_RUN_STATUSES.includes(run.status)) {
     const existingJob = await prisma.backfillJob.findUnique({ where: { shopId_jobType: {...} } });
     if (existingJob && !["succeeded","failed","cancelled"].includes(existingJob.status)) {
       return { status: "reused", run, snapshot: prepared.snapshot };
     }
   }
   ```
   A call made *without* `resetAttempts: true` while a job is genuinely still queued/running is
   short-circuited into a no-op "reused" response — no new job, no run mutation.

The gap flagged in `03` (call sites that pass `resetAttempts: true` unconditionally skip guard #2)
is real but did not fire twice in this incident, so it remains a flagged risk, not a demonstrated
cause.

## What "Try again" would have done if clicked during the automatic retries

`retryFastOnboarding`'s `merchant_plan` target (`fast-onboarding.server.js:518-531`) is gated on
`progress.recommendation?.state` already being `failed`/`missing`/`blocked`. During the ~3-minute
window where the job was silently retrying (attempts 1 and 2), `MerchantPlanRun.status` was still
`running` (never flipped to a terminal state between attempts — `runClaimedBackfillJob`'s
non-terminal-failure branch only touches `backfillJob.status`, not `merchantPlanRun.status`), so
`progress.recommendation?.state` would not yet read as failed/missing/blocked, and the "Try again"
button's own gate would not have let it fire even if the founder had clicked something during that
window. This matches `06`'s (README) direct answer: the UI's "Try again" affordance did not
coexist with the automatic retry — it only became available once the run genuinely reached its
terminal `failed` state.
