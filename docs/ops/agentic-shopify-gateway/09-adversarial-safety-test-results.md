# Part 9 — Adversarial safety test results

`apps/shopify/tests/agentic-shopify-gateway-safety.test.mjs` — **20/20 passing**, run 2026-08-25.
Every case maps directly to an item on the task brief's adversarial list.

```
ok 1  - shopify_query rejects an explicit mutation document
ok 2  - shopify_query rejects an aliased mutation (aliasing doesn't change operation type)
ok 3  - rejects multiple operations in one document (query+mutation together)
ok 4  - rejects a named fragment used to indirect a mutation selection
ok 5  - rejects an inline fragment at the operation root
ok 6  - rejects a second root mutation field smuggled alongside a reviewed one
ok 7  - rejects malformed GraphQL intended to defeat the parser
ok 8  - allows introspection through the query tool (it is schema-shaped, not a mutation)
ok 9  - rejects a mutation-typed field wrapped as a query even though its name reads like a query
ok 10 - rejects an unsupported/unknown directive
ok 11 - rejects a mutation document that omits userErrors (HTTP 200 ≠ success)
ok 12 - rejects pagination past the gateway cap, from a literal
ok 13 - rejects pagination past the gateway cap, from a bound variable
ok 14 - rejects a document nested past the structural depth limit
ok 15 - a genuinely valid read passes and is normalized/printable
ok 16 - a genuinely valid mutation passes, classifies, and builds an executable synthetic stub
ok 17 - an operation absent from the local catalog snapshot still gets a real, non-dead-end classification
ok 18 - recommendation mode's tool dispatcher never exposes the mutation tools at all
ok 19 - verification mode's tool dispatcher also refuses mutation tools
ok 20 - shopify_query with a mutation document is rejected structurally even in recommendation mode

tests 20, pass 20, fail 0
```

## Coverage against the task's explicit adversarial list

| Adversarial vector requested | Test(s) | Result |
| --- | --- | --- |
| Explicitly emits a mutation | 1 | rejected, `SAFETY_OPERATION_KIND_MISMATCH` |
| Aliases a mutation | 2 | rejected, same code — aliasing is cosmetic to the AST |
| Multiple operations in one document | 3 | rejected, `MULTIPLE_OPERATIONS_IN_DOCUMENT` |
| Fragments/directives to hide write behaviour | 4, 5, 10 | rejected — fragments banned outright, inline fragments banned, non-standard directives banned |
| Query and mutation operations in same document | 3 | same as above (one document, one operation, full stop) |
| Malformed GraphQL to bypass the parser | 7 | rejected, `GRAPHQL_SYNTAX_ERROR` |
| Introspection tricks | 8, 9 | introspection itself is fine (it's a query); test 9 proves a mutation-typed field can't be smuggled in as if it were a query-shaped read |
| Prohibited operation through a query-shaped wrapper | 9 | `bulkOperationRunQuery` — a real Shopify mutation whose *name* reads like a query — rejected when wrapped as a query, proving classification never trusts the name |
| (not explicitly listed, found during design) Multiple mutation fields in one mutation operation | 6 | rejected, `MULTIPLE_ROOT_MUTATION_FIELDS` — see `03-security-model.md` |
| (not explicitly listed) HTTP 200 treated as success without checking business errors | 11 | rejected before execution if `userErrors` isn't selected — see Part 6 of the design brief |

## Regression check against the existing catalogue path

Ran the three pre-existing Shopify gateway/safety test files after making the `stubOverride` addition
to `gateway.server.js` and adding `graphql` as a direct dependency:

```
tests/mutation-safety-classifier-audit.test.mjs   9/9 passing
tests/shopify-api-gateway.test.mjs
tests/shopify-eval-mode-isolation.test.mjs
tests/shopify-api-catalog-full.test.mjs           29/29 passing (combined)
```

Zero regressions. The `stubOverride` parameter is additive and `undefined` for every existing caller,
so catalogue-path behaviour is unchanged by construction, not just by testing.
