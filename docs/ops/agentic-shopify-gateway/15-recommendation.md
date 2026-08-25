# Part 15 — Recommendation: catalogue vs gateway

## Answering the question directly

> Is a schema-driven Agentic Shopify Gateway materially more capable, simpler and more future-proof
> than maintaining a generated Shopify operation catalogue?

**On the architectural properties that were actually testable this session: yes, and by a wide
margin, with real evidence.** On recommendation quality against a live store: **not yet answerable**
— that half of the comparison needs a live Shopify token and the migration work in
`14-migration-rollback-strategy.md`, neither of which this session had.

## What's proven, not asserted

- **Future-proofing is demonstrated, not argued.** An operation that has never existed in any
  Shopify catalogue Jefe has ever generated gets a real, safe, non-dead-end classification from the
  gateway with zero code changes — proven by an automated test, not a claim about what should happen
  in theory (`09-adversarial-safety-test-results.md`).
- **Safety is demonstrably not weaker.** 20/20 adversarial tests pass, covering every vector the task
  brief named plus one it didn't (multi-root-mutation-field smuggling). The execution path reuses,
  byte-for-byte, the same authorization/blast-radius/confirmation/idempotency/ledger code the
  catalogue path already runs in production — 29/29 pre-existing tests still pass.
- **A real model can actually do the discovery-and-compose work.** Not a simulation: a live LLM,
  given only the gateway's 4 tools and a natural-language task, discovered real Shopify schema
  fields, adapted when a discovery strategy failed, and wrote a valid, idiomatically-correct GraphQL
  query on its first attempt (`10-real-shopify-query-examples.md`).
- **The maintenance-burden argument is concrete.** 810 generated stub entries with a regeneration
  script vs 0 — and the "0" side isn't a design promise, it's what the classifier already was after
  the unrelated 2026-08-25 execution-safety change, which this experiment discovered and reused
  rather than needing to build.

## What's genuinely still open

- Recommendation *quality* on real merchant data, live-store, side by side — blocked on a live token
  this session, not on anything architectural.
- The 810-op catalogue also does real work today beyond schema data: it's the source for
  `KNOWN_GOOD_OVERRIDES` context (which operations have real typed adapters) and for the
  domain-taxonomy scope inference used across the app. The gateway reuses that data rather than
  replacing it — "retire the catalogue" and "stop using it as the model's tool surface" are different
  claims, and this report only supports the second one.
- Full GraphQL schema validation (`validate()` against a complete `GraphQLSchema`) needs a live
  introspection fetch this session didn't have access to.

## Recommendation

**Keep both running, behind the existing `SHOPIFY_AGENT_SURFACE` flag, and do the migration work in
`14-migration-rollback-strategy.md` before deciding.** The evidence gathered this session is strong
enough to justify that investment — the safety and future-proofing properties are real and tested —
but not strong enough to justify retiring 810 generated operations and the infrastructure around them
on the strength of an 8-turn schema-discovery run with no live Shopify response. The next concrete
step is getting `JEFE_GOLDEN_PATH_SHOPIFY_ADMIN_ACCESS_TOKEN` populated and running
`node scripts/eval-agentic-shopify-gateway.mjs --real-shopify`, followed by wiring the gateway into
`recommendation-agent.server.js` for a real side-by-side comparison.
