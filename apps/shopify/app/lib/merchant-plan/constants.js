// @ts-check

export const MERCHANT_PLAN_JOB_TYPE = "merchant_plan_generate";
export const MERCHANT_PLAN_PROMPT_VERSION = "merchant-plan-v2";
export const MERCHANT_PLAN_SCHEMA_VERSION = "merchant-plan-schema-v1";
export const MERCHANT_PLAN_SNAPSHOT_VERSION = "merchant-plan-snapshot-v1";

export const PLAN_RUN_STATUS = {
  queued: "queued",
  running: "running",
  completed: "completed",
  failed: "failed",
  insufficientData: "insufficient_data",
  modelDisabled: "model_disabled",
};

export const PLAN_REVIEW_STATUS = {
  proposed: "proposed",
  accepted: "accepted",
  rejected: "rejected",
  refinementRequested: "refinement_requested",
  completed: "completed",
};

export const PLAN_CONFIDENCE = ["strong", "reasonable", "emerging"];
export const MIN_PLAN_BELIEFS = 3;
export const MAX_PLAN_BELIEFS = 40;
