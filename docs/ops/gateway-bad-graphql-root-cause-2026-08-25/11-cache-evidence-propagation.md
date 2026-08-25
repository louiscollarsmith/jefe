# Part 14 — `ALREADY_AVAILABLE` propagation

## Mechanism (confirmed by reading the code, `recommendation-agent.server.js` lines ~440-449)

Cache key / identity: `findExistingGatewayQuery(toolResults, toolCall)` →
`gatewayQueryFingerprint(document, variables)` — a stable hash over the **exact printed document
text plus variables**. Any two calls with byte-identical (post-`print(ast)`) document and variables
hit the cache; anything else (a different query, a different candidate's differently-worded document
even for the same underlying question) does not.

Tool results are **global across candidates within one run** — `toolResults` is a single array
threaded through `runCandidateDrivenRecommendation` as `sharedToolResults`, passed to every
candidate's `generateAgenticShopifyRecommendation()` call as `initialToolResults`. This is
intentional and documented (avoids re-querying Shopify for the same fact across candidates in one
run) — not itself the defect.

## Why `improve-customer-retention-measurement` terminated without its own read

Its own evidence question — "can orders be linked to customer identities?" — has nothing to do with
a `products` read. Its termination reasoning explicitly says: *"The only successful live read was a
products query, which returned zero matching products and does not establish order-to-customer
linkage."* This is **not** the cache mechanism forcing reuse — nothing in `findExistingGatewayQuery`
or the investigation-sufficiency gate (`validateInvestigation`) required this candidate to accept an
unrelated read as satisfying its own question. `validateInvestigation`'s "at least one successful
`shopify_query` read" check is satisfied by *any* successful read, regardless of topical relevance —
that is the actual defect this candidate exposes:

```text
deterministic validation incorrectly considering "some successful read" sufficient investigation
```

not model reasoning alone, and not a server protocol *requiring* reuse — the model was free to issue
its own orders/customers query and chose not to, and the deterministic gate that should have forced
it to (`validateInvestigation`) only checks "did *a* read happen," not "did a read happen that bears
on *this candidate's own* diagnosed problem."

## Scope of this defect

This is real and distinct from everything else in this report — it is a **topical-relevance gap in
the investigation-sufficiency gate**, not a cache-scoping bug. Per this task's fix policy ("do not fix
unless conclusively proven and narrow"), this is conclusively demonstrated but **not narrow**: closing
it correctly requires the gate to understand whether a given tool result's fields are relevant to a
candidate's specific evidence question, which is a semantic judgment, not a structural one — the kind
of check this codebase currently delegates to the model itself rather than encoding deterministically
elsewhere (e.g. `checkKnownArguments` deliberately only validates argument *shape*, never business
relevance). **Flagged, not fixed, in this pass** — see `12` for why the fixes actually made here
target the two conclusively narrow, structural mechanisms instead.
