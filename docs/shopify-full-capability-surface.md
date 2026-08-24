# Jefe's Full Shopify Capability Surface

**Date:** 2026-08-24 (updated same day — "Finish & Harden" pass)
**Companion docs:** `docs/recommendation-exhaustion-and-action-diversity.md` (why recommendations exhausted and skewed product-heavy), `docs/shopify-capability-and-scope-expansion.md` (the first real-schema investigation), `docs/shopify-full-scope-audit.md` (the OAuth scope audit), `docs/ops/mutation-safety-classifier-audit-2026-08-24.md` (the full audit backing §5 below).

This is the build that replaces the 16-operation seed catalog with the full real Shopify Admin API surface as Jefe's permanent knowledge of what Shopify can do, while keeping operation *existence*, *execution authority*, and *merchant grant* as three separate, never-collapsed concerns.

## ⚠️ Update: the safety classifier described in the original version of this document was too permissive, and has been fixed

A same-day hardening pass audited the mutation-safety classifier and found it violated its own stated invariant. The original structural-default rule promoted **any mutation matching `/update|create$|add|set|activate$/i` to `EXECUTABLE_WITH_CONFIRMATION`** whenever its domain had a "high"-confidence scope — no human review required. Audited: **47 of 56 attemptable mutations (84%) reached that status through name-pattern matching alone**, including `giftCardCreate`, `giftCardDeactivate`, and `marketCreate`. That is exactly the anti-pattern "operation-name similarity alone must not grant production write authority" forbids.

**Fixed.** The blanket name-pattern promotion is removed. In its place: a small `REVIEWED_FAMILY_POLICIES` table (3 named, individually-justified operation families), an `execution.classificationSource` field on every operation (audit trail: which layer granted authority), and a structural invariant in both the classifier and the catalog validator that **`STRUCTURAL_NAME_INFERENCE` can never produce an executable result**. Full detail in §5 below and `docs/ops/mutation-safety-classifier-audit-2026-08-24.md`. Numbers in the rest of this document that predate this fix are superseded by §5/§10's updated figures.

---

## 1. Complete operation counts

| | Before (seed) | After (real introspection) |
|---|---|---|
| Total operations | 16 | **810** |
| Queries | 3 | 287 |
| Mutations | 13 | 523 |
| Domains recognized | 7 (+ "general" catch-all) | **28** named domains + an honest `other_unknown` residual |
| `other_unknown` share | 467/810 would have been ~58% under the old classifier | **10/810 (1.2%)** under the new one |
| Per-operation scope data | 16/16 hand-curated | 810/810 classified; 319 "high" confidence, 252 "inferred," 239 "unknown" (Shopify's schema exposes no scope data at all — see §3) |
| Per-operation safety classification | 0 (safety didn't exist as a concept) | 810/810 classified across risk tier, reversibility, and interaction requirement |

Regenerated from real introspection against the connected dev store (`jefe-local-store.myshopify.com`), API version `2026-07`, this session. The seed is preserved at `app/lib/shopify/api/catalogs/shopify-admin-api-2026-07.seed-16op.json` for comparison; the real, fully-classified catalog is now the live file at its canonical path.

---

## 2. Domain taxonomy

`app/lib/shopify/api/domain-taxonomy.server.js` replaces the old 7-bucket `inferDomain()` (a first-match `.includes()` chain that dumped 58% of real operations into `"general"`) with an ordered, ~35-rule pattern classifier covering 28 domains: `products, variants, collections, inventory, inventory_transfers, customers, customer_segments, discounts_promotions, orders, fulfillment, returns, refunds, draft_orders, order_edits, content, navigation, markets_international, marketing, publishing_channels, metafields, metaobjects, subscriptions, gift_cards, b2b_company, app_platform, privacy_compliance, financial_payment, other_unknown`.

Real distribution (810 operations):

| Domain | Count | | Domain | Count |
|---|---|---|---|---|
| app_platform | 125 | | draft_orders | 18 |
| financial_payment | 78 | | returns | 18 |
| subscriptions | 62 | | metaobjects | 15 |
| discounts_promotions | 57 | | customer_segments | 14 |
| b2b_company | 39 | | metafields | 13 |
| fulfillment | 38 | | order_edits | 13 |
| products | 34 | | gift_cards | 12 |
| collections | 30 | | variants | 12 |
| marketing | 28 | | privacy_compliance | 11 |
| markets_international | 27 | | **other_unknown** | **10** |
| content | 26 | | refunds | 2 |
| customers | 24 | | | |
| inventory | 23 | | | |
| inventory_transfers | 23 | | | |
| orders | 20 | | | |
| publishing_channels | 19 | | | |
| navigation | 19 | | | |

The remaining 10 `other_unknown` operations (`app`, `publicApiVersions`, `fileAcknowledgeUpdateFailed`, `fileCreate/Delete/Update`, `tagsAdd/Remove`, `taxAppConfigure`, `taxSummaryCreate`) are genuinely cross-cutting or infrastructure-shaped — an honest residual, not a classification failure (`tagsAdd`/`tagsRemove` in particular operate on many different resource types via a generic `resourceId`, and are correctly left unclassified rather than forced into one).

This taxonomy exists for retrieval, reasoning, observability, and safety policy — **never** for recommendation quotas. Nothing in the candidate-discovery prompt or pipeline references domain balance; `buildCandidateDiscoverySystemPrompt()` is unchanged from the prior investigation's finding that it already reasons over evidence without a category constraint.

---

## 3. Scope inference — and its structural limit

**Shopify's GraphQL schema introspection carries no OAuth scope information at all.** Verified directly: of 810 real operation descriptions, only 14 mention the word "scope," and none in a parseable "requires scope X" form. This means scope can never be *derived* from the schema — it has to come from a separate source, and the honesty of that source matters more than its completeness.

`inferShopifyOperationScopes()` maps **domain → scope pair**, sourced from Shopify's own public Admin API scope documentation (not guessed), with a small number of name-pattern overrides for domains that legitimately span several distinct scopes (fulfillment alone has at least four: assigned/merchant-managed/third-party/marketplace fulfillment orders). Every operation carries a `scopeConfidence`:

- **`high`** (319 ops) — a domain maps cleanly to one Shopify scope pair, or a name-pattern override applies confidently.
- **`inferred`** (252 ops) — a reasonable mapping, not Shopify-confirmed (e.g. collections riding `write_products`, which is correct but not spelled out in Shopify's scope docs the way `write_orders` → orders is).
- **`unknown`** (239 ops) — domains that genuinely span multiple scopes we haven't sub-classified (`app_platform`, most of `financial_payment`, `metafields` in general — a metafield's real scope depends on which resource it's attached to), or the 10 `other_unknown` operations.

**`unknown` is a first-class, load-bearing state, not a placeholder.** `evaluateOperationSafety()` in `gateway.server.js` denies any mutation with `scopeConfidence: "unknown"` outright (`DENIED_UNSAFE_SEMANTICS` / `scope_requirement_unknown`), regardless of what `requiredScopes` says — an empty array must never be read as "no scope needed" when the truth is "we don't know." This is enforced at the schema level too: `validateShopifyApiCatalog()` rejects any catalog where a mutation has `scopeConfidence: "unknown"` and `execution.status: "EXECUTABLE"` — that combination cannot exist even by mistake.

Reads are exempt from this gate (`§8` below) — a query cannot mutate merchant state, and the gateway separately re-verifies real granted scopes live, for every operation, before admitting it.

---

## 4. Retrieval architecture

`retrieveShopifyApiOperations()` (`app/lib/shopify/api/retrieval.server.js`) was already domain-agnostic token-scored search with a `domains` filter — it needed no rewrite to work across 810 operations. Two real problems surfaced once the catalog grew, both fixed at the source rather than by tuning weights:

1. **Raw Shopify schema descriptions are full markdown docs with embedded `shopify.dev` links**, repeated across every operation (`docs`, `api`, `admin`, `graphql`, `objects`...). Left raw, this boilerplate drowned real signal in the scorer — `collectionCreate` failed to rank in the top 5 for "create a collection and add products" because `productCreate`/`productBundleCreate` shared just as many boilerplate tokens. Fixed by `cleanShopifyDescription()` in `generation.server.js`: strip markdown link syntax and URLs, keep the first real sentence, cap at 320 characters. This also meaningfully shrinks the token cost of every retrieved stub in Luna's prompt — the same fix improves both retrieval quality and context economy.
2. **No stopword filtering or singular/plural normalization** meant "and"/"for" inflated unrelated scores, and a domain id like `"collections"` never matched the query token `"collection"`. Fixed with a small stopword list and a conservative internal-only singularization in `tokenize()`.
3. **`app/lib/shopify/api/query-expansions.server.js`** generalizes the synonym-expansion pattern already proven in the older `capabilities/search.server.js` (`SEMANTIC_QUERY_EXPANSIONS`) to the full taxonomy — ~45 phrase-to-terms mappings ("declining repeat purchase" → customer/segment/order; "shortage" → inventory/replenishment/transfer) so Luna's natural-language questions retrieve the right domain's operations even without exact keyword overlap. Keyword expansion, not embeddings — consistent with the rest of this codebase's engineered, inspectable search.

Retrieval remains a **context/token optimization, not an eligibility filter** — an operation omitted from one `retrieve_shopify_operations` call is never removed from the catalog and remains discoverable on a later query with different wording.

**Validated against 18 merchant-intent queries spanning every required domain** (`tests/shopify-api-catalog-full.test.mjs`, "Finish & Harden" Part 6 — customer, discount, fulfillment, returns, markets, storefront/content, inventory, publishing): all 18 pass. Two real gaps were found and fixed while validating this, not hypothetically — "orders waiting too long to **fulfil**" (British spelling; the catalog's own vocabulary is American "fulfillment") and "product **discovery**" (no term connected the word to collections/merchandising) both missed their expected domain until `fulfil`/`fulfilment` and `discovery` were added to the expansion table.

---

## 5. Mutation safety architecture (audited and hardened 2026-08-24)

`app/lib/shopify/api/mutation-safety.server.js` classifies every operation across three dimensions (`RISK_TIER`, `REVERSIBILITY`, `INTERACTION`) and one top-line gate (`EXECUTION_STATUS`), in four priority-ordered layers — each `EXECUTABLE`/`EXECUTABLE_WITH_CONFIRMATION` result now also carries an `execution.classificationSource` naming which layer produced it:

1. **Explicit named prohibitions** (`PROHIBITED_OPERATIONS`, 8 operations: `appUninstall`, `appRevokeAccessScopes`, `customerCancelDataErasure`, `customerRequestDataErasure`, `bulkOperationRunMutation`, `themeFilesUpsert`, `disputeEvidenceUpdate`, `transactionVoid`) — always `PROHIBITED`, regardless of scope, evidence, or merchant approval. Visible to Luna's reasoning, permanently denied at the gateway.
2. **Known-good overrides** (`KNOWN_GOOD_OVERRIDES`, 11 operations, source `EXPLICIT_KNOWN_GOOD` or `EXPLICIT_OPERATION_OVERRIDE`) — seeded verbatim from the live `ACTION_REGISTRY` (2 operations, `EXPLICIT_KNOWN_GOOD` — a real built adapter, live in production) and the curated 14-operation capability manifest (9 more, `EXPLICIT_OPERATION_OVERRIDE` — reviewed and risk-understood, no adapter yet).
3. **Reviewed family policies** (`REVIEWED_FAMILY_POLICIES`, source `REVIEWED_OPERATION_FAMILY_POLICY`) — a small, human-curated table of `(domain, name-shape) → policy`, each with its own written justification. **This replaced a genuine bug found in this audit** (see below) and is the actual "cheaper than 523 adapters" mechanism — three named families today: `collections-metadata-v1` (`collectionUpdate`/`ReorderProducts`/`RemoveProducts`), `metaobjects-data-v1` (`metaobjectCreate`/`Update`/`Upsert`), `navigation-structure-v1` (`menuCreate`/`Update`). Each excludes its family's `*Delete` sibling by construction.
4. **Structural defaults** — by construction, this layer can only ever return `UNSUPPORTED_SEMANTICS` (or, for reads, `EXECUTABLE` under the broadly-available-reads policy, §8). It may sharpen risk/reversibility *metadata*, but it cannot flip `execution.status` to something attemptable — enforced both in the classifier's control flow and as a hard invariant in `catalog.server.js`'s validator (rejects any catalog where an executable result traces to `STRUCTURAL_NAME_INFERENCE`).

### The bug this audit found and fixed

The version of this classifier shipped earlier the same day had a fifth, implicit layer: any mutation matching `/update|create$|add|set|activate$/i`, on a domain with a "high"-confidence scope, was promoted straight to `EXECUTABLE_WITH_CONFIRMATION` — no human review. **Audited: 47 of the 56 attemptable mutations (84%) reached that status this way**, including `giftCardCreate`, `giftCardDeactivate`, `marketCreate`, and `locationDeactivate` — none reviewed. That is precisely what the "operation-name similarity alone must not grant production write authority" invariant forbids. It's gone; layer 3 above (individually justified, narrow families) replaces the role it played.

### Real distribution, post-audit (810 operations, 523 mutations)

| `execution.status` | Count (all ops) | Count (mutations only) |
|---|---|---|
| `EXECUTABLE` | 283 | 2 |
| `EXECUTABLE_WITH_CONFIRMATION` | 16 | 16 |
| `UNSUPPORTED_SEMANTICS` | 503 | 497 |
| `PROHIBITED` | 8 | 8 |

Classification source, every `EXECUTABLE`/`EXECUTABLE_WITH_CONFIRMATION` result (299 total — 283 reads + 16 mutations):

| Source | All | Mutations only |
|---|---|---|
| `EXPLICIT_KNOWN_GOOD` | 2 | 2 |
| `EXPLICIT_OPERATION_OVERRIDE` | 8 | 8 |
| `REVIEWED_OPERATION_FAMILY_POLICY` | 289 | 8 |
| `STRUCTURAL_NAME_INFERENCE` | **0** | **0** |

**`STRUCTURAL_NAME_INFERENCE: 0` is the headline number** — every single executable operation, mutation or read, traces to an explicit human decision. Only 18 of 523 mutations (3.4%) are attemptable at all today; the rest are `UNSUPPORTED_SEMANTICS` by honest default, including every order-edit, return, refund, discount, and draft-order operation not yet individually reviewed. Full domain-by-domain breakdown in `docs/ops/mutation-safety-classifier-audit-2026-08-24.md`.

### The gateway enforcement point

`executeShopifyOperation()` in `gateway.server.js` runs one new check inside the `MUTATION` branch, before the pre-existing accepted-Action/revision checks:

```
PROHIBITED                                → DENIED_PROHIBITED_OPERATION (permanent, no override path)
scopeConfidence !== "high"                → DENIED_UNSAFE_SEMANTICS (scope_requirement_unknown) — tightened from
                                              "unknown only" to "must be high" (task Part 2.3: "inferred" is not
                                              enough for production write authority)
UNSUPPORTED_SEMANTICS                     → DENIED_UNSAFE_SEMANTICS (unsupported_execution_semantics)
interaction === EXPLICIT_HIGH_RISK_...    → NEEDS_EXPLICIT_CONFIRMATION (no confirmation UI built yet — fails closed)
otherwise                                 → proceeds to the existing accepted-Action / blast-radius / intent checks, unchanged
```

The scope invariant is enforced **twice**, independently: once inside `mutation-safety.server.js`'s own `result()` helper (downgrades to `UNSUPPORTED_SEMANTICS` before the classification ever leaves that module), and again at the gateway. Belt-and-suspenders deliberately — neither enforcement point depends on the other being correct. `tests/mutation-safety-classifier-audit.test.mjs` and `tests/shopify-eval-mode-isolation.test.mjs` cover both.

Nothing about the pre-existing guarantees changed: idempotency, live scope verification, accepted-Action/revision matching, the blast-radius cap, and the destructive/pricing/inventory intent-drift checks are exactly as they were.

**What's honestly still missing**: a real merchant-facing confirmation UI for the `EXPLICIT_HIGH_RISK_CONFIRMATION_REQUIRED` interaction tier — `hasExplicitHighRiskConfirmation()` always returns `false`, so `inventoryTransferCreate`, `orderEditBegin`, `fulfillmentCreate`, `discountCodeBasicCreate`, and `customerUpdate` can't execute yet even with an accepted Action. That's a real next build, not a gap this task closes.

---

## 6. Discovery/execution separation in the live pipeline

`buildOpportunitySurface()` (`recommendation-agent.server.js`) now groups by the real 28-domain taxonomy instead of the old 7 buckets, and every family reports:

- `capabilityState`: `"available"` only if at least one mutation in the family is both scope-satisfied (live grant, or the eval-mode assumption — §7) **and** gateway-attemptable (`EXECUTABLE`/`EXECUTABLE_WITH_CONFIRMATION`).
- `executionSummary`: a count rollup (`executable`, `executableWithConfirmation`, `unsupportedSemantics`, `prohibited`) so Luna and any future observability surface can see *why* a family isn't attemptable — a scope gap ("grant this permission") versus a safety-classification gap ("no scope would fix this") are now distinguishable, per the standing product principle that "adding a scope cannot solve a missing capability implementation."
- Every domain with at least one mutation is **always** represented, regardless of capability state — discovery is unconditional, matching task §7's "an operation omitted from one retrieval result must remain discoverable" and §2's requirement that `UNSUPPORTED_SEMANTICS` never removes an operation from Luna's reasoning universe.

`initCoverageLedger()`'s non-executable reason text now distinguishes the two cases explicitly (`nonExecutableReason()`) rather than always saying "required write scopes not granted," which was actively misleading for a family blocked entirely by safety classification (e.g. `refunds`, `returns` — every operation `UNSUPPORTED_SEMANTICS`, independent of any scope grant).

---

## 7. The eval-mode flag — `assumeAllScopesGranted`

For controlled capability evaluation ("if permissions were not the constraint, what could Jefe discover and propose?"), `buildOpportunitySurface()`, `buildRecommendationContext()`, `generateAgenticShopifyRecommendation()`, and `runCandidateDrivenRecommendation()` all accept an optional `assumeAllScopesGranted: boolean` (default `false`). Set `true`, it bypasses only the *scope* check — it can never make a `PROHIBITED` or `UNSUPPORTED_SEMANTICS` operation look available (tested directly in `tests/shopify-eval-mode-isolation.test.mjs`). Scope and safety are separate axes; this flag only ever touches one of them.

**Structural isolation from production**, stronger than "defaults to false": `assumeAllScopesGranted` does not exist as a concept anywhere in `recommendation-service.server.js` (the production, DB-writing service layer the merchant-facing "Generate another proposal" button calls) or in `gateway.server.js` (the actual write executor) — verified by a source-grep regression test, not just a default-parameter convention. The eval script (`scripts/eval-full-capability-recommendation.mjs`) calls the lower-level `runCandidateDrivenRecommendation()` directly, in-memory, bypassing the production service layer entirely. There is no code path — not a flag left on, not an env var, not a config value — by which this assumption could reach a real merchant's execution.

---

## 8. Reads

287 queries, broadly available per task §12: `classifyShopifyOperationSafety()`'s QUERY branch defaults every read to `EXECUTABLE` (283 of 287), with a narrow carve-out to `EXECUTABLE_WITH_CONFIRMATION` for reads touching specially restricted data (disputes, payment mandates, credit cards, tax exemptions, or the `privacy_compliance` domain — 6 operations). No bespoke per-query adapter is required for any of them; `retrieveShopifyApiOperations`/`call_shopify_operation` already work generically over the whole read surface. This is what gives Luna's investigation phase real reach: 283 read operations across every domain, not the 3 the seed catalog exposed.

---

## 9. Multi-step workflows

Order edits, returns, and fulfillment are genuinely multi-mutation protocols in Shopify's real schema (`orderEditBegin → orderEditAddVariant/orderEditAddCustomItem/... → orderEditCommit`; `returnRequest/returnCreate → returnApproveRequest → returnProcess → returnRefund`; `fulfillmentOrderHold/AcceptFulfillmentRequest → fulfillmentCreate`). The execution loop itself is already general enough to represent them — `execution-agent.server.js`'s `runAgenticShopifyExecution()` is a plain multi-turn tool-calling loop (up to `MAX_EXECUTION_ITERATIONS = 10`) with no per-operation-count limit; nothing about its structure assumes a single mutation per Action.

**The actual current gap is one layer earlier, in safety classification, not in the execution loop or the accepted-intent keyword checks.** Verified directly: `orderEditBegin` reached `EXECUTABLE_WITH_CONFIRMATION` (it's in the known-good override table, seeded from the curated manifest), but `orderEditAddVariant` and `orderEditCommit` — the very next steps of the *same* workflow — resolve to `UNSUPPORTED_SEMANTICS`, because the `order_edits`/`returns`/`draft_orders`/`refunds`/`discounts_promotions` domains are deliberately excluded from the generic "simple write" promotion path (§5) — any mutation touching money or order state requires a human override before it's structurally attemptable, regardless of how simple its name looks. The same is true across the whole `returns` and `fulfillment` families: only the family's first-mentioned operation (if any) is in the override table; the rest default-deny. This means a real order-edit or return workflow cannot complete today even once accepted — not because the execution loop or the destructive/pricing keyword drift-check in `evaluateAcceptedIntent()` rejects the follow-up calls, but because they're denied one step earlier, at the safety gate, before intent-checking is ever reached.

**This is the right conservative default for a first pass** — money-adjacent multi-step workflows are exactly where a human should curate the whole sequence's risk/reversibility together (a return isn't safe merely because each individual mutation looks reversible in isolation; the workflow's *net effect* is what matters) rather than letting generic per-operation rules piece it together. The concrete next step (not done in this pass) is a **workflow-level override** — analogous to `KNOWN_GOOD_OVERRIDES` but keyed on a *sequence* rather than a single operation, reviewed and curated the same way `price_markdown`/`tidy_up` were, for the highest-value multi-step candidates identified in the companion scope-and-capability report (order edits, returns).

---

## 10. Before/after recommendation evaluation

Re-ran the candidate-driven pipeline for the same real dev merchant whose actual exhaustion the prior investigation captured (`merchantId 1c435ded-...`, `shopId c02236e8-...`), using `scripts/eval-full-capability-recommendation.mjs` — the full 810-operation catalog, `assumeAllScopesGranted: true`, a real Gemini call, and the merchant's real Merchant Memory snapshot (no live Shopify call; reads are stubbed generically since this evaluates capability/coverage, not data fidelity).

**BEFORE** (16-op catalog, captured in the companion report from real `MerchantPlanRun` rows):
```
16 operations visible, 7 domains (58% of the real surface would have been "general")
Candidates per run: 5-6, all investigated with real Shopify reads
Domains reached: products, inventory, customers (diagnosed, not executed)
Final recommendations: 1 of 3 real runs recommended (productUpdate — draft a dead product)
Exhaustion point: every non-product candidate died on NON_EXECUTABLE — "no Shopify write
  operation implements this" — even for candidates whose required scope was already granted
  (capture-variant-costs needed inventoryItemUpdate, which the 16-op catalog simply didn't have)
```

**AFTER** (810-op catalog, `assumeAllScopesGranted: true`, real Gemini/OpenAI calls against the same merchant's real Merchant Memory snapshot, via `scripts/eval-full-capability-recommendation.mjs`; full machine-readable trace in `docs/ops/eval-full-capability-recommendation/`):

```
810 operations visible, 28 domains
Candidates discovered: 6 (first pass), 0 novel (rescue pass) — same materiality ceiling as
  before: Luna proposes a genuinely diverse set once, and correctly declines to pad the queue
  with restated ideas on rescue, matching the "do not fabricate a candidate merely to fill the
  queue" instruction.
Domains reached in diagnosis: products/inventory (cost coverage), orders (basket breadth,
  selling cadence), customers (identity-capture measurement), collections/merchandising
  (homepage feature placement)
Final recommendation: none — but for a materially different, more honest reason than before
  (see the capture-product-costs story below), not because the search gave up early.
```

**A real retrieval bug was found and fixed via this eval, live, in this pass** — worth recording as the clearest evidence this architecture change actually works end-to-end, not just in isolated unit tests. First run: `capture-product-costs` (the same candidate that blocked the original 16-op-catalog merchant in the companion report) resolved to `NON_EXECUTABLE` with reason *"the bound Shopify operation catalogue contains no safe mutation for setting a variant's cost per item"* — **even though `inventoryItemUpdate` (which sets exactly this) was now in the 810-op catalog with a granted scope.** Diagnosis: the server-side capability-binding query for this candidate scored generic `product`/`productVariant` operations above `inventoryItemUpdate` — the query-expansion table (§4) had `"margin"` and `"cost of goods"` as trigger phrases but not the bare word `"cost"`, which is what this candidate's diagnosis actually used. Added `cost → inventory item` to `query-expansions.server.js`, confirmed locally (`inventoryItemUpdate` moved from unranked to the top 8 for the same query), and **re-ran the same real merchant** — `capture-product-costs` now correctly resolves to `BLOCKED_BY_EVIDENCE`: *"the successful `inventoryItems` read returned `unitCost: null`... [the mutation] exists, [but] populating costs without merchant-supplied cost values..."* — an accurate `EVIDENCE_MISSING` classification instead of a false `MISSING_SHOPIFY_CAPABILITY` one, for the exact same real candidate. This is the "operation exists, Luna can retrieve it, Luna can reason about it" chain from task §10 actually working, and it demonstrates the architecture's promised property directly: fixing a *generic* retrieval rule (one dictionary entry) immediately corrected classification for a *specific* real candidate, with no candidate-specific code written.

The other five candidates in the final run held up as genuine, correctly-classified findings, not retrieval artifacts:
- `restore-consistent-selling-cadence`, `increase-basket-breadth` — real `MISSING_SHOPIFY_CAPABILITY`: no Shopify Admin API mutation implements homepage-feature placement or cross-sell/basket-breadth merchandising (confirms the report 2 finding: this needs the `metafieldsSet` → Shopify-native recommendation-metafield semantic mapping, a `NEEDS_RUNTIME_SUPPORT` case, not a missing operation).
- `improve-repeat-customer-measurement` — real `SHOPIFY_API_LIMITATION`: the only bound customer write was `customerSendAccountInviteEmail` for one already-known customer; nothing configures store-wide checkout identity capture via the Admin API.
- `protect-demand-on-stockout-variants` — correctly `BLOCKED_BY_EVIDENCE`, limited by this eval harness's generic fixture reads rather than the real store's actual per-variant stock data (an eval-harness fidelity limit, not a finding about Jefe).

**What this confirms about the original question**: with the full real catalog and every scope assumed granted, this merchant's real recommendation search *still* does not produce an executable Action — not because Shopify or scope is the constraint anymore (both are now maximal by construction), but because the remaining candidates are genuinely `MISSING_SHOPIFY_CAPABILITY` (no such Admin API mutation exists), `SHOPIFY_API_LIMITATION` (checkout customization isn't an Admin API concern), or `EVIDENCE_MISSING` (Jefe doesn't have the merchant's actual cost data). **This is exactly the honest, capability-and-evidence-driven ceiling the companion reports predicted** — the 16-op catalog was hiding real capability (§1's `inventoryItemUpdate` finding); the full catalog now correctly separates "Shopify can't do this" from "Jefe doesn't have the input" from "nobody's told Jefe the actual number yet," instead of collapsing all three into one misleading `NON_EXECUTABLE`.

### 10.1 — Re-confirmed under the hardened classifier + refreshed Merchant Memory

Re-ran the same merchant a final time after §5's safety hardening (18 attemptable mutations, down from 74) and after triggering a full deterministic Merchant Memory rebuild to pick up the new RFM-segmentation/discount-intelligence belief definitions landed upstream (commit `10dcbda`). Result: **120 active beliefs** for this merchant (up modestly from ~114; the new RFM/discount-mix derivations exist in the registry but several are data-gated — this merchant's thin order/customer volume doesn't clear the coverage threshold for some of them, which the registry handles by suppression, not guessing).

The five surviving candidates were materially the same set, with the same correct dispositions — **the safety hardening removed 47 unreviewed mutations, none of which any real candidate from this merchant actually needed**, so tightening the classifier did not regress the earlier finding:

```
restore-consistent-selling-cadence    NON_EXECUTABLE       — MISSING_SHOPIFY_CAPABILITY (no recurring-merchandising primitive)
capture-product-costs                 BLOCKED_BY_EVIDENCE  — CAPABILITY_AVAILABLE_BUT_INPUT_MISSING (inventoryItemUpdate found and
                                                                bound; unitCost read back as null; the number itself is merchant-only input)
increase-basket-breadth               NON_EXECUTABLE       — CAPABILITY_AVAILABLE_BUT_EXECUTION_SEMANTICS_MISSING (needs the
                                                                metafieldsSet → cross-sell-metafield semantic mapping, not a missing operation)
improve-repeat-customer-measurement   NON_EXECUTABLE       — SHOPIFY_API_LIMITATION (checkout identity capture isn't Admin API territory)
protect-demand-on-stockout-variants   BLOCKED_BY_EVIDENCE  — inconclusive: limited by this eval harness's generic fixture reads,
                                                                not a finding about the real store; needs live-Shopify re-verification
```

Full trace: `docs/ops/eval-full-capability-recommendation/latest.json`.

### 10.2 — Domain funnel, before vs. after (real numbers, not claimed)

No explicit `category`/domain field exists on a recommendation or candidate (confirmed in the companion report) — the funnel below is built from each candidate's `diagnosedProblem`/`possibleIntervention` text and its ultimately-bound `feasibleWriteOperations`' domain, read directly off the real runs captured in this and the companion report. Two real runs, same merchant, same evidence tier (companion report's exhausted runs vs. this task's final re-run):

```
BEFORE (16-op catalog, 3 real MerchantPlanRun rows, companion report)
  candidate discovery:            products/inventory 3/6 (50%), customers 2/6 (33%), cross-sell 1/6 (17%)
  verified executable candidates: products 1/1 (100%) — the only recommendation that ever survived

AFTER (810-op catalog, hardened classifier, this task's final re-run)
  candidate discovery:            inventory/cost 1/5 (20%), orders/basket-breadth 1/5 (20%),
                                   orders/cadence 1/5 (20%), customers 2/5 (40%)
  operations retrieved:           spans inventory, products, orders, customers domains (not just products)
  execution-eligible (scope+safety both satisfied): inventoryItemUpdate only, among the operations
                                   these 5 candidates actually needed
  final recommendations:          0 — but for domain-diverse, individually-classified reasons
                                   (capability/input/evidence/limitation), not a collapsed "no capability"
```

**Has the product-heavy behaviour materially changed?** Discovery-time diversity: yes, clearly — candidates now span inventory, orders, and customers with no single domain dominating, versus the near-total products/inventory concentration before. Whether a *recommendation* (not just a candidate) is domain-diverse remains untested by this one merchant, because none of the 5 final candidates happened to clear both capability and evidence for this specific merchant's specific data — that's an evidence-and-capability ceiling for *this store*, not a sign the search collapsed back to products. The one candidate that reached `BLOCKED_BY_EVIDENCE` rather than `NON_EXECUTABLE` (`capture-product-costs`) is the concrete proof the ceiling moved: same merchant, same evidence, different (correct) answer once the real capability was visible.

---

## 11. Remaining intelligence gaps (Merchant Memory side) — empirical backlog, not a new tranche

No new beliefs were implemented in this task, per its explicit instruction. This section classifies every candidate this task's real evaluations actually surfaced, using the task's taxonomy, so the *next* Merchant Memory tranche is picked from evidence rather than guessed:

| Candidate | Classification | Why |
|---|---|---|
| `capture-product-costs` | `CAPABILITY_AVAILABLE_BUT_INPUT_MISSING` | `inventoryItemUpdate` exists, is bound, scope is granted — the blocker is a merchant-only number (actual cost per item), not something Jefe can derive or infer. This is an **intake-flow gap** (ask the merchant), not a belief-derivation gap. |
| `increase-basket-breadth` / `restore-consistent-selling-cadence` | `CAPABILITY_AVAILABLE_BUT_EXECUTION_SEMANTICS_MISSING` | The raw mutation (`metafieldsSet`) exists and is bound; what's missing is the semantic mapping to Shopify's native cross-sell/recommendation metafield namespace. This is a **runtime engineering task**, not a Merchant Memory gap. |
| `improve-repeat-customer-measurement` | `SHOPIFY_API_LIMITATION` | Checkout identity capture isn't Admin API territory at all. No belief tranche fixes this. |
| `protect-demand-on-stockout-variants` | inconclusive (harness artifact) | Needs re-verification against real Shopify reads, not this eval script's generic fixture data, before it can be classified. |

**Empirical answer to "which Merchant Memory domains does this evaluation say we need next"**: for *this* real merchant (thin catalog, 50 orders, 0% customer-identity linkage), **none** of the five highest-priority candidates Luna actually surfaced were blocked by missing fulfillment, returns, markets, or publishing/channel beliefs — none of those domains appeared in the candidate queue at all across two independent discovery passes (first pass + rescue). The candidates that *did* surface were gated by **input** (cost data), **execution semantics** (cross-sell mapping), and one genuine **API limitation** (checkout identity) — none of which a new belief tranche would fix. This is a real, if narrow, empirical result: **for this merchant, more Merchant Memory breadth is not the next highest-leverage investment; an intake flow for merchant-supplied inputs (starting with cost-per-item) and the metafield semantic-mapping runtime work are.**

This is one merchant's signal, not a universal claim — the companion report separately confirmed zero deterministic belief coverage for promotions/discounts, storefront/content, and Shopify Markets across the codebase generally (a structural gap, not merchant-specific), and Task 2's new RFM/discount-mix beliefs exist but were data-gated for this specific merchant's volume. Re-running this same evaluation against a higher-volume fixture merchant (e.g. `scripts/answer-quality/fixtures.mjs`'s `garden-centre-pos` archetype) would be the natural next step to get a second, independent data point before committing to a tranche — flagged as a good next move, not done here (out of this task's explicit scope).

```
discount capability exists (discountCodeBasicCreate, now discoverable and scope-known)
but no real candidate this merchant's evidence produced actually needed it
→ INTELLIGENCE_GAP, unconfirmed by this merchant's data — worth testing against a
  promotions-heavy fixture merchant before prioritizing
```

---

## 12. What this task did not do (honest scope boundary)

- **OAuth scope expansion was applied 2026-08-24, after the founder confirmed directly in conversation** (recorded in `CLAUDE.md` → "OAuth scope authorization record"). Two prior task documents claimed pre-approval inside the document itself and were declined for that reason; the actual application only happened once the confirmation came from the user, not from a document. `shopify.app.toml`/`shopify.app.staging.toml`/`SCOPES` now declare 72 scopes (up from 11) — see `docs/shopify-full-scope-audit.md` for the full before/after, what's still pending genuine Shopify-side approval, and what was deliberately excluded. Declaring the scope doesn't grant it to any existing merchant — that still requires per-merchant re-consent, unaffected by this change.
- **Did not build a merchant-facing high-risk-confirmation UI.** `EXPLICIT_HIGH_RISK_CONFIRMATION_REQUIRED` operations fail closed until that surface exists.
- **Did not build a workflow-level override for order edits/returns/fulfillment.** Documented as the concrete next step in §9.
- **Did not fully sub-classify scope for `app_platform`, `financial_payment`, or generic `metafields`** — 239 operations remain `scopeConfidence: "unknown"` by honest design; extending the domain→scope table for these is straightforward incremental work, not a redesign.
