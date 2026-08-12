// @ts-check

export const MERCHANT_GOALS_JOB_TYPE = "merchant_goals_generate";
export const MERCHANT_GOALS_PROMPT_VERSION = "merchant-goals-v6-context";
export const MERCHANT_GOALS_SCHEMA_VERSION = "merchant-goals-schema-v1";
export const MERCHANT_GOALS_SNAPSHOT_VERSION =
  "merchant-goals-snapshot-v2-context";

export const GOAL_RUN_STATUS = {
  queued: "queued",
  running: "running",
  completed: "completed",
  failed: "failed",
  insufficientData: "insufficient_data",
  modelDisabled: "model_disabled",
};

export const GOAL_HORIZONS = [
  { key: "threeMonths", label: "3 MONTHS", months: 3, orderIndex: 1 },
  { key: "sixMonths", label: "6 MONTHS", months: 6, orderIndex: 2 },
  { key: "twelveMonths", label: "12 MONTHS", months: 12, orderIndex: 3 },
];

export const GOAL_MEMORY_KEYS = {
  threeMonths: "goals.generated.three_months",
  sixMonths: "goals.generated.six_months",
  twelveMonths: "goals.generated.twelve_months",
};

export const MIN_GOAL_BELIEFS = 3;

// Upper bound on how many beliefs are placed in the Goals generation
// snapshot. Mirrors MAX_PLAN_BELIEFS / MAX_INSIGHT_BELIEFS so a mature store
// cannot exceed the provider's maxInputTokens (18000) and fail permanently as
// `input_too_large`. The Goals belief set is already bounded upstream by the
// Insights cap it reuses; this is the explicit, independently-enforced bound.
export const MAX_GOAL_BELIEFS = 40;
