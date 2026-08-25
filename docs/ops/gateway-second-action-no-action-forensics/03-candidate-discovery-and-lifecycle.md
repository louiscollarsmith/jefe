# Part 03 — Raw candidate discovery and candidate-by-candidate lifecycle

Raw: `raw/candidate-queue.json` (full, unedited `diagnostics.candidateQueue`), `raw/discovery-log.json`,
`raw/progress-log.json`.

## Discovery output

First-pass discovery (17:15:40.516Z–17:15:55.673Z, ~15s, one LLM call, 66,017 tokens with 64,650
cached) produced **6 candidates**. Rescue discovery ran afterward (17:19:37.025Z–17:19:55.762Z,
~18s, one LLM call, 66,058 tokens, 0 cached) and produced **0 new candidates** — see Part 07.

**Did Luna still discover multiple commercially plausible opportunities? Yes.** Six candidates
spanning six different domains — marketing, product variants/margin, products/bundling,
collections/merchandising, customers/segmentation, inventory — is genuine breadth, not a set
narrowed around the existing collection Action. Only one candidate (`activate-rising-product`) is
even in the same domain (`collections`) as the existing Action.

| Rank | Candidate | Domain | Evidence cited | Proposed intervention | Overlaps existing Action? |
| ---: | --------- | ------ | --------------- | ---------------------- | -------------------------: |
| 1 | `restore-order-momentum` | marketing | 6 active selling days / 13 orders in trailing 30d, 19 days since last order | targeted promotion/marketing activity for proven products | No |
| 2 | `capture-product-margin` | variants | `products.cost_coverage` = 0% of 25 active variants | populate cost-per-item | No |
| 3 | `increase-basket-combination` | products | median order = 1 item, 54% of trailing-90d orders single-item, 6% ≥4 items | curated product bundle | No |
| 4 | `activate-rising-product` | collections | 1 product rising vs. 13 declining (trailing 30d momentum) | feature Cloud Needle Tsolikouri in a merchandising placement | Adjacent domain, different product, different mechanism — not the same Action |
| 5 | `improve-repeat-purchase-measurement` | customers | 0 of 50 stored orders linked to a known customer identity | improve customer data capture + create repeat-purchase segment | No — unrelated to the collection Action; rejected because Shopify already has an equivalent segment (Part 05) |
| 6 | `refresh-inventory-confidence` | inventory | 51/51 inventory levels stale, p90 freshness 462.18 hours | refresh/reconcile inventory quantities | No |

## Candidate-by-candidate lifecycle

Timing reconstructed from `trace.progressLog` (real, per-candidate timestamps — see Part 12 for
budget/duration analysis).

| Candidate | Shopify evidence requested | Evidence obtained | Safe intervention identified? | Final disposition | Exact reason (verbatim, truncated) |
| --- | --- | --- | ---: | --- | --- |
| `restore-order-momentum` | products, discount/marketing operation catalogue | Active products confirmed; no existing code/automatic discounts | No | `BLOCKED` / `INSUFFICIENT_EVIDENCE` | "...requires a specific offer (percentage, amount-off, BXGY, or free shipping), validity window, qualifying products, and channel. Shopify cannot infer the merchant's intended commercial terms..." |
| `capture-product-margin` | inventory items, variant catalogue | 25 active variants confirmed, cost_coverage 0%, inventoryItems returned no unit-cost values | No | `BLOCKED` / `INSUFFICIENT_EVIDENCE` | "...required accurate cost inputs are not stored in Shopify and cannot be inferred safely from prices, SKUs, inventory, or sales." |
| `increase-basket-combination` | products, customer/bundle operation catalogue | 17 active products confirmed with real prices; no discounts active | No | `BLOCKED` / `INSUFFICIENT_EVIDENCE` | "...Shopify has no authoritative input for which complementary products the merchant wants bundled or what bundle price/discount to use." |
| `activate-rising-product` | product, collections, **channels (failed)** | Product ACTIVE confirmed; collection read: existing empty "Proven Products" collection; `channels` → `NEEDS_SHOPIFY_AUTHORIZATION` (missing `read_publications`, verified real — Part 06) | No | `BLOCKED` / `INSUFFICIENT_EVIDENCE` | "...channels failed with NEEDS_SHOPIFY_AUTHORIZATION due to missing read_publications. Because the desired channel/placement...cannot be verified, no safe reversible merchandising mutation can be specified now." |
| `improve-repeat-purchase-measurement` | customers, segments | Linked customer/order records found; an existing "Customers who have purchased more than once" segment found (`number_of_orders > 1`) | N/A — already satisfied | `NO_ACTIONABLE_OPPORTUNITY` / `ALREADY_COVERED` → taxonomy-relabeled `DUPLICATE_EXISTING_ACTION` (Part 05) | "...the segments read found an existing...segment...No mutation is warranted." |
| `refresh-inventory-confidence` | inventoryItems | Stale-inventory premise confirmed live (matches Merchant Memory) but no trustworthy current-quantity source returned | No | `BLOCKED` / `INSUFFICIENT_EVIDENCE` | "...the Shopify reads do not provide a trustworthy current quantity source...applying values derived from the stale records would not constitute a safe refresh." |

Every disposition above is the *actual* runtime `finalDisposition`/`status` pair from
`candidateQueue`, not collapsed into a generic bucket — five of six land on the taxonomy's
`INSUFFICIENT_EVIDENCE` disposition, but the five underlying *reasons* are materially different from
each other (missing merchant business decision × 3, missing stored data × 1, missing OAuth scope × 1)
and are analyzed individually in Part 04/06.
