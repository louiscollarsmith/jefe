# AI Development Workflow

The company should be built AI-first, but not AI-chaotic.

Humans are orchestrators:
- product decisions
- architecture decisions
- security decisions
- reviewing PRs
- testing with merchants
- deciding tradeoffs

Agents implement:
- scaffolding
- migrations
- connectors
- UI components
- tests
- docs
- refactors
- bug fixes

## Workflow

1. Human writes ticket.
2. Conductor assigns to coding agent.
3. Agent reads AGENTS.md and relevant context files.
4. Agent creates branch.
5. Agent implements.
6. Agent runs tests/lint/typecheck.
7. Agent opens PR with summary and risks.
8. QA/security agent reviews.
9. Human approves merge.

## Ticket format

Each ticket must include:

- Goal
- Context
- Files likely involved
- Acceptance criteria
- Tests required
- Out of scope
- Security notes

## Do not allow

- agents auto-merging to main
- agents accessing production secrets
- agents changing architecture without approval
- agents adding dependencies casually
- agents expanding Shopify scopes without written justification
- agents building extra features outside ticket scope
