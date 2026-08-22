# Agentic Recommendation Anchoring Investigation

Date: 2026-08-21

Scope: diagnostic only. No production prompts, retrieval code, model config, app behavior, Merchant Memory, Shopify state, recommendations or Actions were changed.

## Executive Summary

The exact local database row for `Create an 'Available Proven Wines' storefront collection` was not recoverable in this workspace. Exact title search found that phrase only in test fixtures, not in local `merchant_plan_recommendations` or `merchant_plan_runs`.

The local database did contain one real completed `agentic_recommendation` run with the same collection-shaped behavior:

- Run: `deb2390a-67f5-47d0-a38c-53686f342673`
- Shop: `jefe-local-store.myshopify.com`
- Created: `2026-08-21T14:46:21.347Z`
- Provider/model: `openai` / `gpt-5.6-luna`
- Snapshot hash: `b121365d972aca51dfd7c2cd3b6079232fca9e38ec6b7c3f3e96ed6de5944c6b`
- Selected recommendation: `Create an in-stock "Cases & Bundles" storefront collection`

For that recoverable run, Luna did see literal collection concepts before its first hypothesis. `buildRecommendationContext` supplied `initiallyRetrievedShopifyTools` containing `collectionCreate` and `collection` before the first model response. The first model turn then proposed making cases and bundles visible through a dedicated shopping destination and listed `collectionCreate`.

The controlled experiment does not support prompt examples as the cause. There are no production-visible recommendation examples in the `agentic_recommendation` prompt, and removing/replacing diagnostic examples did not materially change the candidate shape.

The controlled experiment also does not support early Shopify tool retrieval as the sole cause. When initial Shopify operation stubs were withheld until after a hypothesis turn, Luna still produced collection/merchandising hypotheses in 5/5 runs. In the clean-room condition, it selected collection-shaped actions in 5/5 runs.

The strongest explanation is evidence-driven, with two reinforcing anchors:

1. Merchant/store evidence strongly points at cases, bundles and broader-order purchasing.
2. Earlier model-generated goals phrase that evidence as making "cases and bundles a clearer part of the buying journey".

The behavior should be classified as:

- `EVIDENCE-DRIVEN`
- `SELF-ANCHORED`, narrowly, through generated goal/memory phrasing rather than prior recommendation history

It is not primarily `PROMPT-ANCHORED`, not primarily `TOOL-RETRIEVAL-ANCHORED`, and not `MODEL-UNSTABLE` for solution class. Tool retrieval does introduce the literal `collectionCreate` concept before the first hypothesis, so it remains a sequencing risk, but delaying it did not remove the collection-shaped idea in this snapshot.

## Reconstruction Of The Observed Run

### Exact "Available Proven Wines" Run

Recoverability:

- Local database exact search for `Available Proven Wines`: no rows.
- Local database broader search for `Proven`: no recommendations.
- Repository exact search found synthetic/test occurrences:
  - `apps/shopify/tests/action-workspace-v2.test.mjs`
  - `apps/shopify/tests/fast-onboarding.test.mjs`

Therefore the exact historical assembled context for that title cannot be reconstructed from this workspace.

### Closest Recoverable Real Run

The closest recoverable real run is the completed agentic run for `Create an in-stock "Cases & Bundles" storefront collection`.

The run result stores safe trace data, not the full raw prompt. The reconstructed context below was rebuilt from repository code and local database state using the run's `createdAt` cutoff. The rebuilt snapshot hash matched the production run hash exactly:

```text
b121365d972aca51dfd7c2cd3b6079232fca9e38ec6b7c3f3e96ed6de5944c6b
```

That hash match means the reconstructed `goals`, `insights`, `beliefs`, `merchantContext` and `previousRecommendations` match the snapshot object used by the production run.

### Model-Visible System Prompt

The model-visible system prompt came from `buildRecommendationSystemPrompt()` in `apps/shopify/app/lib/shopify/agentic-runtime/recommendation-agent.server.js`. It tells Luna to decide the most valuable concrete Shopify Action, use Merchant Memory, bounded evidence, Shopify read tools and a searchable generated Admin API catalogue, and to avoid generic advice or invented Shopify facts. It names the two tool-call protocol operations:

- `retrieve_shopify_operations`
- `call_shopify_operation`

It also says recommendation investigation must never call mutations and that writes begin only after Action acceptance.

### Model-Visible User Prompt Shape

The runtime sends one JSON prompt per iteration:

```text
promptVersion
iteration
merchantMemory
  goals
  insights
  beliefs
  merchantContext
  previousRecommendations
boundedStoreEvidence
searchableShopifyApiKnowledge
initiallyRetrievedShopifyTools
previousAttemptDiagnostics
toolResults
```

For the recoverable run, the snapshot counts were:

| Context component | Count |
| --- | ---: |
| Goals | 3 |
| Insights | 5 |
| Beliefs | 40 |
| Merchant context | 0 |
| Previous recommendations | 0 |

### Merchant Memory And Evidence Visible To Luna

High-salience memory/evidence included:

- Merchant-confirmed priority: `Grow revenue`.
- Model-generated six-month goal: `Grow revenue from broader orders`, describing cases and bundles as a clearer buying-journey component.
- Model-generated three-month goal: build steadier wine sales while protecting availability of products with low cover.
- Deterministic belief: Wine Bundles generated `GBP 785`, `22.93%` of trailing-90-day product revenue.
- Deterministic belief: recent revenue declined `12.45%` versus the prior 90 days.
- Deterministic belief: discount depth was low, `0.65%` of pre-discount revenue.
- Deterministic stock evidence: two products had zero available inventory and should not be promoted.
- Merchant-confirmed operating rule: do not include products with fewer than 3 units available.
- Merchant-confirmed operating rule: do not recommend `Borderlands Discovery Four`.

Visible product evidence included a specialist wine catalogue with single bottles, cases and bundle products. The stored production trace later records Shopify reads confirming one active in-stock bundle and one unavailable bundle.

### Initially Retrieved Shopify Tools

The reconstructed initial tool list for the matched snapshot was:

```text
products
product
productVariantsBulkUpdate
orders
productUpdate
refundCreate
collectionCreate
discountCodeBasicCreate
collection
metafieldsSet
```

This is the exact answer to the sequencing question for the recoverable run: Luna saw `collectionCreate` and `collection` before its first hypothesis.

### First Model Turn In The Real Run

The first stored turn had no tool calls and returned `RECOMMEND_ACTION`. It considered:

```text
Improve broader-order revenue by making existing cases and bundles more visible as a dedicated shopping destination.
```

The reason cited:

```text
Wine Bundles generated GBP 785, or 22.93% of trailing-90-day product revenue, while the assortment currently sells mostly single bottles. A dedicated collection is a concrete Shopify change aligned with the merchant's broader-order goal.
```

Relevant operations listed:

```text
products
collectionCreate
collection
```

The app rejected that first turn for insufficient investigation, then Luna retrieved Shopify operations and read products.

### Tool Timeline In The Real Run

```text
Merchant Memory and initial Shopify tool stubs visible
  includes collectionCreate and collection
v
First Luna hypothesis
  broader-order revenue -> dedicated shopping destination / collection
v
recommendation_validation
  insufficient investigation
v
retrieve_shopify_operations
  query: create a storefront collection containing existing in-stock case and bundle products, then verify membership
v
call_shopify_operation
  products
v
validation repairs
v
selected action
  Create an in-stock "Cases & Bundles" storefront collection
```

## Collection-Anchor Search Results

| Source | Classification | Could the run see it? | How it became visible | Anchoring strength |
| --- | --- | --- | --- | --- |
| Initial Shopify API stubs: `collectionCreate`, `collection` | `SHOPIFY API DESCRIPTION` | Yes | `initiallyRetrievedShopifyTools` in first prompt | High for literal operation shape |
| Generated API catalogue descriptions for `collectionCreate`, `collectionAddProducts`, `collections`, `collection` | `SHOPIFY API DESCRIPTION` | Yes, when retrieved or initially selected | Lexical retrieval over `shopify-admin-api-2026-07.generated.json` | High after retrieval |
| Merchant goal "broader orders" and "cases and bundles" | `RUNTIME-GENERATED HISTORY` and merchant-derived goal context | Yes | Completed goal run loaded into snapshot | High for business opportunity |
| Deterministic Wine Bundles revenue share | `REAL MERCHANT/STORE EVIDENCE` | Yes | Active Merchant Memory belief | High |
| Product catalogue with case/bundle variants | `REAL MERCHANT/STORE EVIDENCE` | Yes after product read | Shopify read through gateway | High after read |
| Previous recommendations | `RUNTIME-GENERATED HISTORY` | No in matched snapshot | Count was 0 before cutoff | None |
| Action memory / episodic memory | `RUNTIME-GENERATED HISTORY` | No in matched snapshot | Count was 0 before cutoff | None |
| `Available Proven Wines` exact phrase in tests | `EVAL-ONLY` / test fixture | No | Test files only | None for production |
| London fast-delivery collection tests and live eval script | `EVAL-ONLY` | No normal production visibility | Test/eval files only | None for production unless copied into runtime |
| `docs/diagnostics/llm-runtime-and-prompt-audit.md` | Diagnostic doc | No for production | Documentation only | None |

Key answer: a collection-shaped literal API operation was visible before Luna independently formed its first merchandising hypothesis. However, collection/merchandising also emerged without initial API stubs in Condition D and F, so the API stub is not the only source.

## Immutable Snapshot

Snapshot id/hash:

```text
b121365d972aca51dfd7c2cd3b6079232fca9e38ec6b7c3f3e96ed6de5944c6b
```

The diagnostic harness rebuilt the snapshot using the production run cutoff:

```text
2026-08-21T14:46:21.347Z
```

The harness used local canonical product and inventory rows as immutable fake Shopify read responses instead of live Shopify. It omitted Prisma from the Shopify gateway context, so no `shopify_operation_calls` ledger rows were written. It called the lower-level recommendation loop directly and did not persist recommendations or Actions.

Raw run data is in `.context/agentic-anchoring/results.json`.

## Experimental Methodology

All runs used:

- Provider/model: `openai` / `gpt-5.6-luna`
- Same schema: `AGENTIC_RECOMMENDATION_SCHEMA`
- Same max iterations: 6
- Same output/input limits as production agent call
- Same immutable base snapshot
- Fake read-only Shopify client backed by the frozen local product snapshot
- Recommendation mode, so mutations were denied

Five runs were executed for each base condition and five runs each for the counterfactual A/F conditions.

Condition definitions:

| Condition | Change |
| --- | --- |
| A | Current behavior control |
| B | No illustrative examples supplied |
| C | Diagnostic-only diverse non-collection examples supplied |
| D | Initial Shopify operation stubs withheld until after first hypothesis turn |
| E | Prior recommendations/action/episode history removed and inferred beliefs filtered |
| F | Clean room: B + D + E |

Limitations:

- The exact `Available Proven Wines` run was unavailable locally.
- Conditions D and F are diagnostic harness approximations, not production code paths.
- E and F remove inferred beliefs and previous generated context, but completed goals remain because production treats completed goals as first-class planning inputs. Those goals are partly model-generated and are a plausible self-anchor.
- Some runs hit the six-iteration cap because Luna repeatedly cited unsupported belief/insight ids after otherwise forming the same candidate. Those runs still count for candidate-frequency and timeline analysis, but not selected-action frequency.

## Per-Run Results

### Base Snapshot

| Condition | Runs | Successful selected action | Collection candidates | Collection selected actions | Titles |
| --- | ---: | ---: | ---: | ---: | --- |
| A | 5 | 3 | 5 | 3 | null; null; in-stock cases and bundles collection; availability-aware Wine Bundles collection; in-stock wine cases and bundles collection |
| B | 5 | 2 | 5 | 2 | null; null; in-stock wine bundles collection; in-stock Cases & Bundles collection; null |
| C | 5 | 3 | 5 | 3 | available wine bundles collection; null; null; in-stock Cases & Bundles collection; in-stock Cases & Bundles collection |
| D | 5 | 0 | 5 | 0 | all hit iteration cap, but all produced collection/merchandising candidates |
| E | 5 | 3 | 1 | 2 | case-led offer around Borderlands Discovery Four; null; null; curated Cases & Multi-Style Picks collection; visible Cases & Bundles buying path |
| F | 5 | 5 | 3 | 5 | dedicated Case & Bundle collection; Cases & Bundles pathway; available wine bundles buying path; Cases & Bundles buying path; visible Cases & Bundles collection |

### Counterfactual Snapshot

The counterfactual fixture made collection creation inappropriate and inventory correction directly supported by evidence.

| Condition | Runs | Inventory selected actions | Collection selected actions | Titles |
| --- | ---: | ---: | ---: | --- |
| A | 5 | 5 | 0 | stock-backed best sellers; Shopify availability for best sellers; stock visibility; top-selling stock mismatch; sellable stock |
| F | 5 | 5 | 0 | reconcile Shopify stock; sellable stock; warehouse stock; accurate stock; stocked best sellers |

## Aggregate Frequency Table

| Condition | Collection candidate frequency | Collection selected Action frequency |
| --- | ---: | ---: |
| A | 5/5 | 3/5 |
| B | 5/5 | 2/5 |
| C | 5/5 | 3/5 |
| D | 5/5 | 0/5 selected, because all runs hit iteration cap |
| E | 1/5 literal collection candidates, 2/5 selected collection/pathway actions |
| F | 3/5 literal collection candidates, 5/5 selected collection/pathway actions |
| Counterfactual A | 0/5 | 0/5 |
| Counterfactual F | 0/5 | 0/5 |

## Tool Retrieval Timelines

### Production Control Pattern

```text
Initial context
  Merchant evidence: cases, bundles, broader orders, Wine Bundles revenue share
  Initial tools: products, product, productVariantsBulkUpdate, orders, productUpdate, refundCreate, collectionCreate, discountCodeBasicCreate, collection, metafieldsSet
v
First hypothesis
  Create collection / buying path for cases and bundles
v
retrieve_shopify_operations
  collection/product membership queries
v
call_shopify_operation
  products
v
candidate/selected action
  in-stock cases and bundles collection
```

### Hypothesis-First Pattern

Even when initial tool stubs were withheld, first hypotheses still used collection-adjacent business language:

```text
Merchant evidence only
v
First hypotheses in 5/5 D runs
  focused merchandising
  case-and-bundle collection
  storefront collection
  buying journey for cases/bundles
v
retrieve_shopify_operations
  queries then requested collection/product stubs
```

### Counterfactual Pattern

```text
Merchant evidence
  warehouse stock exists, Shopify shows zero, products are already grouped adequately
v
First hypotheses
  restore accurate inventory / purchasability
v
retrieve_shopify_operations
  inventoryItem, locations, products, inventoryAdjustQuantities
v
selected action
  restore stock availability
```

## Historical And Self-Anchoring Results

The matched snapshot had no previous recommendations, no action memory and no episodic context before the run cutoff. Therefore the observed collection recommendation was not caused by prior recommendation/action/conversation history.

There is still a self-anchoring channel through generated goals:

- The six-month goal was model-generated.
- It explicitly framed the business objective as broader orders through clearer cases/bundles buying.
- The first production hypothesis cited that goal.

Condition E removed previous generated context and inferred beliefs but kept completed goals; collection frequency did not disappear. This means prior recommendation history is not the cause, but generated goal phrasing remains a plausible amplifier.

## Counterfactual Results

The counterfactual fixture selected inventory actions in 10/10 runs across A and F. It did not select collection actions.

This rules out a broad model tendency to always choose collections when Shopify collection operations exist. Luna can choose a different action class when merchant evidence points clearly elsewhere.

## Final Classification

### `EVIDENCE-DRIVEN`

Supported. Collection-shaped recommendations repeatedly emerged from the real snapshot because the evidence and goals pointed to cases, bundles, broader orders and available larger-format products. The counterfactual changed the evidence and Luna switched to inventory in 10/10 runs.

### `PROMPT-ANCHORED`

Not supported. The production `agentic_recommendation` prompt has no few-shot collection recommendation examples. Removing examples had no meaningful effect because there were none to remove; adding diverse non-collection examples did not prevent collection candidates.

### `TOOL-RETRIEVAL-ANCHORED`

Partially supported as a sequencing risk, not supported as the primary cause. The production run saw `collectionCreate` before the first hypothesis, but withholding initial operation stubs did not remove collection/merchandising hypotheses.

### `SELF-ANCHORED`

Supported narrowly. The matched run had no prior recommendation/action/conversation history, but it did include model-generated goals that framed the merchant's revenue priority around cases and bundles. That is a form of generated-history anchoring, though it is grounded in merchant/evidence inputs.

### `MODEL-UNSTABLE`

Not supported for solution class. Some runs failed validation or hit iteration limits, but the candidate class on the base snapshot was consistently cases/bundles merchandising. The counterfactual was consistently inventory.

## Evidence Supporting The Classification

1. The production run's first turn cited deterministic Wine Bundles revenue share and broader-order goals before any Shopify read.
2. The production run's first prompt included `collectionCreate` and `collection` in `initiallyRetrievedShopifyTools`.
3. Condition D withheld those initial stubs; all 5 runs still formed collection/merchandising hypotheses.
4. Condition F selected cases/bundles buying-path actions in 5/5 runs despite clean-room controls.
5. Counterfactual A/F selected inventory correction in 10/10 runs.
6. Exact `Available Proven Wines` text was not production-visible in local evidence; it was found only in tests.

## Recommended Architectural Changes For Later Consideration Only

No fixes were implemented. Later changes to consider:

1. Split first-pass hypothesis generation from Shopify operation retrieval, so operation names cannot precede the first hypothesis.
2. Label completed goals by origin: merchant-authored, merchant-approved model draft, or unconfirmed model draft.
3. Separate deterministic evidence from model-generated goals/beliefs in `agentic_recommendation` prompts.
4. Require selected recommendations to quote which evidence is deterministic versus generated.
5. Keep previous recommendations/action memory out of first-pass recommendation generation unless they were merchant-approved or executed.
6. Add runtime diagnostics that persist the redacted assembled prompt/context hash and initial tool list for each agentic run.
