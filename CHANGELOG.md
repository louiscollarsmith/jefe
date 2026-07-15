# Changelog

## 2026-07-15

### Added

- Added a shared action safety lifecycle for proposals, approvals, executions and verification states.
- Added Klaviyo Winback v0 so Jefe can identify dormant customers, prepare an approval-gated draft, apply House Rules and hold back a measured control group without sending automatically.
- Added fixture customers to the dev dummy store and Watchdog scenario orders so winback testing has reachable test buyers attached to orders.
- Added a dev Klaviyo Winback scenario loader with 60-180 day customer orders for winback testing.

### Changed

- Renamed Today’s Verdict to Revenue & Margin so Daily Brief is clearly the main morning summary and Revenue & Margin is the detailed performance view.
- Added more bottom spacing across the app so the final card on each page can scroll comfortably above the bottom edge.
- Replaced the Daily Brief manual generate button with scheduled status copy and moved test generation to the Dev page.
- Reduced duplication between Daily Brief and module pages so Daily Brief acts as the main morning summary and detail pages focus on evidence.
- Removed the separate fixture-customer dev action now that fixture customers are included by default.
- Clarified Klaviyo Winback approval states so draft preparation is not shown as merchant approval.
- Updated Klaviyo Winback so draft preparation, approval, execution and verification are recorded as separate safety states.
- Added clearer Klaviyo Winback mode, holdout group and estimated upside copy.
- Added a deterministic Klaviyo Winback email copy preview before approval.

### Fixed

- Fixed the Klaviyo private key field so pilot stores can enter and save their key reference.
- Fixed Klaviyo Winback empty-state copy so it explains when test orders are too recent instead of implying emails are missing.
- Fixed Klaviyo Winback audience filtering so Shopify customer account state does not suppress marketable buyers and reused emails are grouped consistently.
- Fixed House Rules saving so edited caps and unchecked rule toggles are submitted reliably from Manager Settings.
- Clarified Klaviyo Winback holdout copy so measurement controls are not confused with House Rules exclusions.
- Added Klaviyo Winback economics detail so estimated upside is shown separately from discount cost before approval.
- Fixed the Klaviyo Winback approval queue badge so preparing a draft does not display as merchant approval.

---

## 2026-07-14

### Added

- Added Daily Brief v0 with one morning operator brief across Today's Verdict, Inventory Guardian and Watchdog.
- Added Inventory Guardian v0 with stockout risk, sales velocity, revenue-at-risk and reorder quantity estimates.
- Added Watchdog v0 with read-only alerts for refund spikes, sales collapses, revenue drops, missing product costs and other operational anomalies.
- Added Changelog v0 inside the Shopify app and made changelog updates part of the agent workflow.
- Added changelog rules for future tickets and PRs.
- Added Shopify embedded app scaffold.
- Added Today's Verdict page.
- Added onboarding for goals, House Rules and COGS.
- Added Daily Verdict v0 with revenue, net after refunds, margin confidence and product highlights.
- Added COGS confidence handling for missing, estimated and confirmed product costs.
- Added dev-only Shopify scenario seeding for refund spikes, sales collapse, unavailable products, revenue drops, missing COGS sellers and high-return products.

### Changed

- Improved Watchdog alert cards so incident details, evidence and suggested checks are easier to scan.
- Improved Watchdog sales-collapse alerts with clearer baseline evidence and suggested checks.
- Improved Inventory Guardian ordering so active revenue-at-risk items appear before zero-risk inventory notes.
- Improved Shopify app page headers so Inventory Guardian, Manager Settings and Changelog use consistent single-title layouts.
- Improved Inventory Guardian so out-of-stock variants with no recent demand are separated from active stockout risks.
- Improved the Daily Verdict page with a clearer hero verdict, separated metric cards, tighter status header, an operator brief section and cleaner product insight cards.
- Improved the Changelog page so it reads as a clean left-aligned vertical product update feed.
- Updated House Rules to include winback discount cap, campaign audience approval threshold, email cooldowns and BFCM freeze mode.
- Improved House Rules defaults and merchant-facing helper copy.
- Moved MVP status and dummy store data controls to a dev-only page.

### Fixed

- Fixed dev-only Shopify scenario loading so partial runs can resume without duplicating existing products, orders or refunds.
- Fixed Inventory Guardian confidence so zero-risk variants do not drag down the overall risk confidence.
- Fixed Inventory Guardian money displays so variant prices are no longer shown as currency prefixes.
- Fixed COGS behaviour so entering a valid manual cost defaults confidence to confirmed.
- Fixed COGS behaviour so clearing a value returns confidence to missing.
- Fixed Daily Verdict loading so dev-only dummy store checks no longer obscure or slow the homepage.

---

## 2026-07-13

### Added

- Added Shopify ingestion foundations for products, orders, refunds and inventory updates.
