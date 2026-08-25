# Part 4 — Recommendation/query-mode design

## Tools available

`shopify_schema` and `shopify_query` only. `shopify_prepare_mutation`/`shopify_execute_mutation` are
absent from the tool list passed to the model in this mode, and the dispatcher refuses them anyway
if called (`03-security-model.md`, Layer 1).

## `shopify_schema`

`{ action: "search"|"inspect_field"|"list_fields"|"inspect_enum"|"inspect_input", query?, fieldName?,
typeName?, kind?, prefix?, limit? }` — see `07-tool-schemas.md` for the full schema. Returns compact,
bounded summaries (`schema-index.server.js`'s `summarizeField`/`compactTypeMap`), never a full type
dump.

## `shopify_query`

`{ document, variables? }`. The agent writes real Admin GraphQL. `analyzeGatewayDocument()` in
`GATEWAY_MODE.queryOnly` validates it; on success the *normalized* document (re-printed via
`graphql`'s `print()`, which also strips comments) is sent to Shopify via the same
`ShopifyAdminGraphqlClient` the rest of the app uses. On failure, the tool result's `error.code` is
one of the codes in `03-security-model.md` and `error.message` is written to be directly actionable
("Directive `@exfiltrate` is not supported..." / "productDelete has no known argument `id`. Known
arguments: input.") — this is the repair-loop contract: the agent reads the error and tries again in
its next turn, with no special-casing needed in the orchestration loop.

## The repair loop in practice

Observed directly in the real run recorded in `11-real-recommendation-run-trace.md`: the model used
`shopify_schema` eight times across six turns trying different discovery strategies (search, then
`inspect_field` on object type names — which failed, a real coverage gap — then `list_fields`, then
search again) before writing a `shopify_query` document that validated on its first attempt. The
validator never had to reject and repair a GraphQL document in that specific run because the model's
first written document was already structurally valid; the reject/repair mechanic itself is proven
separately and repeatably by the automated test suite (`09-adversarial-safety-test-results.md`),
which exercises every rejection code including malformed syntax.

## Why recommendation mode's read boundary doesn't need per-operation review

Reads are broadly trusted by `classifyShopifyOperationSafety()`'s existing "reads-broadly-available-v1"
policy — a read cannot mutate merchant state, so every query is `AUTONOMOUS_ELIGIBLE` by default,
except a small `SENSITIVE_READ_PATTERN` carve-out (disputes, payment mandates, credit cards, tax
exemptions) and the `privacy_compliance` domain, both of which require `APPROVAL_REQUIRED`. This
logic is untouched by the gateway — it already worked for arbitrary operation names, not just
catalogue-known ones, because it's a structural rule.
