// @ts-check

export const MERCHANT_INSIGHTS_JOB_TYPE = "merchant_insights_generate";
export const MERCHANT_INSIGHTS_PROMPT_VERSION = "merchant-insights-v5";
export const MERCHANT_INSIGHTS_SCHEMA_VERSION = "merchant-insights-schema-v1";
export const MERCHANT_INSIGHTS_SNAPSHOT_VERSION =
  "merchant-insights-snapshot-v2";

export const INSIGHT_RUN_STATUS = {
  queued: "queued",
  running: "running",
  completed: "completed",
  failed: "failed",
  insufficientData: "insufficient_data",
  modelDisabled: "model_disabled",
  stale: "stale",
};

export const INSIGHT_REVIEW_STATUS = {
  unreviewed: "unreviewed",
  confirmed: "confirmed",
  corrected: "corrected",
};

export const INSIGHT_CONFIDENCE = ["high", "medium", "emerging"];
export const INSIGHT_CATEGORIES = [
  "customers",
  "products",
  "revenue",
  "retention",
  "inventory",
  "operations",
  "geography",
  "growth",
  "risk",
  "other",
];

export const MAX_INSIGHTS = 10;
export const MAX_ONBOARDING_INSIGHTS = 5;
export const MIN_USEFUL_INSIGHT_BELIEFS = 3;

// Upper bound on how many beliefs are placed in the Insights generation
// snapshot. Mirrors MAX_PLAN_BELIEFS: a mature store (hundreds of active
// beliefs) would otherwise blow past the provider's maxInputTokens (16000)
// and fail permanently as `input_too_large`. Beliefs beyond this cap are
// dropped by prioritisation (see selectPrioritizedCandidates), never by
// silent truncation.
export const MAX_INSIGHT_BELIEFS = 40;
