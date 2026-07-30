# Actions & Autonomy

Autonomy is earned per action type. Evaluate permission, confidence, safeguards, reversibility and blast radius before execution.

This file is the intended architecture for how Jefe moves from *advising* to *acting* — a synthesis of the guardrails already fixed in `AGENTS.md` (North Star) and `CLAUDE.md`, not a loosening of them. It is a v1 to build against; the founder owns the product direction it encodes.

## The ramp

Advisory (now) → **approved-execute** (rung 1: the merchant approves a recommendation and Jefe executes it — human-in-the-loop) → progressively autonomous on the safe, high-confidence, reversible, low-blast-radius action types as trust is earned, until routine ones need no tap.

Autonomy is **earned, memory-grounded, and per action type** — never generic or ungrounded. The merchant is always the principal: they set goals and autonomy levels and can veto or reverse any action.

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

## Rung 1 — approved-execute (the next build)

1. Jefe proposes a recommendation (grounded in Merchant Memory, as today).
2. On approval, Jefe builds the typed-adapter **preview** for the concrete action and shows the merchant exactly what will change.
3. The merchant confirms; Jefe executes through the adapter (idempotent, capped, reversible).
4. The outcome is recorded — into the audit trail and back into Merchant Memory (an `Observe→Learn` signal on how that action performed).

This reuses the existing spine: memory → recommendation → **now execution** → learning. The only new surface is the adapter + preview + approval flow; the memory, provenance, and precedence machinery is unchanged.

## Autonomy: earned, but merchant-owned

The **merchant holds the authority** — a *set* of sliders, one per action class (full-auto reorders while pricing stays advisory, say), never one global dial. "Earned per action type" **informs** the recommended default and Jefe's own caution; it is not a hard cap the system imposes over the merchant. The default posture the merchant starts from is **auto on the safest reversible actions** — Jefe acts from day one on what is provably safe, and the merchant dials trust up or down from there. `business.recommendation_engagement` (already in memory) is the track-record substrate that raises Jefe's confidence and the recommended default over time.

### The auto-eligibility gate (what makes day-one auto safe)

A brand-new merchant with **zero** track record can already have Jefe acting, so safety cannot come from earned trust — it must be **structural**. An action may auto-run **only if it clears, at the execution gate**:

> **reversible ∧ blast_radius ≤ cap ∧ confidence ≥ threshold**

computed from the action's risk metadata plus context, checked in the adapter layer — never by prompt or convention. Fail any of the three and it falls back to **ask-then-act**, no exceptions. The LLM cannot route around this (the same shape as the citation-allowlist and numeric-grounding gates: structural, not trusted). Genuinely **irreversible / catastrophic-blast-radius** actions default to a confirm even at full auto — a merchant-adjustable floor, because you can always dial trust up once it is earned but you cannot undo a catastrophic action. The merchant owns the thresholds (the safe-set definition and the caps).

This pairs with `docs/action-ontology-and-autonomy.md` — the action ontology and the slider-as-policy (the WHAT); this file is the execution contract that enforces it (the HOW).

## What stays permanent

The guardrails above never loosen. Autonomy grows by *earning trust within them* — better memory, a proven track record, tighter previews — never by removing the idempotency key, the preview, the cap, the reversibility, or the merchant's veto. Advisory-only was a V1 safety posture; the typed-adapter discipline is the permanent foundation the ramp is built on.

See also: `context/07_architecture.md` (the as-built spine this extends) and `AGENTS.md` → North Star.
