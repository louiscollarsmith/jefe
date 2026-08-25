# Part 02 — Existing Action state: "Create a Proven Products collection led by Borderlands Discovery Four"

Raw: `raw/existing-action-state.json` (real `plan_json`/`progress_json`/`outcome_json` for
`MerchantAction.id = 3399c23b-2b90-40d7-ba79-4f4f7a97e383`).

## Durable state

| Field | Value |
| --- | --- |
| `MerchantAction.id` | `3399c23b-2b90-40d7-ba79-4f4f7a97e383` |
| Source recommendation ID | `d2208566-ddd7-408d-86f4-fc45d39c10b4` |
| Source run ID | `f8cbea9e-6ab6-4bea-bdd6-6c4b01b2542a` (the real Gateway run — Part 01, Part 07) |
| Status | `in_progress` |
| Accepted revision | `sar_d4543d45825325dd` (== current revision — not stale) |
| Accepted at | `2026-08-25T16:47:55.407Z` |
| Execution phase | `failed` |
| Execution status | `NEEDS_MERCHANT_INPUT` |
| Execution blocker | **"A separate explicit merchant confirmation is required before adding the product to the collection."** |
| Execution job started/completed | `16:47:59.381Z` → `16:48:27.430Z` (28 seconds) |
| Outcome | `{ "status": "NEEDS_MERCHANT_INPUT", "blocker": "..." }` — same blocker, no verification ever ran |

## What this actually means, concretely

The accepted semantic Action's intent: create a new "Proven Products" collection, add
**Borderlands Discovery Four** (product `gid://shopify/Product/10375207780648`) to it as the lead
product, and change nothing else. Execution reached `collectionAddProducts` — a mutation that,
under this branch's mutation-safety classifier, requires a real, human-granted
`EXPLICIT_HIGH_RISK_CONFIRMATION_REQUIRED` confirmation before it will execute (this is the exact
same tier this session's own Gateway golden-path testing hit for `collectionAddProducts`
independently — see `docs/ops/agentic-shopify-gateway-full/`). No such confirmation was ever
recorded for this Action/revision, so execution stopped there: `NEEDS_MERCHANT_INPUT`, `failed`.

**The founder's UI showed "In progress · 4 of 5 done."** The durable execution-job state says
`failed` with an unresolved merchant-input blocker, not "4 of 5 done and on track." Whether the
collection itself (step 1) was actually created in Shopify before execution stopped is answered
independently in Part 06: the target run's own live read of `collections` at 17:15–17:19Z found
"an existing empty Proven Products collection" — so the collection exists, but Borderlands
Discovery Four was never added to it. That is consistent with "the create-collection step
succeeded, the add-product step is blocked" — i.e., closer to 1-of-2 real Shopify mutations
attempted, not 4-of-5. Whatever "4 of 5" refers to in the UI (it does not obviously map to the two
real Shopify mutations this Action's `materialExpectedEffects` describe — create collection, add
product), it is not describing execution progress that matches the durable
`executionJob`/`outcome` state, and reads as an overclaim relative to what actually happened.
This is a real UI-vs-backend discrepancy, independent of the Gateway-provenance question in
Part 01, and worth its own fix — not attempted here per this task's "diagnostic first, no fixes
until root cause is ranked" instruction.

## How this Action was represented to the later (target) recommendation run

The target run's model-visible context is not persisted verbatim in `MerchantPlanRun.result_json`
(it records the model's *output* — turns, tool results, diagnostics — not the full input prompt
payload), so this report cannot quote the exact `activeWork` JSON blob the model received for
`5540e23a`. What can be shown, from the target run's own candidate reasoning, is that the model
*did* have live, accurate awareness of both (a) the existing Action's identity and (b) its actual
Shopify state, not a stale summary:

- Candidate `activate-rising-product`'s reasoning explicitly reads: *"collections shows an existing
  empty Proven Products collection and no confirmed placement for Cloud Needle Tsolikouri"* — this
  is a **live Shopify read** of the actual collection (matching Part 06's finding that the
  collection was created but never populated), not a memory-layer description of the Action's
  intent.
- Candidate `improve-repeat-purchase-measurement`'s rejection (`ALREADY_COVERED`/
  `DUPLICATE_EXISTING_ACTION` — see Part 05) is about an unrelated existing Shopify customer
  segment, not this collection Action at all — direct evidence the model was not simply pattern
  matching "there's an active Action, so reject everything near it."

So on the specific question "was the existing Action represented accurately" — yes, on the one data
point this report can directly verify (the collection's real membership state), the system that ran
this request had it right.
