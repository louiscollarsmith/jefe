# Part 5 — Candidate lifecycle (central deliverable)

Reconstructed from `raw/target-run-result.pretty.json` (`trace.progressLog`, `trace.toolResults`,
`diagnostics.candidateQueue`), in investigation order. Timestamps are UTC.

| Candidate | Evidence question | Shopify queries | Useful answer obtained? | Proposed write | Final disposition | Reason |
| --- | --- | ---: | ---: | --- | --- | --- |
| `reactivate-sales-after-gap` (18:04:59–18:05:10) | Are Borderlands Discovery Four / Cloud Needle Tsolikouri currently live and placeable? | 1 `shopify_query` (`products`) | **No — returned 0 nodes** (see 05/06: this is independently disproven against live Shopify) | Promotional placement of the two products | `REJECTED` / `WEAK_DIAGNOSIS` | "products query returned zero nodes for both named products" |
| `improve-customer-retention-measurement` (18:05:10–18:05:15) | Can orders be linked to customer identities via Shopify state? | 1 `shopify_query` (`products`, reused/not directly on-topic for this candidate's question) | No — same empty products read; no orders/customers query was actually issued for this candidate's own question | Enable customer identity capture | `NON_EXECUTABLE` | "only successful live read was a products query… does not establish order-to-customer linkage" |
| `raise-items-per-order` (18:05:15–18:05:19) | Do the two anchor products exist to build a bundle/cross-sell around? | 0 new (`ALREADY_AVAILABLE` reuse of the same empty products read) | No — inherited the same empty result | Complementary-product bundle | `BLOCKED_BY_EVIDENCE` | "executed successfully but returned zero product nodes" |
| `recover-declining-product-demand` (18:05:19–18:05:34) | Can the two anchor products be used to reorder merchandising ahead of decliners? | 0 new (`ALREADY_AVAILABLE` reuse) | No — inherited the same empty result | Reorder collection/storefront placement | `BLOCKED_BY_EVIDENCE` | "prior products query returned an empty node set… no collection/storefront ordering state was read" |
| `restore-unavailable-variants` (18:05:34–18:05:57) | Which 2 of 25 tracked variants have 0 available units, and what are safe in-stock alternatives? | 1 new `shopify_query` (`products`, this time genuinely scoped to product/variant status+inventory+price — a *different*, on-topic query, not the anchor-products search) | No — this on-topic query **also returned 0 matching nodes** | Replenish or swap placement | `BLOCKED_BY_EVIDENCE` | "successful Shopify products query returned zero matching nodes, so the two affected variants cannot be identified" |
| `capture-product-margin-data` (18:05:57–18:06:51, includes 1 provider error + retry + 2 belief-id repair turns) | Is cost-per-item populated for the 25 active variants? | 1 new `shopify_query` (`products`/variants incl. `inventoryItem.unitCost`) — **succeeded and returned real data**: 25 variants across 17 ACTIVE products | **Yes** — genuinely confirmed all 25 `unitCost` values are `null` | Populate cost data, then use it for margin-aware promotion | `BLOCKED_BY_EVIDENCE` | "Shopify cannot provide authoritative supplier purchase costs… merchant-confirmed cost mapping… required" — this one is correctly grounded |
| Rescue pass (18:06:51–18:07:11) | Is there a genuinely different opportunity the 6 rejected candidates missed? | 0 (discovery-only call, no tool calls) | N/A | — | 0 candidates produced | See 09 |

## The load-bearing pattern

Candidates 1, 3, and 4 never issued their own Shopify query — they reused candidate 1's single
`products` read via the `ALREADY_AVAILABLE` cache ("this exact GraphQL document and variables were
already run successfully in this run… do not call again"), and inherited its empty result as if it
answered their own, different evidence questions. That reuse mechanism is working as designed (it
exists to stop redundant identical calls) — the actual defect is upstream of it: **the first
`products` read, whatever it searched for, returned zero nodes for two products that are real,
ACTIVE, and trivially searchable** (05/06). Everything downstream of that one empty read inherited a
false negative.

Candidate 5 (`restore-unavailable-variants`) is the cleanest evidence that this isn't a caching
artifact: it issued its **own**, differently-scoped `products` query (for variant-level inventory
data, not a title search) and *also* got zero matching nodes. Two independently-issued `products`
queries in the same run, on the same live store, both returning zero nodes for products this
investigation proved exist — that is a pattern, not a one-off unlucky query string.

Candidate 6 (`capture-product-margin-data`) is the control case: its `products` query **worked
correctly** and returned the real 25-variant/17-product data used to reach a genuinely-grounded
rejection. This rules out "the Gateway's products tool is broken" as a blanket explanation — the tool
clearly can and did return real product data in the same run. Whatever went wrong with the other two
`products` reads is scoped to *how those two calls searched* (most likely their query filter
argument), not to the tool or transport layer. See 05/06 for why the exact query text is not
recoverable from this run's persisted record, and what independent evidence rules in/out as the
mechanism.
