# Database Schema

Jefe uses Postgres as the source of truth. Prisma owns the schema and Shopify session storage is stored in the same database through the generated `Session` model.

## Tenancy And Install State

`merchants` is the top-level tenant. `shops` belongs to a merchant and represents the connected Shopify store, install state, onboarding state and backfill readiness.

`connector_accounts` stores connector metadata such as connector name, Shopify domain, granted scopes and token references. Shopify access tokens remain in Shopify session storage.

## Event Ledger

`ledger_events` records source events for evidence backfills and webhooks. Events include event timestamps plus dedupe and idempotency keys so retries and duplicate webhook deliveries do not double-write source events.

## Commerce Evidence

`products` and `variants` store Shopify product evidence. `orders`, `order_line_items` and `refunds` store Shopify order/refund evidence. `customer_identities` stores order-derived aggregate customer identity evidence. `inventory_levels` stores current Shopify inventory evidence by inventory item and location.

The commerce evidence layer intentionally stores raw source payloads for traceability while Merchant Memory evidence stores only bounded, merchant-safe summaries.

## Merchant Memory

`merchant_memory_beliefs` stores structured beliefs with stable semantic keys, lifecycle status, confidence, timestamps, precedence and derivation lineage. `merchant_memory_evidence` stores provenance for each belief without copying raw Shopify payloads or customer PII. `merchant_memory_belief_history` preserves value and status changes. `merchant_memory_refresh_runs` records memory build attempts and failures.

Merchant-authoritative statuses are not silently overwritten by deterministic recalculation.

## Store Understanding, Insights, Goals And Plan

`store_understanding_runs` records bounded LLM Store Understanding passes over Shopify and deterministic-memory summaries.

`merchant_insight_runs` and `merchant_insight_findings` store validated, evidence-grounded onboarding insights.

`merchant_goal_runs` and `merchant_goal_horizons` store generated 3-, 6- and 12-month objectives plus run state.

`merchant_plan_runs` and `merchant_plan_recommendations` store one generated first move for onboarding. These records are recommendations only; they do not represent external Shopify execution.

## Conversations And Open Questions

`merchant_memory_conversations`, `merchant_memory_conversation_messages` and `merchant_memory_open_questions` support merchant coaching, planning-document context and future memory review interactions.

## Channels

Channel tables store Slack and future WhatsApp connection state, encrypted credential references, OAuth state, verification challenges and test-message delivery records. Channel credentials stay encrypted server-side.

## Evidence Backfill

`shop_backfill_statuses` stores evidence and memory build status by shop and domain. `backfill_jobs` stores queued evidence backfill, memory refresh, insight, goal and plan work.

Backfill and worker code use these records to queue, retry, recover stale jobs, inspect progress and avoid blocking OAuth or page load on long-running imports.

## Migration History

Prisma migrations are historical deployment records. Old migration names may reference retired Daily Brief, COGS, Klaviyo or action-safety surfaces; keep them intact for database continuity unless a founder explicitly approves a reset.
