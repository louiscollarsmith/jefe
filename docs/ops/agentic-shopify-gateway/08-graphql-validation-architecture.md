# Part 8 — GraphQL validation architecture

Implementation: `apps/shopify/app/lib/shopify/gateway/document.server.js`, function
`analyzeGatewayDocument({ documentText, mode, variables, schemaIndex })`. Uses the `graphql` npm
package (v16, now an explicit `apps/shopify/package.json` dependency — it was previously only a
transitive dependency of dev tooling, not something production server code imported directly).

## Pipeline

| # | Check | Mechanism | Rejection code |
| - | --- | --- | --- |
| 1 | Valid syntax | `graphql`'s `parse()` | `GRAPHQL_SYNTAX_ERROR` |
| 2 | No fragments | AST definition-kind scan | `FRAGMENTS_NOT_SUPPORTED` |
| 3 | Exactly one operation | count `OperationDefinition`s | `MULTIPLE_OPERATIONS_IN_DOCUMENT` |
| 4 | No subscriptions | `operation.operation` check | `SUBSCRIPTIONS_NOT_SUPPORTED` |
| 5 | Operation kind matches tool mode | `operation.operation` vs `mode` | `SAFETY_OPERATION_KIND_MISMATCH` |
| 6 | Only `@include`/`@skip` directives | directive name allowlist walk | `DIRECTIVE_NOT_SUPPORTED` |
| 7 | Top-level selections are plain fields | selection-kind check | `INLINE_FRAGMENT_NOT_SUPPORTED` |
| 8 | Exactly one root field (mutations only) | selection count | `MULTIPLE_ROOT_MUTATION_FIELDS` |
| 9 | Depth ≤ 12, nodes ≤ 400 | recursive selection walk | `STRUCTURAL_LIMIT_EXCEEDED` |
| 10 | `first`/`last` ≤ 250 (literal or bound variable) | arg-value walk | `STRUCTURAL_LIMIT_EXCEEDED` |
| 11 | Mutation payload selects `userErrors` | selection-name walk | `MUTATION_MUST_SELECT_USER_ERRORS` |
| 12 | Known-field argument names/required-ness (best effort) | schema-index lookup, skipped if field unknown | `UNKNOWN_ARGUMENT` / `MISSING_REQUIRED_ARGUMENT` |

Every rejection returns `{ ok: false, code, message, repairable: true }` — `message` is written to be
directly actionable by the agent in its next turn (see `04-recommendation-query-mode-design.md`).

## Why no full schema validation (e.g. `graphql`'s `validate()` against a `GraphQLSchema`)

`validate()` requires a complete `GraphQLSchema` object, which requires either a fresh live
introspection fetch or a complete previously-saved raw introspection dump. Neither was available this
session (`13-known-limitations.md`) — the checked-in "REAL-INTROSPECTION" file is actually catalogue
output (810 per-operation argument/input/enum snapshots), not a raw `__schema` dump, and
`JEFE_GOLDEN_PATH_SHOPIFY_ADMIN_ACCESS_TOKEN` is unset in this dev environment. Check 12 above is the
best-effort substitute this session could build: real argument-name and required-ness validation for
any root field the local index happens to know about (810 of them), honestly skipped for anything it
doesn't. What check 12 cannot catch — a bad field deep in a selection set on an output type, e.g.
`variant.nonExistentField` — is caught by Shopify's own GraphQL layer instead, via
`normalizeGatewayProviderError()`, which is the explicitly sanctioned fallback per the task brief
("If Shopify rejects a field or arguments, return a compact error that allows the LLM to repair its
query"). When a live token is available, swapping the schema-index source for a fresh introspection
result and adding real `buildClientSchema()` + `validate()` is a bounded follow-up, not a redesign —
see `14-migration-rollback-strategy.md`.

## Output — a validated, printable document

On success, `analyzeGatewayDocument()` returns the re-printed document (`graphql`'s `print()`, which
normalizes whitespace and strips comments) plus `operationKind`, `rootField`, `domain`,
`requiredScopes`, `scopeConfidence`, `safety`, `execution`, and `knownInSchemaIndex`. This is the
exact shape `synthetic-stub.server.js` consumes to build a `ShopifyApiOperationStub`-compatible
object for `gateway.server.js`.
