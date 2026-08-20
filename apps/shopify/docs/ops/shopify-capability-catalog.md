# Shopify Capability Catalog

Catalog: `shopify-capabilities:2026-07`

API version: `2026-07`

Machine-readable source: `app/lib/shopify/capabilities/catalogs/shopify-capabilities-2026-07.json`

| Operation | Semantic effect | Write | Scope | Jefe support | Approval | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `productUpdate` | changes mutable product catalogue fields such as title, status, vendor, taxonomy, handles, options and descriptive metadata | yes | `write_products` | PARTIAL | MEDIUM | REQUIRES_APPROVAL |
| `productVariantsBulkUpdate` | changes product variant fields such as price, option values, inventory policy or barcode for variants that belong to one product | yes | `write_products` | IMPLEMENTED | HIGH | REQUIRES_APPROVAL |
| `inventoryTransferCreate` | creates a Shopify transfer record for moving existing inventory quantities from one location to another | yes | `write_inventory_transfers` | IMPLEMENTED_FLAG_OFF | MEDIUM | REQUIRES_APPROVAL |
| `inventoryItemUpdate` | changes operational inventory attributes for an item, including whether Shopify tracks quantity and the item's unit cost | yes | `write_inventory` | NOT_IMPLEMENTED | HIGH | REQUIRES_APPROVAL |
| `inventoryActivate` | enables an inventory item to be managed at a specific location | yes | `write_inventory` | NOT_IMPLEMENTED | MEDIUM | REQUIRES_APPROVAL |
| `discountCodeBasicCreate` | creates a checkout discount code with eligibility, value, timing and usage constraints | yes | `write_discounts` | NEEDS_SCOPE_AND_ADAPTER | HIGH | HIGH_RISK |
| `collectionCreate` | creates a manual or rule-based grouping of products for merchandising and navigation | yes | `write_products` | NOT_IMPLEMENTED | MEDIUM | REQUIRES_APPROVAL |
| `orderEditBegin` | opens a calculated order edit session so later mutations can alter line items, discounts or shipping before commit | yes | `write_orders` | NOT_IMPLEMENTED | HIGH | HIGH_RISK |
| `fulfillmentCreate` | marks fulfillment-order line items as fulfilled and can notify customers with tracking information | yes | `write_merchant_managed_fulfillment_orders` | NEEDS_SCOPE_AND_ADAPTER | HIGH | HIGH_RISK |
| `customerUpdate` | changes customer profile data such as tags, notes, addresses or marketing-related fields | yes | `write_customers` | NOT_IMPLEMENTED | HIGH | HIGH_RISK |
| `metafieldsSet` | writes structured custom data onto Shopify resources for operational or storefront use | yes | `write_products` | NOT_IMPLEMENTED | MEDIUM | REQUIRES_APPROVAL |
| `inventoryItems` | reads inventory items and their tracking, SKU and location inventory relationships | no | `read_inventory` | CANONICAL_MIRROR_FIRST | LOW | SAFE_TO_SUPPORT |
| `locations` | reads Shopify locations used for inventory, fulfillment and transfer decisions | no | `read_locations` | CANONICAL_MIRROR_FIRST | LOW | SAFE_TO_SUPPORT |
| `products` | reads product catalogue, product status, taxonomy and variant relationships | no | `read_products` | CANONICAL_MIRROR_FIRST | LOW | SAFE_TO_SUPPORT |

## Architecture

Before this catalogue, Jefe's executable Shopify knowledge was centred on action/use-case identifiers such as `execute:price_markdown:dead_stock` and `execute:shopify_inventory_transfer:restock`. The new substrate separates the provider primitive (`productVariantsBulkUpdate`, `inventoryTransferCreate`) from Jefe's business use case, semantic interpretation and execution admission.

Runtime execution remains bounded: a capability can be discovered and semantically searched without becoming executable. Execution still requires an admitted manifest, required scopes, a Jefe executor, known inputs, approval/autonomy policy and the typed adapter path.

## Discovery

The deterministic development command is `npm run shopify:capabilities:discover`. It loads the versioned machine-readable catalogue, validates manifest structure, can compare optional Admin GraphQL introspection JSON supplied with `--introspection=path/to/schema.json`, and writes this report. The catalogue is tied to Shopify API version `2026-07`; a future API-version refresh should generate the new version beside this one, diff them, inspect changed operations, then migrate consumers.

## Capability Manifest

Each manifest keeps `technical` facts from Shopify's API contract separate from `semantic` interpretation. Technical facts include operation kind, input/output types, required arguments, user-error shape, scopes and deprecation. Semantic metadata carries provenance, effects, affected entities, qualification requirements, auto-resolvable inputs, merchant decisions, outcomes and retrieval tags.

## Versioning

`diffShopifyCapabilityCatalogs(previous, next)` reports added, removed and changed operations, including required scopes, argument contracts, input/output types, descriptions and deprecation. Consumers should resolve capabilities by stable provider refs plus API version, not by timeless mutation assumptions.

## Compatibility Boundary

The old action registry still exists as the typed executor binding layer. Current adapters are preserved as Jefe executors: `clearance-adapter` maps to `productVariantsBulkUpdate`, `product-status-adapter` and `listing-copy-adapter` map to safe subsets of `productUpdate`, and `inventory-transfer-adapter` maps to `inventoryTransferCreate`. Business target names such as `dead_stock`, `missing_product_type`, `stale_listing` and `restock` are no longer canonical Shopify capability definitions and are not used to shape new Merchant Plan opportunities. See `docs/ops/dynamic-capability-legacy-audit-2026-08-20.md`.

## Generalisation Proof

The catalogue includes previously unmodelled operations without operation-specific opportunity code: `discountCodeBasicCreate`, `collectionCreate` and `metafieldsSet` all have semantic manifests and qualification plans. Search can retrieve them from conditions such as promotion/conversion, messy navigation or custom structured metadata, but availability resolution correctly reports missing adapter/scope or high-risk admission before execution.

## Semantic Prompt

```text
You are analysing one Shopify Admin GraphQL operation.

The supplied schema and Shopify documentation are authoritative.

Explain the real-world commerce operation represented by this API.

Identify:
- what state it changes or reads,
- which Shopify entities it affects,
- what conditions logically need to be true for the operation to be useful,
- what evidence should be checked before proposing it,
- what inputs can likely be resolved automatically,
- what decisions may require merchant input,
- what outcomes could later be measured.

Do not invent Shopify functionality not present in the supplied API definition.
Do not map this operation to one hardcoded Jefe feature or recommendation.
Describe the capability generically.

Return JSON with semanticEffects, affectedEntities, requiredEntities, qualificationRequirements, autoResolvableInputs, merchantDecisionInputs, outcomes and tags.
```

## Inventory Transfer Qualification Proof

`inventoryTransferCreate` is admitted as a generic Shopify operation for moving existing stock between locations. Its manifest requires `inventory.source.available_quantity` to be a positive number. A shortage with zero stock anywhere therefore fails qualification before recommendation generation, while a shortage with stock at another location can qualify once identities and location differences are resolved. No operation-specific restock rule is needed; the conclusion follows from the manifest requirement and the generic qualification evaluator.

## Tests

`tests/shopify-capability-catalog.test.mjs` covers schema parsing, API-versioned catalogue validation, required inputs/scopes, semantic provenance, capability search, qualification-plan generation, authorization resolution, safe execution admission, catalogue diffing, legacy adapter bridging, three unmodelled operations, and the inventory-transfer source-stock distinction.

## Luna Evaluation

The final Luna semantic prompt is checked in above. This local run did not call live Luna because the test runner disables external LLM calls and no production merchant data or secrets are used. The handoff path is to run the same prompt against one operation at a time in a development-safe environment, compare output to official Shopify descriptions, and update the manifest only after validation.

## Failures Discovered

The first pass showed the report was too thin for operator handoff, so the generator now includes architecture, discovery, versioning, hardcoding, generalisation and Task 2 notes. The inventory-transfer proof also forced the source-stock requirement to be explicit in the manifest rather than hidden in restock-specific code.

## Recommendation Runtime

Recommendation generation retrieves candidate write capabilities with `searchShopifyCapabilities(condition, { writeOnly: true })`, builds qualification plans with `buildShopifyCapabilityQualificationPlan`, satisfies evidence requirements from the canonical mirror before bounded Shopify reads, then calls `resolveShopifyCapabilityAvailability` with declared scopes, merchant-granted scopes, API version and executor refs. Only qualified provider capabilities with an enabled executor binding are supplied to Luna as executable opportunities. Candidate IDs are provider-capability IDs with a proposal-shape hash, not old business-use-case IDs.
