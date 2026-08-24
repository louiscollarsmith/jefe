// @ts-check

export const AGENTIC_RECOMMENDATION_JOB_TYPE = "agentic_recommendation_generate";
export const AGENTIC_RECOMMENDATION_SOURCE_MODE = "agentic";
// Bump this version whenever the snapshot schema changes (new fields, removed fields,
// or changed semantics). It is included in the snapshot object before hashing, so any
// version change produces new hashes for all future runs — making schema changes
// explicit and debuggable. Existing queued runs are refreshed in-place by the worker.
// v2: added shopifyMirrorWatermark field (Shopify state invalidation via backfill watermark)
export const AGENTIC_RECOMMENDATION_SNAPSHOT_VERSION =
  "agentic-recommendation-snapshot-v2";
export const AGENTIC_RECOMMENDATION_SCHEMA_VERSION =
  "agentic-recommendation-schema-v4";

// Prefix for per-action durable execution jobs stored in the BackfillJob table.
// The full jobType is `${PREFIX}:${actionId}`, satisfying @@unique([shopId, jobType]).
export const AGENTIC_SHOPIFY_EXECUTION_JOB_TYPE_PREFIX = "agentic_shopify_execute";

// Prefix for verification-only retry jobs. These are separate job entries so the
// execution job can be marked succeeded while verification retries are still pending.
export const AGENTIC_SHOPIFY_VERIFICATION_JOB_TYPE_PREFIX = "agentic_shopify_verify";
