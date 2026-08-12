# Memory / Ontology lane — handover (2026-08-13)

Successor to the session that ran 2026-08-12. Everything below is on `origin/main` and
gate-green. **Your next build is `business.brand_voice`** (§1). Read §5 before writing code —
it lists the traps that actually cost time here.

---

## 1. YOUR NEXT BUILD — `business.brand_voice`

**Matt's direction, verbatim in substance (2026-08-12):** prose listing copy *should* be done,
but "in their voice / encourage edits / help them be consistent with their brand voice", with
"before/after" always shown and "edits or full autonomy depending on the mode they set".

That reframes the risky thing into the valuable thing, and it lands in this lane because
**brand voice is a belief**:

> observe their existing product descriptions → infer the voice → show it back →
> they confirm or correct → Jefe writes consistently with what they confirmed.

Not Jefe deciding how they sound. Jefe *noticing* how they sound and being told when it's
wrong. That is the Merchant Memory loop applied to copy.

**Why it must exist BEFORE prose listing copy.** A wrong price is obviously wrong. Wrong copy
just sounds like the merchant wrote it — so it never gets challenged. The listing-copy action
is deliberately scoped to product types only until this belief exists (§2).

**The sharper product than "write new copy":** most catalogues have drifted — different people,
different years, some listings written with care and some pasted from a supplier. Jefe
*noticing that inconsistency* and offering to bring the odd ones into line is more useful and
far less presumptuous than Jefe imposing a house style.

**Design constraints inherited from this lane, do not relax:**
- **Descriptive, never comparative.** The same reasoning that killed a "premium vs budget"
  price band applies: describing a merchant against *themselves* needs no external basis;
  describing them against *other merchants* needs benchmark data, and
  `benchmark-priors.server.js` still ships with NO data.
- **Report the evidence, not just the label.** Every business-shape belief carries the numbers
  behind its enum precisely so a merchant can correct the *premise*, not just the conclusion.
  A voice belief should quote the listings it was read from.
- **Thin evidence → say nothing.** `listing-copy-proposal.server.js` is the pattern: where the
  signal is mixed it proposes NOTHING and asks. A model will always produce an answer; that is
  exactly the failure to design against.
- Follow the enum-bucket pattern in `shopify-derivations.server.js` (see `channelMix`,
  `rangeComposition`) and the registry shape in `deterministic-belief-registry.server.js`.

⚠️ **Unlike the other shape beliefs, voice probably needs the LLM** (reading prose). Everything
in the tranche so far is deterministic. That is a real departure — provenance, confidence and
merchant-correctability all have to hold anyway. Worth a note to chat 10 before building.

---

## 2. Listing copy — LIVE, product types only

`LISTING_COPY_EXECUTE_ENABLED=true` in production (Railway `jefe`). The whole path works:
registry → binding → proposal → adapter → Shopify client → wire → **approve dispatch**.

- **Only ever fills a BLANK product type.** A merchant who categorised a product made a
  decision; silently rewriting it would be Jefe overruling them somewhere they'd never look.
  Compare-and-set re-reads the live value, so a merchant who types it themselves mid-flight
  wins.
- **Proposes only from the merchant's OWN vocabulary** (vendor dominance ≥3 products ∧ ≥80%,
  or an unambiguous title token). Deterministic, no LLM. Mixed evidence → proposes nothing.
- ⛔ **Widening to descriptions/titles is gated on §1.** Not a config change.

## 3. Business shape — 7 dimensions, merchant-facing

`channel_mix` · `catalogue_shape` · `purchase_cadence` · `order_value_bands` ·
`delivery_footprint` · `purchase_consideration` · `range_composition`.

Surfaced after Matt reviewed them against 14 real merchants (Origin Coffee reads as a
fortnightly £12 refill business; Antler as a £138 single-market one — they read true).

**Validated against 207 real merchants via Quiver Redshift (Metabase MCP, database_id 5).**
Two were WRONG and the data caught both: `purchase_cadence` had a bucket nothing could reach,
and `channel_mix` binned marketplace/social/headless into "other". Still unvalidated:
`catalogue_shape`, `range_composition`, `purchase_consideration` — they need product data
Quiver's warehouse lacks, though **Quiver's postgres (database_id 3) has `product_orms`**,
which I never got to.

⚠️ Quiver's base is London delivery clients — DTC-skewed, food/fashion heavy. They repeat
faster and use marketplaces less than Shopify at large. Re-check against Jefe's own merchants.

---

## 4. Open items

- **The last unvalidated three** (§3) — `product_orms` is probably the way in.
- **`Shop.currencyCode`** — with chat 10. The base-currency label is currently a *vote* over
  presentment labels; the true value is fetched and stored but unread. Persisting it on `Shop`
  (like `ianaTimezone`) makes it read, not guessed, and lets the fabrication below be deleted.
- ⛔ **`Variant.currency` is FABRICATED** — `currencyCode(variant.price)` falls through to a
  hardcoded `"GBP"` for every variant of every merchant (`normalize.server.js:26-35`). Flagged
  to chat 10, not fixed. Do not trust that column.
- **Shape beliefs don't reach ACTION chat.** Fixed for the memory chat (§5); the v2
  `retrieveSemanticMemory` takes 16 of ~140 beliefs by precedence, and shape beliefs sit at
  `systemInference` like everything else, so they lose. Same trap, third surface.
- **Gate throughput** — chat 10 ruled the pre-push hook should shrink to a fast subset; not
  implemented. I lost 18 consecutive ref-lock races in one stretch.

---

## 5. TRAPS THAT COST TIME — read before coding

1. ⛔ **A belief can derive, store, test green, and never reach the model.** The prompt fits
   ~40 of ~140 beliefs, ranked by keyword overlap with the merchant's message. Anything that
   is *framing* rather than topical matches nothing, scores on confidence alone, and loses
   every slot. Fixed for the memory chat with a standing boost (`isBusinessShapeBeliefKey`).
   **Check this for any new belief** — nothing else surfaces it.
2. ⛔ **`node --test` green ≠ typecheck green.** These files are `@ts-check` and CI typechecks
   separately. It reddened main twice this week.
3. ⛔ **Redshift:** `order_prices.order_id` joins `orders.ID` (per-ETL uuid), NOT
   `orders.order_id`. The obvious join returns **zero rows silently** — I nearly reported the
   warehouse as empty. `PERCENTILE_CONT` must be a WINDOW function there.
4. ⛔ **Don't trust a red DB test until migrations are applied.** I created isolated schemas,
   suppressed `prisma migrate deploy`'s output, trusted it, and **told Matt main was red when
   it wasn't.** Never suppress that output.
5. **Guard tests will fight you, and they are right to.** Three caught me: the registry size
   guard, the applicability-vocabulary guard (every dimension must be observable with a named
   evidence belief), and the belief-audience split. Update them deliberately with reasoning —
   never loosen them.
6. **Siblings improve your work.** My crude `merchantVisible` boolean was replaced by a proper
   audience model (`merchant`/`internal`/`model`). Work *with* the better design.

---

## 6. Working notes

- Push: `fetch → rebase → push` in a loop; the pre-push hook runs the full gate, so **don't
  run preflight manually too** — that doubles your lost-race window.
- `npm ci` in your own worktree before writing code. The shared `node_modules` can be emptied
  by another session mid-run.
- Pathspec commits only. Expect a `CHANGELOG.md` conflict most rebases — keep BOTH sections.
- Memory (`~/.claude-personal/projects/-Users-mb-Claude-jefe/memory/`) is current: see
  `project_jefe_business_shape_tranche`, `project_jefe_listing_copy_action`,
  `reference_worktree_gate_workflow`.
