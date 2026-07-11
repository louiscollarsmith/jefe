# 03 — MVP Scope and Modules

## Founder call

The MVP is broad on reads and narrow on writes.

It ships:
- Daily Verdict
- Inventory Guardian
- Watchdog
- Klaviyo winback loop
- Feedback Engine
- House Rules + goals

The risk is Verdict accuracy on messy real data. Mitigation:
- confidence ranges
- AI-assisted COGS onboarding
- founder-assisted setup for first stores
- hardening in production during weeks 2–6

## Daily Verdict

### What it does

True contribution margin by SKU and channel:

- Shopify revenue
- read-only Meta/Google spend where available
- COGS
- shipping
- refunds/returns where possible

Example:

> You made £4.1k this week; SKU-12 loses money after shipping; here is why.

### Why it matters

Merchants do not want another dashboard. They want the conclusion.

### Behaviour

- ships with confidence ranges until COGS gaps close
- clearly labels missing data
- shows evidence links
- avoids false precision

## Inventory Guardian

### What it does

Stockout/reorder radar:

- sales velocity
- current inventory
- projected stockout date
- £ at risk
- reorder quantity suggestion

Example:

> £6.2k at risk — reorder 400 of X by Tuesday.

### v0

Velocity maths only.

### Later

- PO draft
- supplier chasing
- delay tracking

## Watchdog

### What it does

Silent-breakage detection as a thin thresholds-and-rules layer:

- conversion anomalies after theme updates
- ad sets past 3× CPA
- discount stacking
- refund spikes
- return-rate outliers
- metric regressions
- product suddenly unavailable
- stock/sales anomalies

### Why it matters

Insurance value builds trust faster than optimisation.

One 2am catch can pay for a year of fees.

## Klaviyo winback loop

### What it does

- identifies dormant customers
- creates segment
- creates campaign draft
- randomised holdout
- staged send 10% → 90%
- blast-radius caps
- approve-in-app
- weekly verified P&L line

### Why it matters

Clean first proof of incremental margin.

## Feedback Engine

Capture → interpret → confirm → Linear → £-weighted ordering.

Live from store one.

## House Rules + goals

Merchant constitution and 3/6/12-month goals captured at onboarding.

Rules cited in every proposal.

This is the manager identity, enforced by construction.
