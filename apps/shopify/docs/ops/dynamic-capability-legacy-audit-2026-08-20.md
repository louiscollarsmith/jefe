# Dynamic Capability Legacy Audit — 2026-08-20

## Acceptance Result

New Merchant Plan recommendation discovery no longer shapes opportunities by legacy business refs such as `execute:shopify_inventory_transfer:restock`, `execute:price_markdown:dead_stock` or `execute:listing_copy:missing_product_type`.

The discovery path is:

1. Merchant Memory beliefs and canonical Shopify records produce store-condition text.
2. Store-condition text searches the Shopify capability catalogue.
3. The matched provider manifest supplies required scopes, semantic effects and qualification requirements.
4. Existing typed executors dry-run the concrete mutation preview.
5. The manifest qualification evaluator admits or rejects the opportunity before Luna sees it.
6. Candidate IDs are provider-capability IDs with a proposal-shape hash, not old business-use-case IDs.

`tests/shopify-capability-catalog.test.mjs` has a regression test that fails if the candidate builder reintroduces old `execute:*:*` branch shaping or old business opportunity IDs.

## Remaining Legacy References

| Location | Classification | Why it remains |
| --- | --- | --- |
| `app/lib/actions/action-intent.server.js` | Technical executor adapter registry | Maps Jefe action types to deterministic adapters, feature flags and provider capability refs. This is the executor binding used after dynamic discovery has selected and qualified a provider capability. |
| `app/lib/actions/action-resolution.server.js` | Technical executor adapter | Contains resolver implementations for existing adapters, including clearance, product status/listing-copy and inventory transfer. These build typed previews and execution summaries; they do not select business opportunities for Luna by old IDs. |
| `app/lib/merchant-plan/schema.server.js` | Historical/backward compatibility guard | Detects inventory-transfer execute steps so validation can prevent merchant purchase-order prerequisites and approval-as-merchant-work regressions in existing workflow plans. |
| `app/lib/actions/action-replanner.server.js` | Historical/backward compatibility guard | Normalises existing focused-action workflows and refuses unsupported purchase-order substitutions. It is runtime workflow repair, not Merchant Plan opportunity discovery. |
| `app/lib/actions/action-workspace.server.js` | Historical/backward compatibility projection | Projects legacy workflow rows into the V2 Action Workspace and labels old capability refs for display/state repair. |
| `app/lib/actions/shopify-action-capabilities.server.js` | Capability-truth compatibility layer | Keeps old action-capability truth rows linked to discovered provider manifests for existing action-chat capability checks. |
| `tests/**` | Fixtures/regressions | Existing action-runtime tests still use old capability refs because the execution adapters and stored workflow rows are backward-compatible. |

## Current Boundary

Old business-use-case refs may still appear in stored workflows, tests and adapter binding tables. They must not be used to decide which new recommendation opportunity exists. New recommendation discovery is enforced through the provider capability catalogue and manifest qualification before model planning.
