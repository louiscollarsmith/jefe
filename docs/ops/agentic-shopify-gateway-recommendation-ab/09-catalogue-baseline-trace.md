# Part 9 — Catalogue baseline trace

Same merchant, same Merchant Memory snapshot, same LLM config, `SHOPIFY_AGENT_SURFACE=catalog`
(default). Run immediately before the gateway run reported in `10-full-gateway-trace.md`, no
merchant state changed between the two (both are read-only investigations). Full JSON:
`docs/ops/agentic-shopify-gateway-recommendation-ab/trace-catalog.json`.

## Outcome

**`NO_ACTIONABLE_OPPORTUNITY`** — "Investigated 8 candidate(s) across discovery and rescue passes;
none verified against current Shopify state." 14 LLM calls, 272,667 ms wall clock, 5
`retrieve_shopify_operations` calls, 11 `call_shopify_operation` reads, 0 failed reads.

## All 8 candidates and why each failed

| Candidate | Disposition | Reason (grounded in a real Shopify read or Merchant Memory, per the run) |
| --- | --- | --- |
| `restart-selling-activity` | `BLOCKED_BY_EVIDENCE` | Orders query completed but returned no order records/summary — the bound operation could not surface the needed detail |
| `capture-product-costs` | `BLOCKED_BY_EVIDENCE` | 0 of 25 active variants have cost-per-item recorded; no Shopify write can supply cost data Jefe doesn't have |
| `increase-multi-product-baskets` | `NON_EXECUTABLE` | Orders, active-products, and automatic-discounts reads all completed; no safe write path implements the intervention as diagnosed |
| `recover-unused-range-demand` | `REJECTED` | Live product lookup for the named product ("Rain Map Tannat") returned `null` — the premise doesn't hold against current Shopify state |
| `protect-sales-from-stockouts` | `BLOCKED_BY_EVIDENCE` | Checked `products(status:active)` and a specific product lookup; evidence insufficient to act |
| `establish-customer-retention-visibility` | `NON_EXECUTABLE` | 0 known customer identities, 0% identity linkage across 50 orders confirmed; no write operation fixes missing identity data |
| `refresh-stale-inventory-records` | `BLOCKED_BY_EVIDENCE` | 51 of 51 inventory levels exceed the 72-hour freshness threshold (p90: 458.64 hours) — a real data-freshness problem, not one a Shopify write resolves |
| `repair-unlinked-order-line-items` | `NON_EXECUTABLE` | Available order-edit mutations would add a new line item, not repair an existing unlinked one — genuine capability gap |

Rejection funnel: `{"recommended":0,"rejected":8,"total":8,"byDisposition":{"INSUFFICIENT_EVIDENCE":4,"CAPABILITY_RETRIEVAL_FAILURE":3,"WEAK_DIAGNOSIS":1}}`.

## Assessment

Every one of the 8 rejections is evidence-grounded — each cites a specific Shopify read or specific
Merchant Memory figures, not a vague "couldn't find anything." This is a legitimate, well-functioning
catalogue run, not a degraded baseline (contrast with the forensic investigation this whole
experiment was originally, and incorrectly, framed against — see
`docs/ops/agentic-shopify-gateway/00-overview.md`). `increase-multi-product-baskets` is thematically
close to the collection the gateway run went on to recommend (both target shallow, single-item
baskets) but was rejected here specifically as `NON_EXECUTABLE` — see
`13-candidate-quality-comparison.md` for a direct comparison of how each surface handled this same
underlying opportunity area.
