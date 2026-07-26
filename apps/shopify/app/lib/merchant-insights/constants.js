// @ts-check

export const MERCHANT_INSIGHTS_JOB_TYPE = "merchant_insights_generate";
export const MERCHANT_INSIGHTS_PROMPT_VERSION = "merchant-insights-v3";
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
