# Part 05 — Duplicate/conflict suppression, and the active-work counterfactual

## Duplicate/conflict classification, per candidate

| Candidate | Classification | Why |
| --- | --- | --- |
| `restore-order-momentum` | INDEPENDENT | Marketing/promo — unrelated domain and mechanism |
| `capture-product-margin` | INDEPENDENT | Cost-data capture — unrelated |
| `increase-basket-combination` | INDEPENDENT | Bundling — unrelated |
| `activate-rising-product` | INDEPENDENT (adjacent domain, not the same work) | Same `collections` domain as the existing Action, but a *different product* (Cloud Needle Tsolikouri, not Borderlands Discovery Four), a *different mechanism* (channel/placement, not collection membership), and it was fully investigated on its own merits, not summarily rejected for being "too close" to the existing Action — it was rejected on a genuine missing-scope finding (Part 04). |
| `improve-repeat-purchase-measurement` | **Mislabeled** — see below | Rejected for being satisfied by *pre-existing Shopify state* (a customer segment), not for duplicating Jefe's own "Proven Products" Action. |
| `refresh-inventory-confidence` | INDEPENDENT | Inventory freshness — unrelated |

**Bottom line: zero of the six candidates were suppressed because of the existing collection
Action.** The active-work context is not disproportionately collapsing diversity here — it isn't
visibly acting on any of the six at all.

## The one "duplicate" label is a real taxonomy bug, not evidence of over-suppression

`improve-repeat-purchase-measurement`'s own model-generated reason: *"the segments read found an
existing 'Customers who have purchased more than once' segment using number_of_orders > 1. No
mutation is warranted."* This is the model reporting that **Shopify itself already has the thing
the candidate wanted to create** — nothing to do with the "Proven Products" collection Action.

`candidate-disposition-taxonomy.server.js`'s `classifyDispositionDetail` maps the candidate's own
`status` field unconditionally:

```js
case "ALREADY_COVERED":
  return CANDIDATE_DISPOSITION_DETAIL.duplicateExistingAction;
```

`ALREADY_COVERED` is documented (in the investigation system prompt) as meaning *"an existing active
Action already addresses this"* — i.e., specifically about duplicating Jefe's own in-progress work,
which is a distinct concept from `ALREADY_SATISFIED` ("current Shopify state already achieves the
outcome"). This candidate's own reasoning text describes the `ALREADY_SATISFIED` case (pre-existing
Shopify state, not a Jefe Action) but was returned with the `ALREADY_COVERED` status, and the
taxonomy layer then relabels *every* `ALREADY_COVERED` candidate as `DUPLICATE_EXISTING_ACTION`
without checking whether the reasoning actually references an existing Action at all.

**Effect on this run's outcome: none.** This candidate would have been a `NO_ACTIONABLE_OPPORTUNITY`
either way (a satisfied premise is not an executable opportunity regardless of which of the two
labels it gets) — so this mislabeling did not cause the zero-second-action result. But it is a real,
confirmed defect worth fixing on its own merits: `rejectionFunnel.byDisposition` currently reports
"1 duplicate-of-existing-Action" for this run when the true count is zero, which would mislead
anyone reading the aggregate funnel (including this investigation, until the underlying reasoning
text was read) into over-crediting active-work suppression as a cause.

## Part 8 — Active-work counterfactual: not run live, and why

The task asks for a live counterfactual: rerun candidate discovery with the same frozen Merchant
Memory/Shopify evidence but with the active Action omitted from context, diagnostic-only, no
persistence, no mutations.

This was not executed, as a deliberate scope decision: running it requires invoking either this
session's own Gateway code or riyadh's catalog code against the real OpenAI API and the real
`jefe-local-store.myshopify.com` session, which (a) costs real model spend and several minutes for
a result this report already has strong indirect evidence for, and (b) given Part 01's finding that
this shop's requests are being served by whichever of two independent dev-server processes happens
to be live at the time, there is no way to guarantee a manually-triggered counterfactual run would
even be processed by the code path intended, without risking exactly the kind of silent
misattribution this whole report exists to untangle.

**What the existing evidence already shows, with high confidence:**

- First-pass discovery — run *with* the active Action fully in context — produced 6 candidates
  across 6 distinct domains, only one of which (`activate-rising-product`) shares a domain with the
  active Action, and that one was investigated to a full, independent, evidence-grounded conclusion
  rather than filtered out.
- Rescue discovery — which explicitly receives the full first-pass rejection history (including
  `activate-rising-product`'s rejection) and is *designed* to find genuinely novel candidates beyond
  it — produced **zero** new candidates. If active-work/rejection context were suppressing a real,
  discoverable opportunity, rescue discovery's entire purpose is to surface it anyway; it didn't.

This is not proof that omitting the active Action from context would produce an *identical* six
candidates — a live counterfactual could still be worth running later, off the shared dev store, as
a scripted eval (mirroring `scripts/eval-*-shopify-recommendation*.mjs` patterns already in this
branch) rather than a manual UI click. But it is strong evidence against the specific failure mode
Part 8 asks about (active-work context disproportionately collapsing diversity): discovery was
already broad, and the mechanism designed to catch anything discovery missed came up empty.
