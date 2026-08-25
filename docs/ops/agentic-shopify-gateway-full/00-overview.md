# Agentic Shopify Gateway — full production cutover (2026-08-25)

Overview of what actually landed in this pass. The founder's mid-task steer ("we just want to run
the new gateway fully," then "Remove all catalog related code, we dont need it on this branch")
simplified the original 18-section ask from "prove an A/B case" to "finish the migration," so this
doc set is organized by what changed and why rather than as a side-by-side comparison report.

## Document index

- `00-overview.md` — this file.
- `01-final-architecture.md` — the four tools, the `document.server.js` validation pipeline, the
  `synthetic-stub.server.js` seam, the schema source.
- `02-removed-catalogue-dependencies.md` — detailed before/after dependency inventory: what was
  deleted, what was deliberately kept and why, what was removed-not-migrated.
- `03-runtime-migration-matrix.md` — per-layer (recommendation/execution/verification/chat)
  before/after table, the capability-binding removal, the read-vs-write ledger visibility change.
- `05-mutation-safety-and-partial-errors.md` — the (unchanged) mutation-safety classifier, partial
  GraphQL error handling, and the three real bugs found and fixed during this pass.
- `08-observability-and-schema-version.md` — API-version strategy, schema staleness/health,
  logging, and an honestly-flagged observability gap.
- `10-test-coverage-and-full-suite-results.md` — every dedicated and migrated test file, with
  counts, plus the full-suite result.
- `12-known-limitations-and-strategic-assessment.md` — what's still open, and why the earlier
  `CONTINUE_DUAL_TRACK` A/B conclusion is now settled by removal.
- `real-dev-store-golden-path-trace.json` — the real, reversible end-to-end write proof.

## What changed

The Agentic Shopify Gateway (`app/lib/shopify/gateway/`) — four tools (`shopify_schema`,
`shopify_query`, `shopify_prepare_mutation`, `shopify_execute_mutation`) that let the model discover
real Shopify schema and compose its own GraphQL, validated deterministically by AST shape — is now
the *only* Shopify agent tool surface in this app, across all four runtime layers:

- `recommendation-agent.server.js` (both `focusCandidate`-scoped investigation and the open-ended,
  no-caller discovery mode)
- `execution-agent.server.js`
- `verification-agent.server.js`
- `action-chat.server.js` (read-only: `shopify_schema`/`shopify_query` only, never the mutation
  tools — chat cannot blur into execution)

The generated 810-operation catalogue's model-facing dispatcher
(`agentic-runtime/tools.server.js`'s `SHOPIFY_AGENT_TOOL`/`runShopifyAgentTool`, and the
`agentic-runtime/tool-surface.server.js` surface switcher) is deleted, not merely superseded.
`api/gateway.server.js`'s `executeShopifyOperation` no longer has a catalog-name-lookup fallback —
`stubOverride` (built from a Gateway-validated document via `synthetic-stub.server.js`) is the only
way to reach it. Everything that pipeline already guaranteed — accepted-Action-revision
authorization, live-scope checks (never a locally-cached scope snapshot), blast-radius/pricing-
intent guard, `EXPLICIT_HIGH_RISK_CONFIRMATION_REQUIRED`, idempotency, the durable
`ShopifyOperationCall` ledger — is unchanged and reused unchanged, per CLAUDE.md's standing
invariant that these are properties of the write primitives, not of the catalogue.

## What did NOT change

- `api/catalog.server.js`, `api/retrieval.server.js`, `api/generation.server.js` remain — they're
  real production dependencies of unrelated features (`capabilities/*`, `merchant-plan/
  candidates.server.js`, `actions/action-resolution.server.js`, the app-home route), not part of
  the agent tool-dispatch surface this migration replaced. See
  `02-removed-catalogue-dependencies.md` for exactly what stayed and why.
- The mutation-safety classification model (`mutation-safety.server.js`) — pure structural function
  of `{operation, operationKind, domain, scopeConfidence}` — is untouched. It classifies both
  catalog-sourced and Gateway-composed operations identically; this migration only changed how a
  stub reaches it, not the classifier itself.
- The merchant-confirmation route (`api.merchant-actions.confirm-shopify-operation.tsx`) was
  already migrated to document-based confirmation in an earlier phase of this work, before today's
  cutover — untouched further here.

## Real, verified end-to-end proof

A real golden-path run against `jefe-local-store.myshopify.com` (real store, real Gemini/OpenAI
model, no scripted responses): accept → agent-composed `productUpdate` mutation → agent-composed
verification query → `completed`. Trace: `real-dev-store-golden-path-trace.json` in this directory.
Two real bugs were found and fixed via that live run before it succeeded:

1. **False `WRITES_COMPLETE`.** A failed mutation attempt (`PROVIDER_ERROR`) followed by the model
   claiming `WRITES_COMPLETE` on the very next turn, with nothing gating on whether a write had
   actually succeeded. Fixed with a `WRITES_COMPLETE_WITHOUT_SUCCESSFUL_WRITE` validation gate in
   `execution-agent.server.js` — regression-tested.
2. **Swallowed real Shopify error detail.** `gateway.server.js`'s catch block only ever surfaced
   the generic `ShopifyAdminGraphqlError.message`, never the real per-field GraphQL error array, so
   the model couldn't see what to fix. Fixed with `formatShopifyGatewayError()` — regression-tested.

A third bug was found and fixed during the post-migration test-suite repair, not the live run: the
Gateway's duplicate-read de-dup fingerprint compared the model's raw GraphQL text against the
*reformatted* (`graphql-js print()`) text of a prior identical call — for example, `print()` drops
the `query` keyword on an anonymous shorthand query, so two byte-identical repeats never
fingerprinted as equal. Fixed by canonicalizing both sides through the same parse+print before
comparing, with a whitespace-collapse fallback if the current text doesn't parse.

## Removed architecture, not migrated

Three server-side "pre-filter to a ranked top-N, then hand the model that shortlist" capability-
binding call sites (recommendation, execution, verification) are gone — not replaced with a
Gateway-native equivalent. This was the documented root cause of a real false `NON_EXECUTABLE`
conclusion in the earlier recommendation A/B (`docs/ops/agentic-shopify-gateway-recommendation-ab/`):
`collectionCreate`/`collectionAddProducts` didn't rank into the top 8 results for one real
candidate's wording, so the model concluded no safe write existed when one did. Gateway mode has no
pre-binding step by design (Part 4 of the original Gateway proposal: "schema lookup is the model's
own choice, not a ritual") — the failure class is structurally eliminated, not reproduced with a
different ranking algorithm.

## Test coverage

Full suite: 1978 tests, 1976 passing after this change. The 2 non-passing tests are unrelated to
this migration:

- `tests/fast-onboarding.test.mjs` — one pre-existing failure (`prisma.merchantPlanRun.upsert is
  not a function`, a test-fixture Prisma mock gap), present before this session started.
- `tests/merchant-memory.test.mjs` — one flaky failure observed only inside the full-suite run,
  not reproducible running the file standalone (35/35 pass in isolation) — looks like shared-state/
  ordering flakiness unrelated to Shopify code.

Every test file that exercised the removed catalog dispatcher was migrated to Gateway shape (real
GraphQL documents matched against fixture clients by `document.includes(...)`, mirroring how the
real `ShopifyAdminGraphqlClient` is called) rather than deleted, including the deep
`executeShopifyOperation` safety-pipeline tests in `shopify-api-gateway.test.mjs` (accepted-
revision staleness, live-scope-vs-stale-local-snapshot reconciliation, pricing-drift guard,
idempotent-replay, blocked-idempotent-retry, explicit-confirmation-then-proceeds) — all 14
re-verified against the real Gateway dispatch path, not dropped.

## Known limitations / follow-ups not done in this pass

- The open-ended (no-`focusCandidate`) branch of `recommendation-agent.server.js` has zero
  production callers (`candidate-pipeline.server.js` is the only real caller and always passes
  `focusCandidate`) — kept working on Gateway rather than deleted, but not exercised by real
  production traffic, only by direct unit tests.
- `candidate-disposition-taxonomy.server.js`'s `CAPABILITY_RETRIEVAL_FAILURE` heuristic (a separate
  curated capabilities/policy catalog, not the 810-op stub catalog) was not re-examined — flagged
  as a real follow-up in `02-removed-catalogue-dependencies.md` now that the Gateway can prove
  operation non-existence deterministically instead of inferring it from a capped search miss.
- `scripts/eval-agentic-shopify-runtime.mjs` had one broken import fixed
  (`buildExecutionSystemPrompt` → `buildGatewayExecutionSystemPrompt`) but was not otherwise run
  end-to-end in this pass (requires live LLM keys and a live dev Shopify store).
- The `SHOPIFY_AGENT_SURFACE` env var and its `withSurface()` test scaffolding (4 test files) are
  now fully inert — no production code reads the env var any more, since there is only one surface
  to switch to. Left in place rather than stripped from those 4 test files; harmless, just
  vestigial. `.env.example`'s now-stale documentation of the variable was removed.
