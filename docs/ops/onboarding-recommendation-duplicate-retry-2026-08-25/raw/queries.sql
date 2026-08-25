-- All MerchantPlanRuns for jefe-local-store, unfiltered by status/time
select r.id, r.status, r.created_at, r.started_at, r.completed_at, r.failed_at, r.source_mode,
       r.safe_error_code, r.last_error, r.snapshot_hash
from merchant_plan_runs r join shops s on s.id = r.shop_id
where s.shop_domain ilike '%jefe-local-store%'
order by r.created_at asc;

-- Every llm_usage_event for the merchant, across the onboarding window
select run_id, run_type, feature, provider, model, input_tokens, output_tokens, status,
       latency_ms, created_at
from llm_usage_event
where merchant_id = (select merchant_id from merchant_plan_runs where id = '2d8f34ab-3b2d-4041-be7c-443f3553202f')
order by created_at asc;

-- All backfill_jobs for the shop, this onboarding epoch
select id, job_type, status, priority, attempt_count, max_attempts, run_after, started_at,
       completed_at, failed_at, last_error, created_at, updated_at, payload_json
from backfill_jobs
where shop_id = (select shop_id from merchant_plan_runs where id = '2d8f34ab-3b2d-4041-be7c-443f3553202f');
