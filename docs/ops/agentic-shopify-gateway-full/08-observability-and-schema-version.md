# Part 8 — Observability and schema/API-version strategy

## API version

Single source of truth: `app/lib/shopify/api-version.server.js`'s `getConfiguredShopifyApiVersion(env)`,
reading `SHOPIFY_API_VERSION` with a `"2026-07"` default. Every Shopify-facing module — the Gateway
(`document.server.js`'s schema index load, `synthetic-stub.server.js`'s stub `apiVersion` field),
`api/gateway.server.js`'s `executeShopifyOperation`, and all four agentic-runtime agents — reads it
from this one function rather than each hardcoding its own default, so an API-version bump is a
one-line env change, not a multi-file audit. This module was extracted from `api/catalog.server.js`
during this pass (previously catalog-owned) since it's now a shared dependency of files that no
longer import the catalog at all.

## Schema source and staleness

`gateway/schema-cache.server.js`'s `loadPinnedShopifySchemaCache()` reads a pinned JSON snapshot
(`gateway/schema-cache/shopify-admin-schema-2026-07.json`) — the same generated-catalog data
`api/catalog.server.js` loads, reused as the most complete locally-available real-schema data, not
a functional re-adoption of catalogue retrieval/binding behavior (see Part 1). `getGatewaySchemaHealth()`
exposes `{ status, apiVersion, fields, queries, mutations, generatedAt, generatedFrom }` —
`status: "unavailable"` if the index has zero operations. This is exposed at `/health.tsx` under the
`shopifyGatewaySchema` key (previously `shopifyApiCatalog`, pointing at the catalog health function
of the same shape) — an operator can see the schema snapshot's age and field count without
inspecting the repo.

## Logging

`api/gateway.server.js`'s `executeShopifyOperation` — unchanged surface, still the single place
every Shopify write is logged — emits structured logs at `info` (admitted operations) and `warn`
(provider errors, installed-scope-probe failures), tagged with `shopDomain`/`merchantId`/`shopId`
where relevant, credentials masked per this repo's observability discipline (`apps/shopify/docs/
observability.md`). The Gateway's own tool-dispatch layer (`gateway/tools.server.js`) does not log
directly — every dispatch happens inside an agent's per-turn loop, and each agent (`execution-agent.
server.js`, `verification-agent.server.js`, `recommendation-agent.server.js`) logs its own
phase-level milestones (mutation-phase-complete, verification-outcome, recommendation-selected)
through the same `logger` passed down from the caller, unchanged from before this migration.

## What is NOT separately instrumented (a real gap, not fixed in this pass)

There is no dedicated metric or log line for "the model used `shopify_schema` before a read" vs.
"it went straight to `shopify_query`," or for how often `analyzeGatewayDocument` rejects a document
(and for which of its ~10 failure codes). This would be useful signal for judging whether the
Gateway's model-driven discovery is working well in practice (vs. the removed top-N pre-binding,
which was at least implicitly observable via `retrievedOperations` diagnostics). Not built in this
pass — flagged as a real follow-up rather than silently left unmentioned.
