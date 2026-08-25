# Part 2 — Catalogue runtime dependency inventory (final state)

Supersedes the original version of this doc (2026-08-25 AM), which was a pre-migration inventory
("not yet acted on"). This is the post-migration state, written after the full cutover landed the
same day.

## What was actually removed

- `app/lib/shopify/agentic-runtime/tools.server.js` — the catalogue's model-facing tool surface
  (`SHOPIFY_AGENT_TOOL` = `retrieve_shopify_operations`/`call_shopify_operation`,
  `runShopifyAgentTool`). Deleted entirely. Zero importers remained once recommendation-agent,
  execution-agent, verification-agent and action-chat were all migrated to the Gateway's four tools
  (`shopify_schema`/`shopify_query`/`shopify_prepare_mutation`/`shopify_execute_mutation`).
- `app/lib/shopify/agentic-runtime/tool-surface.server.js` — the `SHOPIFY_AGENT_SURFACE=catalog|gateway`
  switcher. Deleted. There is only one Shopify agent tool surface now; a switch between two surfaces
  no longer has a second option to switch to.
- `app/lib/shopify/api/gateway.server.js`'s catalog-lookup fallback inside `executeShopifyOperation`
  — `stubOverride` is now the *only* way to reach the shared execution pipeline (accepted-Action-
  revision authorization, live-scope checks, blast-radius/pricing-intent guard, explicit high-risk
  confirmation, idempotency, the durable `ShopifyOperationCall` ledger). There is no more
  `getShopifyApiOperationStub(operation)` fallback when `stubOverride` is absent — a bare
  `operation` name with no `stubOverride` is now a structural `DENIED_OPERATION_UNKNOWN`, not a
  catalog lookup.
- `recommendation-agent.server.js`'s open-ended discovery mode (no `focusCandidate`) — originally
  scoped to stay on the catalogue surface (docs/ops/agentic-shopify-gateway-recommendation-ab/,
  since it has zero production callers), it was *also* migrated to Gateway during this pass, purely
  because leaving it wired to the deleted catalogue dispatcher would have made it dead code that
  silently failed rather than working code with no caller. `candidate-pipeline.server.js` is the
  only real production caller of `generateAgenticShopifyRecommendation`, and it always passes
  `focusCandidate` — the open-ended branch remains untested in production traffic, but it is no
  longer broken if something ever calls it directly (also directly unit-tested — see
  `tests/candidate-pipeline.test.mjs` Tests 5/6, `tests/recommendation-breadth.test.mjs`,
  `tests/recommendation-convergence.test.mjs`, `tests/recommendation-llm-retry.test.mjs`).

## What was deliberately NOT removed (kept, still live)

The original inventory conflated "everything that mentions the generated Shopify API catalogue"
with "the agent tool-dispatch surface being replaced." Only the latter was in scope. Still live,
still real production dependencies, unrelated to this migration:

- `app/lib/shopify/api/catalog.server.js` (`loadShopifyApiCatalog`, `getShopifyApiOperationStub`,
  `validateShopifyApiCatalog`, `validateShopifyOperationVariables`) — consumed by
  `capabilities/search.server.js`, `capabilities/qualification.server.js`,
  `capabilities/discovery.server.js`, `merchant-plan/candidates.server.js`,
  `actions/action-resolution.server.js`, `actions/shopify-action-capabilities.server.js`, and
  `api/preview.server.js`/`api/blast-radius.server.js`. None of these are the LLM agent tool
  surface; they are separate product features that use the generated catalogue as static reference
  data. Left untouched.
- `app/lib/shopify/api/retrieval.server.js` (`retrieveShopifyApiOperations`) — a pure, generic
  keyword-search utility over catalog data. Its only production importers were the two files just
  deleted (`agentic-runtime/tools.server.js`, `tool-surface.server.js`), so it is now dead code from
  the live runtime's perspective — but it still has real, substantial dedicated test coverage
  (`tests/shopify-operation-retrieval.test.mjs`, plus sections of
  `tests/shopify-api-catalog-full.test.mjs`) exercising it as a general search algorithm over the
  live catalogue, independent of the agent-dispatch use case it originally served. Left in place
  rather than deleted, since removing it would mean deleting that test coverage too for no safety
  or architecture benefit — it's provably inert (no live caller), not dangerous.
- `app/lib/shopify/api/generation.server.js` — the catalogue's build/generator tooling. Has a real
  production importer (`app/routes/app._index.tsx`) and is invoked by
  `scripts/shopify-api-generate.mjs`. Entirely unrelated to the agent runtime; left untouched.
- `gateway/schema-index.server.js` importing `loadShopifyApiCatalog` from `api/catalog.server.js`
  as its schema-cache **data source** (relocated into `gateway/schema-cache.server.js` /
  `gateway/schema-cache/shopify-admin-schema-2026-07.json` during the earlier gateway-experiment
  phase) — this was always documented as deliberate data reuse (the most complete locally-available
  real-schema snapshot), not a functional dependency on the catalogue's retrieval/binding behavior.

## Server-side capability-binding — removed, not migrated

The original inventory found three server-side "pre-filter to a ranked top-N, then hand the model
that shortlist" binding call sites (`recommendation-agent.server.js`, `execution-agent.server.js`,
`verification-agent.server.js`), and flagged this pattern as the root cause of a real false
`NON_EXECUTABLE` conclusion during the recommendation A/B (`collectionCreate`/`collectionAddProducts`
didn't rank into the top 8 for one real candidate). All three are gone now — not migrated to a
Gateway-native equivalent, removed outright. Gateway mode has no pre-binding step at all: the model
calls `shopify_schema` itself, only when it decides it needs to (Part 4 of the original Gateway
design — "schema lookup is the model's own choice, not a ritual"). This eliminates the failure
class entirely rather than reproducing it with a different ranking algorithm.

## Prompt language

Every catalogue-specific prompt fragment flagged in the original inventory
(`retrieve_shopify_operations`/`call_shopify_operation` instructions in
`execution-agent.server.js`, `verification-agent.server.js`, `action-chat.server.js`, and the
non-gateway branches of `recommendation-agent.server.js`) was rewritten to describe the four
Gateway tools instead, mirroring the swap already done in `recommendation-agent.server.js`'s
original gateway branch. `buildExecutionSystemPrompt`/`buildVerificationSystemPrompt` (the
catalogue-worded prompt builders) were deleted outright rather than left as dead exports;
`buildGatewayExecutionSystemPrompt`/`buildGatewayVerificationSystemPrompt` are now unconditional.

## `candidate-disposition-taxonomy.server.js`'s `CAPABILITY_RETRIEVAL_FAILURE` heuristic

Not re-examined in this pass — out of scope (it concerns a separate curated capabilities/policy
catalog, not the 810-op stub catalog or the agent tool-dispatch surface this migration touched).
Flagged again here as a real follow-up: now that the Gateway's AST validator can prove an
operation's non-existence deterministically (`FIELD_NOT_FOUND` from `analyzeGatewayDocument`/
`inspectGatewayField`) rather than inferring it from absence in a capped, ranked result set, the
heuristic's original justification ("a retrieval miss is now more likely than a genuine Shopify
gap") may no longer hold for whatever candidate-pipeline call sites feed it Gateway-derived
evidence. Worth a dedicated look, not done here.

## Outside `app/lib/shopify/`

- `app/services/shopify-backfill-worker.server.js` — imports `getActionRevisionState` (shared,
  non-catalogue-specific) and calls `runAgenticShopifyExecution`/`runAgenticShopifyVerification`.
  Indirect dependency via the execution/verification agents; nothing in this file itself changed.
- `scripts/eval-agentic-shopify-runtime.mjs` — updated: `buildExecutionSystemPrompt` (deleted)
  replaced with `buildGatewayExecutionSystemPrompt`. Not otherwise exercised as part of this pass
  (requires live LLM keys and a live dev Shopify store to run meaningfully).
- No `app/routes/` file referenced the deleted catalogue-dispatch modules directly, except
  `app/routes/api.merchant-actions.confirm-shopify-operation.tsx`, which was migrated in the
  earlier (execution-safety) phase of this work: `operation` (catalog name) param replaced with
  `document` (raw GraphQL), stub resolution now via `analyzeGatewayDocument`/
  `buildSyntheticGatewayStub` instead of `getShopifyApiOperationStub`/
  `validateShopifyOperationVariables`.
- `app/routes/health.tsx` — `shopifyApiCatalog` health payload key replaced with
  `shopifyGatewaySchema` (`getGatewaySchemaHealth()`), in the earlier phase.
