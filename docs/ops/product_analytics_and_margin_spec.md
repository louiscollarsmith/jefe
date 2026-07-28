# Spec: Product analytics, funnel drop-off & per-client margin (internal)

> **Status:** Draft spec (for review) · **Audience:** Jefe developers only · **Not** merchant-facing.
> Goal: instrument the app **once** so we can answer three developer questions off shared tables:
> 1. **Usage** — how are clients actually using Jefe?
> 2. **Drop-off** — where in onboarding / the loop do they stall or leave?
> 3. **Margin per client** — revenue minus LLM/infra cost, per merchant.

All three fall out of two new event streams — an **LLM cost ledger** and a **product-event stream** — plus a small **billing** record for the revenue side. This doc specs the data model, where to instrument it (grounded in the current code), the derived metrics, and a phased build. No UI in v1.

---

## 1. Principles

- **Instrument once, query many.** Capture raw events + raw token usage; derive every metric downstream. Don't pre-aggregate in app code.
- **Internal only, no customer PII.** Events are keyed by `merchantId` / `shopId` and event type — never customer names, emails, order contents. Honors the repo rule "do not expose production customer data."
- **Additive & non-blocking.** New tables and a thin wrapper; writes are fire-and-forget (or in the same txn as the run) and never slow a merchant request or block onboarding.
- **First-party first.** Postgres is the source of truth. An external tool (PostHog/Segment) can be layered later for exploration, but margin math needs first-party cost data anyway.

---

## 2. Data model (proposed Prisma additions)

Three new models. Sketch (names/fields to firm up in review):

```prisma
/// One row per LLM call — the cost + usage ledger.
model LlmUsageEvent {
  id             String   @id @default(cuid())
  merchantId     String   @map("merchant_id")
  shopId         String   @map("shop_id")
  feature        String   // "insights" | "goals" | "plan" | "store_understanding" | "memory_refresh" | "conversation"
  runType        String?  @map("run_type")   // e.g. "MerchantInsightRun"
  runId          String?  @map("run_id")      // FK-ish link to the generation record
  provider       String   @default("gemini")
  model          String                        // e.g. "gemini-3.1-flash-lite"
  inputTokens    Int      @map("input_tokens")
  outputTokens   Int      @map("output_tokens")
  totalTokens    Int      @map("total_tokens")
  costUsd        Decimal  @map("cost_usd") @db.Decimal(12, 6)
  latencyMs      Int?     @map("latency_ms")
  status         String   // "ok" | "error" | "timeout" | "validation_failed"
  createdAt      DateTime @default(now()) @map("created_at")

  @@index([merchantId, createdAt])
  @@index([feature, createdAt])
  @@map("llm_usage_event")
}

/// One row per meaningful product action — the usage + funnel stream.
model ProductEvent {
  id          String   @id @default(cuid())
  merchantId  String   @map("merchant_id")
  shopId      String   @map("shop_id")
  type        String   // see event taxonomy below
  step        String?  // onboarding step context: connect|channels|insights|goals|plan|memory
  properties  Json?    // small, PII-free { channel: "slack", findingConfidence: "high", ... }
  createdAt   DateTime @default(now()) @map("created_at")

  @@index([merchantId, createdAt])
  @@index([type, createdAt])
  @@map("product_event")
}

/// Revenue side of margin — one current row per merchant (history optional).
model MerchantBilling {
  id            String    @id @default(cuid())
  merchantId    String    @unique @map("merchant_id")
  plan          String    // "free" | "starter" | "pro" | ...
  status        String    // "trialing" | "active" | "cancelled"
  mrrUsd        Decimal   @map("mrr_usd") @db.Decimal(10, 2)
  currency      String    @default("USD")
  startedAt     DateTime? @map("started_at")
  shopifyChargeId String? @map("shopify_charge_id") // Shopify AppSubscription id
  updatedAt     DateTime  @updatedAt @map("updated_at")

  @@map("merchant_billing")
}
```

Notes:
- `LlmUsageEvent` is the highest-value, lowest-effort table — it alone answers "cost per client" and powers margin.
- `MerchantBilling` needs a **Shopify managed-pricing / `AppSubscription` integration that does not exist yet** (no billing model in the schema today). Until then, margin can run with a hard-coded/manual plan→MRR map as a stopgap.
- Retention: raw events grow fast. Plan a rollup (daily per-merchant aggregates) + drop raw > 90 days. Out of scope for v1 but note the index choices support it.

---

## 3. Instrumentation points (grounded in current code)

### 3.1 LLM cost — one wrapper
`apps/shopify/app/lib/llm/provider.server.js` is the **single LLM entry point** and already returns a `usage` object (`{ inputTokens, outputTokens, totalTokens, estimatedInputTokens }`; Gemini's `usageMetadata` maps to it). Wrap the call so every invocation writes an `LlmUsageEvent`:

```
provider.generate(request, ctx)  →
  { result, usage } = <existing call>
  costUsd = price(model, usage.inputTokens, usage.outputTokens)
  enqueueLlmUsageEvent({ merchantId, shopId, feature, runType, runId, model, ...usage, costUsd, latencyMs, status })
  return result
```

The callers (`lib/merchant-insights`, `merchant-goals`, `merchant-plan`, `merchant-memory/store-understanding`, `conversation`) must pass a small **cost context** (`merchantId`, `shopId`, `feature`, and the `run` they're generating for) down to the provider. Each of those features already creates a versioned `*Run` row — pass its id as `runId`.

Pricing lives in a config map, e.g. `lib/llm/pricing.js`:

```js
// $ per 1M tokens — PLACEHOLDER values, fill from the provider's current price sheet.
export const LLM_PRICING = {
  "gemini-3.1-flash-lite": { inputPer1M: 0.0, outputPer1M: 0.0 },
};
export const priceUsd = (model, inT, outT) => {
  const p = LLM_PRICING[model] ?? { inputPer1M: 0, outputPer1M: 0 };
  return (inT / 1e6) * p.inputPer1M + (outT / 1e6) * p.outputPer1M;
};
```

> ⚠️ Do not guess prices — pull the real per-model rates and keep this table version-controlled. (The `changelog-watcher` tool can flag when the model/pricing changes.)

### 3.2 Product events — a tiny `track()` helper
Add `services/product-events.server.js` exposing `track(type, { merchantId, shopId, step, properties })`, writing a `ProductEvent`. Call it at the meaningful moments (most already have a clear code home):

| Event `type` | Where | Answers |
|---|---|---|
| `app_opened` | `app._index` loader | DAU/WAU, sessions |
| `shopify_connected` | post-OAuth / `ensureShopifyTenant` | funnel entry |
| `backfill_completed` | `shopify-backfill-worker` (already emits memory refresh) | time-to-first-memory |
| `onboarding_step_viewed` | `app._index` loader, keyed on `activeStep` | **funnel drop-off** |
| `channel_connected` | `channels/*` (slack/whatsapp) | integration adoption |
| `insight_confirmed` / `insight_corrected` | `merchant-insights/correction-processor` | trust / data-capture rate |
| `goals_accepted` | `merchant-goals` | funnel |
| `plan_accepted` / `onboarding_completed` | `completePlanOnboarding` | **funnel completion** |
| `memory_viewed` | `app._index` memory mode (`appMode:"memory"`) | post-onboarding engagement |
| `memory_belief_corrected` | memory view actions | ongoing usage |

Onboarding step/state is already tracked via `Shop.onboardingCompletedAt` + `normalizeOnboardingStep` (steps: connect → channels → insights → goals → plan → memory), so the funnel needs only the `onboarding_step_viewed` + `*_accepted` events layered on top.

---

## 4. The three questions → the queries

### 4.1 Usage
- **Active clients:** distinct `merchantId` in `ProductEvent` per day/week (DAU/WAU).
- **Feature adoption:** counts of `channel_connected`, `insight_confirmed/corrected`, `memory_viewed`, `memory_belief_corrected` per merchant.
- **Depth:** events/session, corrections per merchant (are they *teaching* Jefe?).

### 4.2 Drop-off (funnel)
Per merchant, the furthest `onboarding_step_viewed` reached + `onboarding_completed` flag + timestamps →
- **Step conversion:** connect → channels → insights → goals → plan → completed, as a % at each hop.
- **Drop-off point:** the step with the biggest fall-off; cohort by install week.
- **Time-in-step / stalls:** merchants sitting > N hours on a step (e.g. stuck on Insights because a generation failed — cross-reference `MerchantInsightRun.status`).

### 4.3 Margin per client
```
llm_cost(merchant, period)  = Σ LlmUsageEvent.costUsd
revenue(merchant, period)   = MerchantBilling.mrrUsd   (or manual map stopgap)
infra_alloc(merchant)       = flat per-active-merchant allocation (Railway/Neon) — coarse v1
margin       = revenue - llm_cost - infra_alloc
margin_pct   = margin / revenue
```
Surface: rank merchants by margin; **flag negative-margin clients** (LLM cost > revenue) and cost outliers (which *feature* burns the most tokens — usually generation retries on validation failures). This is the number that tells us if the unit economics work.

Ship as **SQL views** in v1 (`v_merchant_llm_cost`, `v_onboarding_funnel`, `v_merchant_margin`) + a `tools/analytics-report` CLI that prints them (same zero-dep shape as `changelog-watcher`). No dashboard yet.

---

## 5. Phasing

1. **Phase 1 — LLM cost ledger (highest value, ~1 model + 1 wrapper).** `LlmUsageEvent` + pricing table + provider wrapper + `v_merchant_llm_cost`. Immediately answers "what does each client cost us."
2. **Phase 2 — product-event stream.** `ProductEvent` + `track()` + the ~10 call sites → usage + funnel drop-off views.
3. **Phase 3 — revenue & margin.** `MerchantBilling` fed by Shopify managed pricing / `AppSubscription`; `v_merchant_margin`. (Biggest external dependency — needs the billing decision.)
4. **Phase 4 — surface it.** Internal `/app/dev` admin view (there's already `ENABLE_DEV_TOOLS` + an `app.dev` route) or a read-only ops dashboard. Optional PostHog for exploratory usage analytics.

---

## 6. Open decisions (need founder input)

- **Revenue model** — flat plan, per-seat, or usage-based? Determines whether margin is simple (MRR) or itself usage-derived.
- **Pricing source of truth** for `LLM_PRICING` and how we keep it current (manual vs the changelog-watcher).
- **Retention & rollups** — how long to keep raw events; when to introduce daily aggregates.
- **Build vs buy for usage** — first-party only, or add PostHog/Segment for the exploratory side (margin stays first-party regardless).
- **Attribution granularity** — cost per run is enough, or do we also want per-request (each retry) resolution? (Retries on schema-validation failures are a real cost sink worth seeing.)

---

## 7. Why this shape

Every metric here is a query over `LlmUsageEvent` + `ProductEvent` (+ `MerchantBilling`). We never bake a metric into app logic, so new questions ("which insight type gets corrected most?", "does connecting Slack raise retention?") are just new SQL, not new instrumentation. Phase 1 alone — the cost ledger off the single provider chokepoint — is a few hours of work and gives us per-client cost and the margin denominator today.
