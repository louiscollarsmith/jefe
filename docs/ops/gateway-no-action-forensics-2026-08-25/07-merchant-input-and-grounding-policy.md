# Parts 9, 10 — Merchant input dependency and grounding policy

## Is "grounded" being interpreted as "must already be explicit in Shopify"?

The task brief specifically worried about this becoming a hidden bottleneck: rejecting reasonable
inferences (e.g. "orders show A+B bought together → recommend a bundle") merely because the exact
parameter isn't a pre-existing Shopify fact.

**Not observed as a live pattern in this run**, and the evidence is instructive precisely because one
candidate looks at first glance like it might be this bug, and turns out not to be:

- `raise-items-per-order` diagnoses low basket size from real order-history evidence (median items/
  order = 1, 54% single-item) and proposes a *specific* intervention (bundle/cross-sell around named
  products) — this is exactly the "grounded business inference" pattern the task brief wanted to see
  more of, not the "unsupported invention" pattern. It was rejected not because Jefe was unwilling to
  propose a bundle without Shopify telling it to, but because the products query it needed to
  *identify the actual product records to bundle* came back empty (05/06). If that query had worked,
  nothing in the reasoning suggests the model would have refused to propose the bundle anyway pending
  merchant approval — it was blocked on identification, not on principle.

- `capture-product-margin-data` is the one candidate where "Jefe cannot know this" is the correct and
  final answer, not a symptom of over-conservatism: supplier cost-per-item is verified `null` for all
  25 variants (a real, successful Shopify read, not an assumption), and cost data does not exist
  anywhere else in Merchant Memory either. This is the task brief's own worked example of a
  legitimately-blocking gap, not an "already covered by grounded inference" case — there is no order/
  sales signal that substitutes for actual supplier cost.

## Distinguishing `NOT_RECOMMENDABLE` from a value Jefe could reasonably propose

None of the six candidates were rejected on a "must be explicit in Shopify" technicality once you
separate the "wrong products query" defect (05/06) from genuine data gaps. The one place a merchant
decision is unavoidable (`capture-product-margin-data`) is unavoidable because the number literally
does not exist anywhere accessible to Jefe — not because the system refused to estimate or propose a
value on the merchant's behalf.

## Conclusion

**This run does not show evidence of over-conservative grounding as a distinct bottleneck.** The
dominant defect (05/06: a live-Shopify read returning an empty result the model didn't verify or
retry) fully explains 4 of 6 rejections without needing "Jefe won't propose values not already in
Shopify" as an additional cause. Recommending a change to evidence thresholds or grounding policy on
the strength of this run would be treating a downstream symptom (wrong evidence) as if it were the
policy (how much evidence is required) — the task's own "do not loosen recommendation standards"
instruction is correctly not being triggered here.
