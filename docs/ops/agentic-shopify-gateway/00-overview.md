# Agentic Shopify Gateway — Overview

Status: experimental, built 2026-08-25, behind `SHOPIFY_AGENT_SURFACE=gateway` (default `catalog`,
unchanged production behaviour).

## What this is

An alternative to Jefe's generated 810-operation Shopify catalogue
(`apps/shopify/app/lib/shopify/api/catalogs/`, `apps/shopify/docs/ops/agentic-shopify-runtime-v1.md`).
Instead of Jefe pre-generating a bounded GraphQL document per Shopify operation, the model discovers
the relevant schema itself, writes its own GraphQL, and a small deterministic gateway validates and
executes it.

## Origin and how this compares to the forensic premise it was proposed against

This build was requested as a "competing experiment" against a claimed baseline
(`docs/ops/recommendation-yield-forensics-2026-08-25/`) that does not exist in this repository. The
actual same-day diagnostic (`apps/shopify/docs/proposal-generation-failure-2026-08-25.md`) reaches
the opposite conclusion from the one the task document assumed: the 810-op catalogue was not the
cause of the `no_actionable_opportunity` run under investigation there — a same-day comparable run
on the *same* catalogue architecture succeeded normally (12 LLM calls, 58–85k input tokens/call).
The founder was told this directly and confirmed proceeding with the gateway build anyway, as a
genuine parallel architecture bet rather than a fix for a bug the catalogue didn't actually have.
That context matters for how to read `12-baseline-comparison.md`: it is not "broken vs fixed," it is
"two working architectures, compared on their own merits."

## What was actually built and verified this session

- Real schema-driven document validator (`app/lib/shopify/gateway/document.server.js`) — parses
  agent-authored GraphQL, enforces query-only/mutation-only structurally from the AST, never from
  operation-name matching. 20 automated adversarial tests pass
  (`apps/shopify/tests/agentic-shopify-gateway-safety.test.mjs`).
- Targeted schema discovery (`app/lib/shopify/gateway/schema-index.server.js`) — search/inspect
  primitives over real Shopify schema data, not a full-schema dump into context.
- A synthetic-stub seam (`app/lib/shopify/gateway/synthetic-stub.server.js` +
  a 3-line addition to `app/lib/shopify/api/gateway.server.js`) that lets agent-composed mutations
  run through the *exact same* accepted-Action-revision authorization, blast-radius, explicit
  confirmation, idempotency and ledger machinery the catalogue path already uses, unchanged. All 29
  pre-existing gateway tests still pass.
- A real, live LLM run (`apps/shopify/scripts/eval-agentic-shopify-gateway.mjs`, transcript in
  `.context/agentic-shopify-gateway/latest.json`) that discovered real Shopify schema fields, wrote
  valid GraphQL, and hit an honest, non-fabricated execution blocker (see Known Limitations).
- Genuine research into what Shopify officially provides (`01-research.md`), including one specific
  claim from a secondary source that could **not** be corroborated against the primary source and is
  flagged as such rather than presented as fact.

## What was not completed this session, and why

- **No live Shopify write or read against a real store.** `JEFE_GOLDEN_PATH_SHOPIFY_ADMIN_ACCESS_TOKEN`
  is unset in this dev environment. The gateway's execution path is built and unit-tested against the
  real classification/blast-radius/preview stack, but Part 13/14's live-store runs could not be
  executed with real Shopify responses this session. See `13-known-limitations.md`.
- **Not wired into the production recommendation/execution/verification/chat runtime.**
  `app/lib/shopify/agentic-runtime/recommendation-agent.server.js` has ~20 call sites structurally
  tied to the existing 2-tool (`retrieve_shopify_operations`/`call_shopify_operation`) shape. A
  feature-flag switch (`app/lib/shopify/agentic-runtime/tool-surface.server.js`) exists and is ready,
  but rewiring those call sites for the gateway's 4-tool shape is real follow-up work, not done here
  — see `14-migration-rollback-strategy.md`.

## Reading order

1. `01-research.md` — what Shopify actually provides
2. `02-architecture-decision.md`
3. `03-security-model.md`
4. `04-recommendation-query-mode-design.md`
5. `05-execution-mutation-mode-design.md`
6. `06-api-version-schema-strategy.md`
7. `07-tool-schemas.md`
8. `08-graphql-validation-architecture.md`
9. `09-adversarial-safety-test-results.md`
10. `10-real-shopify-query-examples.md`
11. `11-real-recommendation-run-trace.md`
12. `12-baseline-comparison.md`
13. `13-known-limitations.md`
14. `14-migration-rollback-strategy.md`
15. `15-recommendation.md`
