# Part 10 — Test coverage and full-suite results

## Dedicated Gateway/safety test files (all currently green)

| File | Tests | What it proves |
| --- | --- | --- |
| `tests/agentic-shopify-gateway-safety.test.mjs` | 20/20 | `document.server.js`'s deterministic AST validation — 20 adversarial cases (aliased mutations, smuggled second root fields, malformed GraphQL, pagination/depth-cap evasion via literal or bound variable, missing `userErrors`, an operation absent from the local schema snapshot still classifying safely) plus mode-dispatch tool-list restrictions. |
| `tests/agentic-shopify-gateway-recommendation-ab-safety.test.mjs` | 8/8 | Gateway wired into `recommendation-agent.server.js`'s real investigation call sites — including the regression tests for the two real bugs found during the original A/B (`validateInvestigation`/`buildRecommendationDiagnostics` hardcoded to catalog tool names on the `NO_ACTIONABLE_OPPORTUNITY`/`BLOCKED` branches) and the updated "gateway is also applied to open-ended discovery" test reflecting this pass's universal cutover. |
| `tests/agentic-shopify-gateway-execution-safety.test.mjs` | 6/6 | Execution-agent Gateway wiring, including the `WRITES_COMPLETE_WITHOUT_SUCCESSFUL_WRITE` regression and the real-Shopify-error-detail-preservation regression. |
| `tests/agentic-shopify-gateway-verification-safety.test.mjs` | 3/3 | Verification-agent Gateway wiring, structural read-only enforcement. |
| `tests/agentic-shopify-gateway-chat-safety.test.mjs` | 3/3 | Chat never recognizes the mutation tool names regardless of surface; tool catalogue describes `shopify_schema`/`shopify_query`, not the catalog tools. |
| `tests/agentic-shopify-gateway-partial-errors.test.mjs` | 8/8 | `requestWithClassification` + gateway `shopify_query` partial-data handling. |
| `tests/shopify-api-gateway.test.mjs` | 14/14 | The deep `executeShopifyOperation` safety pipeline itself, re-proven through real Gateway dispatch (`stubOverride` built from real documents, not fixture catalog stubs): accepted-revision authorization/staleness, live-scope-vs-stale-local-snapshot reconciliation, pricing-drift/blast-radius guard, `EXPLICIT_HIGH_RISK_CONFIRMATION_REQUIRED` for a formerly-prohibited operation (`appRevokeAccessScopes`) and an unreviewed delete-shaped mutation (`customerDelete`), an unknown-scope-confidence mutation (`tagsAdd`) still landing at explicit-confirmation rather than frictionless, `userErrors` surfacing, idempotent replay, blocked idempotent retry on unknown prior result. |
| `tests/shopify-eval-mode-isolation.test.mjs` | 6/6 | `assumeAllScopesGranted` (controlled capability evaluation) has no path into the gateway that executes real writes — proven directly against `executeShopifyOperation` with a real `stubOverride`, not a fixture bypass. |

## Migrated (not deleted) pre-existing suites

Every pre-existing test file that scripted catalog-shaped tool calls (`retrieve_shopify_operations`/
`call_shopify_operation`) against a real dispatch path was converted to real Gateway-shaped calls —
actual GraphQL documents matched against fixture Shopify clients by `document.includes(...)`,
mirroring how the real `ShopifyAdminGraphqlClient` is invoked — rather than pinned to a
now-nonexistent catalog surface or deleted outright:

- `tests/candidate-pipeline.test.mjs` (12/12) — including Test 5 (retrieval-loop prevention) and
  Test 6 (zero-read regression), both migrated to `shopify_schema`/`shopify_query`.
- `tests/agentic-shopify-runtime.test.mjs` (17/17) — chat, recommendation, and execution scenarios,
  including the multi-step "create collection, add products, verify" and "set metafield, verify"
  execution flows, and the mutation-ledger-vs-toolResults distinction (Part 3).
- `tests/agentic-eligibility.test.mjs` (22/22) — including the focused semantic-repair test, which
  needed a `focusCandidate` added (it previously exercised the now-fully-migrated open-ended
  discovery path without one).
- `tests/agentic-execution-lifecycle.test.mjs` (13/13), `tests/agentic-verification-phase.test.mjs`
  (10/10) — helper functions converted to gateway tool shape.
- `tests/recommendation-breadth.test.mjs` (33/33), `tests/recommendation-convergence.test.mjs`
  (30/30), `tests/recommendation-llm-retry.test.mjs` (18/18) — including the duplicate-read
  fingerprint bug found via this migration (Part 5).
- `tests/shopify-api-catalog-full.test.mjs` (6/6) — the synthetic `widgetFrobnicate` end-to-end test
  now passes its hand-built stub as `stubOverride` directly (it already had exactly the right shape).
- `tests/recommendation-domain-fixtures.test.mjs`, `tests/recommendation-domain-competition.test.mjs`,
  `tests/recommendation-sequential-exhaustion.test.mjs`, `tests/helpers/agentic-recommendation-fixtures.mjs`
  (shared fixture harness) — `readCall`/`retrieveCall` helpers rebuilt to compose real GraphQL
  documents (connection-shaped or singular-lookup-shaped, inferred from the passed variables) for
  arbitrary domains/operations, not just products.

## Deleted from the live runtime, kept as static reference data

`api/catalog.server.js`, `api/retrieval.server.js`, `api/generation.server.js` and their existing
test files (`shopify-api-catalog-full.test.mjs` retained; `shopify-operation-retrieval.test.mjs`
retained) are untouched or only lightly touched — they test functions with real, unrelated live
callers (Part 2), not the removed agent-dispatch surface.

## Full suite

`node --test tests/*.test.mjs`: **1978 tests, 1977 passing.** The one non-passing test
(`tests/fast-onboarding.test.mjs`, "retrying a failed agentic recommendation creates a fresh run and
requeues the worker with provenance", `prisma.merchantPlanRun.upsert is not a function`) is a
pre-existing test-fixture Prisma mock gap, present before this session's Shopify-catalog work
started, and unrelated to anything touched in this pass — confirmed by inspection of the failure
(a mock object missing a method, not a Shopify/Gateway assertion).

A separate full-suite run observed one additional flaky failure in `tests/merchant-memory.test.mjs`
("Merchant Memory refresh jobs are debounced, retryable and process without Shopify tokens") that
did not reproduce running that file standalone (35/35 pass in isolation) or on a second full-suite
run — looks like shared-state/ordering flakiness unrelated to Shopify code, not a real regression.
