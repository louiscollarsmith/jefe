# AGENTS.md

## Product

Jefe builds and maintains a living understanding of each merchant's business.

The central product object is **Merchant Memory**: a durable, structured, versioned record of facts, merchant-confirmed facts, model inferences, uncertainties, goals, constraints, operating rules, current priorities, corrections and history.

Jefe is not an analytics dashboard, a chatbot, an ungrounded autonomous agent, or a collection of ecommerce modules.

## North Star

Produce Merchant Memory so accurate that the merchant says:

> Yes. That's exactly how my business works.

Everything else exists to create, improve, inspect, correct or use that memory.

Merchant Memory is the substrate, not the destination. The destination is for Jefe to operate as the merchant's **eCommerce manager** — **taking autonomous action from install** (founder rule, 2026-07-30: autonomy is the default, **not** advisory-for-months). Two action modes are available per action type from the start: **(1) approve→execute** — the merchant approves a recommendation and Jefe executes it via a typed reversible adapter — and **(2) fully autonomous** — Jefe acts through the same adapter without asking and reports what it did. Which mode applies is set by **policies/permissions per action type** (built as the action layer matures), not by a slow advisory ramp. Autonomy ("don't ask") and the safety machinery (typed, idempotent, reversible adapters, blast-radius caps, merchant-as-principal) are **orthogonal**: Mode 2 still acts *through* the machinery, just without the tap. The external-write guardrails in Implementation Rules are exactly what make fast autonomy safe — **more** discipline, not less — and stay permanent. Advice is **LLM-generated from memory with typed primitives to execute** — one action ontology, never a bespoke shaper per action, never generic or ungrounded. Memory itself is fed from everything the merchant has — deterministic commerce data, their corrections, uploads of any type (text/docs/images/audio/video → LLM analysis), and connected repositories (Notion / Drive / Gmail). The merchant is always the principal — they set goals and autonomy levels and can veto or reverse any action. First action type: dead-stock clearance.

## Authoritative Context

Read in this order before coding:

1. `AGENTS.md`
2. `HANDOVER.md`
3. `CLAUDE.md`
4. `context/00_north_star.md`
5. Relevant files in `context/`

Historical context, reset audits and previous product prompts live under `docs/archive/`. They are not authoritative unless a founder explicitly reactivates a specific idea in current instructions.

## Architecture Principles

- Commerce sources feed raw events and source records.
- Deterministic code computes facts and features.
- Evidence items connect facts to source records and ledger events.
- LLMs interpret evidence into claims, beliefs, questions and recommendations.
- The application decides what is persisted.
- Merchant corrections supersede model inference.
- Memory updates create new versions; do not overwrite history.
- Inferred claims need provenance and confidence.
- Never allow inferred information to silently become fact.
- Migrations must be additive, safe and reversible unless explicitly approved.
- Every subsystem is observable by default: it logs through the structured logger with redaction, lets failures surface to the central error hooks, and exposes a health/self-check for any new service or external dependency.

## Implementation Rules

- Inspect existing code before replacing it.
- Preserve useful Shopify ingestion, canonical commerce records, ledger, provenance, approval and action-safety patterns where they currently exist.
- Do not resurrect retired COGS dashboard, Daily Brief, Klaviyo Winback, Watchdog or old operator-roadmap code from archived material.
- Do not expose production secrets or production customer data to AI tools.
- Do not let any LLM directly mutate Shopify, Klaviyo or third-party systems.
- External writes require typed adapters, idempotency keys, previews, approval gates and blast-radius caps.
- Use TypeScript types properly and keep changes scoped to the user's current request.
- Log all server-side events through the structured logger (`apps/shopify/app/lib/observability/logger.server.js`), never bare `console.*`. Log identifiers and metadata, never request/response payloads, secrets or customer PII — redaction is a safety net, not permission to log sensitive data. Let thrown errors surface to the central hooks (`handleError` in `entry.server.tsx`, route error boundaries) rather than swallowing them, and add a health signal for any new external dependency. See `apps/shopify/docs/observability.md`.
- Shopify embedded merchant UI must use Shopify Polaris React components for visible layout, navigation, forms, tables, feedback and actions.

## Shared Working Tree

Multiple Claude Code sessions work concurrently in this one tree, and the git **index/staging area is shared** across all of them.

- **Isolate by default:** new sessions work in their own `git worktree` + branch (`git worktree add .claude/worktrees/<name> -b claude/<name>`) — physical isolation is the reliable fix and depends on nothing being wired. Coordinate via worktrees + cross-session messages. Only the main checkout pushes `origin/main`; worktree branches land via rebase → ff-merge → single push. Full model: `docs/ops/build-deploy-and-coordination.md`.
- **Pathspec-commit, always:** `git commit -- <explicit paths> -m "…"`. Never a bare `git commit` / `git commit -a` — it commits the entire shared index and will sweep another session's staged files into your commit (this happened twice on 2026-07-28).
- **Never** `git add -A` or `git add <dir>`; stage explicit paths only.
- Stage and commit **atomically**, and verify `git diff --cached --name-only` shows only your files first.
- Leave another session's uncommitted work unstaged. You may edit another session's files, but ask that session first, per file — use the cross-session message tool.

## Architecture Decisions

Architecture, design, refactor and cross-cutting **consistency** decisions are owned by the **architecture session** (currently "Jefe chat 7 — architecture", 2026-07-29). Route those questions there via cross-session message rather than to the founder, so decisions stay coherent across sessions. The architecture owner escalates to the founder only what is genuinely his: product scope, irreversible / one-way-door changes, and safety-rail / merchant-write-guardrail questions. This binds current and future sessions; when the role passes to a successor, update the holder named here. Details and the coordination model: `docs/ops/build-deploy-and-coordination.md`.

## Before Coding

Restate the task, list files you expect to change, and state assumptions or blockers.

For UI work, state:

- What is the page's job?
- What is the one thing the user should do?
- What should be visually dominant?
- What can be secondary or hidden?
- What should not be shown?
- Proposed layout

## Before Finishing

- Update `apps/shopify/CHANGELOG.md` using today's UK/London date.
- Use merchant/operator-facing language.
- Confirm new server code is observable: it logs through the structured logger, captures/propagates errors to the central hooks, and (for any new endpoint, service or dependency) has a health or self-check. See `apps/shopify/docs/observability.md`.
- Run typecheck, lint and tests where available.
- Summarise changes, risks, follow-up work and any checks that could not be run.
