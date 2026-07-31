# Actions & Autonomy

Autonomy is earned per action type. Evaluate permission, confidence, safeguards, reversibility and blast radius before execution.

This file is the execution contract for how Jefe *acts* on a merchant's store — a synthesis of the guardrails fixed in `AGENTS.md` (North Star) and `CLAUDE.md`, not a loosening of them. As of 2026-07-31 the contract is **built and LIVE for the first action** (dead-stock clearance / `price_markdown`): `CLEARANCE_EXECUTE_ENABLED=true` in production, so the execution path is active — inert for a given store only until it has costed dead stock to clear. This is the as-built, now-live model. The founder owns the product direction it encodes.

## Three modes, per action type, from day one

Jefe acts on the merchant's behalf **from install** — not advisory-for-months. The merchant sets, **per action type**, one of three modes (persisted in `action_autonomy_policies`, read by `getActionMode`):

- **recommend** — Jefe surfaces the recommendation; no execution.
- **approve_execute** — Jefe proposes; the merchant taps approve; Jefe executes (human-in-the-loop).
- **autonomous** — Jefe executes without a tap, **only** for action instances that clear the structural auto-eligibility gate (below); an ineligible instance degrades to `approve_execute`, never a silent skip of the gate.

All three are available in **v1**. `resolveAutonomyMode(merchantSetting, eligibility)` maps the merchant's dial × the gate to the effective mode for each run. Autonomy is **earned, memory-grounded, and per action type** — the track record (`business.recommendation_engagement` + measured outcomes) raises Jefe's confidence and the *recommended* default over time, but the merchant is always the principal: they own the dial and can veto or reverse any action. (The default mode for a dial the merchant hasn't set is currently `approve_execute` — propose-first, never auto-by-default — a founder-owned launch-posture choice.)

## The typed adapter (how *any* external write happens)

Every write to an external system (Shopify, Slack, email, …) goes through an approved **typed adapter**. There is no other path — an LLM never mutates an external system directly. Each adapter enforces, by construction:

- **Idempotency key** — the same action can't be applied twice.
- **Preview** — a deterministic dry-run of exactly what will change, before anything happens.
- **Approval gate** — the merchant confirms, until autonomy is earned for that action type.
- **Blast-radius cap** — bounded scope (how many records / how much value a single action can touch).
- **Reversibility** — a defined undo, or an explicit "irreversible" flag that forces approval + a higher bar.
- **Audit trail** — every action, its preview, its approver, and its outcome are recorded.
- **Merchant as principal** — actions are taken on the merchant's authority, within the limits they set.

These are the same guardrails the whole product is built to preserve; they are *more* discipline than advisory mode, not less, and they are what make growing autonomy safe.

## The execution path (as built)

The concrete flow for the first action, end-to-end:

1. **Propose** — `proposeActionFromIntent` (the resolution layer) turns a validated LLM action-intent into a deterministic, floored **preview** (`buildClearancePreview`), computes structural eligibility + the resolved mode, and creates a **`proposed`** `ActionExecution` row (the ledger — it carries the preview + the autonomy trio). Writes nothing external.
2. **Approve + execute** — `wireClearanceExecution` is the **single entry point** the surface calls: a merchant tap → `mode:"approve"`, the autonomous path → `mode:"auto"`. It records `proposed→approved`, then — only when `CLEARANCE_EXECUTE_ENABLED` — runs the typed adapter `applyClearance`: re-check the gate, compare-and-set against the live price (skip on drift), write via `productVariantsBulkUpdate`, one idempotent `ActionExecutionWrite` per target, auto-revert on partial failure. **Flag-off is a safe no-op** — it records approved and writes nothing (the honest dark path).
3. **Outcome** — recorded into the ledger (`action_executions.outcome`: units moved, cash recovered, effectiveness) and back into Merchant Memory as an `Observe→Learn` signal.

This reuses the existing spine — memory → recommendation → **execution** → learning; the memory, provenance, and precedence machinery is unchanged. The concrete modules and the full action catalog (states, scopes, effectiveness) live in `13_action_capability_registry.md`.

**Go-live is DONE** (2026-07-31, founder call): the surface wires the approve/auto paths to `wireClearanceExecution`, and `CLEARANCE_EXECUTE_ENABLED=true` is set in production. Execution now runs per each merchant's dial; it stays inert for a given store until that store has a non-`recommend` mode set and a costed dead-stock variant to clear.

## Autonomy: earned, but merchant-owned

The **merchant holds the authority** — a per-action-type dial (recommend | approve_execute | autonomous), never one global switch. "Earned per action type" **informs** the recommended default and Jefe's own caution; it is not a hard cap the system imposes over the merchant. Out of the box, a dial the merchant hasn't set defaults to **`approve_execute`** (propose-first): autonomy is *available* from day one — the merchant can set `autonomous` on any action immediately, subject to the gate — but Jefe does not auto-write before the merchant has opted in. `business.recommendation_engagement` (already in memory) + measured outcomes are the track-record substrate that raises Jefe's confidence and the recommended default over time. (Whether the recommended default should lean more autonomous on provably-safe reversible actions is a founder call — flagged.)

### The auto-eligibility gate (what makes day-one auto safe)

A brand-new merchant with **zero** track record can already have Jefe acting, so safety cannot come from earned trust — it must be **structural**. An action may auto-run **only if it clears, at the execution gate**:

> **reversible ∧ blast_radius ≤ cap ∧ confidence ≥ threshold**

computed from the action's risk metadata plus context, checked in the adapter layer — never by prompt or convention. Fail any of the three and it falls back to **ask-then-act**, no exceptions. The LLM cannot route around this (the same shape as the citation-allowlist and numeric-grounding gates: structural, not trusted). Genuinely **irreversible / catastrophic-blast-radius** actions default to a confirm even at full auto — a merchant-adjustable floor, because you can always dial trust up once it is earned but you cannot undo a catastrophic action. The merchant owns the thresholds (the safe-set definition and the caps).

This pairs with `docs/action-ontology-and-autonomy.md` — the action ontology and the slider-as-policy (the WHAT); this file is the execution contract that enforces it (the HOW).

## What stays permanent

The guardrails above never loosen. Autonomy grows by *earning trust within them* — better memory, a proven track record, tighter previews — never by removing the idempotency key, the preview, the cap, the reversibility, or the merchant's veto. Advisory-only was a V1 safety posture; the typed-adapter discipline is the permanent foundation the ramp is built on.

See also: `context/07_architecture.md` (the as-built spine this extends) and `AGENTS.md` → North Star.
