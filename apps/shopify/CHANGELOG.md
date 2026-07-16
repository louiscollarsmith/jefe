# Changelog

## 2026-07-16

### Added

- Added progressive onboarding checklist so merchants can configure Jefe while Shopify data imports.
- Added data-based unlocks for product costs, protected products, first risks and the first Daily Brief.

### Changed

- Consolidated the in-app changelog into one production source of truth.
- Updated Shopify development scopes so local fixture loading can create products, inventory, customers and test orders after reinstall.
- Improved post-install setup from raw import progress to merchant-facing onboarding and readiness.
- Moved Jefe setup out of Daily Brief into a dedicated onboarding flow.
- Hid the main app navigation until required onboarding steps are complete.
- Simplified onboarding into a focused setup hub with one dominant next step.
- Moved setup forms out of the onboarding hub into dedicated setup pages.
- Removed import progress from onboarding so setup stays focused while Shopify data imports in the background.
- Removed the extra setup header and Dev link from the focused onboarding screen.
- Show optional setup steps only after the three required setup steps are complete.
- Moved task page Save and Back actions into the setup header and removed duplicate task section headings.
- Disabled task page Save buttons until the current task has unsaved changes.
- Added editable goal examples so merchants can choose a 3, 6 or 12 month starting point and tailor it.
- Split House Rules into grouped settings sections so discount, messaging, product and approval rules are easier to scan.
- Renamed setup to Onboarding and made approval mode an editable setup choice with consistent status labels.
- Moved onboarding row status badges beside the item title and changed setup actions to Set before completion and Edit after completion.
- Split onboarding into collapsible Required setup and Optional setup cards with a single Complete setup action once required steps are done.
- Refined onboarding setup copy, plural goals wording and title-row completion action placement.
- Removed optional setup skip buttons so optional tasks can simply be left alone until needed.
- Separated Brand Voice and Protected Products into their own optional setup pages instead of showing the full House Rules form.
- Made completed optional setup badges use the same green success treatment as required setup.
- Added an onboarding import-progress step that waits for Shopify import completion and the first generated Daily Brief before opening the app.
- Split guided Onboarding from Manager Settings and added Back/Continue controls to the onboarding import screen.
- Kept onboarding task actions aligned in the top-right header area.
- Clarified onboarding import rows so shop details and webhooks no longer show misleading zero-count imports.
- Simplified onboarding import progress copy and removed the duplicate import status badge.
- Removed redundant helper copy from the onboarding import progress step.
- Updated onboarding completion actions so merchants only see the import step when shop data is still being prepared.
- Removed Onboarding from the main app navigation after first-install setup.
- Enforced onboarding as the app entry until required setup and backfill readiness are both complete.
- Removed the dummy import-progress preview mode.
- Simplified onboarding import badges to Queued, Importing and Completed.
- Updated onboarding import progress to show live database counts and keep merchants on the completed step until they click Complete.
- Redirected all completed onboarding URLs to Daily Brief once required setup and backfill readiness are complete.
- Moved completed-onboarding redirects out of the app shell so embedded navigation renders Daily Brief instead of a blank frame.
- Removed onboarding status badges from Manager Settings.

### Fixed

- Fixed Shopify history setup progress so it polls automatically and reports canonical imported counts.
- Fixed Shopify history import totals so setup progress can show imported records against the expected Shopify count.
- Fixed Shopify history setup copy so queued imports do not show imported-count progress before importing starts.
- Clarified Shopify history setup copy to show the order-history window being imported.
- Fixed the in-app Changelog so production can load the app-local changelog file.
- Fixed Shopify history jobs so stale running work is retried after worker restarts.
- Fixed Dev page fixture status copy so complete seed data is shown as loaded instead of implying records are missing.
- Fixed first app load routing so merchants land on onboarding, import progress or Daily Brief instead of a blank app frame.
- Fixed the import progress screen so it remains inside onboarding and hides the main app navigation until Daily Brief is ready.
- Fixed onboarding import completion so a degraded first Daily Brief still unlocks Continue.

---

## 2026-07-15

### Added

- Added a shared action safety lifecycle for proposals, approvals, executions and verification states.
- Added install-time Shopify backfill so new stores can import products, orders, inventory and customer identities after OAuth without blocking install.
- Added Shopify bulk operations as the primary install backfill path for product and order history imports.
- Added setup progress states so merchants can see Jefe importing Shopify history instead of an empty app.
- Added the single staging deployment plan for Railway, Neon and the Shopify development app.
- Added Klaviyo Winback v0 so Jefe can identify dormant customers, prepare an approval-gated draft, apply House Rules and hold back a measured control group without sending automatically.
- Added fixture customers to the dev dummy store and Watchdog scenario orders so winback testing has reachable test buyers attached to orders.
- Added a dev Klaviyo Winback scenario loader with 60-180 day customer orders for winback testing.

### Changed

- Documented auto-deploy from `main`, staging environment variables, Shopify app URLs and Neon migration flow.
- Renamed Today's Verdict to Revenue & Margin so Daily Brief is clearly the main morning summary and Revenue & Margin is the detailed performance view.
- Added more bottom spacing across the app so the final card on each page can scroll comfortably above the bottom edge.
- Replaced the Daily Brief manual generate button with scheduled status copy and moved test generation to the Dev page.
- Reduced duplication between Daily Brief and module pages so Daily Brief acts as the main morning summary and detail pages focus on evidence.
- Removed the separate fixture-customer dev action now that fixture customers are included by default.
- Clarified Klaviyo Winback approval states so draft preparation is not shown as merchant approval.
- Updated Klaviyo Winback so draft preparation, approval, execution and verification are recorded as separate safety states.
- Added clearer Klaviyo Winback mode, holdout group and estimated upside copy.
- Added a deterministic Klaviyo Winback email copy preview before approval.
- Added degraded behaviour when historical Shopify order access is limited to recent orders.
- Updated backfill progress to show bulk operation status, object counts, fallback use and import completion.

### Fixed

- Fixed Shopify history import compatibility so installs can complete cleanly against the current Admin API.
- Fixed first app load setup so Shopify history import is queued even when Shopify lands directly on Daily Brief.
- Fixed staging scope configuration so Shopify can request extended order history access.
- Improved Railway deployment startup so health checks can reach the Shopify app once required production variables are set.
- Fixed the Shopify app Docker image so Prisma Client is generated during image builds before Railway starts the web service.
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
