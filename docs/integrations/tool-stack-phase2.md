# Tool-stack detection — phase-2 build status + belief-wire handoff

**Status: BUILT, DARK, tested (2026-07-31, chat 10).** The "detect the merchant's stack without
asking" engine now has a working Shopify-signal feeder + orchestrator, all behind
`ENABLE_TOOL_STACK_DETECTION` (unset ⇒ complete no-op). Strategy: `docs/integrations-strategy.md`.

## What shipped (all in `app/lib/integrations/`, unwired to any surface)

| Module | Role |
|---|---|
| `tool-detection.server.js` | Pure `detectToolStack(signals)` + `TOOL_SIGNATURES` seed registry (expanded to ~22 tools). Phase-1; unchanged contract, +9 seed signatures. |
| `tool-stack-signals.server.js` | **Feeder.** `TOOL_STACK_SIGNALS_QUERY` (one bounded Admin GraphQL query: recent orders' `paymentGatewayNames`+`tags`, customers' `tags`, `metafieldDefinitions` namespaces across owner types) + pure `signalsFromShopifyResponse(data)` mapper. |
| `tool-stack-detection.server.js` | **Orchestrator.** `detectAndRecordToolStack({ client, merchantId, env, recordBelief, logger })` — flag-gated; queries → maps → `detectToolStack` → optional `recordBelief` seam. `isToolStackDetectionEnabled(env)`. |

Tests: `tests/tool-stack-signals.test.mjs`, `tests/tool-stack-detection.test.mjs` (+ existing `tests/tool-detection.test.mjs`). Fully green.

Deliberately **not** built (see "Open decisions"): the belief persistence, the connect-offer
surface, the storefront-fingerprint feeder.

## Why the belief write was left as a seam (not wired)

Persisting `business.tool_stack` is a Merchant Memory registry integration — it touches
`shopify-derivations.server.js`, `deterministic-belief-registry.server.js`, and a registry-count
guard pinned in 5 spots in `tests/merchant-memory.test.mjs` (a merge-conflict magnet). That's the
**memory lane (chat 9)**, so architecture left `recordBelief` as an injected seam rather than edit
those hot files concurrently. Recipe below so chat 9 can wire it cleanly in one pass.

## Belief-wire recipe (for chat 9) — `business.tool_stack`

Two feeder sources land in the **same** belief (by design — the engine's header says so):
- **DB-derivation** (this recipe): extract gateways/tags/fulfillment from ingested `rawPayload`
  JSON on `Order`/`Customer` in `loadDerivationContext`; run through `detectToolStack`.
- **Live-query feeder** (the orchestrator above): supplies signals not ingested — chiefly
  **metafield namespaces** (the strongest signatures) + later the storefront fingerprint.

Reconcile them (union the detected lists into one belief value) — that's a chat-9 design call.

The 5 edits (all under `apps/shopify/`):
1. **Registry** — append a `business.tool_stack` object to `DETERMINISTIC_BELIEF_REGISTRY` (`category:"business"`, `valueType:"structured"`, `window:"current_state"`, `confidenceTemplate:"direct_observation_v1"`, `tranche:"Tool stack v1"`).
2. **Derivation** — in `shopify-derivations.server.js`: `import { detectToolStack } from "../integrations/tool-detection.server.js"`; add a `toolStack(context, definition)` fn that reads `context.toolStackSignals`, guards `detected.length < 1` → `skipped(...)`, else `derived(...)` with `confidence: max(per-tool confidence)`; add `case "business.tool_stack":` to the `deriveDefinition` switch; extend `loadDerivationContext` to attach `toolStackSignals` extracted from the already-fetched `orders`/`customers` rawPayloads (no new query).
3. Confidence: none — config-driven off the registry entry.
4. Wiring: none — the switch case IS the registration; `service.server.js` already invokes the deriver on a `business` refresh.
5. **Tests** — add a fixture test; bump the registry count `132→133` (5 spots) and add `"Tool stack v1"` to the tranche Set.

## Open decisions (logged for Matt — morning)

1. **Belief wire owner** — hand this recipe to chat 9, or architecture does it in coordination? (High collision on chat 9's files argues for chat 9.)
2. **Storefront-fingerprint feeder** — needs a **bought** detection API (Klaviyo/GA/Meta/Gorgias have no Shopify footprint). Which vendor, and is the spend approved? This is the differentiated half.
3. **Connect-offer surface** — the merchant-facing "we noticed you use X — connect it?" UI is chat 2's surface lane + a product/copy call. Not built.
4. **Go-live gate** — every signature is SEED. Verify the seed set against 1–2 real stores before flipping `ENABLE_TOOL_STACK_DETECTION` (a wrong signature = a false detection, worse than a miss).
5. **Fulfillment signals** — the live query omits fulfillment-service names (field-shape uncertainty); the DB-derivation can supply them from order `rawPayload.fulfillments`. Confirm the source.
