# Action Capability Registry

The catalog of every action Jefe can take on a merchant's store — its state, its safety contract, and its **measured effectiveness**. This is what the write-path buildout is planned against, the source of Jefe's honest "here's what I can and can't do" surface, and the spine of the Observe→Learn loop. It extends `11_actions_and_autonomy.md` (the typed-adapter contract + the autonomy model) with the *catalog* layer: not just *how* an action executes safely, but *which* actions exist, in what state, and whether they've earned their place by adding value.

**Status:** design (chat 7, 2026-07-30, founder-greenlit).

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
  autonomyDefault: "propose",            // propose | auto — the merchant's dial raises it, within the gate
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

Most write paths need OAuth scopes we may not request. **Scopes are added per-action, as each write-path ships** — via `scopes_update`, each addition justified by a real feature the merchant opts into (the right consent model for Jefe taking actions). This is why the launch posture trims to the reads V1 uses and re-adds `write_*` as each action goes live (see the App Store launch scope-trim). `requiredScopes` is the source of truth for that sequencing: **NEEDS-SCOPE is a state, not a blocker** — an explicit, mapped step.

## Improve, don't train

For a system touching merchant money and trust, **auditability beats opacity** — so the registry is *engineered and measured*, not *trained*:

- **The ontology** (the typed adapters, the catalog) is engineered + curated — build each action correctly, with its structural guarantees; it grows demand-driven. Never trained.
- **The safety gate** (`reversible ∧ cap ∧ confident`) is deterministic, inspectable code. Never trained — a black-box policy changing a merchant's prices is exactly what can't be audited or explained.
- **The decision** (what to recommend) is the LLM proposing within grounding + guardrails; we improve the *prompt* and the *memory it reasons over*, not by fine-tuning on actions.
- **The learning** is a transparent feedback loop: measured outcomes → confidence/effectiveness *numbers in memory* → informed defaults. Every step is an inspectable value, not opaque weights.
- **ML belongs in the analysis layer, not the action layer** — clustering the intent-capture corpus into candidate new actions is a fine use of ML (analysis, takes no action); measuring effectiveness is statistics. The action + safety layers stay deterministic.

This is the memory thesis (provenance + confidence, deterministic grounding, typed writes) extended to actions: an action system you can explain to a merchant line-by-line.

## The map today (first-pass inventory)

Verified against the live Shopify Admin GraphQL docs (2026-07). Only `price_markdown` is DONE; the value is seeing the whole surface — what we can build now, what needs a scope, and the genuine walls.

**DONE** — `price_markdown` (dead-stock clearance): decision engine + ledger + typed execution adapter built, flagged-off (`CLEARANCE_EXECUTE_ENABLED`). \*`write_products` is held today but a launch scope-trim candidate; if trimmed, go-live re-adds it via `scopes_update`.

**Highest-value BUILDABLE** (scope held today, adapter-only — the fastest next builds, all reversible → the auto-eligibility sweet spot):
- *Pricing* (`write_products`): `price_set`, `set_compare_at_price`, `bulk_price_update` — the clearance mutation (`productVariantsBulkUpdate`) generalised to promos + repricing.
- *Inventory* (`write_inventory`): `inventory_set`, `inventory_adjust` — correct oversell/stock drift; pairs with the `inventory_levels/update` webhook already subscribed.
- *Merchandising* (`write_products`): `product_status_change` (archive dead SKUs), `add_tags`/`remove_tags`, `collection_add_products` + `collection_reorder`.
- *Customer marketing* (`write_customers`): `customer_email_marketing_consent`, `customer_sms_marketing_consent` — the one marketing lever needing no new scope.
- *Order housekeeping* (`write_orders`): `order_update` (note/tags), `order_close` — low-risk warm-up before the irreversible order actions.

**BUILDABLE but confirm-gated** (scope held, but irreversible → never auto, always confirm): `refund_create`, `order_cancel`, `product_delete`, `customer_delete`, `customer_merge`.

**NEEDS-SCOPE** (mutation exists, scope not held → "grant X to enable", per-action re-consent):
- Fulfillment (`write_*_fulfillment_orders`): create/track/hold/reroute/cancel — a whole domain behind one re-consent bundle.
- Discounts (`write_discounts`): code + automatic discounts, deactivate.
- Order edits (`write_order_edits` — **separate from `write_orders`**, easy to mis-map): add/remove/qty/line-discounts.
- Draft orders (`write_draft_orders`): create/complete/invoice.
- Channel publishing (`write_publications`); online-store content — pages/blogs/menus/redirects (`write_content` / `write_online_store_pages` / `write_online_store_navigation`).
- Inventory transfer (`write_inventory_transfers` — grantability uncertain, verify at build); marketing-activity register (`write_marketing_events` — attributes only, does NOT send).

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
