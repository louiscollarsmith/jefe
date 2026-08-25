/**
 * Regression for docs/ops/onboarding-recommendation-duplicate-retry-2026-08-25.
 *
 * Traced live: one onboarding recommendation attempt produced a single MerchantPlanRun whose
 * first LLM call estimated 83,445 input tokens against an 80,000 cap — a deterministic
 * LlmInputLimitError that will not change by waiting and replaying the identical call. The
 * generic backfill-job retry loop (runClaimedBackfillJob's catch block) did not know this and
 * retried the exact same call 2 more times, spaced 60s then 120s apart per its own backoff
 * schedule (retryAfter), before finally marking the run failed on the 3rd attempt — three minutes
 * of silent "automatic retry" with no founder action and no visible progress, for a failure mode
 * that could never have succeeded on any attempt.
 *
 * isBackfillJobFailurePermanent now consults the same shared classifier
 * (isRetryableLlmInfrastructureError) recommendation-llm-retry.server.js already uses, scoped to
 * AGENTIC_RECOMMENDATION_JOB_TYPE only, so this class of failure is marked permanently failed on
 * the first attempt instead of the last of maxAttempts.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { isBackfillJobFailurePermanent } from "../app/services/shopify-backfill-worker.server.js";
import { AGENTIC_RECOMMENDATION_JOB_TYPE } from "../app/lib/shopify/agentic-runtime/constants.server.js";
import { LlmInputLimitError, LlmProviderInputLimitError } from "../app/lib/llm/errors.server.js";

function agenticJob(attemptCount) {
  return { jobType: AGENTIC_RECOMMENDATION_JOB_TYPE, attemptCount, maxAttempts: 3 };
}

test("an over-budget-input recommendation failure is permanent on the first attempt, not the last", () => {
  const error = new LlmInputLimitError("Estimated 83445 input tokens exceeds 80000.");
  assert.equal(isBackfillJobFailurePermanent(agenticJob(0), error), true);
  // Would previously have been false here (attemptCount 0, maxAttempts 3) — the exact bug traced
  // live: two more identical, doomed attempts before the run was ever marked failed.
  assert.equal(isBackfillJobFailurePermanent(agenticJob(1), error), true);
});

test("a provider-reported input-limit error is also treated as permanent immediately", () => {
  const error = new LlmProviderInputLimitError("context_length_exceeded", {
    provider: "openai",
    estimatedInputTokens: 83445,
    maxInputTokens: 80000,
  });
  assert.equal(isBackfillJobFailurePermanent(agenticJob(0), error), true);
});

test("a transient infrastructure error for the same job type still uses the normal attempt budget", () => {
  const rateLimited = Object.assign(new Error("Too Many Requests"), { status: 429 });
  assert.equal(isBackfillJobFailurePermanent(agenticJob(0), rateLimited), false);
  assert.equal(isBackfillJobFailurePermanent(agenticJob(1), rateLimited), false);
  assert.equal(isBackfillJobFailurePermanent(agenticJob(2), rateLimited), true); // attemptCount+1 >= maxAttempts

  const timeout = new Error("The operation timed out");
  assert.equal(isBackfillJobFailurePermanent(agenticJob(0), timeout), false);
});

test("other job types are unaffected: the input-limit classifier is not applied outside AGENTIC_RECOMMENDATION_JOB_TYPE", () => {
  const error = new LlmInputLimitError("Estimated 83445 input tokens exceeds 80000.");
  const otherJob = { jobType: "merchant_goals_generate", attemptCount: 0, maxAttempts: 3 };
  // Same error, different job type: falls through to the ordinary attempt-budget check unchanged.
  assert.equal(isBackfillJobFailurePermanent(otherJob, error), false);
  assert.equal(isBackfillJobFailurePermanent({ ...otherJob, attemptCount: 2 }, error), true);
});
