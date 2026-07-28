# Growth (Jefe chat 6)

Home for Jefe's **growth infrastructure + commercial** work: outbound (email, partnerships), commercial tracking, and the shared commercial baseline the product sessions build against.

## Docs

- **[commercial-state.md](commercial-state.md)** — the living shared baseline. **Read this first.** Positioning, ICP, activation definition, current status, pricing hypothesis, deliverability, and what each product session should know.
- **[growth-strategy.md](growth-strategy.md)** — the stage-gated plan: 10 → 100 → 1,000 → 10,000.

## Where growth CODE goes

Growth tooling is kept **out of `apps/shopify`** (the product) so it never collides with the four live product sessions that share this tree. Planned home: **`apps/growth/`** (own service/deploy, like `apps/marketing`). `apps/marketing` (the mynamejefe.com waitlist site) is existing and shared — **coordinate before touching it**.

Nothing is scaffolded yet; the first build (a commercial tracker) will create `apps/growth/`.

## Ground rules (chat 6)

- **Reversible → ship.** Docs, internal tooling, instrumentation: build and commit.
- **No real outbound campaign sends without Matt's explicit OK** — same bar the product side holds for real merchant email.
- **Deliverability firewall:** growth outbound uses a **separate sending subdomain**, never the product transactional stream.
- **Shared tree:** stage explicit paths (`git add <path>`), never `-A` or a whole dir. Ask before editing another session's files.

## Coordination protocol

This session feeds a commercial baseline to the product sessions and messages them when something should change their plan. Cross-session steers are logged in `commercial-state.md` (§7 + changelog). Active sessions: chat 2 (onboarding/comms), chat 3 (observability/analytics/cost), chat 4 (merchant memory), chat 5 (feedback triage).
