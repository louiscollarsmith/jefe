# Part 10 — Comparing the two failing queries against the one that worked

| | Query A (`reactivate-sales-after-gap`) | Query B (`restore-unavailable-variants`) | Query C (`capture-product-margin-data`) |
| --- | --- | --- | --- |
| Business intent | Find two *named* products | Find variants with zero available inventory | Read cost data across *all* active variants |
| Own evidence carries a product identifier? | **Yes** — `productId` (internal id) in 2 cited beliefs | No — cited beliefs are pure aggregates (`out_of_stock_variant_count`, `in_stock_variant_share`) | No — cited belief is a pure aggregate (`cost_coverage`) |
| Query shape attempted | Named-entity resolution: `nodes(ids:)` or `products(query: "title:...")` | Broad scan: `products(first: 100, query: "status:active")` with nested inventory | Broad scan: `products(first: 50, query: "status:active")` with nested `variants.inventoryItem.unitCost` |
| First-attempt outcome | Failed (3 different ways across attempts) | Failed (wrong field name, then cost-limit exceeded) | **Succeeded immediately** |
| Root mechanism | Named-entity identifier confusion + a search-DSL grouping gotcha | Schema-knowledge gap (wrong field name) + a structural Shopify cost-limit rejection | None — no identifier resolution needed, and the nested selection stayed within the cost budget |

## The pattern the task brief asked to look for

> A+B use Shopify `query:` search filters; C performs a broader/unfiltered scan.

**Confirmed, but not for the reason initially hypothesized.** A and C both use a `query:` search
filter (`status:active` appears in both B and C too) — the discriminator is not "filtered vs.
unfiltered." It is: **A required resolving specific named entities to Shopify identifiers first**
(the identifier-confusion and search-grouping defects only bite when the model needs to pin down
*which* products it means), while **B and C both scan broadly by status with no named entities at
all** — B's failures are unrelated to identity (wrong field name, then a cost-limit ceiling from
requesting too much nested data per product), and C stayed within both the field-correctness and
cost budget on its first attempt purely because its nested selection (`variants(first: 100) {
inventoryItem { unitCost } }`) is cheaper than B's (`inventoryLevels(first: 5) { nodes { available
location { name } } }` per variant, per product, at `first: 100` products).

**Refined finding**: the common thread across A and B's failures is not "search filter vs. no
filter" — it's **"the harder investigative question (resolve named entities, or read
inventory-per-location across the full catalogue) requires either data Merchant Memory doesn't
correctly expose (A) or a query shape more expensive than a first attempt naturally lands on (B)."**
C's success reflects that its underlying business question (aggregate cost coverage) is the cheapest
and least identity-dependent of the three, not that broad scans are reliable in general — B's broad
scan failed twice before succeeding.
