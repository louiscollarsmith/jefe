# Action Capability Registry

The catalog of every action Jefe can take on a merchant's store — its state, its safety contract, and its **measured effectiveness**. This is what the write-path buildout is planned against, the source of Jefe's honest "here's what I can and can't do" surface, and the spine of the Observe→Learn loop. It extends `11_actions_and_autonomy.md` (the typed-adapter contract + the autonomy model) with the *catalog* layer: not just *how* an action executes safely, but *which* actions exist, in what state, and whether they've earned their place by adding value.

**Status:** design + first action built (chat 7, 2026-07-30, founder-greenlit) — `price_markdown` is DONE/flagged-off; the catalog + effectiveness loop are the ongoing build.

## The capability lifecycle

Every capability moves through the same loop, and the registry tracks all of it:

> **capability → recommendation / action → measured outcome → learning**

- **Capability** — is there a Shopify write path, do we hold the scope, is the typed adapter built? (the four states, below)
- **Action** — a recommendation the merchant approves, or (once trust is set) an auto-run — always through the typed adapter: idempotency, preview, blast-radius cap, reversibility (`11_actions_and_autonomy.md`).
- **Measured outcome** — *did it add value; what's happened since?* Filled post-action from `action_executions.outcome` (clearance: units moved, cash recovered, effectiveness rate) + `business.recommendation_engagement` (accepted / completed).
- **Learning** — the measured outcome raises/lowers confidence + the recommended autonomy default for that action type, proves value to the merchant, and re-prioritises the build backlog.

The loop *is* the point: a recommendation you never measure can't earn autonomy and can't prove its worth. "What's happened since" is a first-class column here, not an afterthought.

## The four capability states

Every candidate action is in exactly one:

| State | Meaning | Surface to the merchant |
|---|---|---|
| **DONE** | Shopify API path **∧** we hold the scope **∧** the typed adapter is built + gated | Jefe does it (approve-first, or auto if the merchant's dial allows) |
| **BUILDABLE** | API path + scope exist, adapter not built yet | "I can't do that *yet*" — and it's on the build backlog |
| **NEEDS-SCOPE** | API path exists, but we don't request the OAuth scope | "Grant me *X* and I can do this" (a scoped, justified re-consent) |
| **NO-PATH** | Shopify exposes no API for it | "Shopify doesn't let me do that" — honest, no false promise |

The honest surface is the trust-preserving move: a merchant asks for something → Jefe answers from the registry (*do it / coming soon / grant this permission / can't*), never overpromising.

## A registry entry

Each action type is a typed catalog entry:

```
{
  actionType: "price_markdown",          // the primitive (maps to action_executions.action_type)
  label: "Mark a product down",
  shopifyMutation: "productVariantsBulkUpdate (price)",
  requiredScopes: ["write_products"],    // first-class — drives scope sequencing
  state: "DONE" | "BUILDABLE" | "NEEDS-SCOPE" | "NO-PATH",
  adapterModule: "app/lib/actions/clearance-adapter.server.js",
  reversibility: "reversible",           // reversible | irreversible — feeds the auto-eligibility gate
  blastRadiusModel: { unit: "variant", caps: { maxVariants, maxDiscountPercent } },
  autonomyDefault: "approve_execute",    // recommend | approve_execute | autonomous — the merchant's dial, raised within the gate
  effectiveness: { measured, samples, addedValueRate },   // from the Observe→Learn loop
  demandSignal: { unfulfilledIntentCount }                // from intent-capture — why/when to build
}
```

`requiredScopes`, `reversibility`, and `blastRadiusModel` are exactly what the **structural auto-eligibility gate** reads (`reversible ∧ blast_radius ≤ cap ∧ confidence ≥ threshold`). `effectiveness` and `demandSignal` are what make the registry *learn* which actions matter.

## The three jobs the registry does

1. **Build backlog, demand-driven.** `intent-capture` already logs `merchant_intent_unfulfilled` (what merchants ask Jefe to do that it can't yet). Frequency × value → which BUILDABLE / NEEDS-SCOPE actions to build first. We build what merchants demonstrably want, not what we guess.
2. **The honest capability surface.** The four-state map powers the merchant-facing answer to "can you do X", including the graceful *not yet / grant scope / can't*.
3. **The effectiveness loop.** Per-action-type effectiveness (aggregated from the `action_executions` ledger) proves value to the merchant, tunes confidence + the recommended autonomy default, and deprecates actions that don't earn their keep.

## Scopes are a first-class column

Most write paths need OAuth scopes we may not request. **Scopes are added per-action, as each write-path ships** — via `scopes_update`, each addition justified by a real feature the merchant opts into (the right consent model for Jefe taking actions). The launch posture trims to the reads V1 uses **plus `write_products`** (the only write a live V1 action needs — clearance), dropping the four unused `write_*` and re-adding them per-action as each goes live (the App Store launch scope-trim → 7 scopes). `requiredScopes` is the source of truth for that sequencing: **NEEDS-SCOPE is a state, not a blocker** — an explicit, mapped step.

## Improve, don't train

For a system touching merchant money and trust, **auditability beats opacity** — so the registry is *engineered and measured*, not *trained*:

- **The ontology** (the typed adapters, the catalog) is engineered + curated — build each action correctly, with its structural guarantees; it grows demand-driven. Never trained.
- **The safety gate** (`reversible ∧ cap ∧ confident`) is deterministic, inspectable code. Never trained — a black-box policy changing a merchant's prices is exactly what can't be audited or explained.
- **The decision** (what to recommend) is the LLM proposing within grounding + guardrails; we improve the *prompt* and the *memory it reasons over*, not by fine-tuning on actions.
- **The learning** is a transparent feedback loop: measured outcomes → confidence/effectiveness *numbers in memory* → informed defaults. Every step is an inspectable value, not opaque weights.
- **ML belongs in the analysis layer, not the action layer** — clustering the intent-capture corpus into candidate new actions is a fine use of ML (analysis, takes no action); measuring effectiveness is statistics. The action + safety layers stay deterministic.

This is the memory thesis (provenance + confidence, deterministic grounding, typed writes) extended to actions: an action system you can explain to a merchant line-by-line.

## The map today (first-pass inventory)

Verified against the live Shopify Admin GraphQL docs (2026-07) and reconciled with the 7-scope launch trim (see below). Only `price_markdown` is DONE; the value is seeing the whole surface — what we can build now (all `write_products`), what needs a scoped re-consent, and the genuine walls.

**DONE** — `price_markdown` (dead-stock clearance): decision engine + ledger + typed execution adapter + the live write client + the `wireClearanceExecution` orchestrator + the surface (approve / decline / 3-mode picker) — all built, on origin, and **LIVE** (`CLEARANCE_EXECUTE_ENABLED=true` in production since 2026-07-31). `write_products` is **kept** at launch: clearance goes live at launch (autonomy-from-day-one), so its scope stays; the launch scope-trim dropped only the four *unused* `write_*` (orders/customers/inventory/locations), re-added per-action as those ship. Go-live is **DONE** (2026-07-31): the plan-rec emit fills the proposed row and `CLEARANCE_EXECUTE_ENABLED=true` is set in production; a given store stays inert until it has costed dead stock + a non-`recommend` dial.

**Scopes held today** (corrected 2026-08-24 — the "7-scope launch trim, `write_products` only" description below was stale; verified live against `shopify.app.toml` and a real connected dev store's granted scopes): `read_products, write_products, read_orders, write_orders, read_all_orders, read_customers, write_customers, read_inventory, write_inventory, write_inventory_transfers, read_locations`. Held **write** scopes are `write_products`, `write_orders`, `write_customers`, `write_inventory`, `write_inventory_transfers` — broader than the original launch-trim plan (see `docs/shopify-full-scope-audit.md` for the current full audit and the remaining scope-expansion recommendation, not yet applied). This changes the near-term roadmap: several inventory/order/customer writes no longer need a new-consent step, only capability + safety-classification work (`docs/shopify-full-capability-surface.md`).

**BUILDABLE — scope held (`write_products`), adapter-only, reversible** — the auto-eligibility sweet spot + the fastest next builds; all reuse the clearance adapter + write client with no new consent:
- *Pricing* (`write_products`): `price_set`, `set_compare_at_price`, `bulk_price_update` — the clearance mutation (`productVariantsBulkUpdate`) generalised to promos + repricing. Reversible (prior price). **The natural 2nd primitive** — it reuses `clearance-shopify-client` + the `expectedFrom`/revert model, so it forces the shared-shape extraction the explicit dispatch is waiting for (two real primitives → the interface).
- *Merchandising* (`write_products`): `product_status_change` (archive dead SKUs that didn't clear — pairs with clearance), `add_tags`/`remove_tags`, `collection_add_products`/`collection_reorder` (verify collections ride `write_products`). Reversible (unarchive / re-tag / re-order).

**BUILDABLE — scope held but irreversible** → always confirm, never auto (`write_products`): `product_delete`.

**NEEDS-SCOPE** — the mutation exists but the scope was **trimmed at launch** (or never held) → re-add per-action via `scopes_update`, each justified by the feature the merchant opts into:
- *Inventory* (`write_inventory` — trimmed): `inventory_set`, `inventory_adjust` — correct oversell / stock drift; pairs with the `inventory_levels/update` webhook. Reversible.
- *Customer marketing* (`write_customers` — trimmed): `customer_email_marketing_consent`, `customer_sms_marketing_consent`.
- *Order housekeeping* (`write_orders` — trimmed): `order_update` (note/tags), `order_close`; plus the irreversible `refund_create`, `order_cancel` (confirm-gated).
- *Customer lifecycle* (`write_customers` — trimmed, irreversible → confirm-gated): `customer_delete`, `customer_merge`.
- *Locations* (`write_locations` — trimmed): location create / edit / activate.
- *Fulfillment* (`write_*_fulfillment_orders`): create/track/hold/reroute/cancel — a domain behind one re-consent bundle.
- *Discounts* (`write_discounts`): code + automatic discounts, deactivate.
- *Order edits* (`write_order_edits` — **separate from `write_orders`**, easy to mis-map): add/remove/qty/line-discounts.
- *Draft orders* (`write_draft_orders`): create/complete/invoice.
- *Channel publishing* (`write_publications`); *online-store content* — pages/blogs/menus/redirects (`write_content` / `write_online_store_pages` / `write_online_store_navigation`).
- *Inventory transfer* (`write_inventory_transfers` — grantability uncertain, verify at build); *marketing-activity register* (`write_marketing_events` — attributes only, does NOT send).

**NO-PATH** (Shopify's API genuinely can't — surface honestly):
1. Send a Shopify Email/SMS marketing campaign (`marketingActivityCreate` only *attributes*) → Jefe's own Resend/Slack/WhatsApp stack is the route.
2. Supplier procurement (place + pay a PO) — `inventoryTransferCreate` only moves *your own* stock between *your* locations.
3. Edit the checkout flow/fields (UI extensions/Functions only).
4. Theme/storefront code (`themeFilesUpsert` needs a special Shopify exemption — effectively closed for a normal app).
5. Store / plan / tax / payment-provider settings.
6. Native product bundles (Functions, not a first-party mutation).

The declared-but-unbuilt `operational_messages` channel capability (proactive Slack/WhatsApp) is BUILDABLE and lives here as its registry home — it's Jefe's own comms stack, not a Shopify write.

*Full per-mutation table (each mutation name + reversibility) from the 2026-07-30 write-surface research; this section is the curated, decision-useful view.*

## Relationships

- `11_actions_and_autonomy.md` — the typed-adapter contract, the merchant-owned autonomy dial, the structural auto-eligibility gate. The registry is the *catalog* over that contract.
- `action_executions` table (the ledger) — the per-instance execution + outcome record; the registry aggregates it into per-action-type state + effectiveness.
- `docs/action-ontology-and-autonomy.md` + `intent-capture` — the demand feed that prioritises the backlog.

**Next:** populate the full BUILDABLE / NEEDS-SCOPE / NO-PATH inventory by walking the Shopify Admin API write surface against our scopes — the concrete map of everything Jefe can, could, and can't do.
