# Merchant Intent vs Jefe Inference — Provenance Correction

## 1. Previous Failure Mode

The upstream self-anchoring problem was experimentally demonstrated on the wine store:

```
Raw merchant input:     "Grow revenue"
Cases/bundles appeared: 5/5 runs with full upstream context
                        0/5 runs with raw merchant + deterministic evidence only
```

The pipeline was:

```
Merchant input
→ Store Understanding  (llmInference)
→ Insights            (systemInference)
→ Goals               (systemInference)
→ Merchant Memory
→ Agentic Recommendation
```

Two structural problems caused this:

**A. Raw integer authority in the recommendation snapshot.**
`normalizeBelief` in `recommendation-service.server.js` wrote `authority: row.precedence` — the raw database integer (10/20/40/60/80/100). The recommendation agent received no legend explaining what these numbers mean, so it could not distinguish `authority: 10` (Store Understanding LLM inference) from `authority: 80` (merchant correction).

**B. Goals and Insights entered the recommendation context with no provenance marker.**
LLM-generated goals (created from onboarding questions + upstream Insight interpretations) were passed to the recommendation agent as plain `{id, horizon, title, description}` — identical in structure to merchant-stated goals. The agent had no way to know whether `"Make cases and bundles clearer"` was what the merchant typed or what Jefe inferred. The same interpretation appeared in Store Understanding → Insights → Goals → inferredBeliefs → recommendation context, giving the impression of multiple independent confirmations of one underlying inference.

## 2. Architecture Change

### 2.1 Fix A — Human-readable authority on beliefs

`normalizeBelief` now calls `authorityLevel(row.precedence, row.status)` (exported from `merchant-insights/candidates.server.js`), producing the same authority string the Insights and Goals prompts already see:

| Integer | String label |
|---------|-------------|
| 10 | `lower_authority_inference` |
| 20 | `system_inference` |
| 40 | `deterministic` |
| 60 | `merchant_confirmed` |
| 80 | `merchant_corrected` |
| 100 | `merchant_corrected` (houseRule) |

Evidence items in the snapshot also now include `sourceType` (e.g. `"llm_store_analysis"`, `"shopify_derivation"`) so the agent can inspect provenance directly.

### 2.2 Fix B — Provenance markers on Goals and Insights

Every goal in the recommendation snapshot now carries:
```json
{ "generatedBy": "jefe_llm", "authority": "jefe_interpretation" }
```

Every insight carries the same. These fields are also added to insights in the Goals snapshot (`buildMerchantGoalSnapshot`) so the Goals LLM sees them.

### 2.3 Fix C — Structured merchantMemory context

`buildRecommendationContext` (in `recommendation-agent.server.js`) previously flattened everything into `merchantMemory.{goals, insights, beliefs, merchantContext, previousRecommendations}`.

It now produces three named provenance layers:

```
merchantMemory.merchantIntent
  goalCoaching          ← raw merchant onboarding statements (authority: merchant_stated)
  confirmedBeliefs      ← beliefs with authority merchant_confirmed or merchant_corrected

merchantMemory.storeEvidence
  beliefs               ← beliefs with authority deterministic (precedence ≥ 40)

merchantMemory.jefeHypotheses
  goals                 ← LLM-generated goal horizons (generatedBy: jefe_llm)
  insights              ← LLM-generated findings (generatedBy: jefe_llm)
  inferredBeliefs       ← beliefs with authority lower_authority_inference or system_inference

merchantMemory.beliefs              ← complete list for supportingBeliefIds resolution
merchantMemory.merchantContext      ← conversation episodes and action memory
merchantMemory.previousRecommendations
```

The `goalCoaching` field (raw merchant onboarding text) is now fetched and included in the agentic recommendation snapshot, giving the agent the original uninterpreted merchant statement alongside the Jefe interpretations of it.

### 2.4 Fix D — Updated system prompt

`buildRecommendationSystemPrompt` now instructs the agent:

- `merchantIntent` is authoritative for desired outcomes and constraints
- `storeEvidence` is authoritative for factual store state
- `jefeHypotheses` are useful leads, not merchant requirements or independent evidence
- The same hypothesis appearing in goals, insights, and inferredBeliefs is still one underlying inference
- A Jefe hypothesis requires explicit merchant confirmation (status `merchant_confirmed` or `merchant_corrected`) before being treated as merchant intent

### 2.5 Fix E — Validation consistency

`validateSemanticRecommendation` updated to look for insights in `context.merchantMemory.jefeHypotheses.insights` rather than the now-absent `context.merchantMemory.insights`.

## 3. Provenance Semantics

The existing `BELIEF_STATUS` and `BELIEF_PRECEDENCE` constants are unchanged. The correction is in how they are communicated to downstream LLMs.

### Source Classes (conceptual → implementation)

| Concept | Implementation |
|---------|---------------|
| `MERCHANT_STATED` | `goalCoaching.authority === "merchant_stated"` |
| `MERCHANT_CONFIRMED` | `belief.authority === "merchant_confirmed"` (status=merchant_confirmed) |
| `MERCHANT_CORRECTION` | `belief.authority === "merchant_corrected"` (status=merchant_corrected) |
| `DIRECT_OBSERVATION` | `belief.authority === "deterministic"` (precedence ≥ 40, sourceType=shopify_derivation) |
| `DETERMINISTIC_DERIVATION` | Same as above |
| `JEFE_INFERENCE` | `belief.authority === "lower_authority_inference"` (precedence 10, sourceType=llm_store_analysis) |
| `JEFE_HYPOTHESIS` | `goal.authority === "jefe_interpretation"` / `insight.authority === "jefe_interpretation"` / `belief.authority === "system_inference"` |

## 4. Goal Changes

Goals in the recommendation snapshot now carry `generatedBy: "jefe_llm"` and `authority: "jefe_interpretation"`. They appear in `merchantMemory.jefeHypotheses.goals`, not in `merchantIntent`.

The raw merchant onboarding statement (e.g. "Grow revenue") now appears in `merchantMemory.merchantIntent.goalCoaching` — structurally separate from the Jefe-generated goal expansions.

The Goals prompt (`merchant-goals/prompt.server.js`) and its snapshot are unchanged in semantics. The Goals LLM already receives `goalCoaching` (merchant direction) separately from generated goals. We added `generatedBy: "jefe_llm"` to insights in that snapshot so the Goals LLM can also distinguish Insight-generated input from merchant input.

## 5. Insight Changes

Insights in the recommendation snapshot now carry `generatedBy: "jefe_llm"` and `authority: "jefe_interpretation"`. They appear in `merchantMemory.jefeHypotheses.insights`.

The Insights generation pipeline is unchanged. The Insights prompt already has a `beliefFieldLegend` and the `isGeneratedOnboardingBelief` firewall preventing LLM-generated goal beliefs from re-entering insights.

## 6. Recommendation Context Changes

### Before
```json
{
  "merchantMemory": {
    "goals": [{ "id": "...", "title": "Make cases and bundles clearer" }],
    "insights": [{ "id": "...", "finding": "Bundles may increase AOV" }],
    "beliefs": [{ "id": "...", "authority": 20 }]
  }
}
```

### After
```json
{
  "merchantMemory": {
    "merchantIntent": {
      "note": "Direct merchant statements. Authoritative for desired outcomes.",
      "goalCoaching": [{ "summary": "Grow revenue", "authority": "merchant_stated" }],
      "confirmedBeliefs": []
    },
    "storeEvidence": {
      "note": "Deterministic Shopify observations. Authoritative for factual store state.",
      "beliefs": [{ "id": "...", "authority": "deterministic" }]
    },
    "jefeHypotheses": {
      "note": "Jefe-generated. Useful leads, not merchant requirements or independent evidence.",
      "goals": [{ "id": "...", "title": "Make cases and bundles clearer", "generatedBy": "jefe_llm", "authority": "jefe_interpretation" }],
      "insights": [{ "id": "...", "finding": "Bundles may increase AOV", "generatedBy": "jefe_llm", "authority": "jefe_interpretation" }],
      "inferredBeliefs": [{ "id": "...", "authority": "system_inference" }]
    },
    "beliefs": [...]
  }
}
```

## 7. Confirmation/Rejection Behaviour

### Promotion (confirmation)

When a merchant explicitly confirms a Jefe hypothesis via chat, correction, or in-app approval:
- The belief's `status` becomes `merchant_confirmed` (precedence 60)
- `authority` resolves to `"merchant_confirmed"` 
- The belief moves from `jefeHypotheses.inferredBeliefs` to `merchantIntent.confirmedBeliefs`
- Downstream recommendation treats it as merchant intent

Confirmation requires an explicit merchant action. Silence or absence of objection does not promote a hypothesis.

### Rejection

When a merchant retracts or corrects a belief:
- `status` becomes `merchant_retracted` (authoritative but not active) or `merchant_corrected`
- `merchant_retracted` beliefs are excluded from all active snapshots — the hypothesis cannot return as merchant intent
- `merchant_corrected` beliefs appear in `merchantIntent.confirmedBeliefs` with the merchant's corrected value

## 8. Tests

`tests/recommendation-provenance.test.mjs` adds 11 unit tests covering:

- `authorityLevel` helper for all 5 authority levels
- **Test A** — broad merchant goal ("Grow revenue") stays in `merchantIntent.goalCoaching`; Jefe-generated strategy stays in `jefeHypotheses.goals`
- **Test B** — explicit merchant strategy in goalCoaching is treated as merchant intent
- **Test C** — merchant-confirmed belief appears in `merchantIntent.confirmedBeliefs`, not in `jefeHypotheses`
- **Test D** — merchant-corrected belief is in `merchantIntent.confirmedBeliefs`; Jefe-generated goals remain in `jefeHypotheses`
- **Test E** — same hypothesis in goal, insight, and inferred belief all carry `jefe_interpretation` / `system_inference` authority; none appear in `merchantIntent`
- **Store evidence isolation** — deterministic beliefs land in `storeEvidence` only

## 9. Wine-Store Rerun

The wine-store diagnostic rerun requires a live DB connection and real LLM calls. Run with:

```bash
CONDITIONS=A,B,C,D,E,F,UPB node .context/agentic-anchoring/run-diagnostic.mjs
```

The frozen snapshot is now built with the provenance-aware structure:
- `goalCoaching` carries raw merchant onboarding statements
- Goals carry `generatedBy: "jefe_llm"`, `authority: "jefe_interpretation"`
- Insights carry `generatedBy: "jefe_llm"`, `authority: "jefe_interpretation"`
- Beliefs carry string authority labels instead of raw integers

Condition A (production baseline) now structurally distinguishes merchant intent from Jefe interpretation for the first time. The system prompt instructs Luna to treat `jefeHypotheses` as leads to independently verify, not as established facts.

### Expected behaviour shift

Before: Cases/bundles appeared in 5/5 runs because Jefe's generated strategy ("Make cases and bundles clearer") was indistinguishable from the merchant's raw goal ("Grow revenue").

After: Luna receives "Grow revenue" as the merchant's authoritative objective and the cases/bundles strategy as a `jefe_interpretation`. If bundles have strong sales data in `storeEvidence`, Luna may still independently conclude bundles are worth acting on — but it will be starting from the store evidence, not from Jefe's prior conclusion.

We are **not expecting cases/bundles to disappear**. We are expecting Luna to reach that conclusion from `merchantIntent + storeEvidence` rather than because `jefeHypotheses` presented it as established fact.

## 10. Collection-Salience Counterfactual

The counterfactual snapshot (`buildCounterfactualSnapshot` in `run-diagnostic.mjs`) is a synthetic store where:

- Merchant intent: "Grow revenue" (goalCoaching)
- Jefe-generated goals: inventory correction objectives
- Jefe-generated insight: "Best sellers are blocked by wrong stock"
- Store evidence: Three best-selling SKUs show zero Shopify availability while warehouse says they have units; navigation/collections are already adequate (explicit belief)
- Shopify read: Products are active but show zero totalInventory

The correct action is inventory quantity correction, not collection creation. Collection creation is unjustified because:
1. Navigation is explicitly evidenced as adequate (`cf-belief-3`)
2. The problem is availability (stock record mismatch), not discoverability

Run counterfactual conditions:

```bash
CONDITIONS=A SKIP_COUNTERFACTUAL=0 node .context/agentic-anchoring/run-diagnostic.mjs
```

With the provenance-aware architecture, Luna should see:
- `merchantIntent.goalCoaching`: "Grow revenue"
- `storeEvidence.beliefs`: inventory mismatch (deterministic), navigation adequate (deterministic)
- `jefeHypotheses.goals`: inventory correction goals

Luna should select inventory correction and should not propose a new collection because the evidence (navigation adequate + availability is the constraint) makes collection creation unjustified.

If Luna still proposes a collection, it indicates a second bias: commercial salience alone triggering merchandising actions. The generic guardrail (Part 13) should only be added if the counterfactual confirms this bias persists after the provenance fix.

## 11. Remaining Risks

**R1 — Collection-salience bias may persist independently of provenance.** Even with Jefe hypotheses correctly labelled, Luna may infer a collection recommendation from `storeEvidence` alone if a product category has strong revenue. This is a separate bias from self-anchoring. The counterfactual is designed to detect this.

**R2 — `isGeneratedOnboardingBelief` firewall is only in the Insights path.** The filter that prevents LLM-generated goal beliefs from entering Insights does not apply in the agentic recommendation path. The provenance structure mitigates this because those beliefs appear in `jefeHypotheses.inferredBeliefs` rather than `storeEvidence`. But the underlying beliefs still exist.

**R3 — System prompt guidance is not enforced structurally.** The provenance structure is structural; the prompt instructions are advisory. A sufficiently confused LLM response could still conflate the layers. Tests A–E verify the context structure is correct, not that the LLM always respects it.

**R4 — Merchant context (episodic memory) mixes merchant statements and action history.** `merchantContext` items are tagged `"conversation_episode"` or `"action_memory"` but sit in the same array. Action memory describes things Jefe did, not merchant preferences. A full fix would further split these.

**R5 — Diagnostic script uses a frozen snapshot.** The frozen snapshot reflects store state at the time the original recommendation ran. Re-running against the current live store state would show different evidence and is a separate concern.
