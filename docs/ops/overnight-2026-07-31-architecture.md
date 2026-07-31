# Overnight build — architecture (chat 10), 2026-07-31 → 08-01

Built autonomously while Matt slept (he said: build integrations phase-2 + 5 more important things).
**Discipline held on every item:** shipped DARK behind a flag or docs-only; no prod secrets, no OAuth
scope changes, no purchases, no external sends, no flags flipped, no merchant writes executed, no live
paths touched; each change in a worktree → preflight-green → pushed to `main` (rebased + re-gated on
races). Decisions I took are marked **[decided]** — override any.

## Shipped (6 commits, all on `main`, all gate-green)

1. **`863736f` — Integrations phase-2: tool-stack detection (DARK, `ENABLE_TOOL_STACK_DETECTION`).**
   Signal feeder (`tool-stack-signals.server.js`: one bounded Admin GraphQL query + pure response→signals
   mapper) → detection → orchestrator (`tool-stack-detection.server.js`, flag-gated, belief-write as an
   injected seam). Seed registry +9 tools. Unwired. `docs/integrations/tool-stack-phase2.md`.
2. **`6afafcc` — Docs: action-layer implementation companion** (`docs/action-layer-implementation.md`:
   as-built spine + shared adapter contract + recipe to add action N) + reconciled the ontology doc to
   as-built (clearance shipped as action #1, live).
3. **`81ba2f4` — 2nd action primitive `product_status_change` (DARK, `PRODUCT_STATUS_EXECUTE_ENABLED`).**
   Archive/unarchive a product; faithful clearance parallel (flag gate, blast-radius cap, idempotent
   ledger writes, compare-and-set, auto-revert, un-gated revert). No migration, no new scope, unwired.
   Adapter + client + 20 tests.
4. **`f014a48` — LLM cost ledger: multi-model pricing API + margin read.** `computeLlmCostUsd` + a
   per-model table (aliases keep the write path untouched) + `cost-report.server.js`
   (`summarizeLlmCost` → by model × feature, with `rateVerified`). Provider is **Gemini**; rates stay
   `verified:false` (real numbers not invented). 8 tests.
5. **`33e1842` — Executed-action visibility read.** `action-report.server.js`
   (`summarizeExecutedActions` → proposal→execution funnel + outcome mix + `hasExecutedAny` milestone).
   Read-only; does not touch the live path. 5 tests.

## Questions / decisions for you

**Integrations phase-2**
- **Belief wire** — persisting `business.tool_stack` touches chat 9's Merchant Memory registry (+ a
  registry-count guard that's a merge-conflict magnet). I left it as an injected seam and wrote chat 9
  the exact recipe (`docs/integrations/tool-stack-phase2.md`). **[decided: route to chat 9]** — OK, or do
  you want architecture to do it in coordination?
- **Storefront-fingerprint feeder** (the differentiated half — Klaviyo/GA/Meta/Gorgias) needs a **bought**
  detection API. Which vendor, and is the spend approved?
- **Connect-offer surface** (merchant-facing "we noticed you use X — connect it?") — chat 2's surface lane
  + a product/copy call. Not built. Build next?
- **Go-live** — every signature is SEED; verify against 1–2 real stores before flipping
  `ENABLE_TOOL_STACK_DETECTION` (a wrong signature = a false detection, worse than a miss).

**Action layer**
- **Extract the shared `ActionAdapter` interface** now two primitives exist — this touches the LIVE
  clearance adapter, so I did **not** do it overnight. Do it (deliberate + gated), or hold?
- **product_status_change go-live** = wire the proposal emit (chat 9) + the surface (chat 2) + flip
  `PRODUCT_STATUS_EXECUTE_ENABLED` after a live test round-trip. Approve the path?
- **Which action #3** — `context/13`'s buildable set (`price_set`, tags, collection ops — all
  `write_products` siblings, no new consent).

**Cost ledger**
- **LLM provider is Gemini** (`gemini-3.1-flash-lite`), not Claude. Pricing is a placeholder
  ($0.10/$0.40 per 1M, `verified:false`). **Paste the real per-model rates** (Lewis's Gemini billing
  account) to make margin figures real — I deliberately didn't invent them.

**Tech-debt (deferred, not built)**
- The **`advisory-run` shared-module refactor** (the insights/goals/plan duplication assigned to
  architecture) is collision-prone overnight (shared generator files, other lanes) with no product value,
  so I held it. Want it done, and by whom?

## Notes
- Everything reversible: unset a flag / delete an alias / revert a docs commit.
- Heavy sibling activity tonight (chat 8 perf+webhook-health monitoring; chat 9 memory surface; chat 11
  app-home 13a) — rebased + re-gated on every push; no conflicts.
- Full running log: the session worklog (scratchpad).
