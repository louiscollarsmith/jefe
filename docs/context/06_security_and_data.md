# Security and Data

This product touches commerce data, customer data, email platforms, ads, support and inventory.

Security is part of the product.

## Principles

- least privilege
- explicit scopes
- HMAC verification
- deduped webhooks
- encrypted secrets
- audit logs
- approval before writes
- idempotent execution
- no god-agent
- no production secrets exposed to AI tools

## Shopify

Plan for protected customer data Level 2 if using:
- customer name
- email
- phone
- address

Mandatory compliance handling:
- customers/data_request
- customers/redact
- shop/redact
- app/uninstalled

## Execution safety

For reversible actions:
- support preview
- support diff
- support rollback

For irreversible actions:
- blast-radius caps
- staged rollout
- approval required
- cooldowns
- max segment size
- max discount
- max daily send delta

You cannot unsend an email. Caps are the honest version of undo.
