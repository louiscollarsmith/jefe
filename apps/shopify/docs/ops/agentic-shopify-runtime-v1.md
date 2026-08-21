# Agentic Shopify Runtime V1

This is the clean runtime path for broad Shopify operation use.

## What Changed

Jefe now has a generated Shopify Admin GraphQL operation catalogue in
`app/lib/shopify/api/catalogs/`. It describes Shopify API operations, not Jefe
business features. The catalogue includes operation kind, arguments, input
objects, enum values, return type, deprecation, required scopes where known,
and a bounded GraphQL document for each supported stub.

`retrieveShopifyApiOperations()` returns a small relevant subset for Luna rather
than putting the whole Shopify surface into each model turn.

`executeShopifyOperation()` is the universal server-side gateway. It validates:

- operation exists in the generated catalogue,
- API version matches the running app,
- variables match the generated argument/input metadata,
- actual granted Shopify scopes include the operation's required scopes,
- mutations have an accepted current Action revision,
- requested material effect fits the accepted semantic Action,
- generic blast-radius and destructive-operation checks pass.

The gateway records every admitted or denied operation in
`shopify_operation_calls`. That ledger is operation-level and covers reads as
well as writes; the existing `action_execution_writes` table remains the
per-target write ledger for legacy typed adapters.

## Runtime Loop

`generateAgenticShopifyRecommendation()` gives Luna Merchant Memory, bounded
store evidence, an initial compact API subset, and two model-facing tools:

- `retrieve_shopify_operations` searches the generated Shopify operation
  catalogue during the same run.
- `call_shopify_operation` runs read operations through the universal gateway
  during investigation.

Recommendation mode rejects mutations. Luna must form hypotheses, retrieve
relevant API stubs, run bounded reads where needed, and then either return a
semantic recommendation or explain why no actionable opportunity survived the
investigation. The recommendation is not tied to legacy action types or
`execute:<feature>:<use-case>` bindings.

`materializeAgenticShopifyAction()` turns that recommendation into a semantic
Merchant Action: outcome, scope, constraints, expected material Shopify effects,
supporting memory IDs and a verification plan. The technical Shopify sequence
is deliberately not materialised as workflow steps.

`acceptAgenticShopifyAction()` stamps `acceptedActionRevision` onto the current
semantic Action revision. That accepted revision is the authorization boundary
for all later mutations; there is no second merchant approval per Shopify
operation.

`runAgenticShopifyExecution()` then gives Luna the accepted Action and the same
retrieval/call tools. Luna chooses the next read or write, receives the actual
gateway result, can retrieve more stubs mid-run, and continues until the
accepted outcome is verified or a bounded blocker occurs. Completion requires
read-back after writes; provider mutation success alone is not enough.

The gateway also handles idempotent write replay. A duplicate matching
idempotency key returns `IDEMPOTENT_REPLAY` without another provider call. A
previous write with an unknown result returns `NEEDS_RECONCILIATION` so the
agent must inspect Shopify state before retrying.

## Regeneration

Run:

```bash
npm run shopify:api:generate
```

With no arguments, the command validates the checked-in generated catalogue and
writes a diff report. To refresh from a schema export:

```bash
npm run shopify:api:generate -- --introspection=path/to/admin-schema.json
```

For an explicitly allowed development shop:

```bash
npm run shopify:api:generate -- --shop=dev-store.myshopify.com --token-env=DEV_SHOPIFY_ADMIN_TOKEN
```

Do not use production merchant tokens for generation.

## Validation

Deterministic runtime validation:

```bash
npm run eval:agentic-shopify-runtime
```

That runner covers:

- an unseen multi-operation collection Action;
- a second unrelated product-metafield Action;
- dynamic retrieval during recommendation and execution;
- accepted Action revision enforcement;
- read-back verification;
- idempotent replay and unknown-result reconciliation.

Live stages are opt-in because they call external systems:

```bash
npm run eval:agentic-shopify-runtime -- --live-luna
npm run eval:agentic-shopify-runtime -- --live-luna --real-shopify
```

Real dev-Shopify execution requires `JEFE_GOLDEN_PATH_SHOPIFY_WRITE_ENABLED`,
an allowlisted `JEFE_GOLDEN_PATH_SHOPIFY_SHOP`, and either an explicit
development Admin token or a local offline Session row for that shop.

## Current Limits

This runtime does not remove the existing typed adapters or workflow tables.
Historical Actions continue to use their compatibility paths. New agentic
Shopify Actions use the semantic Action runtime and universal gateway instead
of legacy action-type dispatch.

The accepted-intent guard is deliberately conservative. It blocks obvious drift
such as pricing writes during a collection Action, stale accepted revisions,
missing scopes, broad resource blasts and destructive operations not named in
the accepted Action.
