# Part 1 — Final architecture

## The four tools

`app/lib/shopify/gateway/tools.server.js` exports `SHOPIFY_GATEWAY_TOOL`:

- `shopify_schema` — targeted schema discovery: `action` is one of `search` (keyword/relevance
  search over root Query/Mutation fields), `inspect_field`, `list_fields`, `inspect_enum`,
  `inspect_input`. Never dumps the full schema into context. Optional per turn — every agent's
  prompt tells the model it does not need to call this before every read/write, only when it isn't
  sure a field or argument exists.
- `shopify_query` — arbitrary agent-composed read-only GraphQL. Structurally cannot execute a
  mutation: `analyzeGatewayDocument` (below) rejects anything but a single, unambiguous query
  operation before it reaches Shopify, regardless of what the tool call claims.
- `shopify_prepare_mutation` — validates, classifies, and previews an agent-composed mutation
  *without* executing it (no network call, no ledger row). Returns the risk tier and whether
  `shopify_execute_mutation` will demand explicit confirmation.
- `shopify_execute_mutation` — executes a validated mutation through the same universal gateway
  (`api/gateway.server.js`) every write in this app goes through: accepted-Action-revision
  authorization, live-scope checks, blast-radius/pricing-intent guard, explicit high-risk
  confirmation, idempotency, and the durable `ShopifyOperationCall` ledger all apply unchanged.

Recommendation/verification mode (and chat) only ever receive `shopify_schema` + `shopify_query` —
the two mutation tools are omitted from the tool list entirely at each call site, not merely
instructed against.

## The validation pipeline (document.server.js)

`analyzeGatewayDocument({ documentText, mode, variables, schemaIndex })` is the layer that must
never rely on the model voluntarily obeying instructions. Every check is structural — parsed AST
shape, never operation-name string matching, never "did the model say this was read-only":

1. Parse with `graphql`'s `parse()`. Syntax errors fail closed (`GRAPHQL_SYNTAX_ERROR`).
2. Reject named fragments (`FRAGMENTS_NOT_SUPPORTED`) and any non-operation definition
   (`UNSUPPORTED_DEFINITION`).
3. Require exactly one operation definition.
4. The operation's kind (`query`/`mutation`, including the anonymous-query shorthand) must match
   the calling tool's `mode` (`QUERY_ONLY` for `shopify_query`, `MUTATION_ONLY` for
   `shopify_prepare_mutation`/`shopify_execute_mutation`) — `SAFETY_OPERATION_KIND_MISMATCH`
   otherwise. This is what makes a mutation-shaped document sent to `shopify_query` fail before any
   network call, no matter what tool name or arguments claim.
5. Reject a second root selection smuggled alongside a reviewed one (no hidden multi-mutation
   documents).
6. Reject any directive outside `include`/`skip`.
7. Structural size/depth/pagination caps: `MAX_SELECTION_DEPTH = 12`, `MAX_SELECTION_NODES = 400`,
   `MAX_PAGE_SIZE = 250` (checked from both literal page-size arguments and bound variables).
8. Best-effort argument validation against the schema index, when the root field is present there.
9. A mutation's selection set must include `userErrors` — an HTTP 200 alone must never look like
   success.
10. On success: a normalized, printable document (`graphql`'s `print(ast)`) plus the inferred
    `rootField`, `operationKind`, `domain` (via `domain-taxonomy.server.js`,
    `classifyShopifyOperationDomain`), `requiredScopes`/`scopeConfidence` (via
    `inferShopifyOperationScopes`), and `safety`/`execution` (via `mutation-safety.server.js`,
    `classifyShopifyOperationSafety` — the exact same classifier the old catalog path used, just
    fed inferred values instead of catalog-stored ones).

20 adversarial tests in `tests/agentic-shopify-gateway-safety.test.mjs` exercise this layer
directly (aliased mutations, inline fragments, smuggled second root fields, malformed GraphQL
intended to defeat the parser, pagination-cap literal vs. bound-variable evasion, depth-limit
evasion, missing `userErrors`, etc.) — all still pass.

## The synthetic-stub seam (synthetic-stub.server.js)

`buildSyntheticGatewayStub({ analysis, apiVersion })` turns a validated `analyzeGatewayDocument`
result into exactly the `ShopifyApiOperationStub` shape `api/gateway.server.js`'s
`executeShopifyOperation` used to receive from a catalog lookup — this is the seam that lets the
Gateway reuse idempotency, accepted-Action-revision authorization, blast-radius, explicit
confirmation, and the durable ledger unchanged. The one field that differs in kind from a catalog
stub: `document` is the agent's own printed GraphQL text (via `print()`, which also strips comments
and whitespace noise), not a pre-generated bounded document. `arguments`/`inputObjects`/`enumTypes`
are left empty on purpose — real argument-shape validation already happened deterministically in
`analyzeGatewayDocument`, and `executeShopifyOperation` no longer re-validates variables against
stub metadata for this reason (see Part 2 for the removed `validateShopifyOperationVariables` call).

`executeShopifyOperation`'s `stubOverride` parameter is now the *only* way to reach the pipeline —
see Part 2 for what was removed to make that true.

## Schema source (schema-index.server.js / schema-cache.server.js)

The Gateway's local schema index is built from a pinned JSON snapshot
(`gateway/schema-cache/shopify-admin-schema-2026-07.json`, loaded via
`loadPinnedShopifySchemaCache()`) — reusing the same generated-catalog data `api/catalog.server.js`
loads, as the most complete locally-available real-schema snapshot, not a re-adoption of the
catalogue's retrieval/binding behavior. This is a deliberate, swappable choice: nothing prevents
pointing it at a fresh raw GraphQL introspection dump instead, and doing so requires no change to
`document.server.js` or the tool dispatchers.

Coverage gap, honestly stated: the schema index only has argument/input-object/enum metadata for
operations present in that snapshot. An operation released after the snapshot was generated still
gets a real, non-dead-end classification (proven by
`tests/agentic-shopify-gateway-safety.test.mjs`'s "an operation absent from the local catalog
snapshot still gets a real, non-dead-end classification" and
`tests/shopify-api-catalog-full.test.mjs`'s synthetic `widgetFrobnicate` end-to-end test) — it just
skips the best-effort argument pre-check and relies on Shopify's own GraphQL layer to reject a
malformed argument at execution time, surfaced back to the model via `formatShopifyGatewayError`
(Part 2).
