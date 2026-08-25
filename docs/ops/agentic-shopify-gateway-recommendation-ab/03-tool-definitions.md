# Part 3 — Model-visible Gateway tool definitions (recommendation mode)

Only two of the gateway's four tools are ever offered during recommendation investigation:
`shopify_schema` and `shopify_query`. `shopify_prepare_mutation`/`shopify_execute_mutation` are
excluded from the schema sent to the model in this mode, and are additionally hard-refused by the
dispatcher if requested anyway (`04-safety-tests.md`).

```
{
  tool: "shopify_schema",
  arguments: {
    action: "search" | "inspect_field" | "list_fields" | "inspect_enum" | "inspect_input",
    query?: string,
    fieldName?: string,
    typeName?: string,
    kind?: "QUERY" | "MUTATION",
    prefix?: string,
    limit?: number,
  }
}

{
  tool: "shopify_query",
  arguments: {
    document: string,               // full GraphQL query document, agent-composed
    variables?: Record<string, unknown>,
  }
}
```

Full schema source: `apps/shopify/app/lib/shopify/gateway/tools.server.js`
(`SHOPIFY_GATEWAY_TOOL_CALL_SCHEMA`) — identical definitions to the standalone gateway experiment's
`docs/ops/agentic-shopify-gateway/07-tool-schemas.md`; not redefined here.

## What's different about how they're offered in this integration vs the standalone experiment

The standalone `eval-agentic-shopify-gateway.mjs` script (previous session) hand-built its own
system prompt and tool schema. This integration instead reuses the *exact* production tool-call
JSON schema mechanism (`AGENTIC_RECOMMENDATION_SCHEMA`) the catalogue path already uses for
structured output, with only the `toolCalls` property's item shape swapped — so the model receives
one coherent structured-output contract (status, hypothesesConsidered, toolCalls, recommendation,
candidateDisposition, ...) regardless of which surface is active, not two different response
formats.
