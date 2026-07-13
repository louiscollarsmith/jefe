# AGENTS.md

## Project

We are building **Jefe**, an accountable AI ecom manager for founder-run Shopify brands.

The product is not:
- a generic analytics dashboard
- a chatbot
- a Shopify Sidekick clone
- a broad autonomous agent
- a feature factory

It is an accountable ecommerce operator that reads the merchant's commerce stack, opens every day with a verdict and money at stake, executes bounded actions only with approval, obeys the merchant's written House Rules, and proves incremental margin using holdouts.

## North star

Holdout-verified incremental margin delivered per merchant per month.

Separate verified and estimated value:
- **Verified lift** = holdout-measured or network-verified incremental revenue/margin.
- **Estimated prevention** = Watchdog/stockout counterfactuals.
- These must never be blended into one merchant-facing total.

## ICP

Founder-run Shopify brands doing roughly **£30k–£250k/month GMV**.

Ideal early customer:
- founder/operator feels the pain directly
- no dedicated ecommerce manager
- enough volume for operational mistakes to matter
- likely using Klaviyo and/or Gorgias
- willing to grant read access and test a managed pilot

## Product identity

Ambient assistants wait to be asked.
A manager summons the merchant with a verdict.

The embedded Shopify App Bridge app is the home base. The daily brief travels by email/Slack/WhatsApp at 7am and deep-links back into the app for evidence, previews and approvals.

## MVP

The MVP is broad on reads and narrow on writes.

Build:

1. Daily Verdict
   - true contribution margin by SKU/channel where possible
   - confidence ranges where COGS is missing
   - evidence links
   - plain-English conclusion, not just charts

2. Inventory Guardian
   - stockout/reorder radar
   - velocity maths v0
   - £ at risk
   - PO/email draft later

3. Watchdog
   - threshold/rules-based silent breakage detection
   - conversion anomalies
   - ad sets beyond CPA thresholds
   - discount stacking
   - refund/return spikes
   - metric regressions

4. Klaviyo winback write loop
   - merchant private key for pilot
   - dormant customer segment
   - randomised holdout
   - staged send 10% → 90%
   - blast-radius caps
   - approve-in-app
   - weekly verified P&L line

5. Feedback Engine
   - capture screen/voice/text feedback
   - LLM distils
   - merchant confirms
   - route to Linear
   - £-weighted ordering
   - changelog close-the-loop

6. House Rules + goals
   - 3/6/12-month goals
   - merchant constitution
   - max discounts
   - email frequency limits
   - brand voice
   - protected hero products
   - margin vs volume priorities
   - rules cited in every proposal

## Explicit MVP non-goals

Do not build in MVP:
- ad-budget write paths
- generic product-copy automation
- generic merchandising/theme widgets
- full internationalisation
- full agency/multi-store RBAC
- unbounded autopilot
- online learning / online model weight updates
- foundational model fine-tuning
- dedicated vector DB
- dedicated graph DB
- Kubernetes
- Redis unless proven necessary
- broad MCP-based production writes
- any LLM direct access to external APIs with broad tokens

## Architecture principles

- Event-first immutable ledger
- Postgres-first
- JSONB for connector payloads
- pgvector only if needed later
- Point-in-time rebuilds from ledger + snapshots
- HMAC-verified webhooks
- Dedupe keys
- Queue-backed execution
- Typed connector adapters
- Idempotency keys on every write path
- Dry-run previews where possible
- Approval gates
- Blast-radius caps
- House Rules enforced by construction
- Provenance links for every recommendation
- Batch ranking/calibration updates only
- No LLM may directly mutate Shopify, Klaviyo, Meta, Google or any third-party system

## AI coding rules

Before coding:
1. Read AGENTS.md.
2. Read CLAUDE.md.
3. Read relevant files in `/docs/context`.
4. Restate the task.
5. List files you expect to change.
6. State assumptions and blockers.

When coding:
- Keep changes small.
- Stay inside the ticket.
- Add tests.
- Use TypeScript types properly.
- Avoid unnecessary dependencies.
- Shopify embedded app UI must use Shopify Polaris React components for visible layout, navigation, forms, tables, feedback and actions. Do not build merchant-facing Shopify UI with App Bridge web components, raw HTML controls, or ad hoc CSS unless there is a written exception in the ticket.
- Never add production secrets.
- Never request broad Shopify scopes without a written reason.
- Never expose production customer data to AI tools.
- Never implement unapproved external write actions.

Before finishing:
- Run typecheck.
- Run lint.
- Run tests.
- Summarise changes.
- List risks.
- List follow-up tickets.
