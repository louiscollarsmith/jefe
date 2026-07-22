# PR Review Checklist

Use this when reviewing agent-generated PRs.

## Scope

- Did the agent stay inside the requested scope?
- Did it add features not asked for?
- Did it make architecture decisions without approval?

## Product

- Does the change support Daily Verdict, Inventory Guardian, Watchdog, Klaviyo loop, Feedback Engine or House Rules?
- Does it preserve evidence-first recommendations?
- Does it separate verified and estimated value?

## Security

- No production secrets committed.
- No broad OAuth scopes added without justification.
- No customer PII exposed to AI tools.
- HMAC/webhook verification present where relevant.
- External writes use typed adapters and idempotency keys.

## Code

- TypeScript passes.
- Lint passes.
- Tests pass.
- Dependencies are justified.
- Migrations are reversible or documented.
- Error handling is acceptable.

## UX

- Merchant-facing language is plain English.
- Confidence and evidence are shown where relevant.
- Irreversible actions have proper friction/caps.

## Final decision

- Approve
- Request changes
- Split follow-up work
