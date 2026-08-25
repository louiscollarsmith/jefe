# Part 06 — Merchant Memory freshness, and reconciliation against live Shopify state

## Merchant Memory freshness (task Part 9)

Sample of the beliefs actually cited across the target run's candidate reasoning (real rows from
`merchant_memory_beliefs`):

| Belief key | `last_observed_at` | `last_evaluated_at` | Cited by |
| --- | --- | --- | --- |
| `customers.known_customer_count` | 16:35:44.536Z | 16:35:44.536Z | `improve-repeat-purchase-measurement` |
| `business.activity_profile` | 16:35:44.536Z | 16:35:44.536Z | `restore-order-momentum` |
| `inventory.stale_inventory_level_share` | 16:35:44.536Z | 16:35:44.536Z | `refresh-inventory-confidence` |
| `products.selling_product_count.trailing_90d` | 16:35:44.536Z | 16:35:44.536Z | `activate-rising-product` |
| `products.cost_coverage` | 16:35:44.536Z | 16:35:44.536Z | `capture-product-margin` |
| `products.product_momentum.trailing_60d` | 16:35:44.536Z | 16:35:44.536Z | `activate-rising-product` |
| `data.inventory_freshness_hours_p90` | 16:35:44.536Z | 16:35:44.536Z | `refresh-inventory-confidence` |

**Every belief behind every candidate was computed at the exact same instant** — a single
onboarding backfill pass at `16:35:44.536Z`, ~2.5 minutes after the shop record itself was created
(`16:33:15.344Z`). None of these beliefs has been refreshed since. By the target run's start
(17:15:40Z), the belief layer was ~40 minutes stale relative to a hypothetical continuously-updating
memory system.

**Is this a bug?** No — this is a brand-new test-store connection with one onboarding backfill and
no subsequent memory-refresh cycle having fired yet in the ~46-minute window between store
connection and this report being requested. That is the expected state of a store this young, not
evidence of a broken refresh mechanism.

**Did staleness corrupt candidate generation or rejection?** No corroborated instance. Every
candidate's disposition is backed by a **live Shopify read taken during this run**, not a bare
memory claim — the model consistently cross-checked memory-derived hypotheses against fresh reads
(e.g., `products.cost_coverage: 0%` → confirmed live via `inventoryItems`;
`inventory.stale_inventory_level_share: 51/51` → the *live* read also failed to produce a
trustworthy quantity, consistent with the memory claim, not contradicting it). Classification per
candidate:

| Candidate | Initial-hypothesis evidence quality |
| --- | --- |
| `restore-order-momentum` | CURRENT_RELIABLE_EVIDENCE (memory claim, then live-confirmed) |
| `capture-product-margin` | CURRENT_RELIABLE_EVIDENCE |
| `increase-basket-combination` | CURRENT_RELIABLE_EVIDENCE |
| `activate-rising-product` | CURRENT_RELIABLE_EVIDENCE (the momentum claim; the *channel* question hit a real scope gap, not a memory problem) |
| `improve-repeat-purchase-measurement` | CURRENT_RELIABLE_EVIDENCE, but see Part 05 — the taxonomy mislabel is downstream of the model's own status choice, not memory staleness |
| `refresh-inventory-confidence` | CURRENT_RELIABLE_EVIDENCE — and see Part 04, the actual gap here is investigation depth (didn't query inventory levels), not stale memory |

One minor data hygiene note, unrelated to staleness: one belief ID in candidate 6's `beliefIds`
array is malformed in the persisted JSON — `"5092d4e9-6884-4101-bb0f-d6c0ce9e8f?"` (a garbled UUID,
literally ending `f?`) immediately followed by what looks like the intended, well-formed value
`"5092d4e9-6884-410e-ba1d-2256a52e1b90"`. Cosmetic — did not affect this run's outcome — but worth a
look at whatever serializes `beliefIds` into the candidate record.

## Existing Action vs. live Shopify state (task Part 10)

Did the "Proven Products" Action change Shopify enough to invalidate other candidates, and is
Merchant Memory describing the store *before* the Action while Gateway/the running system reads it
*after*?

**Direct comparison:**

| | Merchant Memory snapshot (16:35:44Z, before the Action existed) | Live Shopify read during target run (17:15–17:19Z, ~38 min after Action acceptance) |
| --- | --- | --- |
| "Proven Products" collection | Did not exist (Action not yet proposed) | Exists, **empty** — `activate-rising-product`'s own read: *"collections shows an existing empty Proven Products collection"* |
| Borderlands Discovery Four collection membership | N/A | Not added (consistent with Part 02's finding: execution stopped at `collectionAddProducts`, blocked on explicit confirmation) |

**Conclusion: no memory/Shopify desync problem found.** The candidate that actually touched this
area read *live* Shopify state directly and got it right — it did not rely on a stale
pre-Action memory snapshot and did not incorrectly assume the collection was populated. There is no
evidence in this run of "candidate discovery generating already-resolved opportunities" because
memory lagged the Action's real effects; the one candidate adjacent to this area demonstrates the
opposite (correct, current awareness).

No memory-refresh/rebuild mechanism needs identifying for this run — the reconciliation this Part
asks about did not need to happen, because nothing here was ever actually resolved by the Action
(the collection is real but empty; there is nothing later Shopify reads could contradict that memory
still describes as unresolved).
