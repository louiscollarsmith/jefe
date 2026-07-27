# Database Table Audit

Date: 2026-07-22

## Scope

This audit covers the reduced Shopify app schema after the repository reset. The target runtime scope is Shopify install/authentication, product backfill, product persistence and product webhook synchronisation. It does not introduce Merchant Memory tables.

The user-provided table list included `merchant_operating_map_facts`. In the local database, that table is already absent after migration `20260722143000_drop_merchant_operating_map_facts`. The local database also currently contains evidence tables from the earlier evidence-layer correction: `orders`, `order_line_items`, `refunds`, `customer_identities` and `inventory_levels`. Those are reported separately under "Additional Tables Present Locally".

All app tables were empty at audit time. `_prisma_migrations` contained 14 rows.

## Table Audit

| Table | Purpose | Active reads | Active writes | Foreign keys | Rows | Required for retained scope | Duplicate responsibility | Recommendation |
| --- | --- | --- | --- | --- | ---: | --- | --- | --- |
| `_prisma_migrations` | Prisma migration history. | Prisma CLI/migrate engine. | Prisma CLI/migrate engine. | None. | 14 | Required for schema deployment, not runtime app behaviour. | No. | Keep. |
| `Session` | Shopify session storage, including offline access token used by Shopify auth and manual/background backfill. | Shopify app session storage, `shopify-backfill-worker.server.js`, `scripts/shopify-backfill.mjs`. | Shopify app session storage; `tenant.server.js` deletes sessions on uninstall; tests create sessions. | None. | 0 | Required for Shopify auth and product backfill. | Partly overlaps with `connector_accounts.read_token_ref`, but `Session` stores the token and Shopify session shape. | Keep. |
| `merchants` | Tenant anchor for a merchant/business. All retained shop records belong to a merchant. | `tenant.server.js`, tests; indirectly through Prisma relations. | `tenant.server.js` creates merchants; tests create/delete merchants. | None outbound; many inbound FKs. | 0 | Required by current schema and code. | Partly overlaps with `shops` while there is one Shopify shop per merchant, but it represents the business tenant rather than platform installation. | Keep for now; simplify later only with a deliberate tenant-model migration. |
| `shops` | Shopify store/install identity, status and backfill readiness. | `tenant.server.js`, `webhooks.server.js`, `shopify-backfill-status.server.js`, `shopify-backfill-worker.server.js`, Dev route, tests. | `tenant.server.js`, app uninstall handling, backfill status/worker, tests. | `merchant_id -> merchants(id)` cascade. | 0 | Required for Shopify install, product backfill, product storage and product webhooks. | No exact duplicate. `connector_accounts` stores connector auth metadata, not shop identity. | Keep; simplify obsolete columns if product-only scope is re-confirmed. |
| `connector_accounts` | Installation/account metadata: connector name, Shopify domain, granted scopes, token reference and active/inactive status. | `tenant.server.js`, webhook scope/uninstall handling, tests. | `tenant.server.js`, webhook scope/uninstall handling, tests. | `merchant_id -> merchants(id)` cascade; `shop_id -> shops(id)` set null. | 0 | Required for install state and scope/status inspection. | Partly overlaps with `Session.scope` and `shops.status`, but it is the durable connector record while `Session` is Shopify session storage. | Keep; simplify `write_token_ref` if no write scopes return. |
| `ledger_events` | Source event ledger for webhook/backfill idempotency, dedupe and raw-source audit. | `ledger.server.js` checks dedupe key before create; tests inspect counts. | `ledger.server.js` creates events from backfills and webhooks. | `merchant_id -> merchants(id)` cascade; `shop_id -> shops(id)` set null. | 0 | Required for product backfill/webhook idempotency and audit. | Product rows store latest canonical state, not event-level dedupe/audit. | Keep. |
| `products` | Canonical Shopify product mirror. | `canonical.server.js`, Dev route, tests; product relations. | `canonical.server.js`, product backfill, product webhooks, tests. | `merchant_id -> merchants(id)` cascade; `shop_id -> shops(id)` cascade. | 0 | Required for product storage and product webhooks. | No. | Keep. |
| `variants` | Canonical Shopify product variant mirror. | `canonical.server.js`, Dev route, tests; variant relations. | `canonical.server.js`, product backfill, product webhooks, tests. | `merchant_id -> merchants(id)` cascade; `shop_id -> shops(id)` cascade; `product_id -> products(id)` cascade. | 0 | Required for product storage and product webhooks. | No. Variants are not safely embedded in products because they need Shopify IDs, inventory item IDs and independent upserts. | Keep. |
| `shop_backfill_statuses` | Per-shop, per-domain progress record for backfill readiness and Dev-page inspection. | `shopify-backfill-status.server.js`, `shopify-backfill-worker.server.js`, Dev route/tests. | `shopify-backfill-status.server.js`, `shopify-backfill-worker.server.js`, tests. | `merchant_id -> merchants(id)` cascade; `shop_id -> shops(id)` cascade. | 0 | Required for backfill progress/readiness. | Overlaps with `backfill_jobs.status`, but status rows answer domain-level progress while jobs represent executable work. | Keep; simplify domains to product-only if evidence scope is removed. |
| `backfill_jobs` | DB-backed queue for install-time and manual backfill work, retries and stale job recovery. | `shopify-backfill-worker.server.js`, `shopify-backfill-status.server.js`, Dev route/tests. | `shopify-backfill-status.server.js`, `shopify-backfill-worker.server.js`, `tenant.server.js` on uninstall, tests. | `merchant_id -> merchants(id)` cascade; `shop_id -> shops(id)` cascade. | 0 | Required for async product backfill. | Overlaps with `shop_backfill_statuses.status`, but jobs carry scheduling, attempts, run timing and result payloads. | Keep. |
| `merchant_operating_map_facts` | Legacy Merchant Operating Map fact store for inferred/confirmed setup and policy facts. | None in active code. Historical checkpoint code read it via `operating-map.server.js`. | None in active code. Historical checkpoint code wrote it via `saveOperatingPriority`, `syncHouseRulesFacts`, `createKnowledgeSource`, `detectShopifyCommerceStack` and Operating Map/onboarding routes. | Historical FKs were `merchant_id -> merchants(id)` and `shop_id -> shops(id)`. No inbound FKs found. | Not present locally; migration guard would stop if non-empty elsewhere. | Not required. | Its useful source evidence is not raw commerce evidence; it came from removed Operating Map/onboarding flows. No active duplicate is needed because the product is removed. | Remove. Migration `20260722143000_drop_merchant_operating_map_facts` drops it if absent/empty and refuses non-empty drops. |

## Additional Tables Present Locally

These tables are present in the local Prisma schema/database even though they were not in the user-provided table list:

| Table | Active dependency | Recommendation |
| --- | --- | --- |
| `orders` | Active order backfill/webhook code in `canonical.server.js`, `backfill.server.js`, `webhooks.server.js`, worker, Dev route and tests. | Keep only if the evidence-layer scope remains active. If the desired scope is strictly product-only, remove in a separate product-only narrowing pass with code, scopes, webhooks and tests updated together. |
| `order_line_items` | Active order canonicalisation and tests. Links to `orders`, `products`, `variants`. | Same as `orders`. |
| `refunds` | Active order/refund canonicalisation and refund webhook tests. | Same as `orders`. |
| `customer_identities` | Active order-derived customer identity code and tests. | Same as `orders`. |
| `inventory_levels` | Active inventory backfill/webhook code and tests. | Same as `orders`; product-only scope can still retain `variants.inventory_item_external_id` without this table. |

## Specific Questions

### `merchants` vs `shops`

These are related but not exact duplicates. `merchants` is the business/tenant anchor. `shops` is the Shopify platform installation identity. In the current one-Shopify-store implementation, every shop creates one merchant, so the model could be simplified later. It is not safe to merge in this cleanup because all retained canonical records, connector records, ledger events, backfill statuses and jobs currently carry `merchant_id` and active code creates/deletes by merchant.

Recommendation: keep both now. Revisit after deciding whether Jefe must support multiple shops/connectors per merchant.

### `backfill_jobs` vs `shop_backfill_statuses`

These tables both have status fields, but they do not duplicate the same responsibility. `backfill_jobs` is executable queue state: job type, schedule, attempts, running/completed/failed lifecycle and result payload. `shop_backfill_statuses` is domain progress state: products/webhooks/shop readiness, record counts, estimates and progress display.

Recommendation: keep both now. If the backfill worker becomes synchronous or single-step, merge progress into one table then.

### `ledger_events`

`ledger_events` is active infrastructure. `recordSourceEvent` reads it by dedupe key and creates new rows for product backfills and webhooks. Product rows do not replace this because they only hold latest canonical state and raw payload; they do not provide event-level idempotency or webhook delivery audit.

Recommendation: keep.

## Migration Result

Migration `20260722143000_drop_merchant_operating_map_facts` removes the only confirmed orphan from the listed table set. It intentionally refuses to drop a non-empty legacy table in another environment so merchant-supplied Operating Map facts can be reviewed/exported before deletion.
