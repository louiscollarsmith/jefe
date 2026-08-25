# Part 7 — Tool schemas exposed to the model

Source of truth: `apps/shopify/app/lib/shopify/gateway/tools.server.js`
(`SHOPIFY_GATEWAY_TOOL`, `SHOPIFY_GATEWAY_TOOL_CALL_SCHEMA`). Reproduced here for reference; if this
drifts from the code, the code wins.

## `shopify_schema`

```
{
  tool: "shopify_schema",
  arguments: {
    action: "search" | "inspect_field" | "list_fields" | "inspect_enum" | "inspect_input",
    query?: string,        // required for action=search
    fieldName?: string,    // required for action=inspect_field
    typeName?: string,     // required for action=inspect_enum / inspect_input
    kind?: "QUERY" | "MUTATION",
    prefix?: string,       // action=list_fields substring filter
    limit?: number,
  }
}
```

## `shopify_query` (query-only mode)

```
{
  tool: "shopify_query",
  arguments: {
    document: string,               // full GraphQL query document, agent-composed
    variables?: Record<string, unknown>,
  }
}
```

## `shopify_prepare_mutation` (execution mode only)

```
{
  tool: "shopify_prepare_mutation",
  arguments: {
    document: string,               // full GraphQL mutation document, agent-composed
    variables?: Record<string, unknown>,
    purpose?: string,
    expectedEffect?: string,
  }
}
```

## `shopify_execute_mutation` (execution mode only)

```
{
  tool: "shopify_execute_mutation",
  arguments: {
    document: string,
    variables?: Record<string, unknown>,
    purpose?: string,
    expectedEffect?: string,
    idempotencyKey: string,         // required — call is refused without it
  }
}
```

## Result shape (all four tools)

```
{
  tool: string,
  ok: boolean,
  message: string,
  facts: Record<string, any>,       // tool-specific payload, always JSON-size-bounded
  error: { code: string; message: string } | null,
}
```

Identical shape to the existing catalogue surface's `ShopifyAgentToolResult`
(`agentic-runtime/tools.server.js`) — deliberate, so orchestration code that only inspects `ok`/
`error.code`/`facts` doesn't need to change based on which surface produced the result.
