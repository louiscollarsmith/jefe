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
- Do not expose production secrets or production **merchant-customer** data to AI tools. **Exception — Quiver's own data (founder ruling, 2026-08-12):** *"Quiver owns this data and as Jefe is part of Quiver we can use this data in any way we want to."* Quiver's Redshift warehouse may be read and used freely, including its end-customer fields, for the model-testing corpus (`tools/quiver-corpus`). This does **not** extend to a Jefe merchant's own customers, which stay covered by the rule above. In practice the corpus keeps personal columns **off by default** because the belief layer has no use for them — that is a scope choice, not a policy gate, and turning them on is permitted. See `docs/ops/model-testing-quiver-handover-2026-08-12.md`.
- Do not let any LLM directly mutate Shopify, Klaviyo or third-party systems.
- External writes require typed adapters, idempotency keys, previews, approval gates and blast-radius caps.
- Use TypeScript types properly and keep changes scoped to the user's current request.
- New environment variables must be documented in the relevant `.env.example` in the same change that introduces them. Do not put real secrets in examples. When a PR is merged or a commit is pushed to `main` and it introduces or changes a production-required env var, sync the corresponding Railway production variable as part of the release path, or explicitly record why production does not need it.
- Log all server-side events through the structured logger (`apps/shopify/app/lib/observability/logger.server.js`), never bare `console.*`. Log identifiers and metadata, never request/response payloads, secrets or customer PII — redaction is a safety net, not permission to log sensitive data. Let thrown errors surface to the central hooks (`handleError` in `entry.server.tsx`, route error boundaries) rather than swallowing them, and add a health signal for any new external dependency. See `apps/shopify/docs/observability.md`.
- Shopify embedded merchant UI must use Shopify Polaris React components for visible layout, navigation, forms, tables, feedback and actions.
- **Design fidelity — wire-or-keep, never wire-or-remove (founder directive, 2026-07-31).** When implementing a design, build every element to spec. If a control/feature/section isn't wired or working yet, **keep it visible per the design and create an engineering task to build it out** — do not remove, hide, or read-only-gate a design element just because its backing isn't ready. A subtle "soon" indicator is optional, not required. This intentionally overrides the stricter "no dead control" reading of the honesty bar for *controls/features*. **The one hard line that still holds: never fabricate merchant DATA** — where an element needs real numbers/metrics/claims we don't have, show its shell with an honest empty/coming state, never invented figures.

## Shared Working Tree

~8 Claude Code sessions work concurrently against ONE tree that shares a single git object store **and index**. `origin/main` is the only source of truth; the local `main` checkout is a disposable mirror, **not** a workspace. Full model + rationale: `docs/ops/build-deploy-and-coordination.md`.

**Work in a worktree; push straight to origin.**
- Start in your own worktree off origin/main: `git worktree add -b <lane>/<task> .claude/worktrees/<name> origin/main`, then `(cd apps/shopify && npx prisma generate)`.
- Land work by pushing the worktree directly: `git push origin HEAD:main`. If rejected, `git fetch origin main && git rebase origin/main`, **re-run preflight**, then push again.
- **Never leave commits on the local `main` branch.** Committing to the shared main checkout without pushing diverges your work the instant anyone else pushes — it then can't cleanly rebase and blocks every session using that checkout. (This stranded two commits on 2026-07-30.) Keep the main checkout reset to `origin/main`; treat it read-only.

**Local iteration is fast; preflight is the integration gate.** Run the dev server / hot reload to visualise UI and backend changes, and use focused checks while coding. Do **not** run the full suite after every local edit just to inspect the app. Run `bash scripts/preflight.sh` (prisma generate → typecheck → lint → test → build) before pushing/merging to `origin/main`; push only if green. Enable the structural backstop once (shared across all worktrees): `git config core.hooksPath .githooks`.
- **Re-run preflight after ANY rebase/fetch that moved your base.** A sibling's commit can delete a symbol you import (a JS missing-export passes typecheck **and** build, failing only at runtime/test) or trip a consistency guard. A pre-rebase green gate is void post-rebase.
- **"It's just config/docs" is NOT an exception** — guard tests assert config (scope declarations, cross-file consistency). Two red-mains on 2026-07-30 came from skipping the gate on a rebase and on a "config-only" edit.

**Commit hygiene.**
- Pathspec-commit, always: `git commit -- <explicit paths> -m "…"`. Never bare `git commit` / `git commit -a` / `git add -A` / `git add <dir>` — the shared index will sweep another session's staged files into your commit.
- Verify `git diff --cached --name-only` shows only your files before committing.
- A `schema.prisma` change ships **with its migration in the same commit** — an edit without a matching migration trips the drift hard gate (CI-blocking). Migrations are additive unless the founder approves otherwise.

**Cross-lane coordination.**
- You may edit another session's files, but ask that session first, **per file**, via cross-session message.
- **Don't reverse a coordination decision mid-flight.** If you asked a session to add or remove something, confirm they haven't already acted before you change your mind — a flip-flop that removes a symbol another session now depends on breaks the build (this caused a red-main on 2026-07-30).
- **CHANGELOG collisions:** if a sibling already added today's dated section, keep BOTH — take their section, re-insert yours; never overwrite.

## Architecture Decisions

Architecture, design, refactor and cross-cutting **consistency** decisions are owned by the **architecture session** (currently **Jefe chat 10 — architecture II**, from 2026-07-31; previously chat 7). Route those questions there via cross-session message rather than to the founder, so decisions stay coherent across sessions. The architecture owner escalates to the founder only what is genuinely his: product scope, irreversible / one-way-door changes, and safety-rail / merchant-write-guardrail questions. This binds current and future sessions; when the role passes to a successor, update the holder named here.

**Architecture review gate (founder directive, 2026-07-31).** Anything that touches the **core spine** comes through the architecture session for a check *before it lands* — not only design questions, but the change itself. Flag it via cross-session message; the owner acks fast for pattern-following changes and reviews the design for new contracts. The core spine:
- the **action layer** — the capability registry + resolvers (`action-intent.server.js`), the typed adapters (`*-adapter.server.js`) + write clients, the `action_executions` / `action_execution_writes` ledger, `wire-*-execution`, and the autonomy-policy resolution;
- **new action intents** on the shared route action, and the **loader structure** of `app/routes/app._index.tsx` (additive reads folded into the existing `Promise.all` are a light heads-up; new intents or restructures need the check);
- the **Prisma schema + migrations**, and the **tenant/session model** (`Shop` / `Merchant` / `Session`);
- the **Shopify auth/token config** (`shopify.server.ts`) + the admin GraphQL client + offline-token handling;
- the **Merchant Memory belief registry** + derivation dispatch (`deterministic-belief-registry`, `shopify-derivations`);
- the **LLM provider/config** (`app/lib/llm/provider` · `config` · `providers`);
- the **gate / hooks / observability infra** (`scripts/preflight.sh`, `.githooks`, the logger / event-log / redact) and the canonical docs (`AGENTS.md`, `CLAUDE.md`, `context/`).
Lane-local surface components, copy, styling, and read-only fetchers that follow an established pattern don't need the gate — build them in your lane. When unsure, flag it: a 30-second ack beats an incoherent spine.

Details and the coordination model: `docs/ops/build-deploy-and-coordination.md`.

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
- Keep `apps/shopify/GLOSSARY.md` current when adding or renaming product, memory, action, surface or operations entities. Update it in the same change as the entity it describes. When glossary entries are added or materially changed and the change is live and verified, post the additions to **#jefe-slack** with the same timing, short-SHA footer and separator discipline as changelog updates.
- Use merchant/operator-facing language.
- Confirm new server code is observable: it logs through the structured logger, captures/propagates errors to the central hooks, and (for any new endpoint, service or dependency) has a health or self-check. See `apps/shopify/docs/observability.md`.
- Run `bash scripts/preflight.sh` (prisma generate, typecheck, lint, tests, build) only for the integration gate: before pushing/merging — and **again after any rebase**. For local visual checks, keep the dev server running and report any focused checks instead of the full suite. Push only if green.
- Summarise changes, risks, follow-up work and any checks that could not be run.
