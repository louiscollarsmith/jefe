# The action layer, as built — and how to add the next action type

**Status: as-built reference (2026-07-31, chat 10).** Companion to the three design docs:
`context/11_actions_and_autonomy.md` (the execution **contract** — the HOW), `context/13_action_capability_registry.md` (the **catalog**), and `docs/action-ontology-and-autonomy.md` (the **WHAT + POLICY**). This one is the **implementation map**: the concrete pieces that make dead-stock clearance work in prod, the shared adapter contract they imply, and the step-by-step recipe to add executable action #2, #3, … Grounded in clearance (action #1, live) and `product_status_change` (action #2 — product archive/unarchive — built dark as the second worked example, landing alongside this doc).

## The as-built spine (clearance = the reference implementation)

One action flows through seven pieces. Files under `apps/shopify/app/lib/actions/`.

| Stage | Piece | What it does |
|---|---|---|
| Propose | `action-resolution.server.js` (`proposeActionFromIntent`) | Turns a validated LLM **action-intent** into a deterministic, floored **preview** + a `proposed` `action_executions` ledger row (carries the preview + the autonomy trio). Writes nothing external. |
| Intent | `action-intent.server.js` | The LLM picks a **verb from the capability registry** (`context/13`); the primitive computes safe params. The model proposes a *legal move*, never raw code. |
| Autonomy | `action-autonomy-policy.server.js` (`getActionMode`/`setActionMode`/`resolveAutonomyMode`) | Per merchant × action-type dial (`recommend | approve_execute | autonomous`), persisted in `action_autonomy_policies`. `resolveAutonomyMode(dial, eligibility)` maps dial × the structural gate → the effective mode. |
| Execute | `clearance-adapter.server.js` (`applyClearance`) | The **typed adapter**: flag-gated (`CLEARANCE_EXECUTE_ENABLED`), preview re-check, blast-radius cap, compare-and-set against live state (skip on drift), one **idempotent** `action_execution_writes` row per target, **auto-revert on partial failure**. |
| Write client | `clearance-shopify-client.server.js` | The injected read+write pair (`getVariantPrice` + `updateVariantPrice` via `productVariantsBulkUpdate`), wrapping `ShopifyAdminGraphqlClient` with the shop's offline token. |
| Orchestrate | `wire-clearance-execution.server.js` (`wireClearanceExecution`) | The **single approve→execute entry point**. Records `proposed→approved`, then — only when the flag is on — runs the adapter. Flag off = safe no-op (records the decision, writes nothing). |
| Observe→Learn | `clearance-outcome.server.js` + memory derivations | Scores applied runs, writes `business.clearance_effectiveness` back into Merchant Memory — closing belief → decision → action → outcome → belief. |

Ledger: `action_executions` (one row per proposed/approved/applied run) + `action_execution_writes` (one idempotent row per target mutated, carrying `expectedFrom` for revert).

## The shared adapter contract (what every executable action must provide)

Extracted from clearance + `product_status_change` (two primitives → the interface). Any new executable action's adapter must implement, by construction (these are the `context/11` guardrails as code):

1. **`buildPreview(input)`** — deterministic dry-run of exactly what will change; the source of the blast-radius count and the merchant-facing summary. No I/O beyond reads.
2. **`apply(...)`** — flag-gated (its own `*_EXECUTE_ENABLED`); re-checks the gate + preview; **compare-and-set** against live state (skip a target that drifted since preview); one **idempotent** ledger write per target keyed so a re-fire can't double-apply; **auto-revert on partial failure**; structured logging (`component` tag; INFO start/complete, WARN skips, ERROR failures → ops alerter).
3. **`revert(...)`** — restores prior state from the per-target `expectedFrom`/prior-value recorded at apply time. **Un-gated on the execute flag** — undo must never be harder to reach than the action.
4. **`reversibilityPlan`** — the shape `revert` consumes: `{ target, from, to }[]`. If an action is genuinely irreversible it carries an explicit `irreversible: true` that forces approval + the higher floor.
5. **A blast-radius cap** — `{ maxTargets, ...per-action limits }`; an over-cap run **blocks before any write** (never silently trims).
6. **Merchant as principal** — the adapter acts under `approvedBy` + the resolved mode; a `recommend` row never executes; a `mode:"auto"` call is refused unless the merchant's setting resolved to `auto`.

The *interface* these share is the next refactor (a typed `ActionAdapter` + a dispatch keyed on action-type), now that a second primitive makes the shape real. Until then each primitive is a faithful parallel — clearance and product-status differ only in the field they read/write and the reversibility value.

## Recipe: add executable action type `X`

1. **Write client** — `x-shopify-client.server.js`: `createXShopifyClient(session)` exposing the read (current state) + write (mutation) for X's field, wrapping `ShopifyAdminGraphqlClient`.
2. **Typed adapter** — `x-adapter.server.js`: `applyX` (flag-gated on a new `X_EXECUTE_ENABLED`, idempotent, capped, records prior value) + `revertX` (un-gated) + `isXExecuteEnabled` + the preview builder. Mirror the clearance adapter's gates exactly.
3. **Registry** — add X to `context/13_action_capability_registry.md` with states, scopes, effectiveness, and the risk metadata `{ reversible?, blast_radius, confidence_to_act }`. Confirm the OAuth scope (a `write_products` sibling needs no re-consent; inventory/order/customer writes carry a scoped re-consent step).
4. **Autonomy key** — X is a new action-type key for the dial; the merchant sets its mode independently (`action_autonomy_policies`).
5. **Proposal emit** *(memory lane)* — bind the plan-rec / intent to `proposeActionFromIntent` so a real `proposed` row exists to act on.
6. **Surface** *(surface lane)* — the Approve / Decline+reason / Edit + mode-picker card, wired to `wireXExecution` (or the generalised entry point).
7. **Tests** — adapter (flag off/on, drift-skip, idempotency, cap, revert, auto-authorization) + client (mock GraphQL) + a mock-prisma end-to-end. `node --test`, `@ts-check`'d `.server.js`.
8. **Ship dark → verify → flip** — `X_EXECUTE_ENABLED` unset by default. Go-live is a founder call after a live test round-trip (the `clearance-go-live.md` pattern). The listing/claims must stay honest about what's live.

## Open decisions (founder / cross-lane)

- **The `ActionAdapter` interface extraction** — now that two primitives exist, extract the shared type + a dispatch keyed on action-type (touches the live clearance adapter → do it deliberately, gated + re-tested).
- **Which action #3** — `context/13`'s buildable set (`price_set`/`bulk_price_update`, `product_status_change` [built], tags, collection ops) are all `write_products` siblings (no new consent); reorder/inventory/customer-comms each carry a scoped re-consent.
- **Blast-radius caps per action** at full-auto — the key safety lever (`docs/action-ontology-and-autonomy.md` open Q).
- **One flag or per-action flags** — clearance + product-status each have their own `*_EXECUTE_ENABLED`; decide whether breadth keeps per-action flags (fine-grained, more env) or graduates to a policy table.
