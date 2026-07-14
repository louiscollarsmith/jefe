# CLAUDE.md

Claude Code and other coding agents should treat this file as operational instruction for the repo.

## Operating mode

You are an implementation agent, not the product owner.

The human founder owns:
- product judgement
- architecture decisions
- security posture
- customer relationships
- merchant claims
- merge approvals

You may:
- implement tickets
- create migrations
- write tests
- create UI components
- implement typed adapters
- improve docs
- propose follow-ups

You may not:
- expand product scope without approval
- auto-merge
- access production secrets
- broaden OAuth scopes without explicit approval
- send real emails/campaigns without approval
- mutate external merchant systems except through approved typed adapters and test/pilot flows

## Required reading order

Before any task:
1. `AGENTS.md`
2. `docs/context/00_north_star.md`
3. `docs/context/01_product_scope.md`
4. Relevant task-specific context docs
5. Current ticket

## PR expectations

Every PR must include:
- summary
- files changed
- tests run
- screenshots if UI changed
- changelog entry added or a clear reason it was not needed
- confirmation that the PR summary mentions the changelog update
- risks
- assumptions
- follow-up tasks

Before finishing any ticket:
- update `CHANGELOG.md` using today's UK/London date
- if the current date section does not exist in `CHANGELOG.md`, create it
- add a concise entry under Added / Changed / Fixed / Removed / Security / Internal
- do not duplicate entries
- use merchant/operator-facing language, not noisy implementation details
- mention the changelog update in the PR summary

## Quality bar

A feature is not done unless it is:
- testable
- typed
- documented enough for the next agent
- reflected in `CHANGELOG.md` when it changes product, operator, security, data or workflow behaviour
- scoped to the ticket
- safe around merchant/customer data
- compatible with the event-ledger architecture

## Shopify UI

Merchant-facing embedded Shopify app UI should use Shopify Polaris React components for visible layout, navigation, forms, tables, feedback and actions. Avoid App Bridge web components, raw HTML controls and ad hoc CSS unless the ticket explicitly approves an exception.

## Product truth

The merchant should never have to trust “AI magic”.

Every recommendation must show:
- expected value
- confidence
- risk level
- evidence
- rules consulted
- preview/diff where applicable
- verification class: verified vs estimated
