# Changelog Rules

Every completed ticket or PR must update the changelog.

The source of truth is `apps/shopify/CHANGELOG.md`. This is the file rendered by the production Shopify app.

Do not create or update a root `CHANGELOG.md`.

Use the current UK/London date in `YYYY-MM-DD` format.

Group entries under:

- Added
- Changed
- Fixed
- Removed
- Security
- Internal

Only include user-relevant, operator-relevant, security-relevant, data-relevant or workflow-relevant changes.

Do not include noisy implementation details unless they matter for debugging, security, data integrity or future agents.

## Good examples

- Added Daily Verdict v0 with revenue, margin confidence and product highlights.
- Fixed COGS confidence so blank values are marked as Missing.
- Added Shopify webhook HMAC verification.
- Added House Rules fields for winback discount caps and campaign audience thresholds.

## Bad examples

- Renamed variable x to y.
- Moved file from one folder to another.
- Refactored component props.
