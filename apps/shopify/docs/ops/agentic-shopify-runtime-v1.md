# Agentic Shopify Runtime V1

This is the first clean runtime slice for broad Shopify operation use.

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

## Current Limits

This slice does not remove the existing typed adapters or workflow tables. It
adds the generated API substrate and gateway beside them so recommendation and
execution agents can migrate without breaking live action paths.

The accepted-intent guard is deliberately conservative. It blocks obvious drift
such as pricing writes during a collection Action, stale accepted revisions,
missing scopes, broad resource blasts and destructive operations not named in
the accepted Action.
