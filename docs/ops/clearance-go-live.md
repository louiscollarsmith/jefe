# Clearance go-live runbook

The go-live sequence for Jefe's **first executable action** — dead-stock clearance (`price_markdown`). Owned across lanes; this runbook is the ordered checklist + the safety proofs. The execution contract is `context/11_actions_and_autonomy.md`; the catalog is `context/13`.

> ✅ **EXECUTED — go-live is DONE (2026-07-31).** `CLEARANCE_EXECUTE_ENABLED=true` is set in production (Step 4 complete). Clearance execution is LIVE, running per each merchant's dial; it is inert for a store only until that store has costed dead stock + a non-`recommend` mode. This runbook is retained as the record of how go-live was done and the still-valid rollback procedure.

## Where it stands (all on origin, green, LIVE in prod)

- **Execute-half** — `clearance-adapter.server.js` (`applyClearance`: floor-at-gate, blast-radius cap, compare-and-set, per-target idempotent ledger writes, auto-revert on partial failure) + the live write client (`clearance-shopify-client.server.js`: `getVariantPrice` + `productVariantsBulkUpdate`).
- **Orchestrator** — `wire-clearance-execution.server.js` (`wireClearanceExecution` — the single approve→execute entry point; records `proposed→approved`, then runs the adapter **only** when `CLEARANCE_EXECUTE_ENABLED`).
- **Autonomy** — 3 modes per action type (`recommend | approve_execute | autonomous`) in `action_autonomy_policies` (`getActionMode`/`setActionMode`); `resolveAutonomyMode(dial, eligibility)`; the structural gate `reversible ∧ blast_radius ≤ cap ∧ confidence ≥ threshold` floors `autonomous`.
- **Surface** — Approve → `wireClearanceExecution(mode:"approve")`, Decline → `rejectAction`, the 3-mode picker → `setActionMode` (chat 2 lane, `aea5cb2`).
- **Ledger** — `action_executions` + `action_execution_writes`.
- **The one piece remaining:** the **plan-rec emit** (chat-4-lane) — hooks `app/lib/merchant-plan/` into `proposeActionFromIntent` so a real `proposed` row (preview + autonomy trio + money totals) exists to act on.

## Step 1 — Dark-path proof (flag OFF) · architecture-lane, when the emit lands

The honest "wired but off" state: a merchant taps Approve, Jefe records the decision, and **writes nothing**.

1. Trigger the emit so a real `proposed` `action_executions` row exists; note its `runId`.
2. With `CLEARANCE_EXECUTE_ENABLED` unset, drive the approve path (surface tap, or call `wireClearanceExecution(prisma, session, { merchantId, actionRunId: <runId>, mode: "approve" })`).
3. **Assert:** returns `{ ok: true, executed: false, reason: "execution_disabled", status: "approved" }`; the row is `approved` (approvedBy = merchant); **no `action_execution_writes` rows**, **no Shopify mutation**. The structured log shows `clearance approved; execution disabled (flag off) — no store write`.

This is already unit-proven (`wire-clearance-execution.test.mjs` "flag OFF: records approval but writes nothing"); Step 1 confirms it with real emitted data end-to-end.

## Step 2 — Live test round-trip (flag ON, a test store) · founder + architecture

On a **test/dev store only**:

1. Set `CLEARANCE_EXECUTE_ENABLED=true` for that environment.
2. Approve a clearance on a costed dead-stock variant. **Verify:** the variant's price changed in Shopify admin; `action_executions.status = applied`; one `action_execution_writes` row per variant with `expectedFrom`/`targetValue`; the log shows `clearance execution complete`.
3. **Verify compare-and-set:** change a variant's price in Shopify between preview and approve → that variant is `skipped_drift`, not overwritten.
4. **Verify revert:** call `revertClearance` (un-gated on the flag) → prices restored from `expectedFrom`. Undo must never be trappable.
5. **Verify autonomy floor:** a `mode:"auto"` run on a merchant whose dial is `approve_execute` is refused (`auto_not_authorized`); a `recommend` row never executes.

## Step 3 — Honesty gate (before App-Store submit) · with growth-lane + founder

The listing says Jefe **executes**. That claim is honest **only if execution is live at submit/review**. Architecture-lane pings growth-lane + founder the moment Step 4 is done, **before** submit; growth confirms the "executes" copy and greenlights submit. If go-live slips, fall back to recommends-now copy (kept in git history).

## Step 4 — Enable (founder, one-way door) · ✅ DONE 2026-07-31

**Done 2026-07-31:** `CLEARANCE_EXECUTE_ENABLED=true` is set in production (Railway env). This was the deliberate go-live — a founder call. Execution now runs per each merchant's dial; `approve_execute` is the unset default (propose-first, never auto-by-default).

## Rollback

- **Stop new writes:** unset `CLEARANCE_EXECUTE_ENABLED` — `applyClearance` refuses; `wireClearanceExecution` degrades to the dark path (records approved, writes nothing). Reversible, immediate, no deploy needed if the env supports live vars.
- **Undo an applied run:** `revertClearance(shopifyClient, reversibilityPlan)` restores prices from the per-target `expectedFrom` — un-gated on the flag, so it works even after the flag is off.
- **Blast-radius:** capped at `DEFAULT_CLEARANCE_CAPS` (maxVariants, maxDiscountPercent); an over-cap run blocks before any write.

## Invariants this preserves

Every guardrail in `context/11` holds: idempotency (per-target unique key), preview (deterministic, floored at cost), approval gate (recorded), blast-radius cap (blocks, never silently trims), reversibility (`expectedFrom` + un-gated revert), audit trail (the ledger), merchant-as-principal (`approvedBy`, the dial). Autonomy grows within these, never by loosening them.
