# Repository Reorientation Audit

## Current Architecture As Implemented

The repository currently contains one substantial application under `apps/shopify`: a Shopify embedded React Router app using Shopify Polaris, Prisma and Postgres.

Implemented foundations include:

- Shopify OAuth/session handling through the Shopify app template.
- Shopify Admin GraphQL helpers, bulk/backfill jobs, webhook receivers and HMAC verification.
- Tenant setup for merchants and shops.
- Immutable-ish `ledger_events` with dedupe and idempotency keys.
- Canonical commerce tables for products, variants, orders, order line items, refunds, inventory levels and customer identities.
- COGS support with Shopify unit-cost sync, manual onboarding inputs, confidence and coverage calculations.
- Onboarding for goals, House Rules, approval mode, brand voice, product costs and protected products.
- Deterministic services for Daily Verdict, Daily Brief, Inventory Guardian, Watchdog and Klaviyo winback proposal generation.
- Action safety lifecycle, approval events, execution records, holdout assignment, attribution result, external artifacts, connector accounts, cost metering and provenance links.
- App-local changelog surfaced from `apps/shopify/CHANGELOG.md`.

## Current Primary Domain Objects

Current primary objects are `Merchant`, `Shop`, `HouseRule`, `Goal`, `LedgerEvent`, canonical Shopify commerce records, `CogsInput`, `DailyBrief`, `Action`, `Execution`, `Feedback`, `ProvenanceLink`, `HoldoutAssignment`, `AttributionResult`, `ConnectorAccount`, Klaviyo credentials/artifacts and backfill status/jobs.

There is no durable Merchant Memory object. The closest concepts are goals, House Rules, daily brief JSON payloads, deterministic action evidence and feedback rows.

## Old Product Assumptions

The old repository assumes Jefe is primarily an accountable ecommerce operator that opens each day with a verdict, proposes bounded actions and proves incremental margin. That created useful infrastructure, but it made Daily Brief, module pages and action loops feel like the product centre.

The new direction makes Merchant Memory the central product object. Daily briefs, recommendations, watchdog alerts and actions become consumers of that memory, not the source of truth.

## Valuable Components To Retain

- Shopify ingestion, webhook verification, backfill jobs and canonical commerce storage.
- Source event ledger and idempotency practices.
- Deterministic COGS, sales, margin, inventory and anomaly calculations.
- Goals and House Rules as merchant-confirmed constraints.
- Action safety, approvals, executions, holdouts, attribution and provenance patterns.
- Changelog and testing expectations.
- Polaris app shell and existing onboarding routes as a future review surface base.

## Components To Adapt

- Onboarding should infer and present a draft Merchant Memory, not only collect setup fields.
- Daily Brief should be generated from confirmed memory plus current deterministic evidence.
- Feedback should become correction/version input for Merchant Memory.
- Existing `provenance_links` should either link to memory claims or be complemented by memory-specific evidence links.
- Daily Verdict, Watchdog, Inventory Guardian and Klaviyo services should emit deterministic facts/evidence for memory synthesis before producing merchant-facing conclusions.

## Misleading Or Obsolete Components

- Active context and former planning files framed around holdout-verified margin as the north star.
- Prompts that instruct agents to build Daily Verdict modules as the core roadmap.
- Navigation and product copy that imply the app is a set of modules rather than an inspectable understanding of the merchant.
- Any future implementation that lets LLM output bypass deterministic facts and merchant correction.

## Prompt Audit

| Previous prompt | Classification | Action |
| --- | --- | --- |
| `prompts/first_conductor_prompt.md` | Obsolete | Archived because it points agents at the previous MVP modules and old `docs/context` flow. |
| `prompts/pr_review_checklist.md` | Reusable after modification | Archived for now; useful review categories remain, but product checks must be rewritten around Merchant Memory. |

New active prompts now cover onboarding synthesis, memory revision, question generation, recommendations and consistency review.

## Data Model Change Risks

- Existing migrations may be deployed; do not drop or rename tables during reorientation.
- Daily brief/action JSON payloads may be relied on by app surfaces.
- `HouseRule` and `Goal` should not be duplicated into memory as untraceable text; they should be referenced or copied with provenance and versioning.
- Claims need status semantics so model inference cannot silently become fact.
- Merchant corrections must supersede earlier claims without overwriting history.

## First Merchant Gaps

- No durable Merchant Memory document/version/claim schema.
- No service contract for deterministic facts and evidence items feeding memory synthesis.
- No prompt set for onboarding synthesis, revision, question generation, recommendations or consistency review.
- No review/correction UI focused on confirming memory.
- No explicit pilot workflow showing what can be manual for merchant one.

## Recommended Target Architecture

Use this flow:

Commerce sources -> raw events/source records -> deterministic facts/features -> evidence items -> Merchant Memory claims/beliefs/questions -> merchant confirmation/correction -> new memory version -> recommendations/actions.

Near term, implement a hybrid model:

- Queryable relational records for evidence, claims, corrections, questions and recommendations/actions.
- Versioned JSON document snapshots for rendering and reconstruction.
- Existing canonical commerce records remain the deterministic source for calculable facts.

Later, add richer section editors, derived-feature snapshots and consistency review jobs only when the first merchant loop needs them.

## Retain / Adapt / Deprecate / Remove

| Component | Decision | Reason |
| --- | --- | --- |
| Shopify ingestion/backfill/webhooks | Retain | Required source data for first merchant memory. |
| Source event ledger | Retain | Provenance and point-in-time reconstruction base. |
| Canonical products/orders/inventory/customers | Retain | Deterministic facts depend on these records. |
| COGS support | Retain | Product economics and confidence require it. |
| House Rules/goals | Adapt | Become merchant-confirmed memory inputs and constraints. |
| Onboarding | Adapt | Shift from setup checklist to memory review/correction loop. |
| Daily Verdict/Daily Brief | Adapt | Consume memory; do not remain product centre. |
| Inventory Guardian/Watchdog | Adapt | Emit evidence/facts and optionally recommendations. |
| Klaviyo winback | Adapt later | Useful recommendation/action path after confirmed memory exists. |
| Feedback engine | Adapt | Corrections and confirmations become memory-version events. |
| Action provenance/safety | Retain | Still required for bounded action execution. |
| Cost metering | Retain | Useful operating control. |
| Old context/prompts | Deprecate | Archived as historical, not authoritative. |
| Existing migrations | Retain | Do not destructively rewrite deployed history. |
