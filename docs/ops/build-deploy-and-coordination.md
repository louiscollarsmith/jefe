# How we build, deploy & coordinate

The living how-to for the Jefe monorepo. Operating **law** is `AGENTS.md` + `CLAUDE.md`; the canonical product/architecture source is `context/`. This guide is the *how*, and it links out rather than duplicating the detailed docs. Keep it lean — if a section grows, extract it and link.

## The gate

Every deploy runs this, and every session should run it locally before pushing:

```
npx prisma generate && npm run typecheck && npm run lint && npm test && npm run build
```

Railway additionally runs `prisma migrate deploy` as a pre-deploy step. **Never mask the exit code** with `| tail` or similar — it hides a red gate and has burned us. Let it fail loudly.

## Deploy

Push/merge to `main` → Railway auto-builds `apps/shopify` → runs `prisma migrate deploy` against Neon → starts the web service.

- **Getting a change onto `main`:** `origin/main` has a *single writer* — only the **main checkout** pushes it; worktree sessions never `git push origin main`. That keeps `origin/main` a strict ancestor of local `main`, so pushes always fast-forward and **no `git fetch` is needed** (a `fetch` 401 can wipe the shared osxkeychain credential for every session). Land a gate-green feature branch from the main checkout — worktrees share the same `.git`, so the branch is already a local ref, nothing to fetch: `git rebase main <branch>` → `git merge --ff-only <branch>` → one `git push origin main`. Urgent live-hotfixes may go straight to `main` via pathspec commits; feature / multi-commit work uses a worktree branch integrated this way.
- **Service:** `jefe`. ⚠️ The `apps/shopify` directory is Railway-mislinked to `jefe-shepherd`, so always target `--service jefe` explicitly in Railway CLI commands.
- **Health:** `/health` = liveness (always 200 when the process serves; a failing DB probe is logged, not surfaced, so a blip can't recycle a healthy instance). `/ready` = readiness (fails closed 503 when the DB is down) — this is Railway's healthcheck target.
- Railway/Neon specifics, env groups, rollback: `docs/ops/deployment_staging_railway_neon.md`.

## Invariants (enforce in review)

1. **Testable logic in `@ts-check`'d `.server.js`, not `.tsx`.** Tests run on plain `node --test` (no TS transpile), so pure logic must be importable into `.mjs`. Extract pure functions; keep routes thin.
2. **Observability def-of-done.** Every new service/dependency uses the structured logger (`app/lib/observability/logger.server.js`) + redaction and exposes a health signal. No bare `console.*` in server paths. See `apps/shopify/docs/observability.md`.
3. **The gate is sacred.** Never mask its exit code (see above).
4. **Changelog discipline.** A `CHANGELOG.md` entry for any product/operator/security/data/workflow change. See `docs/ops/changelog_rules.md`.
5. **Migrations additive** (new nullable columns, preserve-on-webhook); opaque job ids stay opaque (e.g. `orders_backfill_365d` is kept even though the window is now 24 months).

## Product spine (preserve through refactors)

Commerce sources → deterministic facts → Merchant Memory beliefs (provenance + confidence) → merchant confirmation → recommendations. Deterministic math lives in code, never prompts. External writes go only through typed adapters (idempotency, preview, approval gate, blast-radius cap, reversibility; merchant = principal). The direction is autonomy earned per action type; the guardrails are permanent.

## Multi-agent coordination

Eight-plus sessions share this one working tree and its git index — the source of the CHANGELOG stomping and `git add`-swept files we've hit. The model:

- **Isolate by default.** New sessions work in their own git worktree + branch: `git worktree add .claude/worktrees/<name> -b claude/<name>`. Physical isolation is the reliable fix — it depends on nothing being wired. The P2 standalone-auth session already runs this way.
- **Pathspec-commit, always.** `git commit -- <explicit paths>`. Never `git add -A`/`git add <dir>` or a bare `git commit -a` — it sweeps other sessions' staged files. Verify `git diff --cached --name-only` shows only yours first. Mandatory whether or not you're isolated.
- **If a file you need is dirty with another session's work, leave it and coordinate** — don't commit their changes inside yours. (This is real: `CHANGELOG.md` is frequently mid-edit by another session.)
- **CHANGELOG:** append your entry on your own branch and resolve at merge; don't hand-edit it concurrently on shared `main`.
- **Awareness:** `git worktree list` + branch names show who's live.
- **Worktree gotcha — Prisma client skew:** the generated `@prisma/client` is regenerated to whatever schema last ran `prisma generate`, so a worktree pinned to an older migration can see *false-red* DB tests (`column … does not exist`) that aren't a real regression. Give each worktree its own `node_modules` (+ its own `prisma generate`); if you hit a phantom red, resync/regenerate to your schema before assuming a regression.
- **Shepherd** (the Korso coordination hub) was evaluated and **removed** (2026-07-29): its `SHEPHERD_TEAM_TOKEN` was interactive-shell-only, so MCP subprocesses never inherited it and it never actually coordinated us. Coordinate via worktrees + cross-session messages instead.
- **Environment gotchas:** GNU coreutils `timeout` isn't installed on this macOS — scripts using `timeout` fail with "command not found". Railway `--service jefe` (mislink, above).

## Architecture decisions

Architecture, design, refactor and cross-cutting **consistency** calls are owned by the **architecture session** (currently "Jefe chat 7 — architecture", 2026-07-29). Route them there via cross-session message rather than to the founder, so decisions stay coherent across sessions. The architecture owner escalates to the founder only what is genuinely his: product scope, irreversible / one-way-door changes, and safety-rail / merchant-write-guardrail questions. This binds current and future sessions. When the role passes to a successor session, update the holder named here and in `AGENTS.md`.
