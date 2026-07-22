# 04 — Teardown, COGS and Onboarding

## Free AI teardown

Funnel promise:

> £X left on the table in 48 hours.

But the first number must be defensible.

Do not lead with margin claims before COGS exists.

## COGS-free computables

The teardown should use:

- dormant-customer revenue from order history
- stockout risk from velocity vs inventory
- discount-stacking leaks
- return-rate outliers
- obvious refund spikes
- product unavailable / inventory anomalies
- revenue leakage that does not require cost data

Margin verdicts arrive after onboarding or are clearly labelled as network-benchmark estimates.

## The COGS trap

COGS is messy. Merchants often leave cost-per-item half-empty.

Do not make COGS a prerequisite that merchants abandon on.

## COGS onboarding

Make completion a ten-minute AI-assisted chore:

- import supplier invoices
- upload spreadsheet
- parse CSV
- infer missing values from category benchmarks
- ask merchant to confirm
- show confidence ranges until gaps close

## UX principle

The system should say:

> Margin confidence is medium because 38% of products are missing cost data.

Not:

> We cannot continue until you fill everything in.

## Data model

Add/prepare:
- `cogs_inputs`
- source type: manual, csv, invoice, benchmark, inferred
- confidence
- confirmed_by_merchant
- effective date
- product/variant mapping

## First trust rule

The first number a prospect sees must be defensible, or the product becomes the inflated-audit tool it defines itself against.
