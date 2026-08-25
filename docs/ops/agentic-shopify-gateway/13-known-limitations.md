# Part 13 — Known limitations

Ordered roughly by how much they'd matter for a production decision.

## 1. No live Shopify token in this dev environment

`JEFE_GOLDEN_PATH_SHOPIFY_ADMIN_ACCESS_TOKEN` is unset in `.env`. This blocked:
- A fresh live introspection fetch (the schema index instead reuses the most recent generated
  catalogue snapshot — see #2).
- Any real Shopify read or write this session. The eval script's Shopify client deliberately throws
  an honest, labeled error rather than returning fabricated data when no token/`--real-shopify` flag
  is present (`scripts/eval-agentic-shopify-gateway.mjs`, `buildShopifyClient()`) — verified this
  produced a real, correctly-handled failure in the live run (`11-real-recommendation-run-trace.md`),
  not a silent gap.
- Parts 13/14 of the task brief (real-store validation, real recommendation evaluation) as literally
  specified. What was run instead — real LLM, real validator, no real Shopify response — is described
  honestly throughout rather than presented as the full thing.

**To unblock:** populate `JEFE_GOLDEN_PATH_SHOPIFY_ADMIN_ACCESS_TOKEN` for
`jefe-local-store.myshopify.com` (already the configured `JEFE_GOLDEN_PATH_SHOPIFY_SHOP`) and run
`node scripts/eval-agentic-shopify-gateway.mjs --real-shopify`.

## 2. No full raw introspection dump available; schema index has a real coverage gap

The file named `docs/ops/shopify-real-schema-2026-08-24/shopify-admin-api-2026-07.REAL-INTROSPECTION.json`
is, despite its name, catalogue output (810 per-operation argument/input/enum snapshots) — not a raw
`__schema` introspection dump. Neither this repo nor this session has a complete Shopify Admin type
graph. Consequence, observed directly in the live run: `shopify_schema`'s `inspect_field` only
resolves root Query/Mutation field *names*, not arbitrary object types — the model tried
`inspect_field("Product")`, `inspect_field("ProductVariant")` etc. and got `FIELD_NOT_FOUND` for all
of them, then correctly fell back to `search`/`list_fields` (`10-real-shopify-query-examples.md`).
This is a real usability gap, not a hypothetical one.

**Fix:** either (a) obtain a live token and run a full `__schema` introspection once, cache it, and
build a real `GraphQLSchema` via `graphql`'s `buildClientSchema()` — this also unlocks full
`validate()`-based schema validation (`08-graphql-validation-architecture.md`), or (b) add an
`inspect_type` action to `shopify_schema` that returns the return-type name and known argument/return
shape info already present per-operation, which would at least reduce (not eliminate) the gap without
a fresh introspection fetch.

## 3. Not wired into the production recommendation/execution/verification/chat runtime

`agentic-runtime/recommendation-agent.server.js`, `execution-agent.server.js`,
`verification-agent.server.js`, and `action-chat.server.js` all import `SHOPIFY_AGENT_TOOL` /
`runShopifyAgentTool` directly, with ~20 call sites in `recommendation-agent.server.js` alone that
branch on the 2-tool shape (counting successful retrievals, building `requiredNextTools` prompt
hints, disposition logic keyed on `SHOPIFY_AGENT_TOOL.callOperation`/`.retrieveOperations`). A
feature-flag switch exists (`agentic-runtime/tool-surface.server.js`,
`SHOPIFY_AGENT_SURFACE=catalog|gateway`) and returns a drop-in-compatible
`{ tool, callSchema, dispatch }` shape, but actually rewiring those four files to be polymorphic over
a fundamentally different (4-tool, no explicit "retrieve then call" split) tool shape is real,
separate engineering work — attempting it in this session risked destabilizing the live
recommendation/clearance-execution path for an experiment that's explicitly supposed to be
comparable, not disruptive (task brief, Part 11). See `14-migration-rollback-strategy.md`.

## 4. Best-effort argument validation, not full GraphQL schema validation

Directly follows from #2. For the 810 operations the local index knows about, argument names and
required-ness are checked. For anything else, or for nested selection-set field validity on any
operation, the gateway defers entirely to Shopify's own response. This is the explicitly sanctioned
fallback per the task brief, but it means "deterministically valid" in this implementation means
"passed the checks in `08-graphql-validation-architecture.md`," not "guaranteed to succeed against
Shopify" — the same is arguably true of the catalogue path too (its generated documents are minimal
and don't validate arbitrary nested selections either, since the model doesn't write catalogue
documents at all).

## 5. Release-candidate CI schema testing not built

Investigated (`06-api-version-schema-strategy.md`); not implemented. Needs a decision about where a
CI job sources an RC introspection dump from.

## 6. Recommendation quality/yield not compared on real data

`12-baseline-comparison.md` is explicit about this: no live-store comparison of recommendation
quality was possible this session. The maintenance-burden and safety-architecture comparisons are
real; the "does this produce better merchant recommendations" question is open.
