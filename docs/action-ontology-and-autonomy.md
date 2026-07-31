# Action Ontology & Autonomy Slider — direction proposal

**Status:** Proposal for founder sign-off on the *shape*. **Design only — nothing is built until blessed.** Dated 2026-07-29.

> **Update 2026-07-31 (as-built reconciliation).** Since this was written the shape below has been validated by building it: the **first executable action shipped — dead-stock CLEARANCE (not reorder) — and is LIVE in production** (`CLEARANCE_EXECUTE_ENABLED=true`), end-to-end through the typed-adapter contract with the 3-mode autonomy dial. So the two families, the entry shape, and autonomy-as-policy are no longer "design only" for the first action — they exist in `context/13` (capability registry) + `app/lib/actions/`. Still proposal: the **demand-derived recursion** (intent-capture → cluster → promote) and breadth beyond clearance. The build-sequence below is superseded by what shipped (clearance first). The **as-built layer + the recipe to add the next action type** live in `docs/action-layer-implementation.md`.

Pairs with `context/11_actions_and_autonomy.md`: that doc is the **HOW** — the typed-adapter execution contract + the earned-autonomy ramp. This is the **WHAT** — the action ontology and where it comes from — and the **POLICY** — the merchant-set autonomy slider. Together they are one design; this references `context/11` for execution mechanics rather than restating them. Once blessed, this graduates into `context/`.

Review split: architecture / consistency (does the ontology fit the typed-adapter model + the memory spine + the permanent guardrails) → architecture session; product direction (which actions, the autonomy policy) → founder.

## Thesis

Merchant Memory is the substrate; the destination is Jefe operating as the merchant's eCommerce manager. The bridge is an **action ontology the LLM operates *within*** — the ontology is the LLM's **action grammar**. The model never invents a raw action; it proposes a *legal move* in a governed space. That single constraint is both the safety mechanism and the moat: it turns "ungrounded autonomous agent" (which Jefe refuses to be) into "grounded operator." The typed-adapter guardrails in `context/11` are exactly what make operating within the grammar safe.

## The ontology has two families

1. **Executable actions** — reorder stock, adjust a price, pause a product, win back a segment. Each is a typed adapter per `context/11` (preview, approval, idempotency, blast-radius, reversibility). The kinetic layer.
2. **Decision-support intents** — "should I split my store for a US presence?", "what should I optimise for?". No external write; memory + LLM synthesis grounded in *this* merchant's data. `context/11` doesn't cover these — they're advisory by nature and carry zero blast radius, but they're a first-class part of the ontology (often the highest-value early wins, and where memory's specificity beats a generic LLM).

Both share the same entry shape; they differ only in whether the terminal step is a governed write or a grounded answer.

**A decision-support intent can never itself trigger a write.** Its only escalation path to action is to *propose a separate executable-family entry*, which then goes through the typed adapter (preview, approval, cap, reversibility). The family boundary **is** the advise/act line, and it is enforced structurally, not by prompt: a decision-support entry has no typed-adapter reference, so there is no code path by which it can mutate an external system. Advice governed by the memory-grounding / never-present-inference-as-fact discipline; action governed by the typed-adapter contract; the schema keeps them apart.

## The ontology is derived from demand — recursive, not hand-authored

The founder does not author playbooks. The system **discovers** the ontology from what merchants actually want, and refines it from what they adopt — the same principle as the memory itself: derive structure from observed signal, let the merchant correct it.

**The loop:**
1. **Capture** — every merchant action-intent becomes a candidate-intent record, *including the ones Jefe can't yet fulfil* (the "I wish you could…" signal). Sources: in-app / Slack conversation requests, observed Shopify behaviour, and the operator-community corpus.
2. **Cluster** — recurring candidate-intents group into candidate action-types.
3. **Promote** — a cluster that crosses a **frequency × value** threshold graduates into a first-class ontology entry (surfaced to the founder now; auto-scaffolded later — see the safety note below on what "scaffold" may and may not do).
4. **Feed back** — adoption + outcomes (`context/11`'s Observe→Learn) tell us which graduated entries were right.

**Weight behaviour over talk.** Community discourse over-indexes on the novel and the painful (Markets consolidation, BNPL, tax codes) and under-represents the quiet high-value routine (nobody posts "reordered my bestseller again"). Prioritise by the frequency × value of the underlying *need*, trusting what merchants repeatedly **do and ask Jefe to do** above what they discuss.

**The authored part is deliberately thin** — a small set of safe typed primitives (`context/11`) plus the promotion policy. The *instances and priorities* are learned. This mirrors the memory exactly: learned values over a thin authored schema. And those primitives are precisely what let the LLM safely *compose novel actions* nobody authored — the safety envelope is what makes emergent action safe enough to switch on.

**Hard line on "auto-scaffold" — the safety envelope depends on it.** Scaffolding proposes new ontology *entries* and new *compositions of the vetted primitive set*. It **never synthesises new external-write code** — an LLM does not write a new typed adapter. Every write, however novel the composed action, bottoms out in an already-approved primitive with its idempotency key, preview, cap and reversibility intact. "Novel action" = a new arrangement of safe primitives, reviewed before it goes live; it is never freshly generated adapter code. Read "auto-scaffold" as "propose a composition," never as "generate a mutation path."

## Each ontology entry

```
{ intent,
  family: executable | decision-support,
  beliefs it reads,
  decision function,
  action: typed-adapter ref (executables only),
  outcome it checks,
  risk metadata: { reversible?, blast_radius, confidence_to_act } }
```

The action is bound to the beliefs that justify it and the outcome that validates it — that is what makes this an intelligence layer that *learns*, not an automation list.

## Autonomy as policy — the merchant-set slider

`context/11` establishes that autonomy is earned per action type and the merchant sets the level. This specifies the **control surface** and the **policy function**.

- **The merchant owns the dial.** The architecture must never impose the ceiling. Build the full-autonomy path from day one; the merchant chooses where to sit. No "advisory-only forever" baked in.
- **It is a *set* of sliders, per action class** — not one global dial. A merchant will give full auto on reorders while keeping pricing and customer comms advisory. The demand-derived ontology hands you those classes for free.
- **The policy function:** `autonomy = f(merchant slider, action risk metadata, Jefe confidence) → recommend | ask-then-act | act`. The slider sits at the same layer as the execution contract — it is the merchant's control *over* it.
- **"Earned autonomy" (`context/11`) is a default + a confidence input, not a hard cap.** The slider is the authority. Jefe *suggests* starting conservative and is more cautious when its own confidence is low — but if the merchant wants full auto on day one, that is honoured.
- **Guardrails ≠ ceiling.** The typed-adapter discipline is not an autonomy limit — it is what makes *any* level safe. At full auto the merchant simply stops tapping approve; the action still runs the same idempotent, reversible, capped path. Slider to full, guardrails permanent.
- **One default floor (merchant-adjustable):** genuinely **irreversible / catastrophic-blast-radius** actions default to a confirm even at full auto — because the downside is asymmetric. One irreversible mistake can end the merchant's business, and "the AI destroyed my store" is the single story that ends ours. This is not the system overriding the merchant — it is Jefe behaving like a competent manager on the one-way doors, and the merchant can lower even this floor. You can always dial trust *up* once it is earned; you cannot undo a catastrophic action.

## Decision-support specifics

- **Naturally advisory** — sits at the low end of the slider by nature; the merchant decides, Jefe informs. A clean illustration of why the slider spans strategic-advisory → routine-auto: the intent's own stakes suggest where it lives.
- **Memory is the edge.** A generic LLM gives a listicle; Jefe grounds the answer in *this* merchant's data ("34% of your revenue already ships to the US, your US margin after duties is X — here's whether a separate store pays back for *you*").
- **Know the edge of competence.** Answer the part memory can ground; be explicit about what it cannot (retail leases, tax nexus, entity setup). "Here's your DTC cost-benefit; the legal side needs a specialist" is the trust-building answer — the same never-present-inference-as-fact discipline, applied to advice.

## Proposed build sequence (post-bless)

1. **Intent-capture** — the candidate-intent log (observation-only, low-risk, buildable immediately). Seeds the ontology and starts the recursion before any action exists.
2. **First executable action, end-to-end — reorder.** Memory already justifies it (`inventory.low_cover_products` + days-of-cover); a clean first typed adapter, slider-**defaulted** to propose-only (not locked). Exercises belief → decision → action → outcome (rung 1 of `context/11`).
3. **Belief→action binding + the autonomy slider as policy** over the ontology.
4. **Expand demand-derived**, weighted by frequency × value.

## Open questions for the founder

- Which first executable actions (reorder is the obvious start; then which?).
- The autonomy-policy defaults per action class, and how aggressive the irreversible-action floor should be.
- The **blast-radius-cap thresholds** for high-impact-but-*reversible* actions run at full auto (e.g. a catalogue-wide price change) — the key safety lever under merchant sovereignty. A reversible action can still be *large*; the cap is what bounds how much a single autonomous action may touch, independent of the reversibility floor.
- The promotion threshold — how much demand before a candidate-intent graduates to a first-class entry.

## References

- `context/11_actions_and_autonomy.md` — the execution contract + earned-autonomy ramp (the HOW).
- `AGENTS.md` → North Star; `context/07_architecture.md` — the as-built spine.
- `apps/shopify/docs/merchant-memory-state.md` — current memory state; the substrate this builds on.
