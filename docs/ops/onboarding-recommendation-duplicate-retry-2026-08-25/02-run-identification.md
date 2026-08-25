# Run and job identification, full columns

## `merchant_plan_runs` — the only row for this shop

| Field | Value |
| --- | --- |
| `id` | `2d8f34ab-3b2d-4041-be7c-443f3553202f` |
| `merchant_id` / `shop_id` | (jefe-local-store.myshopify.com's current merchant/shop) |
| `status` | `failed` |
| `source_mode` | `agentic` |
| `created_at` (queued) | 2026-08-25 19:26:47.124 UTC |
| `started_at` | 2026-08-25 19:29:56.255 UTC — the *last* job attempt's start (overwritten on each attempt by `runAgenticRecommendationInvestigation`'s initial `status: running, startedAt: new Date()` update; not the first attempt's start) |
| `failed_at` | 2026-08-25 19:29:56.367 UTC |
| `safe_error_code` | `agentic_recommendation_failed` |
| `last_error` | `Estimated 83445 input tokens exceeds 80000.` |
| `snapshot_hash` | `b6a75d27c4bb7fda5633cd69b198cf9325998d3c2e05ea0460383236937c6ea3` |
| `result_json` | `{"reason": "failed", "runtime": "agentic_shopify"}` (sparse — set by `markAgenticRecommendationJobFailed`, not by the normal candidate-pipeline completion path, confirming the failure happened before any candidate discovery/investigation began) |

No second `merchant_plan_runs` row exists for this shop, at any status, at any time — checked
unfiltered by status/time window.

## `backfill_jobs` — the `agentic_recommendation_generate` row

| Field | Value |
| --- | --- |
| `id` | `fff8b5b5-0eb9-4fdb-8f11-467cf531e373` |
| `job_type` | `agentic_recommendation_generate` |
| `status` | `failed` |
| `attempt_count` | 3 |
| `max_attempts` | 3 |
| `created_at` | 2026-08-25 19:26:47.182 UTC |
| `started_at` | 2026-08-25 19:29:55.547 UTC (last attempt's claim) |
| `failed_at` | 2026-08-25 19:29:56.453 UTC |
| `last_error` | `Estimated 83445 input tokens exceeds 80000.` |
| `payload_json.runId` | `2d8f34ab-3b2d-4041-be7c-443f3553202f` — **same run id on every attempt** |
| `payload_json.attemptNumber` | `1` |
| `payload_json.retryOfRunId` | `null` |
| `payload_json.reason` | `merchant_goals_ready` |
| `payload_json.onboardingEpoch` | `7c380d4e-26ea-4319-822c-e175fd5c1066` |

The unique constraint `backfill_jobs_shop_id_job_type_key` on `(shop_id, job_type)` means there can
only ever be one row for this job type per shop — `enqueueBackfillJob` upserts against it. This is
itself part of why a real "duplicate enqueue" could not have produced a second visible job row even
if one had been attempted; see `04`.

## `llm_usage_event` rows for this merchant, full onboarding window (19:26:02–19:27:52 UTC)

All rows, in order, with `run_id`/`run_type` where populated:

```text
19:26:02.068  gemini-embedding-2   episodic_embedding      ok          366ms
19:26:02.199  gpt-5.6-luna         store_understanding      timed_out  20275ms   <- the ~20s timeout from the companion diagnostic; unrelated subsystem (Insights), not this run
19:26:22.932  gemini-embedding-2   episodic_embedding      ok          351ms
19:26:23.493  gemini-embedding-2   episodic_embedding      ok          320ms
19:26:23.814  gemini-embedding-2   episodic_embedding      ok          283ms
19:26:23.881  gpt-5.6-luna         insights (a53895b5-…)    ok         8081ms
19:26:27.947  gemini-embedding-2   episodic_embedding      ok          396ms
19:26:28.071  gpt-5.6-luna         store_understanding      ok         8181ms   <- the timed-out call's successful retry
19:26:31.972  gpt-5.6-luna         insights (a53895b5-…)    ok         7999ms
19:26:36.936  gemini-embedding-2   episodic_embedding      ok          300ms
19:26:40.461  gemini-embedding-2   episodic_embedding      ok          320ms
19:26:40.963  gemini-embedding-2   episodic_embedding      ok          263ms
19:26:41.108  gpt-5.6-luna         goals (cac8e133-…)       ok         5438ms
19:26:47.536  gpt-5.6-luna         agentic_recommendation (2d8f34ab-…)  error   8ms   <- job attempt 1
19:27:51.974  gpt-5.6-luna         agentic_recommendation (2d8f34ab-…)  error  17ms   <- job attempt 2
19:29:56.335  gpt-5.6-luna         agentic_recommendation (2d8f34ab-…)  error  33ms   <- job attempt 3
```

The `store_understanding` timeout (19:26:02, 20275ms) belongs to a completely different subsystem
(Insights generation's store-understanding step) and a completely different, unrelated job
(`merchant_insights_generate`, `f5a6e0d9-…`, which itself `succeeded` — the timeout's automatic
retry, via that job's own internal LLM retry, worked correctly at 19:26:28). It is not part of the
recommendation-run lineage and is not evidence of a second recommendation attempt.
