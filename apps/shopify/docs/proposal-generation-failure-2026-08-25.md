# Investigation — Proposal Generation Failure, `jefe-local-store.myshopify.com`, 2026-08-25

Diagnostic only. No recommendation behaviour, prompts, scopes, retry policy, validation, or UI
copy were changed while producing this report. Two throwaway read-only investigation scripts
were used to query Prisma/DB state and to invoke the *unmodified* production functions
(`requestHomeProposalGeneration`, `processNextBackfillJob`) for the reproduction step; both were
deleted after use and are not part of this diff.

## 1. Executive conclusion

Clicking "Generate another proposal" produced "Jefe couldn't generate a proposal. Try again."
because the underlying `MerchantPlanRun` genuinely failed — this is not a UI mis-mapping of a
success, and not a disguised "no opportunity found" result. The proposal-generation pipeline
called OpenAI (`gpt-5.6-luna`) to run the first stage of candidate discovery, got back an HTTP
429 (`providerCode: rate_limit`) six times in a row over roughly four minutes — the full budget
of the in-place LLM retry layer (`withRecommendationLlmRetry`, max 6 attempts / 5 minutes
cumulative backoff) — and then gave up. The exception propagated out of
`runAgenticRecommendationInvestigation`, was caught by `markAgenticRecommendationJobFailed`, and
the run was marked `status=failed` with `lastError: "openai request failed with HTTP 429."`. The
merchant's home screen then read that terminal state and rendered the generic failure copy.

This is a genuine OpenAI rate-limit exhaustion, not a symptom of the 810-operation catalog, not a
context/token overflow, not a Shopify scope problem, and not process/version skew. It was
reproduced live during this investigation, ~16 minutes later, with an identical error, meaning
the rate-limit condition was sustained, not a one-off blip. A secondary, real bug was found and is
documented in §5/§9/§10: the worker's automatic job-level retry (distinct from the in-place LLM
retry) can silently create a *new* `MerchantPlanRun` under `sourceMode: "agentic"` instead of
reusing the original `sourceMode: "home"` run, orphaning that retry from the home screen's
polling/eligibility logic entirely. That did not cause this failure, but it does mean the
merchant-visible "failed, try again" state can understate what's actually still happening
server-side, and it left a permanently stuck `running` run in the database.

## 2. Exact failed run

```text
MerchantPlanRun.id     3033f48a-18c3-476b-97c0-35c6f0caa5e4
merchantId              1c435ded-0fa5-4216-959f-93488575bab7
shopId                  c02236e8-1f98-4203-90d4-d17ac876d52d  (jefe-local-store.myshopify.com)
sourceMode              home
status                  failed
createdAt               2026-08-25T08:04:26.180Z
startedAt               2026-08-25T08:04:30.358Z
completedAt              null
failedAt                2026-08-25T08:08:30.491Z
provider / model         openai / gpt-5.6-luna
safeErrorCode            agentic_recommendation_failed
lastError                "openai request failed with HTTP 429."
result                   { runtime: "agentic_shopify", reason: "failed" }
snapshotVersion/promptVersion   agentic-recommendation-snapshot-v2
schemaVersion             agentic-recommendation-schema-v4
relevantBeliefIds.length  122
insightRunId              fcf08d7c-3a57-4f40-bef1-61b11a8a8cf3
goalRunId                 521169bb-f01d-448d-b173-b1ab592828a5
```

Associated `BackfillJob` (`jobType: agentic_recommendation_generate`, unique per `(shopId,
jobType)`, so this single row was reused across attempts):

```text
BackfillJob.id   aa595ea2-e376-4623-b74d-5729c451c9b9
attemptCount     2 of maxAttempts 3 (as of first inspection; job-level retry, separate
                 from the 6-attempt in-place LLM retry inside the same job attempt)
payloadJson.runId          3033f48a-... (attempt 1) — later attempts point at other runs, see §9
lastError (job level)      openai request failed with HTTP 429.
```

`LlmUsageEvent` rows for run `3033f48a`, in order (all `status: "error"`, all `inputTokens: 0`
because OpenAI rejects 429s before token accounting):

```text
08:04:30.373Z  latency 1979ms  error
08:04:46.218Z  latency 1351ms  error   (+16s — 1st backoff)
08:05:18.793Z  latency  921ms  error   (+32s — 2nd backoff)
08:06:29.556Z  latency  935ms  error   (+71s — 3rd backoff)
08:07:31.597Z  latency  915ms  error   (+62s — 4th backoff)
08:08:29.597Z  latency  894ms  error   (+58s — 5th backoff, exhausted after this)
```

Six attempts, matching `RECOMMENDATION_LLM_RETRY_MAX_ATTEMPTS = 6` exactly, with backoff gaps
consistent with the documented `[15s, 30s, 60s, 60s, 60s]` fallback schedule (±20% jitter) in
`app/lib/shopify/agentic-runtime/recommendation-llm-retry.server.js`. Sub-second latencies per
attempt confirm each was a fast provider-side rejection, not a timeout.

## 3. Call-path trace

```text
Home "Generate another proposal" click
→ app/routes/app._index.tsx  intent="home.generate_proposal"                    COMPLETED
→ requestHomeProposalGeneration()  (home-proposal-generation.server.js)         COMPLETED
    (budget/eligibility checks pass; advisory-lock transaction)
→ ensureAgenticRecommendationQueued() → prepareAgenticRecommendationRun()       COMPLETED
    (creates MerchantPlanRun 3033f48a, sourceMode="home", status=queued)
→ enqueueBackfillJob()  (BackfillJob aa595ea2, jobType=agentic_recommendation_generate) COMPLETED
→ worker pickup: processReadyBackfillJobs / processNextBackfillJob              COMPLETED
    (in-process loop — see §8; job claimed, attemptCount incremented, status=running)
→ runAgenticRecommendationInvestigation()  (recommendation-service.server.js)    ENTERED → FAILED
    → loadPreparedAgenticRecommendationRun()  reuses run 3033f48a, preserves sourceMode="home" COMPLETED
    → createLlmProvider() / ShopifyAdminGraphqlClient construction               COMPLETED
    → runCandidateDrivenRecommendation()  (candidate-pipeline.server.js)         ENTERED → FAILED
        → phase DISCOVERING_CANDIDATES: first LLM call (candidate discovery)     FAILED
            (withRecommendationLlmRetry: 6/6 attempts exhausted, all HTTP 429)
        → capability retrieval (retrieve_shopify_operations / call_shopify_operation) NOT REACHED
        → candidate investigation                                                NOT REACHED
        → recommendation validation (schema/semantic/capability)                 NOT REACHED
        → novelty check                                                          NOT REACHED
        → persistence (MerchantPlanRecommendation / MerchantAction)              NOT REACHED
    → catch block: markAgenticRecommendationJobFailed()                          COMPLETED
        (MerchantPlanRun 3033f48a → status=failed, safeErrorCode, lastError set)
    → error rethrown to worker
→ worker's runClaimedBackfillJob() catch: job requeued (attemptCount 1 of 3, not yet permanent) COMPLETED
→ UI loader: getHomeProposalGenerationState()  (app._index.tsx / home-proposal-generation.server.js) COMPLETED
    → no sourceMode="home" run currently queued/running → falls to "most recent home run" lookup
    → finds run 3033f48a, status="failed" → terminalStatus="failed"
→ app/components/daily-home.tsx NextMoveCard: terminalStatus==="failed"          COMPLETED
    → bodyCopy = "Jefe couldn't generate a proposal. Try again."
```

**First failing boundary: candidate discovery** — the very first LLM call of the run, inside
`runCandidateDrivenRecommendation`'s `DISCOVERING_CANDIDATES` phase. Nothing downstream (capability
retrieval, candidate investigation, recommendation validation, novelty, persistence) was ever
reached. This is a pure infrastructure failure at the first LLM boundary, not a pipeline logic
failure.

## 4. Root error

```text
Error class:     LlmProviderHttpError
Message:         "openai request failed with HTTP 429."
status:          429
providerCode:    "rate_limit"
provider:        openai
model:           gpt-5.6-luna
Origin:          app/lib/llm/providers/openai-compatible.server.js:395/425
                 `${providerName} request failed with HTTP ${response.status}.`
Retry outcome:   recommendation_llm_retry_exhausted, attempts=6, cumulativeWaitMs≈229768,
                 reason="max_attempts_exceeded"
Propagation:     runCandidateDrivenRecommendation → runAgenticRecommendationInvestigation
                 (catch) → markAgenticRecommendationJobFailed → MerchantPlanRun.status=failed
                 → rethrown → worker job catch → BackfillJob requeued (job-level attempt, separate
                 budget from the in-place LLM retry)
```

This is the exact, verbatim terminal error recovered from `MerchantPlanRun.lastError` and
independently confirmed live via structured logs during the reproduction in §8 (`statusCode: 429,
providerCode: 'rate_limit'`, `error: 'LlmProviderHttpError'`). No secrets were present in the
recoverable error; nothing was redacted beyond what the app already omits (provider response body).

## 5. Recent-change analysis

| Change | Contributed? | Evidence |
| --- | --- | --- |
| 810-op catalog | No | Catalog loads and validates cleanly at runtime (`loadShopifyApiCatalog()` → 810 ops, 287 queries / 523 mutations / 28 domains, no validation errors). Discovery never got far enough to touch the catalog at all — the failing call is the candidate-discovery LLM call, which happens before any `retrieve_shopify_operations` tool call. Token counts (§6) also rule out catalog-driven bloat. |
| Retrieval changes (`retrieveShopifyApiOperations`, capability retrieval) | No | Never reached — capability retrieval is downstream of candidate discovery, which is where the run died. |
| Mutation safety classifier | No | Never reached for the same reason; also structurally can't run mutations during recommendation mode (`recommendationMode && !operationLooksRead` → `RECOMMENDATION_WRITE_DENIED`), irrelevant to this failure regardless. |
| Task 2 beliefs (RFM/discount intelligence, Merchant Memory expansion) | No | `buildAgenticRecommendationSnapshot` completed successfully for this run (122 relevant belief ids resolved, same `insightRunId`/`goalRunId` as the healthy comparison run 6e000b51 and the reproduction run). Snapshot construction is not in the failing call path — it completes *before* the first LLM call, and it completed fine here. |
| Task 3 diagnostics (structured candidate disposition taxonomy) | No | Diagnostics/persistence code is downstream of candidate investigation, never reached. |
| Broadened desired scopes (2026-08-24) | No | Session scopes for this shop are a superset of every desired scope in `shopify.app.toml` (one diff: legacy `read_pixels` still granted, not in the desired list; nothing desired is missing). No scope-related exception anywhere in the trace. |
| Provider/rate limiting | **Yes — primary cause** | Six consecutive HTTP 429s with `providerCode: rate_limit` at the first LLM boundary of the run; reproduced live 16 minutes later with an identical, immediate 429 on both attempts of a fresh call before any recovery. |
| Worker/web version skew | No | `ENABLE_SHOPIFY_BACKFILL_LOOP=true` in `.env` and `app/shopify.server.ts` calls `startShopifyBackfillLoop(prisma)` unconditionally at module load — in this dev configuration the backfill worker runs **in-process** inside the same `shopify app dev` process that serves the web UI. There is only one process, one module graph, one commit checked out; version skew between "web" and "worker" is structurally impossible here. (This is a secondary, unrelated finding worth flagging: it also means the worker was proven to be alive and processing at 08:04-08:09 on 2026-08-25, since the job was genuinely claimed, run, and retried — the process later exited, sometime before this investigation began around 08:19, but that is investigation-time environment state, not the state during the incident.) |

## 6. Token/context analysis

Reproduction run (`03030099-9b9b-417d-ac36-38ae2dc733e8`), captured live from structured logs of
the first (failing) LLM call:

```text
estimatedInputTokens: 61,600
maxInputTokens:       80,000
maxOutputTokens:       3,200
```

Comparison — the last *successful* (`no_actionable_opportunity`) run for this merchant earlier the
same day (`6e000b51`, 12 real LLM calls, all `ok` except one transient error that self-recovered):

```text
input tokens per call:  57,842 → 84,791 (rising slightly across the run as tool results accumulate)
output tokens per call: 191 → 1,291
sum input across the whole run: 742,941 tokens over 12 calls
```

Both figures are well inside the 80,000-token input budget the provider layer enforces, and
comparable in magnitude between the healthy and the failing run — the failing run's first call
(61,600 est. tokens) sits squarely inside the same range as the healthy run's early calls
(57,842-65,308 tokens), not an outlier.

**Are all 810 operations accidentally entering the prompt/context? No.** The 429 happened on the
very first LLM call of the run — candidate discovery — which happens *before* any
`retrieve_shopify_operations` tool call exists to bind operations into context at all (confirmed
by the healthy comparison run's own trace: `DISCOVERING_CANDIDATES` produces the candidate list
first, then each `TRYING_NEXT_CANDIDATE` step calls `retrieve_shopify_operations` and gets back
`"Server-bound 8 Shopify operation stubs for this candidate"` — capped at 8 by
`boundedLimit()` in `tools.server.js`, regardless of the 810-operation catalog size). Retrieval is
provably limiting the model-visible operation subset to a handful of ranked stubs per query, as
designed; the catalog's full size never reaches the prompt.

## 7. Scope analysis

```text
Desired scopes (shopify.app.toml, applied 2026-08-24):  75 scopes
Granted scopes (Session row, offline, jefe-local-store.myshopify.com):  76 scopes
Desired but not granted:  [] (none)
Granted but not desired:  [read_pixels]  (legacy grant, harmless, not a gap)
Session expiry at investigation time: 2026-08-25T09:04:15.725Z (valid, not expired)
```

Scope state played **no role** in this failure. There is no `SCOPE_NOT_GRANTED`,
`scopeConfidence`, authorization-failure, or reauthorization-required signal anywhere in the run's
result, logs, or trace. The merchant has already re-consented to the full broadened scope set from
the 2026-08-24 change, and the pipeline never got far enough (never past the first LLM call) to
even reach a point where scope state would matter (candidate investigation reads the app's live
granted scopes at runtime via `currentAppInstallation` and reasons about them per-candidate — that
code path was never entered).

## 8. Reproduction result

Reproduced once via the real, unmodified production functions
(`requestHomeProposalGeneration` → `processNextBackfillJob`), invoked directly rather than through
a running `shopify app dev`/CLI process (which was not active in this environment at investigation
time — see note below). No Shopify mutation was possible or attempted (recommendation-mode tool
gate structurally blocks writes).

```text
New run:      03030099-9b9b-417d-ac36-38ae2dc733e8   sourceMode=home
createdAt:    2026-08-25T08:20:17.223Z
startedAt:    2026-08-25T08:20:18.121Z
failedAt:     2026-08-25T08:24:14.712Z   (≈4 minutes later, same as the original)
lastError:    "openai request failed with HTTP 429."   (byte-identical to the original)
```

Structured logs from the reproduction show the identical shape as the original: candidate
discovery's first call returns 429 on both the provider layer's own inner attempt (1 retry,
~250-500ms backoff) and again on the outer `withRecommendationLlmRetry` layer, six times, with
backoff gaps of 15s/30s/60s/60s/60s (`cumulativeWaitMs` reaching 229,768ms), then
`recommendation_llm_retry_exhausted` and the same terminal failure.

**The failure reproduced with the same root cause** — this was not resolved by simply retrying;
the rate limit was still fully in effect roughly 16 minutes after the original incident, meaning
it is a sustained condition (consistent with either an ongoing account/project-level TPM or RPM
cap being saturated — the recent validation work mentioned in the task brief is a plausible
contributor, as is any other concurrent process sharing the same `OPENAI_API_KEY` — this is
inference, not confirmed, since nothing in this investigation's evidence identifies who/what else
is consuming the quota). Nothing about provider quota, process restart, merchant state, code
version, or scope state changed between the original failure and the reproduction; the rate limit
itself did not clear.

One incidental discovery during reproduction: attempting to run the pipeline outside a live
`shopify app dev`/Vite process fails differently — `Cannot find module '.../app/shopify.server'`
— because `offline-token.server.js` dynamically imports `app/shopify.server.ts`, and plain `node`
cannot resolve a bare `.ts` import without the CLI/Vite toolchain. This is a tooling limitation of
ad-hoc reproduction, not related to the original bug; it was worked around using the
already-documented `loadOfflineToken` test-injection seam (reading the same offline `Session` row
the real code path would read), not by fabricating a token or modifying application code.

## 9. Root-cause classification

**Primary: `LLM_RATE_LIMIT`**

Evidence: `LlmProviderHttpError`, `status: 429`, `providerCode: 'rate_limit'`, six consecutive
failures at the first LLM call of the run, `recommendation_llm_retry_exhausted` after the full
6-attempt / ~230s backoff budget, reproduced live with an identical error ~16 minutes later. Every
other named category in §17 was actively ruled out with direct evidence: catalog loads and
validates cleanly (not `SHOPIFY_CATALOG_RUNTIME_FAILURE`); token counts are unremarkable and the
run never got past the pre-retrieval discovery call (not `LLM_CONTEXT_OVERFLOW` or
`CAPABILITY_RETRIEVAL_RUNTIME_FAILURE`); scopes are fully granted (not
`SCOPE_AUTHORIZATION_FAILURE`); the snapshot/belief/goal/insight resolution completed
successfully and consistently across three separate runs (not `MERCHANT_MEMORY_SNAPSHOT_FAILURE`);
there is one process, one code version, so skew is structurally impossible (not
`VERSION_SKEW`); latency per attempt was ~0.9-2s, far short of any timeout threshold (not
`LLM_TIMEOUT`); there was no structured-output/JSON/schema failure — the provider never returned a
response to validate (not `LLM_SCHEMA_FAILURE`); this is not a legitimate empty result (not
`GENUINE_NO_ACTIONABLE_OPPORTUNITY` — compare the earlier same-day run, which *did* reach that
state after 12 successful LLM calls); persistence, novelty, and recommendation validation were
never reached (not `RECOMMENDATION_VALIDATION_FAILURE`, `NOVELTY_FAILURE`, or
`PERSISTENCE_FAILURE`); and the worker itself behaved correctly per its own retry contract — it is
not `WORKER_FAILURE` in the sense of the worker malfunctioning, it correctly detected and surfaced
a genuine upstream provider failure.

**Secondary contributor: `UI_STATUS_MAPPING_BUG`-adjacent (not root cause, but a real, distinct,
evidenced defect)**

When the worker's *job-level* retry (BackfillJob `maxAttempts=3`, separate from the in-place
6-attempt LLM retry inside one job attempt) picked the job back up for its second attempt
(08:09:44, ~1 minute after the original run failed permanently), `loadPreparedAgenticRecommendationRun`
found the original run (`3033f48a`) already in a terminal `failed` state. Per its own documented
"ownership invariant" comment, a terminal run whose snapshot hash no longer matches the current
snapshot falls through to `prepareAgenticRecommendationRun(prisma, input)` — and the worker's call
site (`runBackfillJob` → `runAgenticRecommendationInvestigation`, `app/services/shopify-backfill-worker.server.js`
line ~776) never passes a `sourceMode`, so the new run defaults to `AGENTIC_RECOMMENDATION_SOURCE_MODE`
("agentic") instead of inheriting `"home"`. This is exactly what happened: run
`de79cb10-1468-4f61-8a3b-947e04b4ec69` was created at `2026-08-25T08:09:45.969Z`,
`sourceMode: "agentic"`, and is **still stuck in `status: "running"`** as of this investigation
(`updatedAt: 2026-08-25T08:09:46.015Z`, no further progress since) — because
`isHomeProposalGenerationInFlight` and the terminal-status fallback query in
`getHomeProposalGenerationState` both filter on `sourceMode: "home"`, this orphaned run is invisible
to the home screen's polling logic, invisible to the 15-minute stuck-run detector (which also only
looks at `sourceMode: "home"` runs), and was left behind with no owning `BackfillJob` row (that row
was reused for a later attempt). This did not cause the original merchant-visible failure, but it
means (a) a merchant could in principle see a stale "failed, try again" while a job-level retry
silently churns in the background under the wrong sourceMode, and (b) orphaned `agentic`-sourceMode
runs can accumulate indefinitely with no owner and no recovery path.

## 10. Recommended next task

Do not implement yet — this is the evidence base for that decision. Two independent, precisely
scoped follow-ups fall out of this investigation:

1. **Infrastructure/provider resilience (primary).** The in-place retry budget
   (`RECOMMENDATION_LLM_RETRY_MAX_ATTEMPTS=6`, ~230s max backoff) is not sufficient for a *sustained*
   rate-limit window — it was fully exhausted twice in one investigation session, 16 minutes apart,
   against the same underlying condition. This needs an operational fix, not a pipeline-logic fix:
   confirm what is consuming the shared `OPENAI_API_KEY`'s quota around this time window (candidate:
   the "recent validation work" mentioned in the task brief, or other concurrent processes against
   the same key/org), and/or give the merchant-facing home flow a real fallback provider path (the
   codebase already has `withFallbackProvider`/`isLlmFallbackError` machinery treating 429 as
   fallback-eligible — confirm whether recommendation generation is actually configured with a
   fallback provider, since this run never logged a fallback attempt).
2. **Worker job-lifecycle / sourceMode propagation (secondary, but a real correctness bug).** Pass
   `sourceMode` (and ideally the full retry lineage) through to
   `runAgenticRecommendationInvestigation`'s worker call site so the `prepareAgenticRecommendationRun`
   fallback branch in `loadPreparedAgenticRecommendationRun` cannot silently default a job-level
   retry to `sourceMode: "agentic"` when its parent run was `"home"`. Separately, add cleanup/recovery
   for orphaned non-terminal `MerchantPlanRun` rows outside `sourceMode: "home"` (run `de79cb10` is
   currently stuck `running` forever with no owning job and no recovery path) — this is a
   UI/observability correctness gap, not a generation-logic gap.

No change to recommendation logic, prompts, retry policy defaults, validation, catalog contents,
or scopes is indicated by this evidence.

## Final answer

Jefe failed because the machinery broke, not because it couldn't find a recommendation: the very
first OpenAI call of candidate discovery — before capability retrieval, candidate investigation, or
any evaluation of the merchant's store ever began — was rejected with a sustained HTTP 429 six
times over the full retry budget, and the run was correctly marked failed and correctly (if
narrowly) surfaced as "couldn't generate a proposal, try again."
