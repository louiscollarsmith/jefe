# Decision Log

## Product decisions

- Product is an accountable AI ecom manager, not a dashboard.
- Embedded Shopify app is the home base.
- Daily brief travels to merchant by email/Slack/WhatsApp but links back into app.
- MVP is read-heavy, write-light.
- One measured write loop first: Klaviyo winback with holdout.
- Product must show evidence, confidence and expected value for every recommendation.
- Product must prove outcomes after execution.

## Technical decisions

- TypeScript-first.
- Postgres-first.
- Event ledger from day one.
- pgvector later if needed.
- No dedicated vector DB initially.
- No fine-tuning initially.
- No Redis initially.
- LangGraph optional, not mandatory.
- Postgres-backed state machine plus queue is acceptable.
- First-party OAuth/typed adapters for core integrations.
- MCP only for long-tail reads/discovery, not production writes.

## Go-to-market decisions

- ICP: £30k–£250k/month founder-led Shopify stores.
- Free teardown as acquisition wedge.
- £299/month pilot with case-study rights and holdouts mandatory.
- Later £999–£1,999/month manager mode as autonomy is earned.
- Quiver client network may be useful design-partner pool, subject to legal/non-solicit review.
