# Parts 6, 7 — Tool description and whether `shopify_schema` would have helped

## What Luna is told about `shopify_query`

Exact text from `buildGatewayCandidateInvestigationSystemPrompt()`
(`app/lib/shopify/agentic-runtime/recommendation-agent.server.js`):

> `shopify_query` — run a read-only GraphQL document you write yourself, with variables. It is
> validated deterministically before it reaches Shopify: if you got a field or argument wrong, you
> get back a specific, compact error (not a vague failure) — read it and repair your document in
> your next tool call. It can never execute a mutation, no matter what the document contains.

No mention anywhere in this prompt, or in `buildRecommendationContext()`'s
`searchableShopifyApiKnowledge` block, of:
- what a Shopify Global ID (`gid://shopify/{Type}/{id}`) looks like or where a valid one comes from;
- that Merchant Memory's own belief values may contain internal, non-Shopify identifiers;
- Shopify's `query:` search-string grammar (field-prefix-per-clause vs. grouped parentheses);
- that a schema-valid, no-error GraphQL response can still be a **false negative** (`null` node,
  empty result set) and is not automatically proof of absence.

**Classification: `TOOL_GUIDANCE_INSUFFICIENT`.**

## Would `shopify_schema` have caught any of this?

Inspected the actual schema index entries for the operations involved
(`app/lib/shopify/gateway/schema-cache/shopify-admin-schema-2026-07.json`):

```json
{
  "operation": "nodes",
  "description": "Returns the list of nodes (any objects that implement the Node interface) with the given IDs, in accordance with the Relay specification.",
  "arguments": [{ "name": "ids", "type": "[ID!]!", "required": true }]
}
```

```json
{
  "operation": "products",
  "description": "Retrieves a list of products in a store.",
  "arguments": [{ "name": "query", "type": "String", "required": false }, ...]
}
```

This is GraphQL introspection-derived metadata: operation name, one-line description, argument name
and GraphQL type. **`query`'s type is just `String`** — nothing distinguishes "this String must be
Shopify's search-query grammar" from any other free-text string argument. **`ids`'s type is just
`[ID!]!`** — nothing distinguishes "this must be a real Shopify GID you obtained from a prior read"
from "any string that looks ID-shaped." Shopify's own GraphQL schema does not carry this information
in a form introspection exposes (this is a real, upstream characteristic of the Admin API's schema,
not a defect in this repo's schema-index generation).

**Classification: `shopify_schema` would not have prevented any of the four defects found in this
investigation.** Calling it before writing the `nodes` or `products` query would have returned
exactly the two JSON snippets above — confirming the field exists and its argument type, but
supplying zero information about ID provenance or search-string grammar. This confirms the task
brief's own hypothesis: **a generic "inspect the schema" instruction is not sufficient for this class
of failure; the missing knowledge is about Shopify's ID-and-search-string *conventions*, which live
outside the GraphQL type system.**

## What this means for the fix

The fix in `12-root-cause-and-fix.md` does not attempt to teach the model Shopify's full ID/search
grammar via a schema tool it cannot express — the smallest correct fix removes the specific,
already-known-broken data source (an internal id serialized under a `productId`-shaped key) at its
one root, so the model never has a wrong-but-plausible-looking id to reach for in the first place.
