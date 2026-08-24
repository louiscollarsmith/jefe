# Mutation Safety Classifier Audit — 2026-08-24

Produced per "Finish & Harden Jefe's Full Shopify Capability Surface," Part 1 & Part 2. Regenerate by loading `app/lib/shopify/api/catalogs/shopify-admin-api-2026-07.generated.json` and grouping `operations[]` by `execution.status` / `execution.classificationSource` / `scopeConfidence`.

## Finding: the original classifier was too permissive, and has been fixed

The classifier audited here is **not** the one shipped in the previous session. That version promoted any mutation matching `/update|create$|add|set|activate$/i` to `EXECUTABLE_WITH_CONFIRMATION` whenever its domain had a "high"-confidence scope — no human review required. Audited before this fix: **47 of 56 attemptable mutations (84%) reached that status through name-pattern matching alone**, including `giftCardCreate`, `giftCardDeactivate`, `marketCreate`, and `locationDeactivate` — none reviewed by a human. This is exactly the anti-pattern Part 1.3's invariant forbids ("operation-name similarity alone must not give an unknown Shopify mutation production write authority").

Fixed in `app/lib/shopify/api/mutation-safety.server.js`: the blanket name-pattern promotion is removed entirely. In its place, a new `REVIEWED_FAMILY_POLICIES` table holds a small number of individually-justified (domain, name-shape) family trust decisions — the "cheaper than 523 adapters, but never naming-alone" mechanism the brief asks for. Every operation now carries an `execution.classificationSource`, and the catalog validator (`catalog.server.js`) structurally rejects any `EXECUTABLE`/`EXECUTABLE_WITH_CONFIRMATION` result sourced from `STRUCTURAL_NAME_INFERENCE` — this can't regress silently.

## 1.1 — Execution-status distribution (810 operations, 523 mutations)

```
ALL OPERATIONS (810)
  EXECUTABLE                       283
  EXECUTABLE_WITH_CONFIRMATION      16
  UNSUPPORTED_SEMANTICS            503
  PROHIBITED                         8

MUTATIONS ONLY (523)
  EXECUTABLE                         2
  EXECUTABLE_WITH_CONFIRMATION      16
  UNSUPPORTED_SEMANTICS            497
  PROHIBITED                         8
```

Only **18 of 523 mutations (3.4%)** are attemptable at all — down from 58 (11%) under the old classifier. This is the intended, honest result: a mutation is only ever attemptable after an explicit human decision, and very few operations have had one yet.

### By domain (mutations only)

```
app_platform            executable:0  confirmation:0  unsupported:62  prohibited:4
b2b_company             executable:0  confirmation:0  unsupported:32  prohibited:0
collections             executable:0  confirmation:4  unsupported:13  prohibited:0
content                 executable:0  confirmation:0  unsupported:13  prohibited:0
customer_segments       executable:0  confirmation:0  unsupported:4   prohibited:0
customers               executable:0  confirmation:1  unsupported:15  prohibited:0
discounts_promotions    executable:0  confirmation:1  unsupported:37  prohibited:0
draft_orders            executable:0  confirmation:0  unsupported:12  prohibited:0
financial_payment       executable:0  confirmation:0  unsupported:43  prohibited:2
fulfillment             executable:0  confirmation:0  unsupported:31  prohibited:0
gift_cards              executable:0  confirmation:0  unsupported:8   prohibited:0
inventory               executable:0  confirmation:2  unsupported:13  prohibited:0
inventory_transfers     executable:0  confirmation:1  unsupported:18  prohibited:0
marketing               executable:0  confirmation:0  unsupported:18  prohibited:0
markets_international   executable:0  confirmation:0  unsupported:16  prohibited:0
metafields              executable:0  confirmation:1  unsupported:7   prohibited:0
metaobjects             executable:0  confirmation:3  unsupported:6   prohibited:0
navigation              executable:0  confirmation:2  unsupported:10  prohibited:0
order_edits             executable:0  confirmation:1  unsupported:11  prohibited:0
orders                  executable:0  confirmation:0  unsupported:14  prohibited:0
other_unknown           executable:0  confirmation:0  unsupported:8   prohibited:0
privacy_compliance      executable:0  confirmation:0  unsupported:6   prohibited:2
products                executable:1  confirmation:0  unsupported:18  prohibited:0
publishing_channels     executable:0  confirmation:0  unsupported:13  prohibited:0
refunds                 executable:0  confirmation:0  unsupported:1   prohibited:0
returns                 executable:0  confirmation:0  unsupported:12  prohibited:0
subscriptions           executable:0  confirmation:0  unsupported:49  prohibited:0
variants                executable:1  confirmation:0  unsupported:7   prohibited:0
```

Note `fulfillmentCreate` (the only fulfillment operation previously assumed executable) correctly falls back to `UNSUPPORTED_SEMANTICS`: Shopify has at least four distinct fulfillment-order scopes (assigned/merchant-managed/third-party/marketplace), and which one `fulfillmentCreate` actually needs is genuinely ambiguous without checking a specific fulfillment order's ownership — `scopeConfidence: "inferred"` correctly reflects that uncertainty rather than guessing.

## 1.2 — Classification source for every EXECUTABLE / EXECUTABLE_WITH_CONFIRMATION result

```
ALL (299 total: 283 reads + 16 confirmable mutations)
  EXPLICIT_KNOWN_GOOD                   2   (productUpdate, productVariantsBulkUpdate — live typed adapters)
  EXPLICIT_OPERATION_OVERRIDE           8   (individually reviewed, seeded from the curated capability manifest)
  REVIEWED_OPERATION_FAMILY_POLICY    289   (283 reads under the "reads are broadly available" policy [task §12],
                                              6 sensitive reads under a narrower carve-out, 8 mutations under 3
                                              named, individually-justified mutation family policies)
  STRUCTURAL_NAME_INFERENCE             0

MUTATIONS ONLY (18 total)
  EXPLICIT_KNOWN_GOOD                   2
  EXPLICIT_OPERATION_OVERRIDE           8
  REVIEWED_OPERATION_FAMILY_POLICY      8
  STRUCTURAL_NAME_INFERENCE             0
```

**`STRUCTURAL_NAME_INFERENCE: 0` is the headline result** — no operation is executable merely because its name looks benign. The `catalog.server.js` validator makes this a structural invariant, not just an audit snapshot: it rejects any catalog where an `EXECUTABLE`/`EXECUTABLE_WITH_CONFIRMATION` result traces to `STRUCTURAL_NAME_INFERENCE`.

The 8 family-policy mutations, and their reviewed justification, are the three policies in `REVIEWED_FAMILY_POLICIES`:
- **`collections-metadata-v1`** (`collectionUpdate`, `collectionReorderProducts`, `collectionRemoveProducts`) — merchandising groupings, not money/identity; reversible; same risk shape already reviewed for `collectionCreate`/`collectionAddProducts`.
- **`metaobjects-data-v1`** (`metaobjectCreate`, `metaobjectUpdate`, `metaobjectUpsert`) — merchant-defined custom data, no built-in financial/identity semantics, reversible.
- **`navigation-structure-v1`** (`menuCreate`, `menuUpdate`) — site navigation, no financial/customer data, reversible.

Each family's `*Delete`/`*BulkDelete` siblings are excluded by the match pattern and fall through to the destructive-name path (`UNSUPPORTED_SEMANTICS`), unreviewed.

## 2.1 — Scope confidence distribution

```
ALL OPERATIONS (810)
  high         349
  inferred     222
  unknown      239

MUTATIONS ONLY (523)
  high         230
  inferred     157
  unknown      136
```

## 2.3 — Production execution invariant (enforced, not just documented)

`mutation-safety.server.js`'s `result()` helper enforces this directly: **any classification that would be `EXECUTABLE`/`EXECUTABLE_WITH_CONFIRMATION` is downgraded to `UNSUPPORTED_SEMANTICS` unless `scopeConfidence === "high"`** — "inferred" is real signal for discovery/reasoning/evaluation, never sufficient on its own for write authority. This is why `collections` domain was re-classified from `"inferred"` to `"high"` (Shopify's own scope docs explicitly list collections under `write_products` — a documented mapping, not a guess) rather than simply exempted from the check. `catalog.server.js`'s validator makes the same rule a structural catalog-shape invariant. See `tests/mutation-safety-classifier-audit.test.mjs` for the regression tests proving both enforcement points.
