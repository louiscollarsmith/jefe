# Database Schema

Jefe uses Postgres as the source of truth. Prisma owns the initial schema and Shopify session storage is stored in the same database through the generated `Session` model.

## Tenancy

`merchants` is the top-level tenant. `shops` belongs to a merchant and represents the connected Shopify store. Domain tables carry `merchant_id` and, where the data is store-specific, `shop_id`.

## Event Ledger

`ledger_events` is the append-only event ledger by convention. Application code should only insert ledger rows, never update or delete them. Events include `event_ts`, dedupe and idempotency keys so ingestion, recommendations, approvals, execution steps, feedback, outcomes and attribution can be replayed without double counting.

## House Rules And Goals

`house_rules` and `goals` are first-class data. House Rules include structured JSON fields for enforceable constraints plus free-text rules for explanation and generation context. Actions persist `rules_consulted` and `rule_constraints_applied` so each proposal can cite the constraints it obeyed.

## Commerce State

`products`, `variants`, `orders`, `order_line_items`, `refunds`, `inventory_levels` and `cogs_inputs` store canonical commerce state. Connector payloads are retained in JSONB `raw_payload` fields for traceability.

## Actions And Verification

`actions` stores expected value, confidence, risk level, evidence, rules consulted, preview and verification class. `verification_class` is a Postgres enum with only `verified` and `estimated`; verified lift and estimated prevention should be queried and displayed separately.

`executions` records dry-run or approved execution attempts with idempotency keys. `holdout_assignments` and `attribution_results` support measured outcomes. `provenance_links` ties recommendations and outputs back to ledger events or source records.

## Connectors And Costs

`connector_accounts` stores connector metadata and secret references only, not raw secrets. `cost_metering` tracks provider/service usage per merchant so pilot economics can be inspected.
