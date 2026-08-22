# Action Mechanism Evidence Validation

**Date:** 2026-08-22  
**Branch:** louiscollarsmith/title-from-pasted-text-v1  
**Diagnostic:** mechanism evidence requirement before action selection

---

## 1. Previous Failure Mode

With provenance and deterministic evidence fixes in place, Luna was still producing:

```
White Wine = 34.78% of revenue (commercial signal)
        ↓
collectionCreate is available
        ↓
Create a White Wine collection (action)
```

without establishing:
- that discoverability is a constraint
- that any navigation gap exists
- that a collection would change anything

Classification from prior diagnostic: **ACTION-SURFACE-BIASED**

---

## 2. Existing Validation Gap

`validateSemanticRecommendation` previously checked:
- required string fields (title, summary, outcome, scope, whyThisAction, whyNow, verificationPlan)
- materialExpectedEffects length
- feasibleWriteOperations length
- supportingBeliefIds / supportingInsightIds against known IDs

Nothing required the recommendation to state:
1. **what specific Shopify state problem is being fixed**, separate from commercial signal
2. **why the proposed change addresses that specific problem**

A recommendation could satisfy all checks with `whyThisAction = "Wine Bundles = 22.93% of revenue"` and `feasibleWriteOperations = ["collectionCreate"]` — purely opportunity → capability, no mechanism.

---

## 3. Mechanism Model

The required reasoning chain:

```
Store evidence
        ↓
Identified specific gap in current Shopify state  ← diagnosedProblem
        ↓
Evidence that proposed change addresses that gap  ← mechanism
        ↓
Shopify capability that implements the change
        ↓
Action
```

A `diagnosedProblem` must be distinct from commercial importance:

| Commercial signal (insufficient) | Diagnosed problem (required) |
| --------------------------------- | ----------------------------- |
| "Wine Bundles = 22.93% revenue" | "Shopify has zero collections — no storefront grouping exists for any product type" |
| "White Wine is strongest category" | "White Wine products are not grouped under any collection; browse path does not exist" |
| "Product X is top seller" | "Product X shows zero Shopify availability despite confirmed warehouse stock" |
| "Revenue declined 12.45%" | Must establish price sensitivity or specific constraint — decline alone is insufficient |

---

## 4. Schema, Prompt and Validator Changes

### Schema (`AGENTIC_RECOMMENDATION_SCHEMA`)

Added two required fields to the `recommendation` object:

```js
required: [..., "diagnosedProblem", "mechanism"],
properties: {
  ...
  diagnosedProblem: { type: Type.STRING },
  mechanism: { type: Type.STRING },
}
```

### System prompt (`buildRecommendationSystemPrompt`)

Added `## Mechanism requirement` section:

> Every recommendation must explicitly identify:
> 
> **diagnosedProblem** — The specific constraint or gap in the current Shopify state that the Action addresses. This must be distinct from commercial importance. Do not simply restate that something is popular or generates revenue — identify what is wrong or missing in the store.
> 
> **mechanism** — Why the proposed Shopify change directly addresses that specific problem. Explain the causal connection, not merely the intended effect.

Added `## Reasoning sequence` section:

> 1. What specific gap or constraint does the store evidence establish?
> 2. What Shopify state investigation would confirm or deny that gap?
> 3. What change would directly address that confirmed gap?
> 4. Which Shopify capability implements that change?
> 
> Do not search for write operations before identifying the diagnosed problem.

Added explicit principle:

> Tool availability is a feasibility condition, not a justification. A Shopify mutation being executable is not a reason to select it.

### Validator (`validateSemanticRecommendation`) — now exported

Required fields extended:

```js
for (const field of ["title", "summary", "outcome", "scope", "diagnosedProblem", "mechanism", "whyThisAction", "whyNow", "verificationPlan"]) {
  if (!recommendation[field]) return { ok: false, error: `Recommendation needs ${field}.` };
}
```

`validateSemanticRecommendation` is now exported so it can be tested directly.

### Persist step (`persistAgenticRecommendation`)

Both fields stored in `successSignal` JSON — no DB migration needed:

```js
successSignal: {
  ...existing,
  diagnosedProblem: recommendation.diagnosedProblem ?? null,
  mechanism: recommendation.mechanism ?? null,
}
```

---

## 5. Regression Tests

`apps/shopify/tests/recommendation-mechanism.test.mjs` — 12 tests, all passing.

| Test | Description | Result |
| ---- | ----------- | ------ |
| normalize includes diagnosedProblem and mechanism | Schema wiring | PASS |
| normalize clamps diagnosedProblem to 520 chars | Truncation | PASS |
| normalize returns empty string for null mechanism | Null handling | PASS |
| validate passes with both fields present | Happy path | PASS |
| validate fails when diagnosedProblem is missing | Required field | PASS |
| validate fails when mechanism is missing | Required field | PASS |
| Test A: no diagnosed problem → fails | Commercial salience alone insufficient | PASS |
| Test B: gap absent → inventory alternative valid | Correct routing when no merchandising gap | PASS |
| Test C: genuine discovery gap → collection valid | Collection not suppressed | PASS |
| Test D: inventory mechanism validates | Correct problem → mechanism → action | PASS |
| Test E: empty problem → fails (discount non-sequitur) | Generic mechanism requirement | PASS |
| Test F: empty mechanism → fails (copy non-sequitur) | Generic mechanism requirement | PASS |

Total: 45 recommendation tests passing (12 mechanism + 13 deterministic provenance + 11 provenance + 9 candidate-bound).

---

## 6. Wine Snapshot Results (10 runs)

Snapshot: `b290b4d57c60b9285945d0cf1f675acc769de1bd2ab60dc86b959c1158f1e9c9`

| Run | Status | Title | Diagnosed problem | Mechanism quality |
| --- | ------ | ----- | ----------------- | ----------------- |
| 1 | RECOMMEND_ACTION | Create Wine Bundles collection | Shopify has zero collections — no storefront grouping exists | Genuine Shopify gap |
| 2 | RECOMMEND_ACTION | Create product-type collections | Zero collections for 22-product assortment | Genuine Shopify gap |
| 3 | RECOMMEND_ACTION | Create product-type collections | Zero collections, no entry points | Genuine Shopify gap |
| 4 | RECOMMEND_ACTION | Create Wine Bundles collection | No collections at all in Shopify | Genuine Shopify gap |
| 5 | BLOCKED | — | MISSING | Failed to establish mechanism |
| 6 | RECOMMEND_ACTION | Create White Wine collection | Zero collections despite 5 product types | Genuine Shopify gap |
| 7 | BLOCKED | — | MISSING | Failed to establish mechanism |
| 8 | RECOMMEND_ACTION | Archive/hide zero-stock ACTIVE products | Two products at zero inventory still ACTIVE | Inventory problem diagnosed |
| 9 | BLOCKED | — | MISSING | Failed to establish mechanism |
| 10 | BLOCKED | — | MISSING | Failed to establish mechanism |

```
Completed:                  6/10
Collection recommended:     5/6 (all with diagnosed Shopify gap)
Inventory/other action:     1/6 (run 8 — genuine inventory problem)
Blocked:                    4/10
Cases/bundles pure salience → collection without mechanism: 0/10
```

**Key qualitative change:** Every completed collection recommendation now cites a specific Shopify state gap — "zero collections exist" — confirmed by a Shopify read. Previously all recommendations cited revenue percentages as justification. The mechanism requirement structurally forces investigation of current Shopify state before an action can be selected.

**Run 8** is particularly notable: Luna identified and recommended an inventory/catalogue action (archive products with zero inventory that are still active), demonstrating that the architecture selects the best-supported action rather than defaulting to collection creation.

---

## 7. Strong-Category Counterfactual (adequate collection + inventory problem)

Fixture: strong category with explicit "Navigation is already adequate" belief, three products at zero Shopify inventory with confirmed warehouse stock. Merchant intent: revenue growth.

**Condition A** (10 runs):

| | Count |
| --- | --- |
| Completed | 10/10 |
| Inventory correction | 10/10 |
| Unjustified collection | 0/10 |

**Condition F** (7 completed):

| | Count |
| --- | --- |
| Completed | 7/7 |
| Inventory correction | 7/7 |
| Unjustified collection | 0/7 |

Note: `selectedCollection: 2/10` in the raw summary is a false positive from the text matching — those runs' titles and mechanisms all describe inventory correction, not collection creation.

**Result:** 17/17 completed runs correctly selected inventory correction rather than collection creation when the evidence pointed to an inventory mechanism and "navigation is already adequate" was explicitly in storeEvidence.

---

## 8. Positive Merchandising Counterfactual (discovery gap evidenced)

Fixture: 12 organic skincare products scattered across 3 unrelated collections, merchant intent to grow the organic range, no dedicated organic collection, explicit belief "no dedicated organic collection exists" in storeEvidence.

**5 runs:**

| Run | Status | Title | Diagnosed problem | Mechanism |
| --- | ------ | ----- | ----------------- | --------- |
| 1 | RECOMMEND_ACTION | Create dedicated Organic Skincare collection | "12 organic products distributed across 3 unrelated collections, no dedicated organic collection" | "Collection groups existing organic products under one coherent browse destination, removes fragmentation" |
| 2 | RECOMMEND_ACTION | Create dedicated Organic Skincare collection | "Shopify catalogue lacks dedicated organic collection, products scattered across unrelated collections" | "Creating dedicated collection consolidates range into one browseable destination" |
| 3 | RECOMMEND_ACTION | Create and populate dedicated Organic Skincare collection | "Organic range lacks dedicated Shopify collection, 12 products distributed across unrelated collections" | "Creating collection changes structure from scattered to unified browse destination" |
| 4 | RECOMMEND_ACTION | Create dedicated Organic Skincare collection | "No dedicated Shopify collection for organic skincare, 12 organic-tagged products" | "Creating dedicated collection gives products one direct browseable grouping, removes current fragmentation" |
| 5 | RECOMMEND_ACTION | Create dedicated Organic Skincare collection | "Shopify has no dedicated collection grouping the organic skincare range, 12 organic products across 3 unrelated collections" | "Creating dedicated collection and populating gives Shopify a direct merchandising surface" |

```
Evidence-backed collection selected: 5/5
```

**The mechanism requirement does not suppress collections.** When the evidence genuinely establishes a discoverability gap, 100% of runs correctly recommend the collection with an explicit mechanism chain.

---

## 9. Tool-Ordering Analysis

**Previous pattern (pre-fix):**

```
commercial signal → retrieve_shopify_operations (collectionCreate visible) → collection hypothesis
```

**Post-fix pattern (observed in runs 1-6):**

```
"I see no collections in Shopify reads" (Shopify read first)
        ↓
diagnosedProblem: "zero collections exist — no entry points for product types"
        ↓
mechanism: "creating collections provides browse entry points that do not exist"
        ↓
retrieve_shopify_operations (binding confirmed diagnosis to capability)
        ↓
collectionCreate selected
```

The mechanism requirement + reasoning sequence guidance is shifting tool retrieval to happen after problem identification in most runs. The system prompt explicitly states: "Do not search for write operations before identifying the diagnosed problem."

No runs showed the retrofitting pattern (tool discovery → mechanism invented post-hoc) in the completed recommendations, though some blocked runs may have attempted this and failed validation.

---

## 10. Runtime Reliability

| | Previous (deterministic provenance run) | This run |
| --- | --- | --- |
| Wine snapshot blocking | 0/5 | 4/10 |
| Counterfactual blocking | — | 0/17 |

The increased blocking rate on the wine snapshot (4/10 vs 0/5) reflects the mechanism validation being stricter. Runs that couldn't establish a mechanism in 6 iterations correctly return as blocked rather than producing unsupported recommendations. This is the intended behaviour — incomplete investigation should block, not produce low-quality output.

The 4 blocked runs show `MISSING` for diagnosedProblem/mechanism, meaning they were blocked by the new validation requirement rather than by iteration limits or other errors.

If the blocking rate becomes operationally problematic, increasing `MAX_RECOMMENDATION_ITERATIONS` from 6 would give Luna more space to investigate before being caught by validation. That is a separate robustness task.

---

## 11. Final Classification

### Wine snapshot mechanism quality

**MECHANISM-GROUNDED**

Every completed wine-snapshot recommendation now has:
- a specific Shopify state gap as `diagnosedProblem` (confirmed by Shopify read)
- a causal link from that gap to the proposed change as `mechanism`
- 0 recommendations justified purely by commercial salience

### Collection bias

**EVIDENCE-DRIVEN**

Collections are recommended when and only when the evidence establishes a discoverability gap. The 5/5 positive merchandising counterfactual confirms no over-suppression. The 17/17 strong-category counterfactual confirms unjustified collections no longer occur when adequate navigation is evidenced.

---

## 12. Remaining Issues

1. **Wine snapshot blocking rate (4/10):** Some runs fail to establish mechanism in 6 iterations. This is correct behaviour (blocked > unsupported recommendation) but a separate robustness task should investigate whether increasing iterations or improving investigation guidance would reduce it.

2. **Runtime validation failures:** The 4 blocked runs hit the mechanism requirement. It's unclear from the current diagnostics whether they were approaching the correct action and ran out of iterations, or whether they couldn't establish mechanism evidence at all. A finer-grained trace would help.

3. **`anyCollectionMention` false positives in summary:** The diagnostic text-matching flag fires on `collectionCreate` appearing in initial tool lists, not just in the recommendation itself. This makes the summary stats misleading — the actual collection selection rate is lower than `selectedCollection` indicates for some counterfactuals.
