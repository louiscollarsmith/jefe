# 10 — Security, Privacy and Operational Reality

## Security is product

Jefe handles:
- commerce data
- customer data
- email platforms
- ads
- support systems
- inventory
- operational recommendations

Security and liability are not afterthoughts.

## Controls

### Auth and least privilege

- Shopify OAuth
- OAuth2 for connectors where supported
- read/write tokens split per connector
- minimal scopes

### Secrets

- Secret Manager
- production secrets never exposed to AI coding tools
- redacted dev/test contexts only

### Encryption and residency

- TLS in transit
- encryption at rest
- CMEK where governance requires
- merchants pinned to EU/UK or NA regions
- inference residency addressed explicitly
- EU/UK merchant data routed to EU inference endpoints where contractually required
- disclose inference/subprocessor setup in DPA

### Data protection

- DPA with subprocessor list including model providers
- TTLs by data class
- Shopify compliance webhooks honoured
- derived stores redacted where required

### Liability and insurance

Professional indemnity / E&O cover from the first paying customer.

Terms should frame outputs as recommendations executed with merchant approval, with liability caps.

An accountable operator that drafts POs and sends discounts to thousands of customers invites operational liability most AI app companies ignore.

### Audit

Immutable logs for:
- connector auth changes
- exports
- approvals
- privileged access
- external writes
- House Rules changes

## AI tool boundary

AI coding tools may not access:
- production secrets
- real customer PII
- live merchant credentials
- production databases

Use redacted fixtures and mocked data.
