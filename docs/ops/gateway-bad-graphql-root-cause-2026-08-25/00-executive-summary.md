```text
ORIGINAL FAILED RUN:
80553fc7-13d4-4b5a-b151-a82648c949d2

REPRODUCED BAD QUERY:
YES — three independent, individually-reproduced mechanisms, plus a fourth harness-level defect
that discards a correct self-corrected query.

EXACT FAILING GRAPHQL:
(1) nodes(ids: ["e00fb90c-15a8-44ed-8f26-d702e11c2322", "15523d15-581c-4e80-80c3-bdb36a524dc8"])
    — raw internal database ids passed as Shopify GIDs → hard GraphQL error.
(2) nodes(ids: ["gid://shopify/Product/e00fb90c-...", "gid://shopify/Product/15523d15-..."])
    — same internal ids wrapped in a syntactically-valid gid:// prefix → silent {"nodes":[null,null]}.
(3) products(query: "title:(\"Borderlands Discovery Four\" OR \"Cloud Needle Tsolikouri\")")
    — a Shopify search-DSL grouping form that executes cleanly but matches nothing.
See 03-actual-generated-graphql.md for full documents and variables.

WHAT DID SHOPIFY RETURN?
(1) A GRAPHQL_FAILURE error: "Invalid global id '...'" for both ids.
(2) FULL_SUCCESS classification, but {"nodes": [null, null]} — the exact "returned zero nodes"
    symptom the original run described in its own reasoning.
(3) FULL_SUCCESS classification, {"products": {"nodes": []}}.

WHAT SHOULD SHOPIFY HAVE RETURNED?
Both named products, ACTIVE, with real inventory/variant data — confirmed by this investigation's
own corrected query (03, Attempt D) and by the prior investigation's independent curl verification.

WHY DID THE QUERY RETURN ZERO NODES?
Two of the three reproduced mechanisms are the SAME root cause wearing different clothes: a
deterministic Merchant Memory belief (products.bestseller_by_revenue.trailing_90d and
products.product_momentum.trailing_60d) serializes our own internal Postgres products.id under a
field literally named "productId" — a value that is UUID-shaped exactly like a real Shopify GID's
suffix, with nothing to distinguish it. The model, reasonably, used that value as a Shopify
identifier. The third mechanism (search-DSL grouping) is independent: Shopify's `field:(A OR B)`
grouped-parenthesis form silently matches nothing, where `field:'A' OR field:'B'` works.

WAS THE GRAPHQL SCHEMA-VALID?
YES, in every attempt. Every document parsed, passed structural validation, and executed against
Shopify without a single GRAPHQL_SYNTAX_ERROR or Gateway-side rejection in this investigation's
reproductions (the one GRAPHQL_FAILURE was Shopify itself rejecting an invalid id value at
execution time, not the Gateway's own document validator).

WAS THE SHOPIFY SEARCH DSL CORRECT?
NO, for the products(query:...) attempt — see above. YES for the plain nodes(ids:) attempts (the
document shape was correct; the id values inside it were wrong).

DID THE GATEWAY MODIFY THE QUERY INCORRECTLY?
NO. Traced the full parse → validate → print(ast) → client.request() pipeline directly; the raw
model-generated document and the document that reached Shopify were identical in every attempt
(05-gateway-document-transform.md). GATEWAY_TRANSFORM_CORRUPTION is ruled out.

WERE STABLE SHOPIFY IDS AVAILABLE TO THE MODEL?
YES — but not a valid one. A stable-looking id was available and used; it was our internal database
key, not the real Shopify GID, which sat one field over (products.externalId) and was never
surfaced to the model. See 07-stable-id-analysis.md.

DID LUNA STOP TOO EARLY AFTER THE EMPTY RESULT?
MIXED. In one reproduction (Attempt C), the model correctly diagnosed the null result and issued a
corrected, successful query in its very next turn — but paired that correction with a terminal
BLOCKED status in the same turn, and the harness honored BLOCKED without ever showing the model that
query's (correct) result. In two other reproductions, the model accepted an empty/unavailable read
as final without retrying at all. Both patterns are real; only the first is conclusively a harness
defect rather than a model-judgment gap (10-empty-result-reasoning.md).

DID ALREADY_AVAILABLE PROPAGATE THE BAD EVIDENCE?
YES, structurally as designed (a global tool-result cache is deliberate), but the deeper defect it
exposed for one candidate (improve-customer-retention-measurement) is that the investigation-
sufficiency gate accepts ANY successful read as satisfying "investigation happened," regardless of
whether that read bears on the specific candidate's question (11-cache-evidence-propagation.md).
Not fixed in this pass — not narrow enough to meet this task's fix bar.

PRIMARY ROOT CAUSE:
A deterministic Merchant Memory belief serialized our internal database primary key under a
"productId" field with no marker distinguishing it from a real Shopify identifier, and the model
used it directly in a Shopify GraphQL id lookup, which either hard-errors or silently resolves to
null depending on whether the id happens to be wrapped in a gid:// prefix.

SECONDARY ROOT CAUSE:
The recommendation loop honors a terminal disposition (BLOCKED/NO_ACTIONABLE_OPPORTUNITY/
RECOMMEND_ACTION) even when the same model turn also issued a new tool call, discarding that tool
call's result — observed directly discarding a correct, self-corrected query.

FIX IMPLEMENTED:
(1) app/lib/merchant-memory/shopify-derivations.server.js: added productShopifyGid(), resolving to
    products.externalId (the real Shopify GID), applied at all 7 belief-construction sites that
    previously serialized the internal products.id under a productId key. (2)
    app/lib/shopify/agentic-runtime/recommendation-agent.server.js: the main investigation loop now
    always re-consults the model with fresh tool results before honoring any terminal status,
    instead of only doing so when the model's own declared status was CONTINUE. Both fixes have
    focused regression tests (a belief-shape scanning test for (1); a scripted-turn test
    reproducing the exact discarded-self-correction for (2)); the full affected 282-test suite
    passes. Neither fix touches grounding thresholds, prompts, or dispositions.

POST-FIX REAL RUN:
Not completed — the session's Shopify access token expired partway through this investigation
(13-post-fix-real-recommendation.md), before a live post-fix reproduction could capture a
successful end-to-end result. Both fixes are verified via targeted deterministic regression tests
that reproduce the exact mechanisms found live; a fresh live run is the explicitly recommended next
step once a valid dev session token is available, and this report does not claim an outcome it did
not observe.

CLASSIFICATION:
MULTIPLE — primary: a data-quality defect in Merchant Memory belief serialization (closest named
bucket: STABLE_ID_NOT_USED, inverted — a stable id was used, and it was wrong). Secondary: a
harness orchestration defect (closest named bucket: EMPTY_RESULT_ACCEPTED_TOO_EASILY, but more
precisely structural than judgment-based). Two further causes were conclusively identified and
left unfixed by design: a Shopify search-DSL grouping gotcha, and a schema/cost-limit gap for
broad nested inventory reads — see 12-root-cause-and-fix.md for why each falls outside this pass's
"narrow, conclusively proven" fix bar.
```

## Document set

- `01-runtime-provenance.md` — Parts 1–2: the safeTrace() fix re-verified, and why every
  reproduction in this report bypasses the shared-workspace tunnel risk entirely.
- `02-isolated-reproduction.md` — Part 3: method, attempts, headline result across all three
  candidates reproduced.
- `03-actual-generated-graphql.md` — Part 4: every document and variable set, attempt by attempt,
  diffed against the known-good query.
- `04-shopify-search-dsl-analysis.md` — Part 5: the search-DSL grouping mechanism, isolated.
- `05-gateway-document-transform.md` — Part 8: GATEWAY_TRANSFORM_CORRUPTION ruled out directly.
- `06-schema-tool-and-model-guidance.md` — Parts 6–7: tool guidance is insufficient, and
  `shopify_schema` structurally could not have helped for this class of failure.
- `07-stable-id-analysis.md` — Part 11: stable IDs were available, and wrong; where the real GID
  was sitting unused; scope-checked against variant/order/customer references.
- `08-three-products-query-comparison.md` — Part 10: what actually distinguishes the two failing
  queries from the one that worked.
- `09-generated-query-reliability-benchmark.md` — Part 12: benchmark coverage actually achieved and
  its honest gaps.
- `10-empty-result-reasoning.md` — Part 13: query-generation vs. empty-result-reasoning, kept
  separate as instructed.
- `11-cache-evidence-propagation.md` — Part 14: `ALREADY_AVAILABLE`'s real mechanism and the
  topical-relevance gap it exposed.
- `12-root-cause-and-fix.md` — Part 16: ranked causes, the two fixes made, and why three further
  causes were flagged rather than fixed.
- `13-post-fix-real-recommendation.md` — Part 15: honest reporting of the session-token expiry that
  prevented a live post-fix run, and what was verified instead.
- `raw/` — real captured GraphQL documents, variables, and Shopify responses from this
  investigation's reproductions; no access tokens.
