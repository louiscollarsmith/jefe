# Changelog

## 2026-07-14

### Added

- Added Inventory Guardian v0 with stockout risk, sales velocity, revenue-at-risk and reorder quantity estimates.
- Added Changelog v0 inside the Shopify app and made changelog updates part of the agent workflow.
- Added changelog rules for future tickets and PRs.
- Added Shopify embedded app scaffold.
- Added Today's Verdict page.
- Added onboarding for goals, House Rules and COGS.
- Added Daily Verdict v0 with revenue, net after refunds, margin confidence and product highlights.
- Added COGS confidence handling for missing, estimated and confirmed product costs.

### Changed

- Improved Inventory Guardian ordering so active revenue-at-risk items appear before zero-risk inventory notes.
- Improved Shopify app page headers so Inventory Guardian, Manager Settings and Changelog use consistent single-title layouts.
- Improved Inventory Guardian so out-of-stock variants with no recent demand are separated from active stockout risks.
- Improved the Daily Verdict page with a clearer hero verdict, separated metric cards, tighter status header, an operator brief section and cleaner product insight cards.
- Improved the Changelog page so it reads as a clean left-aligned vertical product update feed.
- Updated House Rules to include winback discount cap, campaign audience approval threshold, email cooldowns and BFCM freeze mode.
- Improved House Rules defaults and merchant-facing helper copy.
- Moved MVP status and dummy store data controls to a dev-only page.

### Fixed

- Fixed Inventory Guardian confidence so zero-risk variants do not drag down the overall risk confidence.
- Fixed Inventory Guardian money displays so variant prices are no longer shown as currency prefixes.
- Fixed COGS behaviour so entering a valid manual cost defaults confidence to confirmed.
- Fixed COGS behaviour so clearing a value returns confidence to missing.
- Fixed Daily Verdict loading so dev-only dummy store checks no longer obscure or slow the homepage.

---

## 2026-07-13

### Added

- Added Shopify ingestion foundations for products, orders, refunds and inventory updates.
