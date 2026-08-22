# Deterministic Evidence Provenance Validation

**Date:** 2026-08-22  
**Branch:** louiscollarsmith/title-from-pasted-text-v1  
**Diagnostic:** storeEvidence bucket population fix

---

## 1. Root Cause

All 40 beliefs for the investigated wine merchant were being normalised as `system_inference`
(precedence 20) inside `buildRecommendationContext`, including deterministic calculations
derived directly from Shopify data such as:

- Wine Bundles = 22.93% of trailing-90-day product revenue
- White Wine = 34.78% of trailing-90-day product revenue
- inventory availability = 0 for two products

**Where:** `apps/shopify/app/lib/merchant-memory/shopify-derivations.server.js`, `belief()` function, line 3774.

The function creates all deterministic Shopify-derived belief objects and hardcoded:

```js
precedence: BELIEF_PRECEDENCE.systemInference,   // was 20
```

despite calling `buildDeterministicEvidence` (which sets `evidenceType: "deterministic_calculation"`)
for every belief it produces. The wrong precedence caused `authorityLevel(20, "inferred")` to
return `"system_inference"`, which bucketed these beliefs into `jefeHypotheses.inferredBeliefs`
rather than `storeEvidence`.

---

## 2. Authority Mapping (before and after)

| Belief origin                                 | Stored precedence | Old authority     | New authority   | Layer               |
| --------------------------------------------- | ----------------: | ----------------- | --------------- | ------------------- |
| Deterministic Shopify derivation (new rows)   |                40 | `deterministic`   | `deterministic` | storeEvidence       |
| Deterministic Shopify derivation (historical) |                20 | `system_inference`| `deterministic` | storeEvidence       |
| Rule-based / system heuristic                 |                20 | `system_inference`| `system_inference` | jefeHypotheses   |
| LLM Store Understanding inference             |                10 | `lower_authority_inference` | `lower_authority_inference` | jefeHypotheses |
| Merchant confirmation                         |                60 | `merchant_confirmed` | `merchant_confirmed` | merchantIntent |
| Merchant correction                           |                80 | `merchant_corrected` | `merchant_corrected` | merchantIntent |

---

## 3. Implementation

### Source fix (new rows)

`shopify-derivations.server.js` `belief()` function:

```js
// before
precedence: BELIEF_PRECEDENCE.systemInference,

// after
precedence: BELIEF_PRECEDENCE.directObservation,
```

All beliefs produced by `shopify-derivations.server.js` are deterministic; none are
LLM-derived. This is the right precedence for the whole file.

### Read-time reclassification (historical rows)

Historical beliefs written with precedence 20 carry `evidenceType: "deterministic_calculation"`
in their linked evidence records (produced by `buildDeterministicEvidence`). The exported
`authorityLevel` function in `candidates.server.js` now checks this:

```js
export function authorityLevel(precedence, status, evidence = []) {
  if (status === BELIEF_STATUS.merchantCorrected) return "merchant_corrected";
  if (status === BELIEF_STATUS.merchantConfirmed) return "merchant_confirmed";
  if (precedence >= BELIEF_PRECEDENCE.directObservation) return "deterministic";
  // Historical rows: deterministic_calculation evidence overrides stored precedence
  if (Array.isArray(evidence) && evidence.some((e) => e?.evidenceType === "deterministic_calculation")) return "deterministic";
  if (precedence <= BELIEF_PRECEDENCE.llmInference) return "lower_authority_inference";
  return "system_inference";
}
```

Call sites updated to pass evidence:
- `merchant-insights/candidates.server.js` line 340: `authorityLevel(precedence, status, evidence)`
- `recommendation-service.server.js` normalizeBelief: `authorityLevel(row.precedence, row.status, row.evidence ?? [])`

Diagnostic harness (`run-diagnostic.mjs`) `diagnosticAuthorityLevel` updated identically.

---

## 4. Historical Row Compatibility

1. **Do existing beliefs contain enough metadata?** Yes. `buildDeterministicEvidence` writes `evidenceType: "deterministic_calculation"` as a structured field on every evidence record. This is authoritative and not susceptible to key-name heuristics.

2. **Can their effective authority be derived at read time?** Yes — the `authorityLevel` read-time check does this without touching stored data.

3. **Is a rebuild required?** No. The read-time reclassification handles all existing rows.

4. **Would a Merchant Memory refresh rewrite correctly?** Yes — new rows will have `precedence: 40` (directObservation), so they will also classify correctly through the precedence check alone.

5. **Is any data migration needed?** No.

---

## 5. Regression Tests

`apps/shopify/tests/recommendation-deterministic-provenance.test.mjs` — 13 tests, all passing.

| Test | Description | Result |
| ---- | ----------- | ------ |
| authorityLevel: historical systemInference + deterministic_calculation evidence | Read-time reclassification | PASS |
| authorityLevel: new directObservation row | Source fix | PASS |
| authorityLevel: systemInference with no evidence | No unintended promotion | PASS |
| authorityLevel: llmInference with LLM evidence | LLM stays lower-authority | PASS |
| authorityLevel: merchant_confirmed overrides evidence | Existing high-authority preserved | PASS |
| authorityLevel: merchant_corrected overrides evidence | Existing highest-authority preserved | PASS |
| Test A: direct observation → storeEvidence | Bucket placement | PASS |
| Test B: historical systemInference + deterministic evidence → storeEvidence | Historical row handling | PASS |
| Test C: deterministic trend metric → storeEvidence | Category coverage | PASS |
| Test D: system_inference (no deterministic evidence) → jefeHypotheses | Inference stays inference | PASS |
| Test E: LLM inference → jefeHypotheses | LLM stays jefeHypotheses | PASS |
| Test F: merchant_confirmed → merchantIntent.confirmedBeliefs | Authority preserved | PASS |
| Test G: mixed snapshot — all beliefs to correct layers | Integration check | PASS |

Existing tests: `recommendation-provenance.test.mjs` (11 tests) and `candidate-input-bound.test.mjs` (9 tests) — all still passing.

---

## 6. Resolved Wine-Store Context (bucket counts)

Snapshot: `b290b4d57c60b9285945d0cf1f675acc769de1bd2ab60dc86b959c1158f1e9c9`  
(previous hash was `b121365d972aca51dfd7c2cd3b6079232fca9e38ec6b7c3f3e96ed6de5944c6b` — changed because belief `authority` values changed)

```
merchantIntent:
  goalCoaching:        0   (this merchant has no coaching evidence — pre-existing gap)
  confirmedBeliefs:    1

storeEvidence:
  beliefs:            36   (was 0 before fix)

jefeHypotheses:
  goals:               3
  insights:            5
  inferredBeliefs:     3   (was 40 before fix)
```

---

## 7. Specific Fact Classification

| Fact / statement                          | Expected layer                | Actual layer after fix         |
| ----------------------------------------- | ----------------------------- | ------------------------------ |
| "Grow revenue" (merchant objective)       | `merchantIntent` (coaching)   | gap — no coaching evidence for this merchant |
| Wine Bundles = 22.93% trailing-90d revenue | `storeEvidence`              | `storeEvidence` ✓              |
| White Wine = 34.78% trailing-90d revenue  | `storeEvidence`               | `storeEvidence` ✓              |
| Zero available inventory (2 products)     | `storeEvidence`               | `storeEvidence` ✓              |
| Revenue declined 12.45%                   | `storeEvidence` if deterministic | `storeEvidence` ✓             |
| "broader orders"                          | `jefeHypotheses`              | `jefeHypotheses` ✓             |
| "make cases and bundles clearer"          | `jefeHypotheses`              | `jefeHypotheses` ✓             |
| "buying journey" interpretation           | `jefeHypotheses`              | `jefeHypotheses` ✓             |

The `merchantIntent.goalCoaching` gap predates this fix. This merchant has no
`merchant_goal_coaching` or `merchant_goal_document_context` evidence records — they did not
use the onboarding coaching step. This is a data gap, not a code defect.

---

## 8. 5-Run Behavioural Sanity Check

Condition: frozen wine snapshot, model gpt-5.6-luna, all other settings unchanged.  
Snapshot hash: `b290b4d5...`

| Run | Title | Evidence cited | Cases/bundles hyp? | Inventory hyp? | Collection selected? |
| --- | ----- | -------------- | ------------------- | -------------- | -------------------- |
| 1 | Create a visible, in-stock Wine Bundles & Cases collection | Wine Bundle £785 (22.93%), 22 products, 2 zero-stock | YES | YES (not selected) | YES |
| 2 | Create a dedicated wine bundles and cases collection | Wine Bundle £785 (22.93%), 22 products | YES | YES (not selected) | YES |
| 3 | Create an in-stock Wine Bundles collection | White Wine £1,191 (34.78%), Wine Bundle £785 (22.93%), 2 zero-stock | YES | YES (not selected) | YES |
| 4 | Create and surface a dedicated White Wine collection | White Wine £1,191 (34.78%), 5/305 discounted orders | YES | YES (not selected) | YES |
| 5 | Create a dedicated, storefront-visible Wine Bundles collection | Wine Bundle £785 (22.93%), 2 zero-stock | YES | YES (not selected) | YES |

**Summary:**

```
Cases/bundles hypothesis:            5/5
Inventory hypothesis (not selected): 5/5
White Wine merchandising hypothesis: 3/5
Collection candidate:                5/5
Collection selected:                 5/5
Completed recommendations:           5/5
Blocked:                             0/5
```

Luna is now demonstrably reading from `storeEvidence` — every run cites specific deterministic
facts ("22.93%", "£785", "22 products", "2 zero-stock") rather than vague strategic
characterisations. All five runs also identified the inventory problem in `storeEvidence` and
explicitly reasoned about why it was not the selected action ("Shopify cannot procure
inventory").

---

## 9. Runtime Failure Observations

Previous session (post-provenance fix, before deterministic fix): 6/10 blocked.  
This session (after deterministic fix): **0/5 blocked**.

The improvement is consistent with the hypothesis that validation failures (unsupported belief
IDs, unsupported insight IDs) were partly caused by `storeEvidence` being empty — Luna had
fewer anchored beliefs to cite, increasing the probability of referencing a belief ID that did
not validate. With 36 beliefs now in `storeEvidence`, citation is stable across all 5 runs.

A separate runtime robustness investigation remains warranted (the previous 60% block rate
on a different snapshot version suggests structural issues beyond provenance alone).

---

## 10. Final Classification

### Deterministic evidence provenance

**RESOLVED**

1. Deterministic/direct store facts consistently enter `storeEvidence` ✓
2. Genuine inference remains in `jefeHypotheses` ✓
3. Existing merchant data is handled safely (read-time reclassification, no migration) ✓
4. No broad authority promotion introduced (only `deterministic_calculation` evidence triggers reclassification) ✓
5. Recommendation context visibly reflects the intended distinction (36 beliefs in storeEvidence, 3 in jefeHypotheses) ✓

### Collection / action-surface bias

**ACTION-SURFACE-BIASED** (unchanged from previous validation)

Luna now reasons from real store evidence, but still moves:
commercial salience (Wine Bundles 22.93%) → available Shopify capability (collectionCreate) → collection recommendation

without establishing a discoverability or grouping mechanism. This is the next task.

---

## 11. Recommended Next Task

**Require mechanism evidence before merchandising recommendations.**

The remaining problem is structural: the recommendation schema has no field for `diagnosedMechanism`,
so Luna can satisfy all validation constraints by citing commercial salience alone. The fix is to
require the `EVIDENCE → DIAGNOSED MECHANISM → INTERVENTION → EXECUTABLE CAPABILITY` chain
as a structural schema requirement, not only prompt prose.

This is a separate task and must not change provenance architecture.
