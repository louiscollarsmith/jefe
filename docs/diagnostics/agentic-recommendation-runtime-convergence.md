# Agentic Recommendation Runtime Convergence

**Date:** 2026-08-22  
**Branch:** louiscollarsmith/title-from-pasted-text-v1  
**Diagnostic:** make `agentic_recommendation` terminate as a valid Action or an explicit evidence-based blocker

---

## 1. Baseline Completion Rate

After the mechanism-evidence change, the frozen wine snapshot was:

```text
10 runs
6 completed successfully
4 did not converge
```

Those 4 runs returned `BLOCKED` with no `diagnosedProblem` / `mechanism`. They were not explicit evidence-based blockers in the intended sense: Luna had not finished a grounded investigation and the runtime gave it no durable record of what was already done.

Classification of the reasoning architecture at that point remained `MECHANISM-GROUNDED` / `EVIDENCE-DRIVEN`. This task did not change that architecture.

---

## 2. Failure Taxonomy (pre-fix)

Inspected from `results-mechanism.json` (wine condition A).

| Failure class | Seen in baseline | What it looked like |
| ------------- | ---------------- | ------------------- |
| Lost / incomplete investigation | Yes (runs 5, 9, 10) | Retrieve stubs succeeded; Luna then concluded without a collections/products read, or reported that the required read “could not be completed” |
| Premature decision | Yes (run 7) | Returned `BLOCKED` because Wine Bundle revenue was commercially important but collections/navigation had not been read |
| Validation repair loop | Not the dominant wine failure | Prior runtime could fail on invented belief/insight IDs and then re-investigate |
| Duplicate identical reads | Possible, not the 4/10 bottleneck | Same `products` / `collections` call could be re-issued after a validation bounce |
| Conflicting validation contract | No | Mechanism + investigation gates are individually satisfiable |
| Iteration-budget exhaustion as the recorded status | Indirect | Diagnostic recorded `BLOCKED`; the underlying issue was unfinished investigation inside 6 turns |

The 4 blocked baseline runs were **protocol / state-propagation failures**, not cases where the store evidence truly could not support an Action.

---

## 3. Root Causes

1. **Investigation state was transcript-only.** Iteration N+1 had to infer completed work from `toolResults`. After a validation error, Luna often treated investigation as unfinished.
2. **Investigation validation and payload validation were conflated in the model’s behaviour.** A bad belief ID or missing field looked like a reason to re-read Shopify.
3. **Validator errors named the class of problem, not the repair.** “Unsupported belief id” did not list valid IDs or say that other fields could stand.
4. **Duplicate reads were always executed.** Identical `call_shopify_operation` arguments consumed a turn without adding information.
5. **There was no durable last-candidate surface.** Repairing one field required the model to regenerate the whole Action from memory.

---

## 4. Runtime State-Flow

```text
Evidence (merchantIntent / storeEvidence / jefeHypotheses)
        ↓
Hypothesis
        ↓
retrieve_shopify_operations  →  investigationState.satisfiedRequirements
        ↓
call_shopify_operation       →  successfulReads[]  (duplicate → ALREADY_AVAILABLE)
        ↓
investigationComplete = true   ← server-owned, not reset by later payload errors
        ↓
Candidate (diagnosedProblem + mechanism + IDs + writes)
        ↓
                    ┌─ investigation incomplete → INSUFFICIENT_INVESTIGATION (keep reading)
Validation ────────┤─ payload field invalid → structured repair + lastCandidate
                    └─ valid → RECOMMEND_ACTION
        ↓
If evidence cannot support a safe Action → BLOCKED
If the iteration budget is exhausted after payload errors → VALIDATION_FAILED
If the budget is exhausted after missing reads → INVESTIGATION_FAILED
```

Healthy repair:

```text
Iteration 0  retrieve + products read
Iteration 1  candidate with one bad supportingBeliefId
             investigationComplete stays true
             lastValidationError names the id and allowedValues
Iteration 2  same Action, corrected id  →  valid
```

---

## 5. Investigation-Ledger Changes

`buildInvestigationState(toolResults, { lastCandidate })` is injected on every turn.

```json
{
  "retrievedOperations": ["products", "collections"],
  "successfulReads": [{ "operation": "products", "variables": { "first": 5 } }],
  "failedReads": [],
  "satisfiedRequirements": [
    "Shopify operation catalogue retrieved ✓",
    "products completed successfully ✓"
  ],
  "investigationComplete": true,
  "lastCandidate": { "...": "previous recommendation payload" },
  "lastValidationError": {
    "errorCode": "UNSUPPORTED_BELIEF_ID",
    "field": "supportingBeliefIds",
    "invalidValues": ["belief_fake_123"],
    "allowedValues": ["b-valid-1"],
    "repairInstruction": "Replace only the invalid id. Do not repeat Shopify investigation."
  },
  "doNotRepeat": "Investigation requirements are satisfied. ..."
}
```

`investigationComplete` is true once at least one successful retrieve and one real (non-`ALREADY_AVAILABLE`) read exist. Validation rows do not reset it.

---

## 6. Validation-Repair Changes

`validateSemanticRecommendation` now returns structured diagnostics:

| Field | Purpose |
| ----- | ------- |
| `errorCode` | `MISSING_FIELD`, `UNSUPPORTED_BELIEF_ID`, `UNSUPPORTED_INSIGHT_ID`, … |
| `field` | Exact payload field to change |
| `invalidValues` | The bad ID(s) |
| `allowedValues` | IDs actually present in Merchant Memory |
| `repairInstruction` | One-step fix; investigation must not be repeated |

Terminal classification treats those payload codes as `VALIDATION_FAILED`, distinct from `INSUFFICIENT_INVESTIGATION`.

`diagnosedProblem` and `mechanism` remain required. A missing mechanism still fails. Invalid IDs are never accepted.

---

## 7. Duplicate-Work Handling

`findExistingRead` matches `operation` **and** a stable fingerprint of `variables`.

| Request | Result |
| ------- | ------ |
| Same operation + same arguments after a successful read | `ALREADY_AVAILABLE`; Shopify is not called again |
| Same operation + different query / page / id | Executed |
| First read failed | Executed again |
| `retrieve_shopify_operations` | Not suppressed (queries vary; catalogue retrieval is cheap) |

Live wine/counterfactual runs did not re-issue identical reads, so `duplicateReadsAvoided` was 0. The guard is still exercised by loop tests.

---

## 8. Blocker Behaviour

After minimum investigation is satisfied, `BLOCKED` / `NO_ACTIONABLE_OPPORTUNITY` are accepted terminal states.

The system prompt now says a legitimate blocker is preferable to repeated failed attempts, and `blocker` should state what was investigated, what is missing, and what would unblock it.

Wine runs 16 and 19 did exactly that: they read product/inventory state, refused an unsafe inventory mutation, and refused merchandising without a collections read. Those are explicit blockers, not iteration-limit deaths.

---

## 9. Regression Tests

`apps/shopify/tests/recommendation-convergence.test.mjs` — 30 tests, all passing.

| Test | Coverage |
| ---- | -------- |
| A | Investigation stays complete after validation failure; loop repair does not require another products read |
| B | Invalid belief ID names the value and allowed IDs |
| C | Same for insight IDs |
| D | Identical read → `ALREADY_AVAILABLE`; not counted as a new successful read |
| E | Different operation or variables still execute |
| F | Later semantic failure does not reset `investigationComplete` |
| G | `diagnosedProblem` / `mechanism` survive an evidence-ID repair via `lastCandidate` |
| H | Explicit `BLOCKED` terminates after investigation |
| I | Missing mechanism / diagnosedProblem still fail |

Also still passing: 12 mechanism, 11 provenance, 13 deterministic-provenance, 13 agentic-runtime tests.

---

## 10. Wine-Store Evaluation

Snapshot: `b290b4d57c60b9285945d0cf1f675acc769de1bd2ab60dc86b959c1158f1e9c9`  
Model: `gpt-5.6-luna`  
Condition A, 20 runs, max 6 iterations.

| Outcome | Count |
| ------- | ----: |
| Completed Action | 18/20 |
| Explicit Blocker | 2/20 |
| Iteration Limit | 0/20 |
| Invalid Terminal State | 0/20 |

| Metric | Value |
| ------ | ----- |
| Average iterations (all 20) | 3.2 |
| Median iterations | 3 |
| Maximum iterations | 4 |
| Duplicate reads avoided | 0 |
| Validation repair attempts | 0 |

Completed Actions all cited a confirmed Shopify gap (“zero collections”) rather than revenue salience alone. Collection titles vary (White Wine, Wine Bundles, style collections) but the mechanism is the same: create a browse path that does not exist.

The two blockers investigated zero-stock selling products and refused both an unsafe inventory write and an uninvestigated merchandising write.

---

## 11. Counterfactual Regressions

### Strong-category / no merchandising problem (5 runs)

All 5 titles restore inventory for the three warehouse-backed SKUs. `selectedCollections: 0`. One run is labelled `collection_or_merchandising` by the diagnostic text matcher because the mechanism mentions storefront availability — the Action itself is inventory correction.

```text
Unjustified collection: 0/5
```

### Positive merchandising fixture (5 runs)

```text
Create a dedicated Organic Skincare collection: 5/5
```

Each `diagnosedProblem` states the missing dedicated organic grouping; each `mechanism` explains consolidating existing organic-tagged products.

Runtime changes did not alter Action semantics.

---

## 12. Iteration Statistics

```text
Wine (20):     2: 1    3: 14    4: 5    5+: 0
Counterfactual: 3: 4    4: 1
Positive merch: 2: 2    3: 1    4: 2
```

Successful grounded runs finish in 2–4 turns. `MAX_RECOMMENDATION_ITERATIONS = 6` is sufficient. The budget was not increased.

---

## 13. Final Classification

**`ROBUST`**

Grounded investigations now reliably end as:

- a valid Action, or
- an explicit evidence-based blocker

Iteration limits were absent across 30 live runs (20 wine + 5 + 5). Mechanism and provenance requirements were not weakened.

---

## 14. Remaining Risks

1. **Conservative inventory-first blockers.** Two wine runs stopped after product reads and asked for merchant confirmation instead of then reading collections. That is a valid blocker, not a protocol failure; it may still leave some investigations shorter than they could be.
2. **Live repair path is unit-tested, not live-exercised.** Wine/counterfactual runs produced zero validation errors, so `lastCandidate` repair was not observed under Luna. Scripted loop tests cover it.
3. **Duplicate-read suppression is similarly unused in live traces.** Luna did not repeat identical arguments. The guard remains for the failure mode that used to burn turns.
4. **Rate limits.** A 20-run batch can 429. The diagnostic harness now retries and resumes; production single-run generation is unaffected.
5. **Wine still prefers collections** because this store has zero collections. That is the mechanism-grounded outcome, not a reintroduced action-surface bias — confirmed by the two counterfactuals.

---

## Quality vs Prior Mechanism Evaluation

| Check | Prior (10 wine) | This run (20 wine) |
| ----- | --------------- | ------------------ |
| Completion | 6/10 | 18/20 |
| Salience-only collection justification | 0/6 completed | 0/18 completed |
| `diagnosedProblem` evidence-backed | Yes | Yes |
| Merchant / store / Jefe provenance | Unchanged | Unchanged |
| Invalid evidence IDs accepted | No | No |
| Strong-category unjustified collection | 0/17 | 0/5 |
| Positive merchandising collection | 5/5 | 5/5 |

Completion improved by making already-done investigation durable, not by loosening reasoning.
