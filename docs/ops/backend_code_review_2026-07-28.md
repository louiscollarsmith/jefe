# Jefe backend — code review (2026‑07‑28)

Three parallel deep-read passes over ~20k LOC + the 33‑model schema, reviewed against `context/` + `CLAUDE.md`:
Merchant Memory core (11k LOC) · generation + LLM + workers (~4.4k) · ingestion + schema + tenancy (~3.8k).
The two highest‑stakes findings were spot‑verified by hand (line‑item total bug; GDPR‑webhook no‑op).

## Verdict

The foundation is genuinely strong and unusually principled — the hard, philosophically‑important parts are right. The gaps cluster in the **live‑data edges** (paths that fire *after* onboarding, on real webhook traffic) and in one product‑critical surface: **a wrong number can reach the merchant as "fact."** Close that surface + the legal/PII gap before onboarding real clients; the rest is normal hardening. The architecture does not need reworking.

## What's genuinely strong (keep — don't touch)

- **Deterministic‑vs‑inferred boundary is exemplary.** All numeric facts are computed in application code (`shopify-derivations.server.js`, `calculation-primitives.server.js`); the LLM store‑understanding value schema has **no number field** (text/option/list only), persists at `llmInference` precedence with a confidence ceiling, and refuses to overwrite deterministic beliefs. Inference cannot masquerade as fact at the persistence layer.
- **Merchant‑correction precedence is coded, not just prompted**, and enforced at *every* write site (`merchant-memory/service.server.js`, `store-understanding.server.js`). Re‑derivation over a merchant‑authoritative belief is skipped and audited. Tested (`merchant-memory.test.mjs:301`).
- **Provenance is validated against the exact model input** — every finding/goal/recommendation must cite belief IDs that were actually in the prompt allowlist; fabricated citations are rejected (`merchant-*/schema.server.js`).
- **Multi‑tenancy is airtight by construction** — tenant identity always derived server‑side (HMAC'd shop domain / validated `*.myshopify.com`), never client input; every downstream row scoped by `merchantId` (+`shopId`); concurrent‑install idempotency is tested.
- **Channel/credential security is strong** — AES‑256‑GCM with per‑record IV + key rotation, single‑use OAuth state, verify‑before‑send, rate limits, and **app‑authored** (not model‑generated) outbound content.
- **Ingestion is disciplined** — append‑only ledger + dedupe, idempotent upserts, Shopify client with 429/`THROTTLED` backoff + SSRF‑guarded endpoint, durable job queue with atomic claim + 15‑min stale recovery. The named hot query paths are indexed.
- **Real tests** — 13 `node:test` suites, strongest on the deterministic core, the precedence guarantee, and ingestion idempotency.

## What to change — tiered

### Tier 1 — before onboarding real clients (legal + "wrong number as fact")

1. **GDPR compliance webhooks are silent no‑ops.** `webhooks.server.js:130‑132` — `customers/redact`, `customers/data_request`, `shop/redact` return `200 "processed"` and do nothing, while PII sits at rest (`customer_identities.normalized_email` plaintext; `orders`/`ledger_events.raw_payload` = full order incl. email/name/address). The redact request body is even written to the ledger **before** this branch, so a redaction request *adds* PII. → Regulatory violation + Shopify App‑Store rejection (these are audited). Implement real redact/export/teardown; stop ledgering the redact body; drop or encrypt `normalized_email` (it is write‑only — nothing reads it).
2. **Live orders store the discount as the line total.** `canonical.server.js:283‑285`/`299‑301` — `totalPrice = discountedTotalSet?.shopMoney ?? total_discount`. GraphQL backfill has `discountedTotalSet` (correct); REST‑shaped webhook orders (`orders/create`) don't → they fall through to `total_discount`. So every order ingested live after onboarding stores a wrong line total (£50 line, £5 off → `totalPrice = 5`), and it feeds revenue derivations. Silent because historical backfill looks right. → Fix the fallback (`price*qty − total_discount`) + a test.
3. **Numeric‑grounding guard is a substring test a wrong number defeats.** `merchant-insights/schema.server.js` (same in plan): the "is this number supported?" check is `supportText.includes(claim)`, where `supportText = JSON.stringify(belief)` **including the cuid `id`** (full of digits) **and `conf` as `toFixed(2)`**. So "56%" passes because some belief has `conf 0.56` or an id contains "56"; comma‑stripping merges array numbers. Goals have **no** numeric grounding at all yet are stored as target beliefs. → The direct hole in "never present inference as fact": exclude `id`/`conf` from grounded text, keep units, attach a citing belief id per numeric claim, extend the check to goals.

### Tier 2 — correctness & reliability as usage grows

4. **Job‑row lifecycle races strand runs + drop refreshes.** Terminal worker writes aren't guarded on `status:"running"` → a run enqueued mid‑job is orphaned as perpetually "queued." Re‑enqueue overwrites the `categories` array instead of unioning it (`shopify-backfill-status.server.js:137`) → a webhook can silently downgrade a full memory rebuild to partial, or drop a category. No DB uniqueness on active `(merchantId,key)` → any queue‑bypassing path can create two active beliefs for one key. → Guard terminal `updateMany` on `status:"running"`; union categories; add a partial unique index on active `(merchantId,key)`.
5. **Multi‑write operations aren't atomic.** Belief → history → evidence are separate awaits outside the one version‑bump transaction (`merchant-memory/service.server.js`, `store-understanding.server.js`); confirm/correct loops too; and customer‑identity aggregation is a non‑atomic read‑modify‑write that loses writes when the web process handles webhooks while the split worker backfills (`canonical.server.js:570‑633`). → A DB hiccup mid‑op corrupts the exact provenance chain the product promises. Wrap committing ops in the existing `runInTransaction`; make aggregation atomic (tx + row lock, or aggregate at read time).
6. **Beliefs go stale as "current fact."** Confirming a *time‑varying observed* metric (AOV, order count) freezes it at confidence 1.0 forever — re‑derivation is then skipped, so by month 3 the memory asserts a stale confirmed number. And deterministic beliefs that drop below their min‑data threshold are never retired (the old value stays active). → Distinguish "confirm current observation" (re‑derivable, keeps system precedence, records a confirmation timestamp) from "assert a value" (authoritative); add a deterministic obsolete‑reconciliation pass (the LLM path already has one — `obsoleteUnsupportedStoreUnderstandingBeliefs`).

### Tier 3 — posture, hygiene, tests

7. **Secret posture.** Shopify offline access token stored plaintext (`schema.prisma` `Session.accessToken`) while the app holds `write_*` scopes — the highest‑value secret and the only major one unencrypted (channel tokens are AES‑GCM). Credential encryption silently falls back to `SESSION_SECRET` → `SHOPIFY_API_SECRET` if the dedicated secret is unset (`crypto.server.js`), crossing security domains. → Encrypt the token (session‑storage wrapper) and/or tighten OAuth scopes to least‑privilege while the product is read‑only; require the dedicated encryption secret in prod (warn on fallback).
8. **Visible memory omits confidence / provenance / last‑updated** (`getMerchantMemoryView`, `app/routes/app._index.tsx`). `context/10_visible_memory.md` requires them, and rendering a 0.6 LLM inference identically to a merchant‑confirmed 1.0 fact edges toward "present inference as fact." The data is already loaded — just surface it.
9. **Insights/Goals input is unbounded** — a mature store with hundreds of beliefs hits a hard `input_too_large` and never generates (Plan already caps at 40). Apply the same relevance cap.
10. **Schema hygiene** — no Prisma enums (30+ free‑form status strings, no DB guardrail against typos/invalid states); `confidence` typed two ways (`Decimal(5,4)` on beliefs vs `String` on findings/recs); unbounded `raw_payload` retention (great for replay, but the main PII‑at‑rest surface — ties to #1); currency hardcoded `GBP` as the fallback (latent multi‑currency trap).
11. **Test gaps where the bugs live** — the worker claim/complete race, a *negative* cross‑tenant isolation test (isolation is asserted by construction, never by test), the real Gemini adapter (all generator tests mock it), the belief undo path (`revertLatestMerchantSuppliedChange` — restores value/status but not confidence/precedence), and the line‑item total. Add tests alongside each fix above.

## The one theme to internalise

Two independent passes found different ways a **wrong number reaches the merchant as fact** — the grounding substring hole (#3), the live line‑item total bug (#2), and frozen‑confirmation staleness (#6). The product's entire differentiation is *trustworthy memory that never presents inference as fact*. Closing that surface end‑to‑end is the single highest‑leverage investment.

## Logical next step

A short, focused **"go‑live hardening" sprint before the 3‑client onboarding**, in order:

1. **Tier 1** (GDPR webhooks + line‑item bug + numeric grounding) — legal + wrong‑number‑as‑fact. ~2–3 days.
2. **Tier 2** (job races + atomicity + belief‑staleness) — the reliability floor for real webhook traffic. ~2–3 days.
3. **Tier 3** (secret posture, visible‑memory provenance, input bounding, schema/enum hygiene, tests) — ongoing.

Fold a negative cross‑tenant test and a worker‑race test in as you go — they lock in the two strongest properties the codebase already has (isolation, idempotency).
