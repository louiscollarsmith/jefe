# 06 — Pilot Fast Path and Integrations

## Shopify surface

- Embedded App Bridge app
- App Home as home base
- Shopify OAuth/token exchange
- Admin GraphQL as default API surface
- Bulk Operations for backfill
- HMAC-verified webhooks for freshness

## Required webhook areas

- orders
- refunds
- products
- inventory
- app/uninstalled
- compliance topics

## Day-0 filings

File on day 0. Do not let these gate week one.

### Shopify

File:
- public App Store review with minimal scopes
- protected customer data Level 2 review

Pilot fast path:
- custom/unlisted installs per design-partner store

### Klaviyo

File:
- public app review for eventual listing

Pilot fast path:
- merchant-generated private API keys

### Meta

File:
- Marketing API app review for standard access

Pilot fast path:
- system-user token generated in merchant's own Business Manager
- or report exports

### Google

File:
- Google Ads developer token application

Pilot fast path:
- GA4 OAuth test-mode consent screen for conversion/traffic context

### Gorgias / 3PL / Stripe

File:
- OAuth apps where applicable

Pilot fast path:
- not required for first write loop
- added only when they improve recommendations

## MCP stance

Use MCP for:
- long-tail reads
- discovery
- optional future integrations

Do not use MCP for:
- production writes
- core execution paths
- systems requiring idempotency, retries, rate-limit handling and approved scopes

Core connectors should use:
- first-party OAuth/apps where possible
- typed adapters
- explicit scopes
- idempotency keys
- dry-run support where possible

## No god-agent rule

No model talks directly to third-party APIs with broad tokens.
