# Part 2 — Architecture decision

## The shape

```
Merchant evidence/problem
        |
       LLM
        |<-----------------------+
        v                        |
  shopify_schema (discovery)     |
        |                        |
  shopify_query /                |
  shopify_prepare_mutation       |
        |                        |
  analyzeGatewayDocument()  -----+  (deterministic reject + repairable error)
  [parse -> AST safety checks -> structural limits -> best-effort arg check]
        |  ok
        v
  classifyShopifyOperationSafety()  (unchanged, reused)
        |
  shopify_execute_mutation -> executeShopifyOperation({ stubOverride }) (unchanged, reused)
        |
  Shopify Admin GraphQL API
```

## Four tools, not 810 — and not a rename of the same 810

`shopify_schema`, `shopify_query`, `shopify_prepare_mutation`, `shopify_execute_mutation`
(`app/lib/shopify/gateway/tools.server.js`). This is smaller than the task brief's own suggested
four-tool sketch would imply is a stretch goal — it *is* the four-tool sketch. No MCP tool wraps
an individual Shopify operation; `shopify_query`/`shopify_execute_mutation` accept an arbitrary,
agent-composed GraphQL document string, not a pointer into a pre-generated stub table.

## Why the catalogue's data is still the schema-index *source*, and why that's not a contradiction

`schema-index.server.js` builds its search/inspect index from the checked-in generated catalogue
JSON. This looks, at a glance, like exactly the thing Part 2 says not to do. It isn't, for one
specific reason: **the validator never restricts which operations the agent may reference to what's
in that index.** `document.server.js`'s classification path
(`classifyShopifyOperationDomain` + `classifyShopifyOperationSafety`, both pure functions of an
operation *name*, not a catalogue lookup) works identically for an operation the catalogue has never
seen — proven directly in `agentic-shopify-gateway-safety.test.mjs`
("an operation absent from the local catalog snapshot still gets a real, non-dead-end
classification"). The catalogue JSON is this session's most complete available snapshot of real
Shopify type/argument/enum data (no live token was available to introspect fresh — see
`13-known-limitations.md`); when a live token is available, `loadGatewaySchemaIndex()` can be pointed
at a fresh introspection result with no change to the validation or execution path. The architecture
property that matters — Shopify's schema is authoritative, Jefe pre-defines nothing — holds either
way.

## Why the existing mutation-safety classifier was reusable unchanged

`mutation-safety.server.js`'s `classifyShopifyOperationSafety({ operation, operationKind, domain,
scopeConfidence })` was already, as of the 2026-08-25 execution-safety architecture change (see root
`CLAUDE.md`), a pure structural function with no dependency on catalogue membership. It was written
for a different reason (removing the permanent per-operation deny-list), but it happens to be exactly
the reusable primitive a schema-driven gateway needs: risk classification by operation-name shape and
domain, not by "do we have a stub for this." This is a case where two initiatives (execution-safety
generalization, catalogue-vs-gateway experiment) turned out to want the same underlying design.

## Why the execution path reuses `gateway.server.js` via a synthetic stub, not a parallel implementation

`executeShopifyOperation()` already does everything Part 5/6 of the task brief asks for: accepted-
Action-revision authorization, blast-radius caps, explicit high-risk confirmation, idempotent replay,
`userErrors`-vs-HTTP-200 distinction, and the durable `ShopifyOperationCall` ledger. Reimplementing
that for agent-composed GraphQL would either diverge from the catalogue path's safety behaviour over
time, or require keeping two implementations in lockstep by hand — the exact maintenance burden this
experiment is supposed to be testing an alternative to. Instead, `synthetic-stub.server.js` builds an
object shaped exactly like a `ShopifyApiOperationStub`, and a 3-line addition to
`gateway.server.js` (`input.stubOverride ?? getShopifyApiOperationStub(...)`) lets the gateway pass
it straight into the unchanged pipeline. All 29 pre-existing gateway tests pass unmodified, which is
the concrete evidence that this seam didn't alter catalogue-path behaviour.

## Why fragments and multi-field mutation documents are banned outright, not merely restricted

The task's adversarial list ("fragments/directives to hide write behaviour," "multiple operations in
one document") could be handled with narrower carve-outs. `document.server.js` instead disallows
named fragments and inline fragments entirely, and requires exactly one top-level field in any
mutation document. This is a deliberate simplicity-over-flexibility call: the gateway's job is
"validate GraphQL a model wrote," not "support every legal GraphQL construct," and eliminating a
whole syntactic category is far easier to reason about as airtight than allow-listing safe uses of
it. The cost is real but small — an agent that wants two related mutations issues two
`shopify_execute_mutation` calls instead of one document with two root fields; each still goes
through its own full classification/confirmation/ledger cycle, which is arguably the more correct
behaviour anyway (independent confirmation per side effect, not one confirmation covering two).
