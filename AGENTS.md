# AGENTS.md

## Project

We are building an AI ecom manager for Shopify merchants.

The product is not a generic analytics dashboard, chatbot, or Shopify Sidekick clone. It is an accountable ecommerce operator that reads merchant data, produces a daily verdict, recommends money-making or protective actions, executes approved actions, and learns from outcomes.

## North star

Deliver holdout-verified incremental margin per merchant per month.

The product must prove value through:
- verified revenue/margin created
- prevented losses such as stockouts or silent breakages
- merchant-approved actions with traceable outcomes

## MVP

Build a Shopify embedded app with:

1. Daily Verdict
   - contribution margin by SKU/channel
   - revenue, refunds, COGS, shipping, spend where available
   - plain-English conclusion, not just charts

2. Inventory Guardian
   - stockout prediction
   - reorder recommendation
   - £ at risk
   - PO/email draft

3. Watchdog
   - anomaly detection
   - conversion drops
   - refund spikes
   - stock/sales anomalies
   - obvious operational breakages

4. One measured write loop
   - Klaviyo winback campaign
   - approval required
   - randomised holdout
   - blast-radius caps
   - weekly result: “we made you £X, verified”

5. Feedback Engine
   - merchant can give feedback in-app
   - feedback is distilled into Linear/product tasks
   - feature requests are weighted by customer value and churn risk

## What not to build yet

Do not build:
- full autopilot
- ad write actions
- theme widgets
- product copy automation
- complex RBAC
- multi-language support
- fine-tuning
- dedicated vector DB
- generic multi-agent system
- generic chatbot interface

## Architecture principles

- Event-first immutable ledger
- Postgres as primary database
- TypeScript-first stack
- Shopify App Bridge embedded app
- Shopify Polaris UI
- Typed connectors, no god-agent
- HMAC-verified webhooks
- Idempotent execution jobs
- Evidence-first recommendations
- Human approval before writes
- Holdout-based attribution where possible
- Batch learning, no online self-modifying model behaviour

## Agent behaviour rules

Before coding:
1. Read this file.
2. Read relevant `/docs/context` files.
3. Restate the task in your own words.
4. Identify files you will change.
5. Confirm assumptions if unclear.

When coding:
- Keep changes small.
- Add tests.
- Use TypeScript types properly.
- Avoid unnecessary dependencies.
- Never add production secrets.
- Never request broad Shopify scopes without justification.
- Never let LLM output directly mutate external systems.
- All external API writes must go through typed adapters with idempotency keys.

Before finishing:
- Run tests/typecheck/lint.
- Summarise changes.
- List risks.
- List follow-up tasks.
