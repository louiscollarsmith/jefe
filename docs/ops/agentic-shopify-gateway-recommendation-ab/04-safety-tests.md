# Part 4 — Recommendation-mode safety proof

`apps/shopify/tests/agentic-shopify-gateway-recommendation-ab-safety.test.mjs` — **9/9 passing**,
run against the real integration point (`generateAgenticShopifyRecommendation`), not just the
standalone gateway module (that's the earlier session's
`agentic-shopify-gateway-safety.test.mjs`, still 20/20 passing and unaffected).

```
ok 1 - gateway surface + focusCandidate: a real read through shopify_query reaches RECOMMEND_ACTION
ok 2 - gateway surface is NOT applied to open-ended discovery (no focusCandidate) — scope restriction holds structurally
ok 3 - gateway surface + focusCandidate: shopify_prepare_mutation and shopify_execute_mutation remain unavailable in recommendation mode
ok 4 - gateway surface + focusCandidate: a mutation-shaped document sent to shopify_query is rejected structurally, never reaches Shopify
ok 5 - gateway surface + focusCandidate: schema lookup is optional — a read alone is sufficient to reach RECOMMEND_ACTION
ok 6 - gateway surface + focusCandidate: RECOMMEND_ACTION with zero successful reads is still rejected (INSUFFICIENT_INVESTIGATION)
ok 7 - gateway surface + focusCandidate: a real read followed by a genuine NO_ACTIONABLE_OPPORTUNITY is accepted, not misreported as insufficient investigation
ok 8 - gateway surface + focusCandidate: a real read followed by BLOCKED is accepted, not misreported as insufficient investigation
ok 9 - catalog surface (default, env unset) is completely unaffected by the gateway wiring

tests 9, pass 9, fail 0
```

## Why each matters

- **Test 1** proves the wiring actually works end to end with a scripted model, not just in theory.
- **Test 2** is the scope-restriction proof the task's "Important scope restriction" section
  demanded: even with `SHOPIFY_AGENT_SURFACE=gateway` set, a call without `focusCandidate` never
  dispatches a gateway tool — the call gets silently dropped by the turn normalizer's allow-list,
  identically to how any hallucinated/unrecognized tool name always was.
- **Test 3** proves the mutation tools stay unreachable *at the real call site*, not merely in the
  standalone gateway module — the standalone tests proved the dispatcher refuses them; this proves
  the integration never even considers offering them here.
- **Test 4** is the never-relies-on-the-model-behaving proof at this layer: a mutation-shaped
  document sent through `shopify_query` is rejected by the parsed-AST check
  (`SAFETY_OPERATION_KIND_MISMATCH`) before the fake Shopify client is ever called — asserted
  directly (`clientCalled === false`).
- **Tests 5/6** prove Part 4 of the brief ("schema lookup optional, not ritualistic") both ways: a
  read-only run with zero `shopify_schema` calls succeeds (5), and a run with zero reads at all
  still fails regardless of surface (6) — schema lookup is optional, a real read is not.
- **Tests 7/8** are the regression tests for the bug found and fixed this session (see
  `15-remaining-limitations.md`): a genuine successful read followed by a legitimate
  `NO_ACTIONABLE_OPPORTUNITY`/`BLOCKED` conclusion must not be misreported as an investigation
  failure.
- **Test 9** is the default-path regression guard: with the env var unset, behaviour is
  byte-identical to before this session's changes.

## Full suite

Combined with the earlier session's standalone gateway tests and the existing recommendation-agent
test files (`recommendation-breadth`, `recommendation-convergence`, `candidate-pipeline`,
`agentic-eligibility`, `agentic-shopify-runtime`, etc.), 203/203 tests pass. Full-suite result (all
1900+ tests in the repo) is in `12-test-suite-results.md`.
