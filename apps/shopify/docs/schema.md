# Database Schema

Jefe uses Postgres as the source of truth. Prisma owns the schema and Shopify session storage is stored in the same database through the generated `Session` model.

## Tenancy And Install State

`merchants` is the top-level tenant. `shops` belongs to a merchant and represents the connected Shopify store.

`connector_accounts` stores the retained Shopify installation record for a shop: connector name, Shopify account domain, granted scopes, token reference and raw install metadata. It stores token references only; Shopify access tokens remain in Shopify session storage.

## Event Ledger

`ledger_events` records source events for evidence backfills and webhooks. Events include event timestamps plus dedupe and idempotency keys so retries and duplicate webhook deliveries do not double-write source events.

## Commerce Evidence

`products` and `variants` store Shopify product evidence. They keep Shopify source identifiers, product/variant display fields, source timestamps, variant inventory item IDs and raw source payloads for traceability.

`orders`, `order_line_items` and `refunds` store order evidence from Shopify backfills and webhooks. Line items keep nullable product and variant links when the corresponding product evidence exists.

`customer_identities` stores order-derived customer identity evidence, including normalized and hashed email fields, order counts and spend totals. It is evidence infrastructure, not a customer profile product surface.

`inventory_levels` stores current Shopify inventory evidence by inventory item and location, with nullable variant links when the variant mirror exists.

The evidence layer intentionally does not include product costs, recommendations, actions or dashboards.

## Merchant Memory

Merchant Memory sits above the raw commerce evidence layer. `merchant_memory_beliefs` stores structured beliefs with stable semantic keys, lifecycle status, confidence, timestamps and precedence. `merchant_memory_evidence` stores provenance for each belief without copying raw Shopify payloads or customer PII. `merchant_memory_belief_history` preserves value and status changes, including merchant confirmations, corrections, supersession and obsolescence. `merchant_memory_refresh_runs` records memory build attempts and failures.

Merchant-authoritative statuses are not silently overwritten by deterministic recalculation.

## Evidence Backfill

`shop_backfill_statuses` stores evidence and memory build status by shop and domain. Current domains are `shop`, `webhooks`, `products`, `orders`, `customers`, `inventory`, `refunds` and `merchant_memory`.

`backfill_jobs` stores queued evidence backfill and memory refresh work. Current job types are `shop_backfill_start`, `products_backfill`, `orders_backfill_365d`, `inventory_backfill`, `backfill_delta_sync`, `backfill_finalize` and `merchant_memory_rebuild`.
