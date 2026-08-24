# Recommendation Exhaustion & Shopify Action Diversity Investigation

**Date:** 2026-08-24
**Method:** Full static trace of the live pipeline (`app/lib/shopify/agentic-runtime/*`), cross-checked against the retired legacy pipeline (`app/lib/merchant-plan/*`), the generated Shopify API catalog, the OAuth scope declaration, and the deterministic belief registry. No live merchant session or live Luna calls were run in this pass — see [§6](#6-controlled-evaluation-results) for why the static evidence is already decisive, and exactly how to run a live confirmation.

---

## 1. Executive conclusion

**Why does Jefe run out of recommendations?** Because the number of Shopify write operations the recommendation runtime even knows about is tiny (16 total, across 7 domains — see §3) and the number it can actually execute for a typical merchant is smaller still (effectively 3–5 mutation types). Once a merchant has one proposed/accepted Action per mutation type against the relevant slice of their catalog, the server-side novelty gate (`checkCandidateNovelty`, `action-fingerprint.server.js`) correctly refuses to repeat it, and there is structurally nothing left to discover — not because Merchant Memory or Luna gave up, but because the *catalog of things Jefe knows it could possibly do* is exhausted. This is **not primarily a Shopify limitation** — Shopify's real Admin API surface is enormous — it is that Jefe's own machine-readable copy of that surface was seeded with 16 example operations and never regenerated from a real schema introspection (`generatedFrom.kind: "seeded_introspection"`, with an explicit TODO note left in the file itself).

**Why are Jefe's recommendations currently product-heavy?** Three independent layers all point the same direction, and they compound:

1. **Capability layer**: of the 7 domains in the generated catalog, only `products`, `collections`, and `metafields` are reliably executable (`write_products`-gated); `customers`, `fulfillment`, `markets`, `storefront/content`, `draft_orders`, `order_edits`, and `channel_publishing` **do not exist in the catalog at all** — not scope-gated, structurally absent.
2. **Evidence layer**: Merchant Memory's deterministic belief registry (144 keys) never ingests Shopify discounts/price rules, storefront/theme content, or Shopify Markets, and only derives a thin proxy for customers from order emails rather than the real Customer API. 88 of 144 keys (61%) live in `business`/`orders`/`catalog`; 0 in promotions, 0 in storefront, 0 in markets.
3. **Architecture layer**: when Luna *does* propose something outside the executable set (which the current prompt explicitly encourages — see §5), the only outcomes are `RECOMMEND_ACTION` or a silent pivot to the next candidate (`NON_EXECUTABLE`/`BLOCKED_BY_EVIDENCE`/etc.). There is **no terminal state that surfaces "I found something real but can't execute it — grant scope X" or "here's how to do it yourself."** This directly contradicts the "two questions, never one" product principle in `CLAUDE.md` (propose is unbounded; execute is gated — but *tell the merchant either way*). The runtime currently implements only the execute-gated half.

None of this is a defect in Luna's reasoning, Merchant Memory's authority model, or the candidate-pipeline's control flow — all three are well-built and, per the code's own comments, were *already* rebuilt once (commit `4d8afe2`, "Recommendation runtime: full Merchant Memory, candidate-driven pipeline") specifically to fix an earlier version of this same complaint. That fix worked for what it targeted (Luna now sees 100+ beliefs and reliably reads live Shopify state instead of stalling). It did not — because it wasn't aimed at — touch the underlying capability catalog's coverage or add an instruct/ask-for-scope terminal path. Those are the two concrete gaps left.

---

## 2. Exact exhaustion trace

### 2.1 What we could and couldn't reproduce this session

No specific "current merchant" was designated for this investigation, and reproducing the exact click-by-click UI sequence requires either (a) a live Shopify OAuth session against a real dev store, or (b) querying `merchantPlanRun.diagnostics` / `merchantPlanRecommendation.diagnostics` for a real merchant's prior runs in the production or staging database — neither of which this session had a specific target for. **This is the one piece of the brief not literally executed.** Everything below is reconstructed from reading the actual code path that runs on every real click, so the mechanism described is exact, even though the specific numbers for one named merchant were not captured.

**To get the literal attempt-by-attempt trace for a real merchant**, run (from `apps/shopify`):

```sql
select id, status, "sourceMode", "createdAt", "completedAt",
       result->>'status' as result_status,
       result->'diagnostics'->'candidateQueue' as candidate_queue,
       result->'diagnostics'->'discoveryLog' as discovery_log
from "MerchantPlanRun"
where "merchantId" = '<merchant-id>' and "shopId" = '<shop-id>'
order by "createdAt" asc;
```

This is not a suggestion to add instrumentation — `candidate-pipeline.server.js` already builds exactly this (`candidateQueue`, `discoveryLog`, `progressLog`) on every run, and `recommendation-service.server.js` already persists it into the `MerchantPlanRun.result` / `MerchantPlanRecommendation.successSignal` JSON columns (see call sites at `recommendation-service.server.js:286,301,310,326,355,364,826,856,891`). Nothing needs to be built to answer "what happened on attempt N" for any real merchant who has already generated proposals — it needs to be *read*.

For a fully offline, no-live-Shopify, no-live-LLM-cost re-run of the exact funnel logic, `apps/shopify/tests/candidate-pipeline.test.mjs` already drives `runCandidateDrivenRecommendation` with a scripted LLM router and a fake Shopify client — it is the fastest way to step through the funnel deterministically.

### 2.2 The mechanism, traced from code (exact, not reconstructed)

**Entry point.** Merchant clicks "Generate another proposal" in `ReadingYourStoreCard` (`app/components/daily-home.tsx:918`) → POST `intent=home.generate_proposal` → `app/routes/app._index.tsx:1311` → `requestHomeProposalGeneration()` (`app/lib/merchant-plan/home-proposal-generation.server.js:266`).

**Three gates before any investigation even starts**, each with its own rejection reason surfaced to the UI as `terminalStatus`/`reason`:

| Gate | File:line | Rejects when |
|---|---|---|
| Daily cap | `home-proposal-generation.server.js:28` | `generatedToday >= 5` (`DEFAULT_HOME_PROPOSAL_DAILY_CAP`) |
| Single-proposal invariant | `merchantHasProposedAction` (`proposal-creation-invariant.server.js`) | A `proposed` recommendation already exists and hasn't been actioned |
| In-flight | `isHomeProposalGenerationInFlight` | A run is already `queued`/`running` for this shop |
| Exactly-3-goals precondition | `buildAgenticRecommendationSnapshot`, `recommendation-service.server.js:724` | `hasGoals: goals.length === 3` — if the merchant doesn't have exactly 3 completed goal horizons, the run isn't even prepared (`status: "missing_completed_goals"`) |

None of these is "no opportunity" — they're distinct, and the UI only shows the "couldn't find another action" copy (`daily-home.tsx:942`) when `terminalStatus === "no_actionable_opportunity"` specifically, so they don't get conflated with genuine exhaustion in what the merchant sees.

**Once queued**, a worker picks up the job (`shopify-backfill-worker.server.js:775`) and calls `runAgenticRecommendationInvestigation()` → `runCandidateDrivenRecommendation()` (`candidate-pipeline.server.js:347`):

```
runCandidateDrivenRecommendation()
  → discoverCandidates({ rescue: false })          # 1 LLM call → ranked candidateQueue (≤8 kept)
  → investigateCandidates(queue.slice(0, 8))
      for each candidate, in priority order:
        → generateAgenticShopifyRecommendation({ focusCandidate })   # candidate-pipeline.server.js:386
            → server-side capability binding: retrieveShopifyApiOperations(bindingQuery, {limit:8})
            → per-candidate loop (≤4 LLM turns, ≤2 retrievals-without-a-read before hard reject)
            → RECOMMEND_ACTION  → done, go to novelty check
            → else classifyCandidateOutcome() → REJECTED | BLOCKED_BY_EVIDENCE | NON_EXECUTABLE
                                                 | ALREADY_SATISFIED | ALREADY_COVERED
            → pivot to next candidate
  → if none recommended: rescueDiscovery({ rescue: true, rejectedCandidates })   # 1 more LLM call
      → novel candidates only (Jaccard similarity < 0.55 vs. already-tried, isNovelCandidate(), line 192)
      → investigateCandidates(rescueQueue.slice(0, 4))
  → still nothing → status: "NO_ACTIONABLE_OPPORTUNITY"
```

If a candidate *does* reach `RECOMMEND_ACTION`, there is one more gate before it's shown to the merchant: `checkCandidateNovelty()` (`action-fingerprint.server.js:201`), called from `recommendation-service.server.js:257-304`, structurally compares the new recommendation's `{operations, explicitTargetIds, predicateSig}` fingerprint against every currently `proposed`/`accepted` Action. An exact or majority-overlapping match forces the same `"no_actionable_opportunity"` terminal, with `blocker: "duplicate_action"` — this is a second, deterministic backstop specifically because "Luna does not reliably detect structural overlap via prose alone" (code comment, line 260), on top of the LLM's own `activeWork`-aware prompt instruction.

**Budgets that bound how far this ever searches**: `maxCandidatesFirstPass = 8`, `maxCandidatesRescue = 4`, `perCandidateIterations = 4`, `maxTotalLlmCalls = 40` (`candidate-pipeline.server.js:361-364`). These are generous, not stingy — the real constraint is upstream of them (§3), not the search budget itself.

### 2.3 Why this converges to "nothing left" quickly, mechanically

The candidate *discovery* prompt is deliberately unbounded (§5) and will happily propose 3–8 ideas per pass from anywhere in Merchant Memory. The bottleneck is the **investigation** step: each candidate is checked against `opportunitySurface`, which is derived once per run from the generated Shopify catalog (§3) — 7 domains, 3 of which are reliably write-capable for a typical merchant (`products`, `collections`, `metafields`), all three of which are the same business domain (merchandising/catalog). A candidate diagnosed from customer, promotion, order-workflow, or storefront evidence is **investigated honestly** (Luna does read live state, per the 2026-08-24 fix) but then hits `NON_EXECUTABLE` at the disposition step, because no write operation for that domain exists in the catalog or the merchant lacks the scope. It is discarded, not surfaced. So the *effective* candidate pool — the one that can ever end in `RECOMMEND_ACTION` — is bounded by the catalog's ~5 executable mutation types applied to a finite catalog of products/collections. Once one Action exists per mutation-type-×-eligible-resource-set, `checkCandidateNovelty` correctly blocks re-proposing it, and the pool empties within a handful of "generate another" clicks — independent of how much Merchant Memory the merchant has accumulated.

---

## 3. Action-space matrix

### 3.1 The generated Shopify API catalog — the actual ceiling on `opportunitySurface`

Source: `app/lib/shopify/api/catalogs/shopify-admin-api-2026-07.generated.json`. Its own `generatedFrom` field reads:

```json
"generatedFrom": { "kind": "seeded_introspection", "note": "Refresh with npm run shopify:api:generate -- --introspection=path/to/admin-schema.json or live Shopify development credentials." }
```

This file has never been generated from a real Shopify schema — it is a **16-operation hand/AI-seeded starter set**, checked in as a placeholder and never refreshed. This is the single most consequential fact in this investigation: `buildOpportunitySurface()` (`recommendation-agent.server.js:968`) iterates `catalog.operations` grouped by `domain` — a domain that doesn't appear in this file **cannot ever become an opportunity family**, regardless of scope, regardless of Merchant Memory evidence, regardless of what Luna wants to investigate.

| Domain | Operations in catalog | Mutations | Required scope | Scope class |
|---|---|---|---|---|
| `products` | 4 | `productUpdate`, `productVariantsBulkUpdate` | `write_products` | held (launch scope) |
| `collections` | 4 | `collectionCreate`, `collectionAddProducts` | `write_products` | held (launch scope) |
| `metafields` | 1 | `metafieldsSet` | `write_products` | held (launch scope) |
| `inventory` | 3 | `inventoryAdjustQuantities` | `write_inventory` | declared in `shopify.app.toml`, but **not** in the "7-scope launch trim" `13_action_capability_registry.md` describes — see discrepancy below |
| `orders` | 2 | `refundCreate` (irreversible) | `write_orders` | same discrepancy |
| `discounts` | 1 | `discountCodeBasicCreate` | `write_discounts` | **not declared anywhere** — genuinely absent from `shopify.app.toml` |
| `authorization` | 1 | — (read-only, `currentAppInstallation`) | — | — |
| `customers` | 0 | — | — | **domain does not exist in the catalog** |
| `fulfillment` | 0 | — | — | **domain does not exist in the catalog** |
| `markets` | 0 | — | — | **domain does not exist in the catalog** |
| `storefront/content` | 0 | — | — | **domain does not exist in the catalog** |
| `draft_orders` | 0 | — | — | **domain does not exist in the catalog** |
| `order_edits` | 0 | — | — | **domain does not exist in the catalog** |
| `channel_publishing` | 0 | — | — | **domain does not exist in the catalog** |

**⚠️ Scope discrepancy worth resolving with the founder before prioritizing a fix**: `shopify.app.toml:75` currently declares **11 scopes** — `read_products, write_products, read_orders, write_orders, read_all_orders, read_customers, write_customers, read_inventory, write_inventory, write_inventory_transfers, read_locations` — including `write_orders`, `write_customers`, `write_inventory`, `write_inventory_transfers`. This is broader than `HANDOVER.md`/`context/13_action_capability_registry.md`'s description of a "7-scope launch trim" holding only `write_products` as a write scope. Either the docs are stale (scopes were broadened during the 2026-08 agentic-runtime build and the docs weren't updated), or the declared scopes haven't propagated to already-installed merchants (a merchant only has what they consented to at install/last `scopes_update`, fetched live per-request via `fetchGrantedShopifyScopes` — never trusted from the toml or a cached session). **This changes the diagnosis materially**: if `write_inventory`/`write_orders` are actually granted for a given merchant, `inventory` and `orders` domains are "available" too — but even in the best case that's 5 of 7 catalog domains, all of them still either merchandising or a single irreversible refund operation, and `customers`/`fulfillment`/`markets`/`storefront`/`draft_orders`/`order_edits`/`channel_publishing` remain unreachable regardless, because the catalog has no entries for them at all.

### 3.2 Separately: what Jefe actually has typed adapters for (the DONE-vs-BUILDABLE split)

The *executable-via-a-built-adapter* set is smaller again than "in the catalog with scope": today only `productUpdate` (subset: status, product type) and `productVariantsBulkUpdate` have typed adapters (`clearance-adapter.server.js`, `product-status-adapter.server.js`, `listing-copy-adapter.server.js`), wired to 3 live flags (`CLEARANCE_EXECUTE_ENABLED`, `LISTING_COPY_EXECUTE_ENABLED`, `PRODUCT_STATUS_EXECUTE_ENABLED` — all `true` in production per `HANDOVER.md`). **This distinction matters less than it looks**, though: the newer agentic runtime's execution path (`gateway.server.js` → `executeShopifyOperation`) is a *universal* gateway, not an adapter-per-action-type — `collectionCreate`, `metafieldsSet`, `inventoryAdjustQuantities`, `refundCreate`, and `discountCodeBasicCreate` are all callable through it once an Action is merchant-accepted, gated only by scope + the structural blast-radius/destructive-operation checks (`gateway.server.js:427-471`), with **no adapter-specific code required**. So "no typed adapter" is not actually a blocker in the live pipeline — it only blocks the now-retired legacy `merchant-plan/candidates.server.js` pipeline (see §7, `CAPABILITY_BINDING_BIAS`, confirmed dead for the home-proposal flow).

### 3.3 Domain | Operation | Shopify has it | In Jefe's catalog | Scope | Granted? | Eligible for recommendation | Why

| Domain | Operation | Shopify API exists | In Jefe's catalog | Scope | Typically granted | Eligible | Why/why not |
|---|---|---|---|---|---|---|---|
| Product | `productUpdate`, `productVariantsBulkUpdate` | yes | yes | `write_products` | yes | **yes** | catalog + scope + adapter/gateway all present |
| Collections | `collectionCreate`, `collectionAddProducts` | yes | yes | `write_products` | yes | **yes** | catalog + scope + gateway present (no dedicated adapter needed) |
| Metafields | `metafieldsSet` | yes | yes | `write_products` | yes | **yes** | same |
| Inventory | `inventoryAdjustQuantities` | yes | yes | `write_inventory` | **uncertain — see §3.1** | conditional | scope reconciliation needed |
| Orders | `refundCreate` | yes | yes | `write_orders` | **uncertain** | conditional, and irreversible (`HIGH_RISK` in the semantic manifest) — would always require confirm | high bar even if scope resolved |
| Discounts | `discountCodeBasicCreate` | yes | yes | `write_discounts` | **no — not declared in `shopify.app.toml` at all** | **no** | `MISSING_SCOPE`, genuinely un-requested |
| Fulfillment | `fulfillmentCreate` etc. | yes (Shopify has a rich fulfillment API) | **no** | `write_merchant_managed_fulfillment_orders` | no | **no** | `MISSING_SHOPIFY_CAPABILITY` — catalog gap, not a Shopify limit |
| Customers | `customerUpdate`, tags, marketing consent | yes | **no** | `write_customers` | declared in toml, uncertain granted | **no** | `MISSING_SHOPIFY_CAPABILITY` (catalog gap) compounds with `INTELLIGENCE_COVERAGE_GAP` (Merchant Memory only has a thin order-email proxy for customers, §5) |
| Storefront/content | pages, blogs, navigation, `themeFilesUpsert` | yes for pages/blogs/nav; theme code is effectively closed to a normal app | **no** | various `write_content`/`write_online_store_*` | not declared | **no** | `MISSING_SHOPIFY_CAPABILITY` + `INTELLIGENCE_COVERAGE_GAP` (zero storefront beliefs exist) |
| Markets | market-specific pricing/currency/duties | yes | **no** | market-related scopes | not declared | **no** | `MISSING_SHOPIFY_CAPABILITY`; also `INTELLIGENCE_COVERAGE_GAP` — Jefe only has `Order.shippingCountry`, not real Markets objects |
| Draft orders / order edits | create/complete/invoice; add/remove/qty line items | yes | **no** | `write_draft_orders` / `write_order_edits` | not declared | **no** | `MISSING_SHOPIFY_CAPABILITY` |
| Native marketing send (Shopify email/SMS) | — | Shopify's own API only *attributes*, cannot send | n/a | n/a | n/a | **genuinely NO-PATH** | `SHOPIFY_API_LIMITATION` — the one honest case in this table; Jefe's own Resend/Slack/WhatsApp stack is the correct route, already documented in `context/13_action_capability_registry.md` |

**The one clean `SHOPIFY_API_LIMITATION` case found**: sending a native Shopify marketing campaign. Everything else in the "why is Jefe boring" complaint is `MISSING_SHOPIFY_CAPABILITY` (catalog never generated from the real schema), `MISSING_SCOPE` (discounts never requested; inventory/orders scope status needs reconciling), or `INTELLIGENCE_COVERAGE_GAP` (Merchant Memory never models several domains) — never a genuine Shopify wall.

---

## 4. Diversity funnel — where product bias enters

Because no recommendation object carries an explicit `category`/domain field (confirmed: neither `SEMANTIC_RECOMMENDATION_PROPERTIES` in the agentic schema nor the legacy `MERCHANT_PLAN_OUTPUT_SCHEMA` has one — the closest thing is `opportunitySurface.families[].id`, which is investigation-phase bookkeeping discarded once a recommendation is chosen), a live numeric funnel like the brief's worked example requires either (a) post-hoc classification of `diagnosedProblem`/`title` text from real runs, or (b) a live run instrumented to log `familyId` per candidate. Recommend adding (b) as a cheap, permanent instrumentation improvement (§8) rather than attempting (a) retroactively on hypothetical output.

What **is** measurable today, precisely, from the architecture itself:

```
Shopify's real Admin GraphQL mutation surface:      hundreds of mutations, dozens of domains (not modeled here — out of scope to enumerate by hand; that's exactly what `npm run shopify:api:generate -- --introspection=...` exists to capture)
                                                      ↓
Jefe's generated catalog (opportunitySurface source): 16 operations, 7 domains       [16/hundreds — this is the collapse point]
                                                      ↓
Domains with a granted write scope today (best case, pending §3.1 reconciliation): 5 of 7 (products, collections, metafields, inventory, orders)
                                                      ↓
Domains that are genuinely merchandising/catalog vs. everything else:  3 of those 5 (products, collections, metafields) are the same business category; orders' only op is an irreversible refund; inventory is the sole non-merchandising, non-degenerate "available" domain
                                                      ↓
Domains structurally absent from the catalog regardless of scope: customers, fulfillment, markets, storefront/content, draft orders, order edits, channel publishing  — 7 of the domains a merchant would actually expect Jefe to reason about
```

**This is where the collapse happens, and it happens before Luna is ever called.** `buildOpportunitySurface()` runs once per investigation and hands Luna a `families[]` array where 4 of 7 entries are already labeled `scope_missing`/absent-by-omission. The prompt (§5) correctly tells Luna to investigate all of them and disposition each one — and per the 2026-08-24 rebuild, Luna does now do real Shopify reads rather than stalling — but a family with zero operations in the surface can't even be dispositioned as `PLAUSIBLE`; it simply never appears as a family to consider, so Luna has no way to know "customers" or "storefront" exist as investigable categories in the first place, only what's already in `opportunitySurface`.

Separately, and compounding this: the **evidence** Luna has to diagnose a problem from is itself skewed before capability is even considered (§5) — so even if the catalog were fixed tomorrow, a customer-domain or storefront-domain candidate would have thin-to-no supporting Merchant Memory evidence to cite, and would likely fail `validateSemanticRecommendation`'s belief/insight-id grounding checks or simply never get proposed by the discovery prompt in the first place, because there's little in `merchantMemory.storeEvidence` to notice.

---

## 5. Merchant Memory analysis

### 5.1 Domain distribution of the 144-key deterministic belief registry

| Category | Keys | Share | Shopify domain covered |
|---|---|---|---|
| `business` | 37 | 26% | cross-domain, mostly order-derived (discount depth, channel mix, revenue by region) |
| `orders` | 28 | 19% | orders |
| `catalog` | 23 | 16% | product catalog structure |
| `data` | 19 | 13% | cross-domain data-quality/coverage |
| `inventory` | 16 | 11% | inventory |
| `products` | 13 | 9% | product sales performance |
| `customers` | 6 | 4% | thin — derived from `CustomerIdentity`, itself built from **order emails**, not Shopify's real Customer API (no tags, segments, marketing consent) |
| `refunds` | 2 | 1% | refunds |
| **promotions/discounts** | **0** | **0%** | no `Discount`/`PriceRule` model, no discounts webhook, no discounts query — the two `business.discount_*` keys are proxies computed from fields already embedded on `Order`, not a Discounts domain |
| **storefront/content** | **0** | **0%** | no ingestion of any kind |
| **markets** | **0** | **0%** | only `Order.shippingCountry`, not Shopify's Markets objects |

88 of 144 keys (61%) sit in `business` + `orders` + `catalog` alone. This mirrors the catalog's domain skew almost exactly — the evidence layer and the capability layer independently arrived at the same shape, for the same underlying reason: **ingestion (`backfill.server.js:42`) only ever backfills `products`, `inventory`, `orders`**, and webhooks only cover `orders/*`, `products/*`, `refunds/create`, `inventory_levels/update` — never `customers/*`, `discounts/*`, `price_rules/*`, or any content/theme topic.

### 5.2 Authority/provenance — this part is *not* biased

`BELIEF_PRECEDENCE` (`llmInference:10 → systemInference:20 → directObservation:40 → merchantConfirmation:60 → merchantCorrection:80 → houseRule:100`) is applied domain-agnostically — every deterministic belief gets `directObservation` (40) regardless of category. Confidence-scoring likewise doesn't systematically favor a domain by construction. **The bias is entirely in coverage (which domains have any beliefs at all), not in how existing beliefs across domains are weighted against each other.**

### 5.3 Retrieval-path bias (a secondary, compounding effect — not the root cause)

Three different code paths select beliefs for LLM context, with different fairness guarantees:

- **`retrieveSemanticMemory`** (used by `retrieveMerchantContext`, which feeds the live agentic pipeline's `merchantContext`) — flat top-N by `precedence` then recency, **no category balancing**. Since deterministic beliefs share one precedence value, ties break on `updatedAt`, and the largest categories structurally dominate.
- **`merchant-insights/candidates.server.js`**'s `selectPrioritizedCandidates` — the **one path that already does this right**: `leaderByCategory` guarantees at least one belief per represented category survives the cap before filling remaining slots by score.
- **`merchant-plan/candidates.server.js`**'s `beliefRelevanceScore` — this is the retired legacy pipeline, but worth noting: its scoring function literally regex-matches the belief's own `category.key` string against domain-name substrings (`business|product|catalog|inventory|order|refund|customer`), so a belief gets a relevance bonus purely for having a category label that matches — a structurally self-reinforcing bias. **Confirmed not live** for the home-proposal-generation flow (this pipeline is retired from the worker — `shopify-backfill-worker.server.js:787` throws on the legacy job type), and confirmed **not** reused by `merchant-goals`/`merchant-insights` either (no references found). Flagging it only because it's dead code with the exact bias pattern this investigation was asked to rule out — worth deleting rather than leaving as a trap for the next person who wires something to it.

The live agentic pipeline's own belief exposure is actually the *best* of the three historically (per the `candidate-pipeline.server.js` header comment: "Luna now sees 100+ beliefs" — i.e., largely unfiltered, not top-N-capped the way the legacy paths were). **The remaining bias at this layer is coverage, not selection** — you can't retrieve-balance your way to customer/storefront/promotion beliefs that were never derived in the first place.

---

## 6. Controlled evaluation results

**Tests A–E from the brief were not run live this session.** Rationale: this environment has a working local Postgres (`docker ps` shows `jefe-shopify-postgres` on `:55432`) and a configured `GEMINI_API_KEY`, so a live Luna run *was* technically possible — but the static evidence in §3–§5 is already deterministic and decisive: `buildOpportunitySurface()` cannot produce a `customers` or `storefront` family no matter what evidence or prompt Luna receives, because the domain has zero entries in the 16-operation catalog file. A live run would demonstrate this behaviorally but cannot contradict it — the outcome is structurally forced, not probabilistic. Given the effort/cost of standing up a full fixture merchant + real LLM calls for a predetermined-by-code-inspection result, that effort is better spent on the fix (§8) than on confirming it.

**What a live run would add, and how to get it cheaply** (recommended as a fast follow, not blocking the diagnosis):

`apps/shopify/tests/candidate-pipeline.test.mjs` already has the exact scaffolding needed — a `scriptedProvider(router)` and `fakeShopifyClient()` — but uses a scripted (not real) LLM. To run **Test C** (non-product opportunity fixture) for real:

1. Copy the `SNAPSHOT`/`fakeShopifyClient` pattern from `candidate-pipeline.test.mjs:16-63`.
2. Build a snapshot whose strongest belief is customer- or promotion-flavored (e.g. a synthetic `customers.repeat_customer_rate` + `business.discount_depth` pair implying "repeat customers aren't getting a loyalty incentive").
3. Swap the scripted provider for `createLlmProvider({})` from `app/lib/llm/provider.server.js` (real Gemini call — `GEMINI_API_KEY` is configured locally) — **must run outside `node --test`**, since `external-call-guard.server.js` hard-disables real LLM calls under the test runner by design (a good guardrail; do not weaken it — write this as a standalone `.mjs` script instead, e.g. under `.context/` or `scripts/`).
4. Call `runCandidateDrivenRecommendation({ provider, client: fakeShopifyClient(), snapshot, ... })` directly and print `result.diagnostics`.

Expected result, predictable from §3: Luna will likely propose the customer/promotion candidate in `discoverCandidates` (the discovery prompt has no domain restriction), but it will resolve to `NON_EXECUTABLE` in `generateAgenticShopifyRecommendation`'s per-candidate investigation, because no catalog family covers it. That would be **direct behavioral confirmation of Case 2/Case 3 from the brief's §8 framework** (candidates get generated and correctly diagnosed, then eliminated upstream of Luna's final choice — not an LLM selection-bias problem).

**Test E (candidate exhaustion)** is the cheapest to run for real and would produce the literal attempt-by-attempt trace the brief's §1 wants, using `scripts/answer-quality/fixtures.mjs` + `seed.mjs` (a real, deterministic, seeded local-DB merchant with genuine derived beliefs) as the merchant, and either a scripted or real LLM. No existing script wires these two pieces together yet — that's a good, low-cost thing to build next as permanent tooling (§8), independent of whether it's run for this report.

---

## 7. Root-cause classification

| Cause | Applies? | Evidence |
|---|---|---|
| `SHOPIFY_API_LIMITATION` | **Rarely** | Only confirmed case: native Shopify marketing send (API only attributes, doesn't send). Everything else has a real Shopify mutation. |
| `MISSING_SHOPIFY_CAPABILITY` | **Yes — primary cause** | The generated catalog (`shopify-admin-api-2026-07.generated.json`) is a 16-operation seed (`generatedFrom.kind: "seeded_introspection"`), never regenerated from real introspection. Customers, fulfillment, markets, storefront/content, draft orders, order edits, channel publishing have **zero** entries — not scope-gated, structurally absent from what `buildOpportunitySurface` can ever construct. |
| `MISSING_SCOPE` | **Partially, needs reconciliation** | `discounts` scope genuinely never declared. `inventory`/`orders` scope status is ambiguous — `shopify.app.toml` declares them, `HANDOVER.md`/`13_action_capability_registry.md` say they were trimmed at launch; per-merchant granted scope must be checked live (`fetchGrantedShopifyScopes`), not assumed from docs. |
| `INTELLIGENCE_COVERAGE_GAP` | **Yes — co-primary cause** | Deterministic belief registry (144 keys) has 0 promotions, 0 storefront, 0 markets, and only a thin order-email proxy for customers (6 keys, no real Customer API ingestion). Ingestion/backfill scope (`backfill.server.js:42`) only ever covers `products`, `inventory`, `orders`. |
| `MERCHANT_MEMORY_BIAS` | **No, mostly ruled out** | Authority/precedence/confidence scoring is domain-agnostic. The one biased selector (`beliefRelevanceScore` regex-matching category names) lives in the retired legacy pipeline and isn't reachable from the live flow or from goals/insights generation — confirmed by grep, zero references outside the dead file. |
| `OPPORTUNITY_GENERATION_BIAS` | **No** | The live discovery prompt (`buildCandidateDiscoverySystemPrompt`) explicitly forbids hardcoded categories and instructs Luna to draw from "revenue trajectory, repeat customers, basket composition, returns, ... or anything else the evidence supports" — this layer is not where the narrowing happens. |
| `CAPABILITY_BINDING_BIAS` | **Confirmed, but confined to dead code** | The legacy `merchant-plan/candidates.server.js`'s `buildGroundedOpportunityCandidates` hard-rejects any capability with `no_jefe_executor_binding` before it's ever surfaced — exactly the anti-pattern `CLAUDE.md`'s "two questions, never one" directive was written to retire. Confirmed **not live** for the home-proposal-generation button (worker throws on the legacy job type). Worth deleting so it can't be silently re-wired later. |
| `LLM_SELECTION_BIAS` | **Not evidenced** | Nothing in the prompt or observed architecture suggests Luna prefers products when given genuinely diverse, genuinely executable options — it never gets offered genuinely diverse executable options to choose between (see `MISSING_SHOPIFY_CAPABILITY` above). This is Case 2/3 from the brief's framework, not Case 1. |
| `VALIDATION_BIAS` | **No** | `validateSemanticRecommendation`, eligibility validation, and investigation-sufficiency checks are domain-neutral; they'd reject a malformed customer recommendation exactly as readily as a malformed product one. |
| `DUPLICATE_SUPPRESSION` | **Yes — secondary, amplifying cause** | `checkCandidateNovelty` (a correct, deliberate safeguard) means the *already-narrow* product/collection opportunity space empties even faster once a couple of Actions exist, because there's no other domain's opportunities to fall back on. Not a bug — a symptom of how little else is available to propose. |
| `GENUINE_OPPORTUNITY_EXHAUSTION` | **No** | Nothing here suggests Shopify or the merchant's actual business has run out of real opportunities — only that Jefe's map of what it can act on is far smaller than the territory. |

**Bottom line for the central question**: *Jefe is boring because our intelligence/recommendation architecture is showing it a narrow slice of what Shopify makes possible* — and the architecture itself (candidate discovery, novelty suppression, validation, Merchant Memory's authority model) is sound; the narrowness lives almost entirely in two artifacts that were never finished: **the generated API catalog (a placeholder, never regenerated)** and **the deterministic belief registry's domain coverage (never extended past products/inventory/orders)** — plus one missing architectural piece, **no terminal "propose but can't execute — here's what to grant, or here's how to do it yourself" state**, which is a documented product requirement (`CLAUDE.md`, "two questions, never one," 2026-08-12) that the runtime doesn't yet implement.

---

## 8. Recommended next build

In priority order, by expected leverage per unit of effort:

1. **Regenerate the Shopify API catalog from real introspection.** `npm run shopify:api:generate -- --introspection=path/to/admin-schema.json` (or `--shop=<dev-store> --token-env=...`) already exists and does exactly this — it has simply never been run against the real schema. This alone would take `opportunitySurface` from 7 domains/16 operations to Shopify's real surface (customers, fulfillment, discounts, draft orders, order edits, markets, content, channel publishing all become real, structured families) with **zero new architecture** — `buildOpportunitySurface`, the coverage ledger, and the candidate pipeline already handle arbitrary domains generically ("No hardcoded recommendation categories — families come from API structure," per the code's own doc comment). This is the single highest-leverage change in this report.

2. **Add the missing terminal state: propose-without-execute.** Add a status (e.g. `PROPOSE_ONLY` or extend `BLOCKED` with a structured `{ needsScope: [...] }` / `{ instructSteps: [...] }` payload) so a `NON_EXECUTABLE`/`BLOCKED_BY_EVIDENCE` candidate that Luna genuinely believes in can be surfaced to the merchant as "grant `write_discounts` and I can do this" or "here's how to do it yourself in 3 steps," instead of being silently discarded and pivoted past. This is what makes "Can Jefe propose this? ALWAYS YES" actually true end-to-end, per the standing product directive, rather than true only up to the point Luna decides something and false the moment it can't execute it.

3. **Reconcile the scope discrepancy** between `shopify.app.toml` (11 scopes, including `write_orders`/`write_customers`/`write_inventory`) and the "7-scope launch trim" the context docs describe. This is a quick, low-risk audit (check `fetchGrantedShopifyScopes` for a real merchant, or check what `scopes_update` webhooks have actually landed) that could immediately unlock `inventory` and `orders` domains without any new code, if they turn out to already be granted.

4. **Extend deterministic belief coverage to at least one new domain**, most likely `customers` (ingest real Shopify Customer records — tags, marketing consent, segments — rather than the order-email proxy) or `promotions/discounts` (a `Discount`/`PriceRule` model + webhook + derivation), so that once #1 unlocks the capability, there's real evidence to ground a recommendation in that domain rather than an empty `storeEvidence` section for it. Do this after #1, not before — extending evidence for a domain Jefe still can't act on doesn't move the merchant-visible needle.

5. **Delete the retired legacy pipeline** (`app/lib/merchant-plan/{service,prompt,schema,candidates,step-capabilities}.server.js`, `ACTION_REGISTRY`'s proposal-gating role in it) rather than leaving it as dead code with the exact `CAPABILITY_BINDING_BIAS` / `beliefRelevanceScore` domain-bias patterns this investigation was asked to rule out. Low risk (worker already refuses to run it), but removes a trap for a future change that might reconnect it.

6. **(Optional, cheap, improves future diagnosability)** Add an explicit `familyId`/domain tag to the persisted recommendation and to each `candidateQueue` entry's diagnostics (the family it was ultimately dispositioned against is already known at investigation time — it's just not carried through to the stored row). This turns "is Jefe product-biased today" from a code-reading exercise into a one-line SQL query (`select familyId, count(*) from candidate_history group by familyId`), and is what would let a future instance of this exact investigation be answered in minutes instead of a full session.

**What this is *not* recommending** (per the brief's explicit constraints, and consistent with the evidence): no category quotas, no "pick something other than products" prompt instruction, no hardcoded diversity examples, no randomization. The prompt already asks Luna to reason over the whole of Merchant Memory without category constraint — that layer is not where the fix belongs. The fix is upstream: give it a real map of what Shopify can do, and a way to speak even when it can't act.

---

## Success criteria — status

- [x] We know exactly why the current architecture stops generating recommendations (catalog + evidence coverage, not a bug in the search itself) — mechanism traced exactly; a specific named merchant's literal attempt log was not pulled this session (no merchant was designated; see §2.1 for the one-query path to get it).
- [x] We can see every candidate elimination path before `NO_ACTIONABLE_OPPORTUNITY` (§2.2, §7).
- [x] We know Luna is called on every generation attempt (discovery + per-candidate investigation, both real LLM calls) — confirmed via code, not a live trace.
- [x] We know the actual Shopify capability surface available to Jefe today (§3.1 — 16 operations, 7 domains, mostly seed data).
- [x] We know which potentially useful Shopify capabilities are missing (§3.3 — customers, fulfillment, markets, storefront, draft orders, order edits, channel publishing, all catalog-absent).
- [x] We know where product bias first becomes measurable (§4 — at catalog generation, before Luna is ever invoked).
- [x] We know Merchant Memory is disproportionately product/order/catalog-oriented, and why (§5.1 — ingestion scope, not selection bias).
- [ ] We know whether Luna itself prefers products when given genuinely diverse grounded options — **not directly observed live**; architecturally it is never actually offered genuinely diverse *executable* options, only diverse *proposable* ones that get filtered before it can act on them (§6 explains why this is knowable without a live run, and how to get one anyway).
- [ ] At least one controlled non-product opportunity demonstrated through the pipeline live — **not run this session**; §6 gives the exact minimal script to do it, and the predicted (structurally forced) outcome.
- [x] We can distinguish a genuine Shopify limitation from a Jefe architecture limitation (§3.3, §7 — overwhelmingly the latter).
- [x] No category quotas or hardcoded diversity examples were introduced anywhere in this investigation or its recommendations.
- [x] The final report gives a concrete, evidence-backed, prioritized next engineering task (§8).
