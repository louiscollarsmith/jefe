# Gateway vs Catalogue: Wired into Real Recommendation Investigation — Overview

Status: `SHOPIFY_AGENT_SURFACE=gateway` now genuinely drives the real candidate-investigation
runtime (`recommendation-agent.server.js`'s `focusCandidate` mode only — discovery, ranking,
disposition, and every other Shopify consumer untouched). `catalog` remains the default. Two real
runs against `jefe-local-store.myshopify.com`, same merchant, same Merchant Memory, same LLM
config, produced genuinely comparable — and genuinely different — outcomes.

## Answering the actual question

> When Luna is allowed to discover the Shopify schema and write its own read-only GraphQL inside
> the real recommendation loop, does Jefe produce better grounded recommendations than when Luna
> uses our pre-generated catalogue abstraction?

**On this one real run: yes.** Gateway mode reached a grounded `RECOMMEND_ACTION` — a real
collection-creation recommendation, backed by real Shopify inventory reads, materialized into a
real `MerchantAction` row — in 104.6 seconds using 4 tool calls and 0 schema lookups. Catalogue
mode, on the same merchant, same Merchant Memory snapshot, investigated 8 candidates and correctly
concluded `NO_ACTIONABLE_OPPORTUNITY` in 272.7 seconds using 16 tool calls. Full detail:
`10-full-gateway-trace.md`, `09-catalogue-baseline-trace.md`, `11-ab-metrics.md`.

**This is n=1 per surface.** Read `13-candidate-quality-comparison.md` and
`15-remaining-limitations.md` before treating this as a settled result — a single run each is
enough to prove the mechanics work end-to-end in production and to surface real bugs (one was
found and fixed mid-session, see below), not enough to establish a durable quality edge.

## What changed in the code this session

- `recommendation-agent.server.js`'s `generateAgenticShopifyRecommendation`, in `focusCandidate`
  mode only, now branches on `getConfiguredShopifyAgentSurface()`: gateway mode swaps in
  `shopify_schema`/`shopify_query`, skips the catalogue's server-side stub-binding step, uses a
  gateway-specific system prompt, and makes schema lookup optional rather than required (Part 4 of
  the task brief). See `01-integration-design.md`, `02-code-path.md`.
- A real bug was found and fixed during this work: two of the three `validateInvestigation` call
  sites (reached on `NO_ACTIONABLE_OPPORTUNITY`/`BLOCKED`, not just `RECOMMEND_ACTION`) were still
  hardcoded to the catalogue's tool names, so a gateway-mode candidate with a genuine successful
  read was still reported as "insufficient investigation" whenever the model concluded anything
  other than `RECOMMEND_ACTION`. Fixed, regression-tested (2 new tests), and the A/B was re-run
  after the fix — the numbers in this report are from the *post-fix* run. See
  `04-safety-tests.md` for the regression tests and `15-remaining-limitations.md` for how this was
  caught.
- 9 new focused safety tests proving the integration point itself — not just the standalone
  gateway module — structurally blocks mutations, respects the scope restriction (gateway tools
  are never even reachable from open-ended discovery), and correctly handles the optional-schema-
  lookup rule. `apps/shopify/tests/agentic-shopify-gateway-recommendation-ab-safety.test.mjs`.
- Full test suite (1953 catalog-mode tests + 9 new + earlier session's 20): see
  `12-test-suite-results.md`.

## Real merchant authentication

The local dev database was found completely empty (0 Shop rows, 0 Session rows) partway through
this session — restored by the user mid-task. Both A/B runs in this report ran against a real,
non-expired offline Shopify session, the identical `runAgenticRecommendationInvestigation` /
`runCandidateDrivenRecommendation` functions the production Generate Proposal flow calls. Full
account: `05-real-merchant-authentication.md`.

## Reading order

1. `01-integration-design.md`
2. `02-code-path.md`
3. `03-tool-definitions.md`
4. `04-safety-tests.md`
5. `05-real-merchant-authentication.md`
6. `10-full-gateway-trace.md`
7. `06-generated-graphql-appendix.md`
8. `07-schema-lookup-appendix.md`
9. `09-catalogue-baseline-trace.md`
10. `11-ab-metrics.md`
11. `13-candidate-quality-comparison.md`
12. `14-graphql-reliability-assessment.md`
13. `12-test-suite-results.md`
14. `15-remaining-limitations.md`
15. `16-strategic-recommendation.md`
