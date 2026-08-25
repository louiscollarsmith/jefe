# Part 8 — Tracing the document through every Gateway transformation

```text
LLM-generated document → tool argument parsing → GraphQL parse() → Gateway AST validation →
print(ast) → variables normalization → client.request(...) → Shopify HTTP request
```

For every reproduction attempt in this report, the raw tool-call argument the model produced
(`turn.toolCalls[].arguments.document`, captured before any Gateway processing) was compared against
the executed tool result's `facts.document` (the value `analyzeGatewayDocument()` returns as
`normalizedDocument = print(ast)`, i.e. after parse-and-reprint).

**Result: identical in every attempt, character-for-character modulo GraphQL's own whitespace/
formatting normalization (which `print()` always applies and which never changes semantics).**
`document.server.js`'s `analyzeGatewayDocument()` (read in full for this investigation) does exactly
what its own header comment says: parse → structural/size checks → `classifyShopifyOperationDomain`/
`classifyShopifyOperationSafety` (read-only classification, no document mutation) → `print(ast)`. It
never rewrites string literal contents, variable values, or argument values — there is no step in
this path capable of altering a search-filter string, an id list, or any other argument value.

Variables (`analysis` output does not touch `variables` at all — they are passed through
`runValidatedQuery(ctx, tool, analysis, variables)` unchanged from `handleQueryTool`'s
`asVariables(args.variables)`, a pure type-guard with no transformation) were likewise identical
between the raw tool-call argument and what reached `ctx.client.request()`.

## Verdict

**`GATEWAY_TRANSFORM_CORRUPTION`: ruled out, definitively.** Every one of the four bad-query
mechanisms found in this investigation (grouped search DSL, internal-id-as-GID, wrong field name,
query-cost limit) originates in what the model generated, not in anything the Gateway's deterministic
validation/normalization layer did to it. This matches the prior investigation's assumption
(`capture-product-margin-data`'s successful query took the identical code path) but is now proven
directly rather than inferred, using the actual document text this investigation recovered.
