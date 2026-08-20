# Shopify Action Capabilities

Date: 2026-08-20

This is the operator-facing audit for Shopify actions Jefe may plan around.
The runtime catalog lives in
`apps/shopify/app/lib/actions/shopify-action-capabilities.server.js`.

## Principles

- Planner semantics and execution truth are separate. A workflow can correctly
  say "create a purchase order" while capability resolution says Jefe cannot
  currently execute that operation.
- No capability state collapses automatically into `MERCHANT`. The intended
  actor stays `JEFE`, `MERCHANT` or `EXTERNAL`; availability explains whether
  Jefe can execute it through a typed adapter.
- The LLM never receives arbitrary Shopify GraphQL write access. It may choose
  a bounded semantic tool; deterministic application code resolves identities,
  validates inputs, applies caps and calls typed adapters.
- Shopify scopes stay least-privilege. A missing scope is
  `NEEDS_AUTHORIZATION`, not a reason to request every possible scope.

## Availability States

- `AVAILABLE`: provider supports the operation, Jefe implements it, required
  authorization/config/input is present.
- `NEEDS_AUTHORIZATION`: provider and Jefe support it, but this shop has not
  granted the required scope.
- `NEEDS_CONFIGURATION`: the capability exists but merchant or shop
  configuration is missing.
- `NEEDS_INPUT`: Jefe can execute once the action supplies required bounded
  inputs.
- `PROVIDER_PREVIEW`: Shopify exposes the surface only through an unstable or
  feature-preview API.
- `UNSUPPORTED_BY_JEFE`: Shopify supports it, but Jefe has not implemented a
  typed executor.
- `UNSUPPORTED_BY_PROVIDER`: Shopify does not expose the needed operation
  through an official public app API.

## Implemented Runtime Catalog

| Operation | Provider support | API stability/version | Scopes | Jefe implementation | Current availability |
| --- | --- | --- | --- | --- | --- |
| `shopify.inventory_transfer.create` | Supported | Admin GraphQL `2026-07` | `write_inventory_transfers` | Implemented typed adapter, approval-gated, capped, idempotent directive | `AVAILABLE` when authorized and input is complete |
| `shopify.inventory_purchase_order.read` | Preview/read only | Admin GraphQL `unstable`, Physical Inventory preview | `read_inventory_purchase_orders` | Not implemented | `PROVIDER_PREVIEW` |
| `shopify.inventory_purchase_order.create` | No public create mutation found | No stable or unstable public mutation found on 2026-08-20 | Would require a provider write scope if Shopify adds one | Not implemented | `UNSUPPORTED_BY_PROVIDER` |

## Shopify Purchase Order Finding

Shopify's official Admin GraphQL documentation currently exposes purchase
orders through unstable read queries:

- `inventoryPurchaseOrder`
- `inventoryPurchaseOrders`

No official supplier purchase-order create mutation was found in the stable
Admin GraphQL docs or the unstable purchase-order docs checked on 2026-08-20.
Jefe must not substitute `orderCreate`: Shopify `Order` is a customer order
object, not a supplier purchase order. Jefe must also not automate Shopify
Admin private UI APIs.

Relevant official docs checked:

- https://shopify.dev/docs/api/admin-graphql/unstable/queries/inventoryPurchaseOrder
- https://shopify.dev/docs/api/admin-graphql/unstable/queries/inventoryPurchaseOrders
- https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventoryTransferCreate
- https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventorySetQuantities
- https://shopify.dev/docs/api/admin-graphql/latest/objects/Order

## Coverage Backlog

| Domain | Examples | Provider support | Jefe state | Notes |
| --- | --- | --- | --- | --- |
| Products | update status, title, copy, tags, product type | Supported in Admin GraphQL | Partially implemented for product status/listing work | Keep individual adapters bounded and reversible where possible. |
| Variants | variant metadata, prices, option data | Supported in Admin GraphQL | Not broadly implemented | Price or variant writes need blast-radius and reversal policy per action type. |
| Inventory quantities | set/adjust quantities | Supported in Admin GraphQL | Not implemented as a general executor | Requires exact inventory item/location inputs and strong caps. |
| Inventory transfers | create transfer | Supported in Admin GraphQL | Implemented | Existing first write path for replenishment logistics. |
| Purchase orders | supplier PO read/create | Read preview only; create unavailable in public docs | Not implemented | Runtime availability is `UNSUPPORTED_BY_PROVIDER` for create. |
| Orders | customer order create/update/cancel | Supported in Admin GraphQL | Not implemented for supplier workflows | Do not use customer orders as supplier purchase orders. |
| Draft orders | create/update/send invoice | Supported in Admin GraphQL | Not implemented | Relevant to merchant sales operations, not replenishment PO creation. |
| Fulfilment | fulfilment orders, holds, tracking | Supported in Admin GraphQL | Not implemented | Higher operational risk; needs dedicated safety model. |
| Returns/refunds | return/refund operations | Supported in Admin GraphQL | Not implemented | Refunds are not trivially reversible; require separate safety policy. |
| Discounts | discount codes/automatic discounts | Supported in Admin GraphQL | Not implemented | Needs caps, expiry, combinability and margin guardrails. |
| Customers | tags, metadata, segments | Supported in Admin GraphQL | Not implemented | Must avoid exposing merchant-customer PII to AI tooling. |
| Collections | collection membership/rules | Supported in Admin GraphQL | Not implemented | Candidate for bounded merchandising actions. |
| Metafields | product/customer/order metafields | Supported in Admin GraphQL | Not implemented broadly | Schema/config required before writes are safe. |
| Locations | read/manage locations | Mostly read/configuration oriented for this product | Read through inventory evidence | Writes require clearer merchant-facing use case. |

## Runtime Use

The focused-action replanner receives capability context, but it remains a
semantic planner. It can decide a purchase order belongs in the desired
workflow. Server-side capability resolution then stamps that workspace item
with `intendedActor: JEFE` and `capabilityAvailability:
UNSUPPORTED_BY_PROVIDER`, producing an integration-limitation focus instead of
a false merchant task.
