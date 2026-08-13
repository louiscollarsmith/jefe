# Step completion: what counts as done

**Date:** 2026-08-13 · **Status:** decided in conversation, recorded here so it survives
the chat · **Context:** Louis's proposal to make recommendations into actionable workflows
(`MerchantPlanRecommendation.executionSteps` already exists as inert JSON; the change is
giving steps identity, state and execution binding).

## Decided (Matt, 2026-08-13)

### 1. Prefer DOING the step to WATCHING for it

Where Jefe can perform a step, it should perform it rather than detect that a human did.

If Jefe drafts and sends the supplier email, completion is **observed** — there is a message
id, a timestamp, a recipient. If Jefe reads a mailbox and concludes a human sent something
supplier-shaped, completion is **inferred** from a classifier over unrelated mail.

Observation by participation is cheaper on consent, stronger as a product ("Jefe drafted the
reorder email — send it?"), and fits the external-write guardrails unchanged: sending is a
typed adapter call, approval-gated, because it cannot be unsent.

⚠️ Outbound email already exists (`app/lib/email/resend.server.js`), as do inbound email and
the Slack/WhatsApp channels. This pattern can be proven end to end with **no new consent**.

### 2. Completion has three states, not two

`observed` · `inferred` · `unverified` — and they must never collapse into each other.

- **observed** — Jefe did it, or the data moved (inventory appeared, price changed).
- **inferred** — a model concluded it from a signal. Carries confidence and provenance; a
  merchant correction supersedes it, per Product Truth.
- **unverified** — nobody can tell yet. Not "not done".

A step marked done ✓ when it wasn't is worse than an untracked step, because it is
confidently wrong and nobody looks again. Same discipline as every belief shipped today:
absence and uncertainty must not become a definite claim.

⛔ **Integrations shrink the unverifiable set; they never empty it.** No integration reaches
"phoned the supplier", "confirmed at a trade show", "the pallet turned up". So these states
are required regardless of how much access Jefe is granted — "we'll integrate" is not a
reason to defer designing them.

### 3. Direction: full workspace access, earned

The long-term aim is merchants granting Jefe access across their workspace, because engaging
across their real operating surface is where the value is.

The three-state distinction above is the **precondition**, not a tax on it: broad access is
granted to a system that visibly separates what it knows from what it guessed, and withdrawn
from one caught presenting inference as fact. Same shape as autonomy in this product —
earned per surface, demonstrated before extended.

⚠️ Gmail mailbox read is a Google **restricted scope**: OAuth verification plus an annual
third-party security assessment (CASA). A programme with a timeline and a recurring cost,
not a sprint task, and a founder call. Outbound send carries none of that.

## NOT decided — open proposals, recorded so they are not mistaken for rulings

- **A status guard on the execute path.** `executeApprovedAction`
  ([execute-approved-action.server.js:39](../../apps/shopify/app/lib/actions/execute-approved-action.server.js))
  selects only `{actionType, merchantId}` and never reads `status`, so `rejected`,
  `reverted` and `failed` actions are re-executable today given a `runId`. This is a live
  hole independent of any workflow change, and it means marking an action `superseded`
  would be cosmetic until it is closed. Proposed by this session; not ruled on.
- **Read-path precedence** (newest plan recommendation beats an older proposed action) as a
  lossless fix for the reported "two current moves" ambiguity, before any supersede write.
- **Supersede scope** — whether a new plan run retires unrelated proposed actions, or only
  same-`actionType` replacements. Superseding by recency discards advice that is still true.
- **In-flight workflows must not be superseded by a proactive sweep.** A workflow someone is
  three steps into is closer to an approved action than to a proposal. Needs settling in the
  same design, not after.
- **Generated vs typed steps.** Suggested resolution: generated prose steps are fine; any
  step that EXECUTES must bind to a registered adapter. That seam is where a generated step
  could otherwise acquire write powers, so it should be explicit in the model.

## ⚠️ Appended after reading #91 — half of the above was written blind

The open proposals were reasoned off the code as it stood at midday. **#91 "Implement
focused merchant actions"** (`49a4a50`, 16:17) landed before this doc and was not read
first. Correcting that here rather than leaving the section quietly stale.

### What #91 built

A durable `MerchantAction` above the existing three entities: one per source recommendation
(unique), `currentActionRunId` → the live execution, `ActionExecution.merchantActionId` back
-referencing so an action can span MANY executions over time, plus `progressJson`,
`outcomeJson`, a `merchant_action_events` log tied to conversation and message id, and
`MerchantMemoryConversation.focusedActionId` so a chat can be focused on one action.

That is a better answer than the original proposal's: an action now has identity
independent of whichever execution is current, so "one current move" no longer requires
destroying old rows to express.

### ⛔ The lifecycle problem is NOT solved — it moved

`deriveMerchantActionStatus` computes the action's status **from** the recommendation's
`reviewStatus` and the execution's `status`. It is a PROJECTION, not an independent source
of truth, and it reaches `superseded` only when the underlying recommendation or execution
is already marked superseded.

Nothing marks them. So #91 built the projection that would display supersession correctly
the moment something writes it, and inherits the staleness wholesale until then.

**Consequence for whoever implements the supersede rule:** write it at
**recommendation/execution level**, which is what the projection reads. Writing
`merchant_actions.status` directly fights the derivation and drifts the moment either
underlying row changes.

`executeApprovedAction` still selects `{actionType, merchantId}` and reads no status —
re-confirmed on `origin/main` after #91. The status-guard gap is untouched and still open.

### Consequence for the step model

`progressJson` plus `merchant_action_events` is already most of the substrate for workflow
steps — they have a home and an audit trail. The proposal above is closer to half-built
than greenfield.

### Smaller note

`syncMerchantActionsForShop` is explicitly best-effort and called on read paths "without
risking a failed page". A read that mutates races itself under concurrent page loads.
Defensive rather than wrong, but worth knowing before more is hung off it.

## Why this matters to Merchant Memory

Completed steps are evidence available nowhere else. "This merchant takes eleven days to
contact suppliers", "they never do the reconciliation step" — operating-habit knowledge that
cannot be bought from Shopify at any price, and that feeds the business-shape beliefs
directly.

Design step outcomes to be belief-producing from day one rather than retrofitting. That is
the difference between a workflow layer that executes and one that teaches Jefe how this
particular merchant actually operates.
