# Upstream Goal And Insight Self-Anchoring Diagnostic

Date: 2026-08-21

Scope: diagnostic only. No production prompts, model config, Merchant Memory behavior, Goal generation, Insight generation, Agentic Recommendation, Shopify state, recommendations or Actions were changed.

## Executive Summary

This investigation traces why the recovered `agentic_recommendation` run selected:

```text
Create an in-stock "Cases & Bundles" storefront collection
```

Recovered run:

- Shop: `jefe-local-store.myshopify.com`
- Run: `deb2390a-67f5-47d0-a38c-53686f342673`
- Snapshot hash: `b121365d972aca51dfd7c2cd3b6079232fca9e38ec6b7c3f3e96ed6de5944c6b`
- Provider/model: `openai` / `gpt-5.6-luna`

Core answer: Jefe did not invent cases and bundles from nothing. Cases and bundles existed in Shopify/product evidence, and Wine Bundle revenue was deterministically measured at `GBP 785`, `22.93%` of trailing-90-day product revenue. However, the specific strategy language that made this become a "broader orders / clearer buying journey / Cases & Bundles collection" recommendation was introduced upstream by Jefe LLMs.

The raw merchant intent was only:

```text
Grow revenue
```

There were no pre-run merchant chat messages, uploaded files, episodes, previous recommendations or Actions. The merchant did not ask for more case/bundle sales, did not use "broader orders", did not identify merchandising/discovery as the problem, and did not suggest a collection.

Primary classification:

```text
AMPLIFIED-BUT-GROUNDED
```

Secondary risk:

```text
UPSTREAM-SELF-ANCHORED
```

Reason: the upstream LLM-generated Store Understanding, Insight and Goal layers faithfully used real product/store evidence, but amplified it into a strategic hypothesis. Downstream Luna then treated that generated strategy as authoritative planning context. In the A/B test, removing generated Goals/Insights/LLM strategic beliefs materially changed the specific direction: Cases & Bundles disappeared from raw-evidence-only initial hypotheses and final actions.

## Raw Merchant Intent

Direct merchant material recoverable before the recommendation run:

| Source | Text | Created at | Classification |
| --- | --- | --- | --- |
| Merchant Memory belief `preferences.optimisation_priority` | `Grow revenue`; stored echo: `revenue comes first` | `2026-08-21T14:45:41.937Z` | `MERCHANT-DIRECT` |

There were no recoverable pre-run:

- Merchant chat messages.
- Uploaded goal documents.
- Merchant Memory candidates from chat.
- Episodic summaries.
- Previous recommendations.
- Previous Actions.

Explicit answers:

| Question | Answer |
| --- | --- |
| Did the merchant themselves ask for more case/bundle sales? | NO |
| Did the merchant themselves use words equivalent to "broader orders"? | NO |
| Did the merchant themselves identify merchandising/discovery as the problem? | NO |
| Did the merchant themselves suggest a collection? | NO |

## Influential Recommendation Inputs

| Exact/redacted text | Record/source | Created at | Created by | Merchant direct? | Shopify direct? | Deterministic? | LLM generated? | Merchant confirmed later? | Included in snapshot? | Downstream risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `Grow revenue` / `revenue comes first` | `preferences.optimisation_priority` | `2026-08-21T14:45:41.937Z` | Onboarding app input | Yes | No | No | No | Yes | Yes | Low |
| Product variants include `Case of six`; product type includes `Wine Bundle` | Shopify product/variant records | Before memory derivation, observed by derivations at `2026-08-21T14:45:29.708Z` | Shopify ingestion | No | Yes | Source data | No | No | Via reads/beliefs | Medium |
| `Wine Bundle` revenue `GBP 785`, `22.93%` | `products.revenue_by_product_type.trailing_90d` | `2026-08-21T14:45:36.936Z` | deterministic derivation | No | Derived from Shopify | Yes | No | No | Yes | High, real evidence |
| `A retailer offering... selected wine bundles` | `business.description` | `2026-08-21T14:46:02.349Z` | Store Understanding LLM | No | Based on store | No | Yes | No | Yes | Medium |
| `multi-vendor, style-diverse... smaller selection of cases and bundles` | `catalog.assortment_character` | `2026-08-21T14:46:02.606Z` | Store Understanding LLM | No | Based on store | No | Yes | No | Yes | High |
| Insight: `The range is breadth-led across wine styles` | Merchant Insight finding `c8d139...` | `2026-08-21T14:46:13.921Z` | Insights LLM | No | Based on beliefs | No | Yes | No | Yes | High |
| Insight finding says mostly single bottles with smaller cases/bundles | same | `2026-08-21T14:46:13.921Z` | Insights LLM | No | Based on beliefs | No | Yes | No | Yes | High |
| Insight why-it-matters says larger-format purchases are present but secondary | same | `2026-08-21T14:46:13.921Z` | Insights LLM | No | Based on beliefs | No | Yes | No | Yes | High |
| Goal: `Grow revenue from broader orders` | six-month Goal `fe401c...` / belief `goals.generated.six_months` | `2026-08-21T14:46:20.926Z` | Goals LLM | No | No | No | Yes | No | Yes | Very high |
| Goal description: cases/bundles clearer in buying journey | same | `2026-08-21T14:46:20.926Z` | Goals LLM | No | No | No | Yes | No | Yes | Very high |
| Goal: stronger case and bundle purchasing | twelve-month Goal / belief `goals.generated.twelve_months` | `2026-08-21T14:46:20.982Z` | Goals LLM | No | No | No | Yes | No | Yes | High |

## Goal Provenance

The Goal generation run:

- Run: `84543b4a-4fc9-49cb-bdee-0b2cc98cb41e`
- Created: `2026-08-21T14:46:14.467Z`
- Completed: `2026-08-21T14:46:21.045Z`
- Prompt version: `merchant-goals-v6-context`
- Provider/model: `openai` / `gpt-5.6-luna`
- Attempts: 1
- Input tokens: 8084

The exact raw prompt body was not persisted. The prompt template is recoverable from `apps/shopify/app/lib/merchant-goals/prompt.server.js`, and the snapshot components are recoverable from the run, beliefs and insights. The prompt tells the model to synthesize 3, 6 and 12 month commercial goals from Merchant Memory and Insights, using merchant-confirmed and deterministic beliefs with higher authority than model inferences.

Generated Goals:

| Horizon | Generated title | Generated description | Provenance |
| --- | --- | --- | --- |
| 3 months | `Build steadier wine sales` | More consistent selling periods around the multi-style range while protecting low-cover products | Goals LLM |
| 6 months | `Grow revenue from broader orders` | Make cases and bundles clearer in the buying journey alongside single bottles | Goals LLM |
| 12 months | `Scale specialist wine revenue sustainably` | Stronger case and bundle purchasing plus cost data | Goals LLM |

Goal-generation input concepts:

- Merchant-direct: `Grow revenue`.
- Deterministic: product-type revenue, average items per order, multi-item order share, revenue trend, stock cover, active product count.
- Upstream LLM: Store Understanding `cases and bundles`; Insight `larger-format purchases present but secondary`.

The Goal LLM is the first known source of:

- `broader orders`
- `buying journey`
- cases/bundles as a strategic growth route rather than just product facts

## Insight Provenance

The Insight generation run:

- Run: `65d48354-4c98-4da7-8f01-5cb6c1516ca7`
- Created: `2026-08-21T14:46:03.327Z`
- Completed: `2026-08-21T14:46:13.983Z`
- Prompt version: `merchant-insights-v7-context`
- Provider/model: `openai` / `gpt-5.6-luna`
- Attempts: 1

Relevant insight:

```text
The range is breadth-led across wine styles
```

Finding:

```text
The assortment spans multiple vendors and wine styles, while mostly selling single bottles with a smaller selection of cases and bundles.
```

Why it matters:

```text
The commercial model is built around varied product choice, with larger-format purchases present but secondary.
```

Supporting beliefs:

- `catalog.assortment_character` - Store Understanding LLM, not deterministic.
- `products.revenue_by_product_type.trailing_90d` - deterministic.

Conclusion: the insight combines one deterministic revenue-by-type belief with one LLM Store Understanding belief. It is grounded in real product/store evidence, but it introduces strategic interpretation: "commercial model", "larger-format purchases", "present but secondary".

## LLM-Derived Belief Provenance

Relevant LLM-derived beliefs in the frozen snapshot:

| Belief | Value | Confidence | Source | Merchant confirmed? | Supports bundle merchandising? |
| --- | --- | ---: | --- | --- | --- |
| `business.description` | Retailer with white/red/orange/chilled red wines and selected wine bundles | 0.72 | Store Understanding LLM | No | Mildly |
| `catalog.assortment_character` | Multi-vendor, style-diverse assortment with mostly single bottles and smaller cases/bundles | 0.75 | Store Understanding LLM | No | Strongly |
| `customers.likely_primary_customer_type` | Individual wine shoppers interested in varied styles | 0.50 | Store Understanding LLM | No | Weakly |
| `goals.generated.three_months` | Build steadier wine sales | 0.82 | Goals LLM | No | Indirect |
| `goals.generated.six_months` | Grow revenue from broader orders; cases/bundles clearer in buying journey | 0.82 | Goals LLM | No | Very strongly |
| `goals.generated.twelve_months` | Stronger case and bundle purchasing | 0.82 | Goals LLM | No | Strongly |

These beliefs reached Agentic Recommendation alongside deterministic beliefs. They had lower precedence than merchant-confirmed beliefs, but the prompt did not physically separate "raw deterministic evidence" from "generated strategic interpretation" in a way that prevented the generated wording from becoming planning context.

## First-Introduction Table

| Concept | First known introduction | Classification |
| --- | --- | --- |
| `cases` | Shopify variant titles such as `Case of six`; later Store Understanding says cases | `SHOPIFY-DIRECT`, then `UPSTREAM-LLM` |
| `bundles` | Shopify product type `Wine Bundle`; deterministic revenue-by-product-type belief | `SHOPIFY-DIRECT` / `DETERMINISTIC` |
| `Wine Bundle = 22.93%` | `products.revenue_by_product_type.trailing_90d` | `DETERMINISTIC` |
| `broader orders` | six-month Goal title | `UPSTREAM-LLM` |
| `buying journey` | six-month Goal description | `UPSTREAM-LLM` |
| `larger-format purchases` | Insight `whyItMatters` | `UPSTREAM-LLM` |
| `cases and bundles clearer` | six-month Goal description | `UPSTREAM-LLM` |
| `stronger case and bundle purchasing` | twelve-month Goal description | `UPSTREAM-LLM` |
| `collection` as solution | Agentic Recommendation and Shopify API stubs | `DOWNSTREAM-LLM` plus `SHOPIFY API DESCRIPTION` |

## Evidence Lineage Diagram

```text
RAW MERCHANT INPUT
  "Grow revenue"
        |
        +------------------------------+
        |                              |
        v                              v
DETERMINISTIC STORE EVIDENCE      SHOPIFY SOURCE DATA
  Wine Bundle = GBP 785             Product type: Wine Bundle
  22.93% of product revenue         Variant title: Case of six
  White Wine = 34.78%               Single-bottle products
  revenue down 12.45%
        |                              |
        +--------------+---------------+
                       |
                       v
STORE UNDERSTANDING LLM
  "mostly single-bottle products"
  "smaller selection of cases and bundles"
                       |
                       v
INSIGHTS LLM
  "larger-format purchases present but secondary"
                       |
                       v
GOALS LLM
  "Grow revenue from broader orders"
  "cases and bundles a clearer part of the buying journey"
                       |
                       v
AGENTIC RECOMMENDATION
  "Create an in-stock Cases & Bundles storefront collection"
```

## A/B Methodology

The diagnostic harness used:

- Frozen snapshot hash: `b121365d972aca51dfd7c2cd3b6079232fca9e38ec6b7c3f3e96ed6de5944c6b`
- Provider/model: `openai` / `gpt-5.6-luna`
- Same schema and iteration cap as the previous diagnostic harness
- Fake read-only Shopify client from local product/inventory rows
- No Prisma passed to gateway writes/ledger
- No persisted recommendations or Actions
- No Shopify writes

Condition A (`UPA`): current upstream context, no recommendation examples, no initial tool stubs before hypothesis formation, no prior recommendation/action history.

Condition B (`UPB`): raw merchant/store evidence only. Removed generated Goals, generated Insights, Store Understanding LLM beliefs, conversation summaries, prior recommendations and assistant prose. Preserved merchant-confirmed priority and deterministic/source evidence.

Raw run output:

```text
.context/agentic-anchoring/upstream-ab-results.json
```

## Per-Run Results

### Condition A - Current Upstream Context

| Run | Initial bundle/case hypothesis? | Selected action | Result |
| --- | --- | --- | --- |
| 1 | Yes | none, iteration cap | Candidates included prominent Cases & Bundles / Wine Bundles collections |
| 2 | Yes | none, iteration cap | Candidates included wine bundles and cases collection |
| 3 | Yes | none, iteration cap | Candidates included case-and-bundle buying collection |
| 4 | Yes | none, iteration cap | Candidate: dedicated Cases & Bundles storefront collection |
| 5 | Yes | `Create an in-stock wine bundles collection` | Collection selected |

UPA initial hypotheses consistently included cases/bundles, broader orders or buying-path language.

### Condition B - Raw Merchant + Store Evidence Only

| Run | Initial bundle/case hypothesis? | Selected action | Result |
| --- | --- | --- | --- |
| 1 | No | `Create and populate a White Wine collection` | Collection, but White Wine not Cases & Bundles |
| 2 | No | `Restore availability for Pear Skin Sipon and Picnic Xinomavro` | Inventory/availability |
| 3 | No | `Pause the two active stockout listings` | Inventory/availability |
| 4 | No | `Create a prominent White Wine collection` | Collection, but White Wine not Cases & Bundles |
| 5 | No | `Create a dedicated White Wine collection to concentrate proven demand` | Collection, but White Wine not Cases & Bundles |

UPB initial hypotheses focused on:

- zero-stock selling products;
- White Wine as top product type by revenue;
- top product concentration;
- discounts/returns/cost data.

They did not recreate the Cases & Bundles / broader-order direction.

## Aggregate A/B Comparison

| Metric | A: current upstream context | B: raw evidence only |
| --- | ---: | ---: |
| Collection selected frequency | 1/5 | 3/5 |
| Bundle/case hypothesis frequency | 5/5 | 0/5 |
| Cases/Bundles selected frequency | 1/5 | 0/5 |
| Inventory/availability selected frequency | 0/5 | 2/5 |
| White Wine selected frequency | 0/5 | 3/5 |

Answers:

| Question | Answer |
| --- | --- |
| Did raw evidence alone cause Luna to identify bundles/cases as the strongest opportunity? | NO |
| Did removing generated Goal/Insight language materially change the recommended solution class? | YES for the specific Cases & Bundles direction; NO for the broader possibility of Shopify collections |
| Did Luna still infer the same commercial direction from Wine Bundle = 22.93% plus raw revenue objective? | NO |

## Final Classification

Primary:

```text
AMPLIFIED-BUT-GROUNDED
```

The upstream LLMs did not hallucinate cases/bundles. Shopify and deterministic evidence contained cases, bundles and Wine Bundle revenue. But upstream LLM layers amplified that evidence into a specific strategy: broader orders through clearer case/bundle purchasing.

Secondary:

```text
UPSTREAM-SELF-ANCHORED
```

The generated goal and insight wording became downstream recommendation evidence. Removing that generated strategic language caused Luna to stop selecting Cases & Bundles and instead choose White Wine collections or stockout actions.

Not:

```text
FAITHFUL-DERIVATION
```

The generated Goals/Insights are directionally grounded, but not merely faithful compression. They add a strategic interpretation not directly stated by the merchant and not required by deterministic evidence.

Not:

```text
INCONCLUSIVE
```

The raw merchant input, relevant records and A/B outcome are sufficient to distinguish the effect.

## Core Answer

Jefe recommended a Cases & Bundles collection because real store evidence made cases/bundles a plausible revenue opportunity, but the specific "broader orders / buying journey / make cases and bundles clearer" strategy was introduced upstream by Jefe's own LLM-generated Store Understanding, Insight and Goal layers.

The merchant supplied only a broad revenue objective. Raw store evidence alone did not lead Luna to the same Cases & Bundles recommendation in the A/B; it led to White Wine collections or availability actions. Therefore the behavior is best understood as grounded amplification with upstream self-anchoring risk, not pure merchant intent and not pure hallucination.

## Implications For Architecture

The current pipeline lets generated strategic language become high-salience evidence for downstream recommendation. The problem is not that LLM summaries exist; it is that downstream prompts do not clearly distinguish:

- merchant-stated objectives;
- deterministic store observations;
- LLM-generated interpretations;
- LLM-generated strategic hypotheses.

This can make a plausible upstream interpretation act like a fact.

## Suggested Fixes For Later Consideration Only

No fixes were implemented. Later changes to consider:

1. Separate `merchant-stated goals` from `LLM-expanded goals` in recommendation context.
2. Label generated strategic interpretations as hypotheses, not facts.
3. Require Agentic Recommendation to cite deterministic or merchant-direct evidence separately from generated Goals/Insights.
4. Give downstream agents raw evidence alongside generated summaries and ask them to compare both.
5. Prevent unconfirmed generated Goal wording from becoming a Merchant Memory belief with the same visual/structural weight as merchant-confirmed priorities.
6. Require merchant confirmation before generated strategy language such as "broader orders" becomes authoritative planning input.
7. Add diagnostics that record first-introduction provenance for recommendation-critical terms.
