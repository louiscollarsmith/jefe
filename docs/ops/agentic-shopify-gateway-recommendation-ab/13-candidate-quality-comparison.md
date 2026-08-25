# Part 13 — Candidate-by-candidate quality comparison

## The headline finding: both surfaces investigated the same underlying opportunity, and diverged for a specific, reproducible, architectural reason

Candidate discovery is identical code (`discoverCandidates`, untouched, no Shopify tools involved)
run against the identical Merchant Memory snapshot, so both runs surfaced a candidate about the
same real problem: most orders are single-item (54% of trailing-90-day orders, median order size
one item).

- **Catalogue mode** investigated this as `increase-multi-product-baskets`
  (priority 3, one of 8 candidates) and concluded **`NON_EXECUTABLE`**: *"No collection or
  product-merchandising write operation is available."*
- **Gateway mode** investigated the same underlying opportunity and reached **`RECOMMEND_ACTION`**:
  *"Create a curated in-stock discovery collection to encourage larger baskets,"* using exactly
  `collectionCreate`/`collectionAddProducts`.

**Both operations catalogue mode said didn't exist are real, reviewed, currently executable
operations** (`collectionCreate`: `EXECUTABLE_WITH_CONFIRMATION`/`APPROVAL_REQUIRED`;
`collectionAddProducts`: `EXECUTABLE_WITH_CONFIRMATION`/`EXPLICIT_HIGH_RISK_CONFIRMATION_REQUIRED`
— verified directly against the real catalogue, not asserted).

## Why the catalogue path missed them — reproduced directly, not inferred

Candidate-scoped investigation in catalogue mode server-binds relevant operation stubs *before* the
model's first turn (`retrieveShopifyApiOperations(bindingQuery, { limit: 8 })`, where `bindingQuery`
is built from the candidate's `possibleIntervention` + `diagnosedProblem` text) — this exists
specifically to avoid the model burning turns on ad hoc `retrieve_shopify_operations` calls. Running
the *exact* real binding query this candidate used, directly against the real catalogue, reproduces
the failure:

```
retrieveShopifyApiOperations(
  "Create or feature curated multi-product bundles or cross-sell groupings around the existing
   range. Most orders are small: the median order contains one item, 54% of orders contain
   exactly one item, and only 6% contain four or more items.",
  { limit: 8 }
)
→ ["orders", "order", "orderEditAddCustomItem", "product", "productOptionsCreate", "products",
   "draftOrderCreate", "orderCreate"]
```

Neither `collectionCreate` nor `collectionAddProducts` makes the top-8 ranked results for this
phrasing — the query's vocabulary ("bundles," "cross-sell groupings") doesn't overlap strongly
enough with "collection" for the relevance search to surface it, even though a merchandising
collection is the textbook Shopify answer to "encourage larger baskets." The model then correctly
reasoned from the (incomplete) stub set it was given and concluded no suitable write operation
existed — not a reasoning failure, an information-starvation failure one layer upstream of the LLM.

## Why Gateway mode didn't have this failure mode

Gateway mode has no server-side stub-binding step at all (Part 4's design choice) — the model is
never constrained to a pre-filtered top-8 list for anything. It reasoned from its own general
Shopify knowledge that a collection was the right merchandising primitive, wrote
`collections(first: 50) { nodes { ... } }` directly, and confirmed the existing "Bundles" collection
had room for a distinct discovery collection before recommending one. This is not because the
gateway's schema discovery is smarter — it made zero `shopify_schema` calls in this run (see
`10-full-gateway-trace.md`) — it's because nothing had already pre-filtered its option space down to
8 items using a lossy keyword match.

## All 8 catalogue candidates vs. what gateway mode did with the one it investigated

| Candidate | Catalogue result | What actually blocked it |
| --- | --- | --- |
| `restart-selling-activity` | `BLOCKED_BY_EVIDENCE` | Orders query returned no usable detail |
| `capture-product-costs` | `BLOCKED_BY_EVIDENCE` | Genuinely missing input data (0/25 variants costed) — not a capability gap |
| `increase-multi-product-baskets` | `NON_EXECUTABLE` (false negative — see above) | Stub-binding search missed `collectionCreate`/`collectionAddProducts` |
| `recover-unused-range-demand` | `REJECTED` | Live product lookup correctly returned `null` — genuine rejection |
| `protect-sales-from-stockouts` | `BLOCKED_BY_EVIDENCE` | Genuinely insufficient evidence after real reads |
| `establish-customer-retention-visibility` | `NON_EXECUTABLE` | Genuine capability gap — no write operation fixes missing customer-identity linkage |
| `refresh-stale-inventory-records` | `BLOCKED_BY_EVIDENCE` | Genuine data-freshness problem, not a write-capability gap |
| `repair-unlinked-order-line-items` | `NON_EXECUTABLE` | Genuine capability gap — available order-edit mutations don't fit |

Only one of the 8 (`increase-multi-product-baskets`) is a false negative traceable to the
stub-binding search rather than a genuine evidence or capability gap — the other 7 catalogue
rejections look sound on inspection and are not contradicted by anything in the gateway run.

## Was gateway's conclusion reasonable?

Yes, on inspection: it read real, current inventory and collection data before recommending; its
constraints (no price/inventory changes, exclude zero-stock variants, avoid duplicating the existing
Bundles collection) are specific and grounded in what it actually read, not generic boilerplate; its
`confidence` was self-labeled `"reasonable"` (not `"strong"`) with an explicit caveat that product
affinity within the collection is a merchandising hypothesis pending merchant review — an
appropriately calibrated level of certainty for a first-pass recommendation, not overclaimed.
