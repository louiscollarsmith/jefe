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

---

## Live Validation — 2026-08-22

### Part 1 — Provenance Tests

11/11 tests pass. All five authority levels verified. Tests A–E confirm structural separation of merchant intent, store evidence, and Jefe hypotheses.

### Part 2 — Snapshot Verification

Expected hash (original production run): `b121365d972aca51dfd7c2cd3b6079232fca9e38ec6b7c3f3e96ed6de5944c6b`

Post-fix diagnostic hash: `d0f2d7be70b4370c8757b5b86d74c9847a25396cffa4f6a2a83c2e58d36b6a75`

**Mismatch is expected and correct.** The provenance fix changes the snapshot structure: beliefs now carry string authority labels instead of raw integers; goals and insights now carry `generatedBy: "jefe_llm"` and `authority: "jefe_interpretation"`; a `goalCoaching` array is added; the `snapshotVersion` string changed. The underlying Merchant Memory data is the same merchant at the same cutoff timestamp.

Provider: `openai` / `gpt-5.6-luna`. Snapshot cutoff: `2026-08-21T14:46:21.347Z`.

### Part 3 — Resolved Post-Fix Context

Effective context for `jefe-local-store.myshopify.com`:

| Concept | Layer | Authority | Generated by | Merchant-confirmed? |
|---------|-------|-----------|--------------|---------------------|
| "Grow revenue" | *absent from goalCoaching* | — | — | Merchant never used coaching step |
| "Grow revenue from broader orders" | `jefeHypotheses.goals` | `jefe_interpretation` | `jefe_llm` | No |
| "Build steadier wine sales" | `jefeHypotheses.goals` | `jefe_interpretation` | `jefe_llm` | No |
| "Scale specialist wine revenue sustainably" | `jefeHypotheses.goals` | `jefe_interpretation` | `jefe_llm` | No |
| "Order activity is concentrated, not continuous" | `jefeHypotheses.insights` | `jefe_interpretation` | `jefe_llm` | No |
| "The range is breadth-led across wine styles" | `jefeHypotheses.insights` | `jefe_interpretation` | `jefe_llm` | No |
| "Two selling products have less than 21 days of cover" | `jefeHypotheses.insights` | `jefe_interpretation` | `jefe_llm` | No |
| Wine Bundles revenue share (22.93%) | `jefeHypotheses.inferredBeliefs` | `system_inference` | Deterministic calculation | No |
| White Wine revenue share (34.78%) | `jefeHypotheses.inferredBeliefs` | `system_inference` | Deterministic calculation | No |
| Zero-stock products | `jefeHypotheses.inferredBeliefs` | `system_inference` | Deterministic calculation | No |
| `preferences.optimisation_priority` | `merchantIntent.confirmedBeliefs` | `merchant_confirmed` | Merchant-confirmed | Yes |

**Provenance gap discovered:** All 40 beliefs for this merchant use precedence 20 (`system_inference`) — including deterministic calculations derived from Shopify data (evidenceType `deterministic_calculation`). The `storeEvidence` bucket (precedence ≥ 40) is therefore empty for this merchant. Wine revenue facts land in `jefeHypotheses.inferredBeliefs` rather than `storeEvidence`. This is a pre-existing data-writing convention (deterministic derivations use `systemInference` precedence), not a bug in the provenance fix. The fix still prevents any Jefe-generated strategy from appearing in `merchantIntent`.

**No goalCoaching:** This merchant's onboarding did not include a coaching step response, so the raw "Grow revenue" merchant statement does not appear in `merchantIntent.goalCoaching`. The provenance separation is structurally correct — nothing is falsely elevated to `merchantIntent` — but the intended merchant objective is not explicitly visible.

**Cases/bundles does not appear in `merchantIntent`.** ✓

### Part 4 — Wine Snapshot Behavioural Validation (10 runs)

10 provenance-aware runs across two independent diagnostic executions, same frozen snapshot, same model.

| Run | Status | Cases/bundles hypothesis | Hypothesis language | Collection selected |
|-----|--------|--------------------------|---------------------|---------------------|
| 1 | BLOCKED | Yes | "not independently verified" | No |
| 2 | BLOCKED | Yes | "needs_verification" | No |
| 3 | RECOMMEND_ACTION | Yes | "plausible_but_unverified" | Yes — wine bundle collection |
| 4 | RECOMMEND_ACTION | (no explicit hypotheses) | — | Yes — wine cases collection |
| 5 | BLOCKED | Yes | "not_verified" | No |
| 6 | RECOMMEND_ACTION | Yes | "unverified" | Yes — Wine Bundles & Cases buying path |
| 7 | RECOMMEND_ACTION | Yes | "under_investigation" | Yes — Cases & Wine Bundles collection |
| 8 | BLOCKED | Yes | "promising_but_unverified" | No |
| 9 | BLOCKED | Yes | "needs_verification" | No |
| 10 | BLOCKED | Yes | "needs_verification" | No |

**Summary:** 4 completed (RECOMMEND_ACTION), 6 blocked. Of completions: 4/4 selected collection. Of all 10 runs: bundles/cases appeared as a hypothesis in 9/10.

### Part 5 — Provenance Behaviour per Run

| Question | Answer |
|----------|--------|
| Did Luna treat "cases and bundles" as a merchant requirement? | **NO** — in all runs that produced initial hypotheses, bundles were labelled "unverified", "needs_verification", "plausible_but_unverified", or "not independently verified" |
| Did Luna explicitly recognise it as a Jefe-generated hypothesis? | **PARTIALLY** — Luna qualified the hypothesis but did not explicitly cite the `jefe_interpretation` authority label |
| Did Luna independently support/reject it using store evidence? | **YES in 3 blocked runs** (correctly treated as unverified); **unclear in completions** (selected without explicit verification step) |
| Did repeated Jefe hypotheses appear to increase their authority? | **UNCLEAR** — cases/bundles appeared consistently, but language was more cautious than pre-fix |
| Was the merchant's actual objective represented as "Grow revenue"? | **NO** — goalCoaching was absent; the Jefe-generated "Grow revenue from broader orders" goal appeared in `jefeHypotheses`, not `merchantIntent`. The original merchant statement is not present. |

### Part 6 — Pre-Fix vs Post-Fix Comparison

| Metric | Pre-fix (condition A) | Post-fix (condition A) |
|--------|----------------------|------------------------|
| Runs | 5 | 10 |
| Cases/bundles hypothesis | 5/5 | 9/10 |
| Cases/bundles treated as merchant intent | YES (implicit — no provenance distinction) | NO (explicitly qualified as unverified) |
| Collection candidate | 3/5 | 4/4 completions |
| Inventory candidate | 2/5 | 7/10 hypotheses |
| Successful final recommendation | 3/5 | 4/10 |
| Blocked / iteration limit | 2/5 | 6/10 |

**Most important change:** The hypothesis language. Pre-fix: Luna received the cases/bundles strategy with no authority label — it appeared indistinguishable from merchant-stated goals. Post-fix: Luna labels it "unverified", "needs_verification", "plausible_but_unverified". The structural separation is working; Luna's internal reasoning is now explicitly treating it as a hypothesis rather than a fact.

**Completion rate decline:** Blocked rate increased from 2/5 (40%) to 6/10 (60%). This is attributable to runtime investigation failures (insufficient Shopify reads), not the provenance change. This is a pre-existing robustness issue that warrants a separate task.

### Part 7–8 — Collection-Salience Counterfactual (10 runs)

Synthetic snapshot: merchant objective = "Grow revenue" (goalCoaching), top-performing category clearly blocked by inventory mismatch (3 best sellers show zero Shopify availability while warehouse confirms stock), navigation explicitly adequate in store evidence.

**Condition A results (5 runs):**

| Run | Status | Collection hypothesis | Collection selected | Inventory selected |
|-----|---------|-----------------------|---------------------|--------------------|
| 1 | RECOMMEND_ACTION | Yes (explicitly deprioritized) | No (text mention) | Yes — "Restore purchasability" |
| 2 | RECOMMEND_ACTION | Yes (explicitly deprioritized) | No | Yes — inventory |
| 3 | RECOMMEND_ACTION | Not mentioned | No | Yes — inventory |
| 4 | RECOMMEND_ACTION | Not mentioned | No | Yes — inventory |
| 5 | RECOMMEND_ACTION | Yes (explicitly deprioritized) | No | Yes — inventory |

All 5 runs completed (no blocking). 5/5 selected inventory correction. In 3/5 runs, Luna explicitly stated "Improve discovery through new collections or navigation changes" as a hypothesis marked `not_prioritized` or `not_supported` — showing it considered and rejected collection creation on evidence grounds.

**Condition F results (5 runs):** Near-identical pattern. 5/5 inventory correction selected. 5/5 completed.

**Answer to the key question:** When evidence clearly points away from merchandising (navigation adequate, availability is the constraint), Luna does NOT automatically reach for collection creation. It considers the collection hypothesis and explicitly deprioritizes it based on the evidence. **Collection-salience bias is not driving collection recommendations here.**

### Part 9 — Action-Surface Bias Assessment

In the wine store runs, the collection recommendation follows this pattern in completions:

```
Wine Bundles = 22.93% of revenue (in jefeHypotheses.inferredBeliefs)
+
Jefe goal: "Grow revenue from broader orders" (in jefeHypotheses.goals)
→ Luna hypothesis: "bundles/cases could grow revenue" (unverified)
→ Shopify read: finds products with bundle/case in title
→ Collection recommendation
```

This is closer to the **action-surface-biased** pattern than the evidence-driven pattern, because:
1. Luna does not establish that discoverability is a constraint
2. Luna does not establish that a collection is missing
3. Luna sees "bundles sell" + "collection creation is available" and connects them

However, the counterfactual shows Luna CAN distinguish evidence-backed from unsupported actions when the evidence is structured clearly. The wine store case is ambiguous: wine bundle revenue IS real store evidence, and bundle grouping IS a plausible mechanism. The issue is whether Luna establishes the mechanism before recommending it.

**Classification: ACTION-SURFACE-BIASED** — collection recommendations in the wine store are not preceded by establishing a merchandising/discoverability gap; they flow from commercial salience to available mutation. This is a separate issue from provenance self-anchoring.

### Part 10 — Runtime Validation Failure Rates

| Status | Pre-fix (cond A) | Post-fix (10 runs) | Counterfactual (10 runs) |
|--------|------------------|--------------------|--------------------------|
| RECOMMEND_ACTION | 3/5 | 4/10 | 10/10 |
| BLOCKED | 2/5 | 6/10 | 0/10 |

Blockers in post-fix wine runs:
- "Recommendation investigation requires tool execution, but the Shopify operation tools were not available" (harness tool-call failure)
- "Recommendation validation requires at least one successful Shopify read" (investigation gate not satisfied)
- "Recommendation investigation is incomplete: the available initial result only supplied read operations" (fake Shopify client not returning sufficient data for the investigation gate)

The counterfactual had 0 failures because the synthetic snapshot's evidence is more compact and Luna reached confident recommendations faster.

**The runtime failure rate is distorting wine-store results.** The 6 blocked runs cannot be counted as non-collection outcomes. The correct interpretation is: of the 4 runs that completed, all 4 selected collection. Of all 10 runs, cases/bundles appeared as an explicit (qualified) hypothesis in 9/10.

**A runtime robustness follow-up task is warranted.** The investigation gate and fake-Shopify read coverage for the wine-store diagnostic should be improved. This is independent of the provenance fix.

### Part 11 — Final Classification

#### A. Provenance / Self-Anchoring: IMPROVED-BUT-REMAINS

**Evidence:**
- Goals and insights now carry `generatedBy: "jefe_llm"` and `authority: "jefe_interpretation"` in the recommendation context ✓
- Luna's hypothesis language noticeably more cautious: "unverified", "needs_verification", "plausible_but_unverified" ✓
- Cases/bundles is not presented as merchant requirement ✓
- Cases/bundles still appears in 9/10 runs — consistent with store evidence (Wine Bundles 22.93% revenue in inferredBeliefs)

**Why IMPROVED-BUT-REMAINS rather than RESOLVED:**
- Cases/bundles still appears in nearly every run. While it's now qualified, the structural loop still exists: Jefe goals containing "broader orders" framing + bundle revenue data = consistent bundle hypothesis.
- The merchant's raw objective ("Grow revenue") is absent from `merchantIntent.goalCoaching` for this store (coaching never populated). The provenance fix is structurally correct but the raw intent is missing for this merchant.
- All deterministic beliefs use `system_inference` precedence — wine revenue facts land in `jefeHypotheses.inferredBeliefs` rather than `storeEvidence`. The storeEvidence bucket is empty.

**RESOLVED criteria not yet fully met:** Luna knows the cases/bundles strategy is Jefe-generated, but the cases/bundles hypothesis still appears consistently. The repeated upstream inference still carries weight.

#### B. Collection/Merchandising Tendency: ACTION-SURFACE-BIASED

**Evidence:**
- Counterfactual strongly evidence-driven (5/5 correct inventory selection in clear cases) ✓
- Wine store: all 4 completions selected collection without establishing a merchandising/discoverability gap ✗
- Run 4: no initial hypotheses at all — went directly to collection recommendation ✗
- No run explicitly established "there is no existing bundle collection" or "discovery is the constraint" before recommending collection creation

**Classification:** The collection recommendation in the wine store is action-surface-biased: commercial salience (bundles = 22.93% revenue) + available write operation (collectionCreate) → collection recommendation, without establishing that discoverability is the mechanism. This is a separate bias from provenance self-anchoring and was not fixed by this implementation.

**This bias should be addressed in a follow-up task.** A mechanism-evidence requirement for merchandising Actions would be the appropriate fix. See Remaining Risks R1 below.

### Recommended Next Tasks

1. **Runtime robustness** — Investigation gate failures are distorting results. Reduce blocking rate to allow clearer behavioural measurement. Likely: improve iteration handling when initial tool retrieval fails.

2. **Mechanism evidence for merchandising** — Require Luna to establish a discoverability/grouping problem before recommending a collection. Should be generic (not wine/bundle specific). Post-counterfactual evidence shows this is needed.

3. **Deterministic belief precedence** — Wine revenue beliefs use `system_inference` (20) instead of `directObservation` (40). Consider writing derivations from `shopify-derivations.server.js` with `directObservation` precedence so they appear in `storeEvidence` rather than `jefeHypotheses`.

4. **GoalCoaching population** — The raw merchant objective ("Grow revenue") is absent for this store. Ensure the coaching evidence is preserved or a raw intent belief is written at `merchant_stated` authority.

## 11. Remaining Risks

**R1 — Collection-salience bias may persist independently of provenance.** Even with Jefe hypotheses correctly labelled, Luna may infer a collection recommendation from `storeEvidence` alone if a product category has strong revenue. This is a separate bias from self-anchoring. The counterfactual is designed to detect this.

**R2 — `isGeneratedOnboardingBelief` firewall is only in the Insights path.** The filter that prevents LLM-generated goal beliefs from entering Insights does not apply in the agentic recommendation path. The provenance structure mitigates this because those beliefs appear in `jefeHypotheses.inferredBeliefs` rather than `storeEvidence`. But the underlying beliefs still exist.

**R3 — System prompt guidance is not enforced structurally.** The provenance structure is structural; the prompt instructions are advisory. A sufficiently confused LLM response could still conflate the layers. Tests A–E verify the context structure is correct, not that the LLM always respects it.

**R4 — Merchant context (episodic memory) mixes merchant statements and action history.** `merchantContext` items are tagged `"conversation_episode"` or `"action_memory"` but sit in the same array. Action memory describes things Jefe did, not merchant preferences. A full fix would further split these.

**R5 — Diagnostic script uses a frozen snapshot.** The frozen snapshot reflects store state at the time the original recommendation ran. Re-running against the current live store state would show different evidence and is a separate concern.
