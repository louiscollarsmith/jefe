# Parts 2, 3, 9, 10, 14 — Candidate discovery

## The six candidates, as discovered (raw, from `diagnostics.candidateQueue`)

| Rank | Candidate | Diagnosed problem (evidence) | Proposed intervention | Final disposition |
| ---: | --------- | ----------------------------- | ---------------------- | ------------------ |
| 1 | `reactivate-sales-after-gap` | Only 6 of last 30 days had orders; 19-day gap despite 13 orders in the preceding 30 days | Promotional merchandising placement featuring Borderlands Discovery Four / Cloud Needle Tsolikouri | `WEAK_DIAGNOSIS` → `NO_ACTIONABLE_OPPORTUNITY` |
| 2 | `improve-customer-retention-measurement` | None of 50 stored orders linked to a stored customer identity | Enable customer identity capture, connect future orders to profiles | `CAPABILITY_RETRIEVAL_FAILURE` → `NO_ACTIONABLE_OPPORTUNITY` |
| 3 | `raise-items-per-order` | Median items/order = 1; 54% single-item orders; 6% ≥4 items | Complementary-product recommendation or bundle around the same two anchor products | `INSUFFICIENT_EVIDENCE` → `NO_ACTIONABLE_OPPORTUNITY` |
| 4 | `recover-declining-product-demand` | 13 products declining MoM (e.g. Lemon Grove Vidiano £63→£0); 1 rising | Reorder collection/storefront merchandising to feature the same two anchor products ahead of decliners | `INSUFFICIENT_EVIDENCE` → `NO_ACTIONABLE_OPPORTUNITY` |
| 5 | `restore-unavailable-variants` | 2 of 25 active inventory-tracked variants have 0 available units | Replenish or swap storefront placement for in-stock alternatives | `INSUFFICIENT_EVIDENCE` → `BLOCKED` |
| 6 | `capture-product-margin-data` | All 25 active variants have `unitCost = null` | Populate cost-per-item to enable margin-aware promotion | `INSUFFICIENT_EVIDENCE` → `BLOCKED` |

Evidence references (`beliefIds`) resolve to real Merchant Memory belief rows — this is not
free-floating LLM narrative; every diagnosed problem cites specific stored beliefs.

## Was candidate discovery commercially diverse?

**Yes.** Six genuinely different commercial angles: revenue-gap/promotion, customer identity capture,
basket size/bundling, declining-demand merchandising, stockout recovery, and cost/margin data
capture. This is not the "narrowed to one theme" pattern the task brief was worried about (Part 4)
— there is no existing Action for these to narrow around in the first place (see 02).

## Did it propose things Jefe could plausibly change through Shopify?

**Yes, for 4 of 6.** Candidates 1, 3, 4 all resolve to a merchandising/collection/placement change —
exactly the class of write the earlier successful Gateway run executed via `collectionAddProducts`.
Candidate 5 resolves to an inventory/storefront-placement change. Only candidate 2 (customer identity
capture) and candidate 6 (cost data) are structurally about *data Jefe doesn't have*, not about a
Shopify write.

## Did candidate discovery generate advisory/non-executable ideas despite the executable-action requirement?

**No, not really.** None of the six candidates propose "run a promotion, merchant decides the offer"
in the way the task brief worried about (its own worked example). Every proposed intervention is a
specific, concrete change: feature two named products, populate cost data, replenish two named
variants. This run's problem is not candidate *formulation* being vague or requiring merchant
judgment calls that Jefe could have made itself — see 07 for the one candidate
(`capture-product-margin-data`) where that *is* legitimately the only option, and why it's correct
there.

## Part 14 — input sizes and migration residue in the prompt

Discovery input: 57,372 tokens (first call) / 58,249 tokens (rescue call) — both close to identical
size, no evidence of the discovery prompt ballooning between the primary and rescue pass. Each
per-candidate investigation call runs 59–65k input tokens, rising slightly over the run (59,092 →
64,883) as prior tool results accumulate in context — expected behavior, not runaway growth.

Checked specifically for the catalogue-migration residue the task named:

```text
retrieve_shopify_operations  → not found anywhere in the accra recommendation-agent prompt text sent this run (SHOPIFY_GATEWAY_TOOL names are hardcoded, no fallback)
call_shopify_operation       → not found
relevantFamilyId             → not found
retrievedOperations          → present as a JSON key in candidateQueue rows, always `[]` — a vestigial
                                field name from the catalog dispatcher's shape, harmless (always
                                empty for Gateway runs) but worth renaming/removing — see 13
```

`retrievedOperations: []` on every candidate is the one piece of literal catalogue-shaped residue
found in this run's persisted output. It carries no information (always empty) and does not affect
any decision, but it is dead vocabulary from the removed dispatcher still being emitted into every
persisted candidate row — flagged in 13, not fixed in this pass (cosmetic, not conclusively blocking
anything).
