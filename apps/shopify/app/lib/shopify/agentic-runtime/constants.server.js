// @ts-check

export const AGENTIC_RECOMMENDATION_JOB_TYPE = "agentic_recommendation_generate";
export const AGENTIC_RECOMMENDATION_SOURCE_MODE = "agentic";
export const AGENTIC_RECOMMENDATION_SNAPSHOT_VERSION =
  "agentic-recommendation-snapshot-v1";
export const AGENTIC_RECOMMENDATION_SCHEMA_VERSION =
  "agentic-recommendation-schema-v4";

// Prefix for per-action durable execution jobs stored in the BackfillJob table.
// The full jobType is `${PREFIX}:${actionId}`, satisfying @@unique([shopId, jobType]).
export const AGENTIC_SHOPIFY_EXECUTION_JOB_TYPE_PREFIX = "agentic_shopify_execute";

// Prefix for verification-only retry jobs. These are separate job entries so the
// execution job can be marked succeeded while verification retries are still pending.
export const AGENTIC_SHOPIFY_VERIFICATION_JOB_TYPE_PREFIX = "agentic_shopify_verify";
