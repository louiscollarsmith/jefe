# Action Workspace V2 Design

Date: 2026-08-20

## Diagnosis

V1 persists every generated recommendation workflow row as a lifecycle-backed
`MerchantRecommendationStep`. That makes analysis, decisions, generated
artifacts, executions, merchant tasks and external waits all look like the same
sequential job. The focused action agent already works more naturally than that:
it targets the whole `MerchantAction` and can update plan values, run assist
work, and replan from natural language. The persistence and UI projection are
the part still implying a wizard.

## V2 Model

V2 keeps `MerchantAction` as the durable action identity and keeps legacy
workflow rows for compatibility. It adds an action-scoped workspace projection
under `MerchantAction.progress.workspace`:

- `items`: semantic action-workspace items with `kind`, `state`,
  `dataDependencies`, and `navigationDependencies`.
- `artifacts`: first-class artifact summaries derived from assist outputs,
  including current revision input hashes and staleness.
- `currentFocus`: deterministic focus over the whole workspace.
- `actionState`: action-level summary such as `needs_merchant`,
  `jefe_working`, `waiting_external`, `on_track`, or `completed`.

The projection is initially restock-focused. Existing non-restock actions fall
back to V1 lifecycle projection.

## Persistence Strategy

No new table in the first slice. The authoritative durable sources remain:

- `MerchantAction.plan` for current decisions.
- `MerchantRecommendationStep`/`MerchantRecommendationStepRun` for legacy
  assist and execution runs.
- `ActionExecution`/`ActionChangeSet` for typed write/execution state.
- `MerchantAction.progress.workspace` for the V2 semantic workspace projection
  and action-scoped artifact index.

This is deliberately additive and reversible. If a later slice needs queryable
artifact history across actions, the JSON shape can be migrated into dedicated
tables without changing the merchant-facing contract.

## Replenishment Vertical Slice

Recommendation evidence such as low-cover inventory review is not future
merchant work. New restock materialisation suppresses `assist:inventory_review`
when a replenishment proposal item exists; the low-cover diagnosis remains in
the recommendation rationale and memory evidence.

The restock workspace projects:

- `Replenishment proposal`: `decision`, states `draft | current | stale | agreed`.
- `Supplier communication`: `artifact`, states `not_created | draft | stale | ready | sent`.
- `Create purchase order`: `execution` if a real adapter appears, otherwise
  `manual` / `integration_not_available`.
- `Supplier fulfilment`: `external_wait`.
- `Receive stock`: `evidence` / `merchant_action`.

Data dependencies are used for freshness and execution preconditions. They do
not restrict chat navigation.

## Hardening Pass

The recommendation's evidence now seeds, but does not imprison, restock scope.
Current scope is stored under `MerchantAction.progress.actionScope` with a
revision and scoped identities for products, variants and inventory items.
Focused chat can resolve a merchant product reference against the local Shopify
mirror, add the resolved product to scope, and rebuild the current proposal
without asking the merchant to run a separate update step.

The current replenishment proposal is canonical collaborative state, stored as
`MerchantAction.progress.replenishmentProposal`. It carries a proposal
revision, cover target, proposal lines, input fingerprint, scope version and
evidence version. Cover changes and scope changes recalculate the proposal as
part of the same bounded turn. Supplier emails are derived artifacts: they
record the proposal revision/fingerprint they used and become stale rather than
mixing old quantities with new cover metadata.

Capability truth is resolved separately from business workflow ownership.
Purchase-order creation remains a semantic `execution` item with
`intendedActor: JEFE`; because Shopify does not expose a public supplier
purchase-order create mutation, the item is stamped
`capabilityAvailability: UNSUPPORTED_BY_PROVIDER` and the current focus becomes
an integration limitation instead of a merchant-owned task.

## Focus Resolver

`resolveWorkspaceFocus` is deterministic. Priority:

1. failure or blocked execution,
2. merchant input / approval required,
3. artifact ready or stale,
4. Jefe actively executing,
5. meaningful external wait,
6. next useful optional workspace item,
7. completed action,
8. quiet on-track state.

The UI should render `currentFocus`, not the first incomplete step.

## Compatibility

Legacy actions continue to use the existing V1 step lifecycle. V2 projection is
only used when `progress.workspace.version === 2` or when the action is clearly a
restock action that can be projected safely from existing workflow rows.

Replanning preserves existing step identity as today, then refreshes the V2
workspace projection from the reconciled workflow.
