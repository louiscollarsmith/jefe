# Shopify Mutation Surface Reconciliation

Generated: 2026-08-25T09:41:35.186Z
Catalog: `shopify-admin-api:2026-07` (2026-07)

## Headline distribution (task §18)

```text
TOTAL MUTATIONS: 523

EXECUTABLE_STANDARD: 14
EXECUTABLE_SENSITIVE_CONFIRMATION: 102
EXECUTABLE_DESTRUCTIVE_CONFIRMATION: 75
EXECUTABLE_SYSTEM_CRITICAL_CONFIRMATION: 332

NOT EXECUTABLE DUE TO JEFE'S OWN MISSING SUPPORT: 0
```

Every mutation the generated catalog carries has a generic execution path — there is no
operation-review gate left to satisfy before a schema-valid mutation can execute. Remaining
friction is entirely about *how much confirmation* an invocation needs, and separately, live
Shopify scope authorization (never fabricated — enforced at request time by gateway.server.js,
not by this static classification). Queries: none of the 287 reads are excluded from
discovery or (subject to live scope) execution; see the interaction breakdown below.

## By interaction tier (mutations)

| Interaction | Count |
| --- | --- |
| SYSTEM_CRITICAL_CONFIRMATION_REQUIRED | 332 |
| EXPLICIT_HIGH_RISK_CONFIRMATION_REQUIRED | 177 |
| APPROVAL_REQUIRED | 14 |

## By classification source (mutations)

| Source | Count |
| --- | --- |
| STRUCTURAL_NAME_INFERENCE | 496 |
| EXPLICIT_OPERATION_OVERRIDE | 9 |
| EXPLICIT_KNOWN_DANGEROUS | 8 |
| REVIEWED_OPERATION_FAMILY_POLICY | 8 |
| EXPLICIT_KNOWN_GOOD | 2 |

## By domain (mutations)

| Domain | Total | Executable |
| --- | --- | --- |
| app_platform | 66 | 66 |
| subscriptions | 49 | 49 |
| financial_payment | 45 | 45 |
| discounts_promotions | 38 | 38 |
| b2b_company | 32 | 32 |
| fulfillment | 31 | 31 |
| products | 19 | 19 |
| inventory_transfers | 19 | 19 |
| marketing | 18 | 18 |
| collections | 17 | 17 |
| markets_international | 16 | 16 |
| customers | 16 | 16 |
| inventory | 15 | 15 |
| orders | 14 | 14 |
| content | 13 | 13 |
| publishing_channels | 13 | 13 |
| draft_orders | 12 | 12 |
| navigation | 12 | 12 |
| order_edits | 12 | 12 |
| returns | 12 | 12 |
| metaobjects | 9 | 9 |
| privacy_compliance | 8 | 8 |
| other_unknown | 8 | 8 |
| gift_cards | 8 | 8 |
| metafields | 8 | 8 |
| variants | 8 | 8 |
| customer_segments | 4 | 4 |
| refunds | 1 | 1 |

## Queries

Total: 287. Executable: 287.

