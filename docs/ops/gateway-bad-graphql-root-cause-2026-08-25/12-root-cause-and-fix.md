# Part 16 — Root cause ranking and fixes implemented

## Ranked causes (evidence only, nothing hypothetical)

1. **Internal database id serialized as `productId` in model-visible Merchant Memory beliefs**
   (`MULTIPLE` → closest named bucket `STABLE_ID_NOT_USED`, but inverted: a stable-looking id *was*
   used, it was simply the wrong one). Proven via exact string match between a belief's `productId`
   and the local `products.id` row, and via two independent live reproductions (Attempts B, C) where
   the model passed that value into `nodes(ids:)` and got either a hard error or a silent `null`.
   **FIXED** — see below.
2. **A harness defect: a terminal status paired with a pending toolCall is honored before the
   toolCall's result is seen** (`EMPTY_RESULT_ACCEPTED_TOO_EASILY`, but more precisely a structural
   orchestration bug than a "should we be more skeptical of empty results" policy question). Proven
   directly: Attempt C's own next turn issued a corrected, successful query in the same response as
   `status: "BLOCKED"`, and the harness returned `BLOCKED` to the caller without the model ever
   seeing that query's real, correct result. **FIXED** — see below.
3. **A Shopify search-DSL grouping gotcha**: `title:(A OR B)` executes without error and matches
   nothing; `title:'A' OR title:'B'` works. Proven via two real, differently-shaped live queries
   (Attempts A and D) against the same store. **NOT FIXED** — see "Flagged, not fixed" below for why.
4. **Schema-knowledge and query-cost gaps for broader inventory reads**: a hallucinated field name
   (`InventoryLevel.available`) and a genuine Shopify per-query cost-limit rejection (2540 vs. 1000)
   when nesting inventory-level data across 100 products. Proven via `unavailable-variants`'
   reproduction. **NOT FIXED** — unrelated to product identity, a distinct problem class.
5. **A topical-relevance gap in the investigation-sufficiency gate** (`validateInvestigation` accepts
   *any* successful read as satisfying "investigation happened," regardless of whether it bears on
   the specific candidate's question). Proven via `improve-customer-retention-measurement`'s
   termination reasoning. **NOT FIXED** — not narrow enough to satisfy this task's fix bar (`11`).
6. **`GATEWAY_TRANSFORM_CORRUPTION`: ruled out.** Proven via direct document-text comparison across
   the parse/validate/reprint pipeline (`05`).
7. **`TOOL_GUIDANCE_INSUFFICIENT`, but structurally unfixable via the schema tool.** Shopify's own
   GraphQL schema does not carry ID-provenance or search-grammar documentation in a form
   introspection exposes (`06`). The fix for cause #1 sidesteps this rather than trying to teach it.

## Fix 1 — resolve product references to the real Shopify GID, not the internal database id

`app/lib/merchant-memory/shopify-derivations.server.js`: added `productShopifyGid(context,
productId)`, resolving via `products.externalId` (already stored as `gid://shopify/Product/…`), and
applied it at all 7 belief-construction sites that were serializing the internal `products.id` under
a `productId` key (`product_momentum`, `top_returned_products`, `top_discounted_products`,
`product_inventory_cover`/velocity rows, `dead_stock`'s `topDeadProduct`, `bestseller_by_revenue`,
`bestseller_by_units`). One `knownAvailabilityByActiveProduct` internal-only aggregation site (never
reaches a belief's `value`) was left untouched — confirmed by tracing its only caller.

This is "teaching the agent the API contract" in the strongest form available: rather than telling
the model to be suspicious of ids (a prompt patch that degrades gracefully into "sometimes trust
this, sometimes don't"), it removes the wrong id from what the model ever sees. A model that reaches
for `productId` in a `products.bestseller_by_revenue` belief now gets a value that is directly usable
in `nodes(ids:)` and will resolve correctly.

Regression tests: 7 existing `tests/merchant-memory.test.mjs` / `tests/customer-discount-
intelligence-tranche.test.mjs` assertions updated from asserting the internal fixture id to asserting
the fixture's `externalId` GID (each fixture was given a realistic `gid://shopify/Product/…`
`externalId`, matching how the real `products` table is populated). One new test added — `"no
product-performance belief ever exposes an internal products.id under a productId key"` — walks every
derived belief's `value` recursively and asserts any `…productId` field is `gid://shopify/Product/…`,
never one of the fixture's own internal ids. This generalizes the regression beyond the two beliefs
this investigation happened to find broken.

## Fix 2 — a terminal status paired with a pending toolCall is provisional, not final

`app/lib/shopify/agentic-runtime/recommendation-agent.server.js`'s main loop: changed

```js
if (turn.toolCalls.length > 0 && turn.status === "CONTINUE") continue;
```
to
```js
if (turn.toolCalls.length > 0) continue;
```

Any toolCalls the model issues are now always executed and fed back before any terminal status
(`RECOMMEND_ACTION`, `NO_ACTIONABLE_OPPORTUNITY`, `BLOCKED`) declared in that same turn is honored.
`maxIterations` bounds this exactly as it already bounds ordinary `CONTINUE` turns — no new
loop-termination risk. This does not touch grounding thresholds, evidence requirements, or
dispositions: it only guarantees the model sees the results of tool calls it itself chose to make
before a verdict reaches the merchant.

Regression test added: `tests/agentic-eligibility.test.mjs` — `"a terminal status paired with a
pending toolCall is provisional, not final"` — a scripted turn declares `BLOCKED` alongside a
`shopify_query` call; asserts the model is re-consulted with that call's (successful) result before
`BLOCKED` would be honored, and that the run reaches `RECOMMEND_ACTION` once the model reconsiders
with the new evidence. The pre-existing "no investigation loop" semantic-repair test's fixture was
restructured (investigation and decision as two turns, matching what a real model must now do) rather
than deleted — its actual subject (one repair call, not an extra investigation round *for the repair
step itself*) is unaffected by this fix and still passes.

Full affected suite after both fixes: 282 tests, 0 failures
(`agentic-eligibility`, `agentic-shopify-gateway-recommendation-ab-safety`,
`agentic-shopify-runtime`, `candidate-pipeline`, `recommendation-breadth`,
`recommendation-convergence`, `recommendation-domain-competition`, `recommendation-domain-fixtures`,
`recommendation-llm-retry`, `recommendation-sequential-exhaustion`, `recommendation-belief-exposure`,
`recommendation-run-identity`, `agentic-recommendation-retry-lineage`, `home-proposal-generation`,
`recommendation-novelty`, `recommendation-gateway-trace-fields`, `merchant-memory`,
`customer-discount-intelligence-tranche`).

## Flagged, not fixed — and why each falls outside this pass's fix bar

- **Search-DSL grouping gotcha (#3)**: real and reproduced, but the "smallest correct fix" is not
  obvious without more evidence — teaching the model the grouping rule via a prompt addendum is a
  narrow, easy patch, but this investigation only reproduced one grouped-query failure; per this
  task's explicit instruction not to add "hardcoded title quoting" or one-off query special-cases,
  and given the model already self-corrects to the right shape unprompted in at least one attempt
  (Attempt D), a prompt-level general reminder about Shopify's `field:'A' OR field:'B'` convention is
  the right next step, not attempted here without a second data point confirming it recurs.
- **Wrong field name / cost-limit (#4)**: a genuinely different problem (inventory-per-location reads
  at scale), deserving its own investigation into whether/how the Gateway should guide the model
  toward paginated or narrower reads as catalogue size grows — out of scope for "the exact failing
  business question" this task named.
- **Topical-relevance gap in investigation-sufficiency (#5)**: conclusively demonstrated but not
  narrow (`11`) — would require the gate to judge semantic relevance, which this codebase currently
  and deliberately leaves to the model.

None of these three touch grounding thresholds, recommendation dispositions, or add generic
retry-on-empty behavior — consistent with this task's constraints.
