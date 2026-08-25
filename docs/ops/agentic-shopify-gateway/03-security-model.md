# Part 3 — Security model

## The core invariant

No safety boundary in this design depends on the model voluntarily obeying an instruction. Every
claim below is backed by a passing automated test in
`apps/shopify/tests/agentic-shopify-gateway-safety.test.mjs` (20/20 passing) — cite the test name,
not the prompt wording, when asking "why can't the model do X."

## Layer 1: tool availability (defense in depth, not the real boundary)

`recommendationMode`/`verificationMode` contexts never receive `shopify_prepare_mutation` /
`shopify_execute_mutation` in the tool list, and `runShopifyGatewayTool` refuses those tool names
outright (`MUTATION_TOOL_UNAVAILABLE`) even if a caller mistakenly dispatches one. This is
convenience and defense in depth — **not** the real boundary, because a model that hallucinates or
is instructed to call `shopify_query` with mutation-shaped GraphQL must still fail. It does:
`analyzeGatewayDocument()` rejects a `mutation { ... }` document handed to the query-only path with
`SAFETY_OPERATION_KIND_MISMATCH`, purely from the parsed AST's `operation.operation` tag.

## Layer 2: parsed-AST structural rejection (the real boundary)

`document.server.js`, in order:

1. **Parse.** Malformed GraphQL never reaches any later stage (`GRAPHQL_SYNTAX_ERROR`).
2. **No fragments, anywhere.** Named fragment definitions and inline fragments are rejected
   outright. Closes the entire "use a fragment to indirect a mutation selection" attack class by
   removing the mechanism rather than pattern-matching its uses.
3. **Exactly one operation definition per document.** Closes "smuggle a mutation alongside a query
   in one document."
4. **Operation kind must match the calling tool's mode**, checked against the AST's `operation.operation`
   field (`"query"` / `"mutation"`), never against the field name being called. Verified directly:
   `bulkOperationRunQuery` is, in Shopify's real schema, a **mutation**-type root field despite its
   name — wrapping it in `mutation { bulkOperationRunQuery(...) }` and handing it to the query-only
   tool is rejected (`SAFETY_OPERATION_KIND_MISMATCH`), proving name-shape is never the signal.
5. **Exactly one top-level field in a mutation document.** Closes "smuggle a second, unreviewed
   mutation field alongside an approved one in the same operation" (GraphQL legally allows multiple
   top-level mutation fields, executed serially — this is a real bypass class, not a hypothetical
   one).
6. **Only `@include`/`@skip` directives allowed**, everything else rejected.
7. **Structural size limits**: selection depth ≤ 12, total selection-node count ≤ 400, `first`/`last`
   pagination arguments ≤ 250 (checked against both literal values and bound variable values).
8. **Mutation payloads must select `userErrors`.** Otherwise rejected before execution — see Part 6
   below; this is what makes "HTTP 200 = success" structurally impossible to assume.
9. **Best-effort argument-name/required-ness check** against the schema index, when the root field is
   known there — skipped (deferred to Shopify's live response) when it isn't, which is the honest
   behaviour given the local index's coverage gap (see `13-known-limitations.md`).

## Layer 3: structural risk classification (reused, unchanged)

Every validated mutation is run through `classifyShopifyOperationSafety()` — the same function the
catalogue path uses, unmodified. An agent cannot talk its way into a lower risk tier: risk comes from
operation-name shape and domain, computed server-side, never from the `purpose`/`expectedEffect`
strings the model supplies (those are recorded for audit, never read by the classifier).

## Layer 4: execution-time authorization (reused, unchanged)

`executeShopifyOperation()` — accepted-Action-revision check, live Shopify granted-scope check
(never a cached/local assumption), blast-radius cap, explicit high-risk confirmation requirement,
idempotent-replay/reconciliation handling, durable `ShopifyOperationCall` ledger row for every
admitted-or-denied attempt. Identical code path to the catalogue surface; see
`02-architecture-decision.md` for why this was reused rather than reimplemented.

## Why Shopify's own schema is a second, independent backstop

Even a gap in the local structural checks doesn't grant execution: `executeShopifyOperation()`
sends the exact validated document to Shopify's real Admin API, and Shopify's own schema physically
does not expose mutation-type fields under the root `Query` type (or vice versa) — a document that
somehow slipped a mutation-typed field into a `query { ... }` operation would fail at Shopify's
GraphQL layer with a normal "field does not exist on type Query" error, not execute. This is
structural at the protocol level, not something Jefe's validator has to get perfectly right alone.

## Why the adversarial cases are enumerated explicitly, not summarized

The multi-root-mutation-field check (item 5 above) is the least obvious of the nine checks: kind
checking and fragment-banning alone would still let a document like
`mutation { a: productUpdate(...) { userErrors{...} } b: collectionDelete(...) { userErrors {...} } }`
through, executing an unreviewed second mutation serially alongside a reviewed one — GraphQL legally
permits multiple top-level mutation fields in one operation. It was designed in from the start
precisely because the task's adversarial list ("includes multiple operations in one document") is
easy to read as only covering separate `OperationDefinition`s, not multiple fields within one. This
is why `09-adversarial-safety-test-results.md` lists every case explicitly with its own test and
rejection code, rather than summarizing "mutations are blocked" — a summary would have hidden
exactly this kind of distinction.
