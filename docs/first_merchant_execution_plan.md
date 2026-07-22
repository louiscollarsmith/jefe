# First Merchant Execution Plan

## Goal

Produce one useful Merchant Memory from real Shopify data, have the merchant confirm/correct it, save a revised version, and generate one recommendation from confirmed memory.

## Shortest Credible Path

1. Connect the first merchant's Shopify store through the existing app install path.
2. Run existing Shopify backfill for products, variants, inventory, orders, line items, refunds and customer identities.
3. Manually verify imported counts against Shopify admin exports for the first merchant.
4. Run deterministic feature generation from existing services: product performance, revenue/margin coverage, inventory risk, refund/anomaly checks and COGS gaps.
5. Store evidence items for the facts used in synthesis.
6. Run onboarding synthesis prompt with deterministic evidence and current goals/House Rules.
7. Save Merchant Memory version 1 as draft claims, beliefs and open questions.
8. Present the memory to the merchant in a founder-assisted review. UI can initially be rough or admin-assisted.
9. Capture confirmations, corrections and answers.
10. Save Merchant Memory version 2 with confirmed/superseded statuses.
11. Generate one recommendation using confirmed memory plus current evidence.

## Manual For Merchant One

- Founder-assisted install and data sanity check.
- Manual COGS gap review for high-revenue products.
- Manual copy/paste of synthesis output into the review flow if UI is incomplete.
- Founder review of all recommendations before showing them.

## Must Be Automated

- Shopify ingestion and dedupe.
- Canonical commerce persistence.
- Deterministic calculation of evidence used for claims.
- Memory version persistence.
- Correction capture without overwriting history.
- Provenance from claims back to evidence.

## Deferred Before Percival

- Self-serve multi-step polished memory editor.
- Multi-store RBAC.
- Fully automated Klaviyo action execution.
- New third-party integrations beyond Shopify unless Percival requires them.
- Vector DB, graph DB or generic agent framework.

## Failure Modes

- Shopify historical data is incomplete.
- COGS coverage is too low for confident margin claims.
- Memory overstates model inference as fact.
- Merchant corrections are stored as notes but do not update claims.
- Recommendation generator ignores confirmed corrections.

## Success Criteria

- Merchant says the revised memory accurately describes how the business works.
- Every important claim has status, confidence and provenance.
- At least one merchant correction supersedes an earlier inference in storage.
- One recommendation cites confirmed memory and deterministic evidence.
- No external write action occurs without explicit approval.
