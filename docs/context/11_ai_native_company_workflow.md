# 11 — AI-Native Company Workflow

## Principle

AI builds most of the product inside a strict review boundary.

Humans own:
- architecture
- product taste
- code review
- security posture
- customer relationships
- investor communication
- final shipping decisions

## Engineering

AI responsibilities:
- UI components
- adapters
- tests
- migrations
- docs
- Terraform drafts

Human responsibilities:
- architecture
- PR review
- enforced tests
- security

## QA

AI responsibilities:
- regression tests
- connector simulation
- eval datasets
- backtest harnesses

Human responsibilities:
- release gates
- edge-case inspection

## Product

AI responsibilities:
- cluster feedback
- draft specs
- draft changelog updates

Human responsibilities:
- decide what ships

## Support

AI responsibilities:
- summarise issues
- propose help docs
- route bugs

Human responsibilities:
- escalations
- learning from churn

## Sales/GTM

AI responsibilities:
- lead research
- personalised drafts
- teardown narratives
- follow-ups

Human responsibilities:
- claims control
- relationships
- investor communication

## Repo rules

- protected branches
- required approvals
- status checks
- no AI-generated merge without tests
- dependency additions require lock files and scanning
- no auto-merge on new dependencies
- AI-assisted PRs labelled
- trace notes kept for major generation sessions
