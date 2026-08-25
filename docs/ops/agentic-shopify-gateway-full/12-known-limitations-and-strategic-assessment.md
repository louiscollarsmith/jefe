# Part 12 — Known limitations and final strategic assessment

## Known limitations

1. **Open-ended discovery has no production caller.** `recommendation-agent.server.js`'s
   non-`focusCandidate` branch is migrated and tested but not exercised by real traffic —
   `candidate-pipeline.server.js` is the only real caller and always passes `focusCandidate`. Not a
   regression (it was equally uncalled before this pass); worth deleting entirely in a future pass
   if it stays permanently uncalled, rather than carrying dead-in-production code indefinitely.
2. **`CAPABILITY_RETRIEVAL_FAILURE` heuristic not re-examined.**
   `candidate-disposition-taxonomy.server.js` defaults an unresolved candidate family to this
   disposition on the assumption that a retrieval miss is more likely than a genuine Shopify gap —
   a heuristic tuned for the old catalog top-N search's known incompleteness. The Gateway can now
   prove non-existence deterministically (`FIELD_NOT_FOUND` from `analyzeGatewayDocument`), which
   may make this heuristic's original justification stale for candidates fed Gateway-derived
   evidence. Not touched in this pass (out of scope: this concerns a separate curated
   capabilities/policy catalog, not the 810-op stub catalog or the tool-dispatch surface migrated
   here).
3. **No dedicated observability for Gateway-specific behavior** (schema-lookup-before-read rate,
   `analyzeGatewayDocument` rejection-code distribution) — see Part 8.
4. **`scripts/eval-agentic-shopify-runtime.mjs`** had one broken import fixed
   (`buildExecutionSystemPrompt` → `buildGatewayExecutionSystemPrompt`) but was not run end-to-end
   in this pass (requires live LLM keys and a live dev Shopify store).
5. **`SHOPIFY_AGENT_SURFACE` is now fully inert.** No production code reads it; the env var and its
   `withSurface()` test scaffolding (4 test files) are harmless vestiges of the earlier A/B-scoped
   design, not cleaned up in this pass. `.env.example`'s documentation of it was removed since it
   was actively misleading (implied a live toggle).

## What this migration proves, empirically, not just architecturally

- **Real golden-path write.** Accept → agent-composed `productUpdate` mutation → agent-composed
  verification query → `completed`, against `jefe-local-store.myshopify.com`, no scripted
  responses. Full trace: `real-dev-store-golden-path-trace.json`.
- **Real bugs only a live run finds.** Two of the three bugs fixed in this pass (Part 5) were found
  by the model actually being wrong in a way no fixture would have exercised: a genuine argument-
  name mismatch (`input` vs. `product`) self-corrected via `shopify_schema` after the error-detail
  fix, and a genuine claim-without-a-write caught by the `WRITES_COMPLETE` gate. The third
  (fingerprint canonicalization) was found by *removing* the fixture layer that had been masking it
  — migrating a test from a scripted catalog stub to a real `graphql` parse/print round trip.
- **Same safety guarantees, proven at the entry point that now actually matters.** The 14 tests in
  `shopify-api-gateway.test.mjs` are not new coverage — they're the *existing* deep safety-pipeline
  tests, re-run through `stubOverride` instead of catalog-name lookup, and all still pass
  unmodified in assertion (only the stub-construction mechanism changed). This is the strongest
  evidence that removing the catalog dispatcher did not weaken anything CLAUDE.md calls out as
  permanent: accepted-Action-revision authorization, live-scope checks, blast-radius, explicit
  confirmation, idempotency, and the ledger all behave identically whether the mutation came from a
  catalog stub or an agent-composed document.

## Strategic assessment

The original recommendation A/B (`docs/ops/agentic-shopify-gateway-recommendation-ab/`) concluded
`CONTINUE_DUAL_TRACK` — not yet a case for full replacement, pending more evidence. That evidence
arrived through this session's work itself: the catalog path's top-N pre-filtering caused a real,
reproducible false-negative (`collectionCreate`/`collectionAddProducts` invisible to a real
candidate), and the *same* pre-filtering pattern was independently found live in the execution and
verification agents too (three call sites, not one) — meaning the risk wasn't confined to one
investigation branch, it was structural to how the catalog surface fed the model capability
information everywhere. Combined with the founder's explicit instruction to remove the catalog
architecture entirely rather than maintain two parallel Shopify agent surfaces indefinitely, the
dual-track question is now settled by removal: there is one surface, it has the same safety
guarantees the old one had (proven, not assumed), and it structurally cannot reproduce the failure
mode that motivated building it in the first place.

The main open cost is #1 above — real production traffic has now exercised the Gateway through
`focusCandidate`-scoped recommendation, execution, verification, and chat, but not yet at the volume
the catalog surface saw over its lifetime. `mutation-safety.server.js`'s classifier and
`document.server.js`'s validator are unchanged/battle-tested independent of this migration, which
bounds that risk considerably — the newly-live surface area is "how a stub gets built," not "what
happens once one is built."
