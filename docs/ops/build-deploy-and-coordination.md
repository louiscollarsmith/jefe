# How we build, deploy & coordinate

The living how-to for the Jefe monorepo. Operating **law** is `AGENTS.md` + `CLAUDE.md`; the canonical product/architecture source is `context/`. This guide is the *how*, and it links out rather than duplicating the detailed docs. Keep it lean — if a section grows, extract it and link.

## Local iteration

Use the dev server and hot reload to visualise UI/backend changes:

```
cd apps/shopify && npm run dev
```

Run focused checks while coding when they are useful, for example one test file or one package's lint/typecheck. Do **not** run the full suite after every local edit just to inspect the app.

## The gate

One command, run before a push/merge candidate (and again after any rebase):

```
bash scripts/preflight.sh        # prisma generate → typecheck → lint → test → build
```

Push only if green: `bash scripts/preflight.sh && git push origin HEAD:main`. Enable the structural backstop once — shared across all worktrees via the common `.git/config`: `git config core.hooksPath .githooks` installs a pre-push hook that runs preflight and **blocks a red push to `origin/main`**. A worktree without `node_modules` can't run the gate — there the hook **skips** with a note (CI still gates); run `cd apps/shopify && npm ci` to enable the local integration gate. Reserve `git push --no-verify` for when you've *just* run preflight green yourself — not as a routine bypass.

Non-negotiables:
- **Re-run preflight after ANY rebase/fetch that moved your base.** A pre-rebase green gate is void once a sibling's commit rebases in — a deleted export (passes typecheck **and** build, fails only at runtime/test) or a tripped consistency guard shows only on a fresh run. Both red-mains on 2026-07-30 came from skipping this.
- **No "it's just config/docs" exceptions** — guard tests assert config (scope declarations, cross-file consistency).
- **Never mask the exit code** with `| tail`/`| grep` — it hides a red gate and has burned us; `preflight.sh` runs un-piped for exactly this reason. Railway additionally runs `prisma migrate deploy` pre-deploy.

## Deploy

Push/merge to `main` → Railway auto-builds `apps/shopify` → runs `prisma migrate deploy` against Neon → starts the web service.

- **Getting a change onto `main`:** work in a **worktree branched off `origin/main`** and push it directly. This is the model that holds at ~8 concurrent sessions (the older "single-writer from a clean main checkout" flow is retired — it stranded commits and stalled at peak):
  - `git worktree add -b <lane>/<task> .claude/worktrees/<name> origin/main` → `(cd apps/shopify && npx prisma generate)` → **preflight** → `git push origin HEAD:main`.
  - On a non-ff rejection: `git fetch origin main && git rebase origin/main`, **re-run preflight**, retry. Resolve CHANGELOG collisions by keeping **both** date sections/entries (verified across a ~6-session night, 2026-07-30).
  - **`origin/main` is the only source of truth. Never leave commits on the local `main` branch** — it diverges the instant origin advances (a session commits unpushed while others push), then can't cleanly rebase and blocks everyone on that checkout. Keep the main checkout reset to `origin/main`; treat it read-only. (Stranded two commits on 2026-07-30.)
  - Fetch only when needed — a `fetch` 401 can wipe the shared osxkeychain credential for every session; re-auth before retrying rather than looping. Urgent live-hotfixes may still go straight to `main` via pathspec commits from a worktree.
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

- **Isolate by default.** New sessions work in their own worktree off origin/main: `git worktree add -b <lane>/<task> .claude/worktrees/<name> origin/main`, then `(cd apps/shopify && npx prisma generate)`. Physical isolation is the reliable fix — it depends on nothing being wired. Push straight to origin with `git push origin HEAD:main`; never leave commits on the local `main` branch (see Deploy).
- **Pathspec-commit, always.** `git commit -- <explicit paths>`. Never `git add -A`/`git add <dir>` or a bare `git commit -a` — it sweeps other sessions' staged files. Verify `git diff --cached --name-only` shows only yours first. Mandatory whether or not you're isolated.
- **If a file you need is dirty with another session's work, leave it and coordinate** — don't commit their changes inside yours. (This is real: `CHANGELOG.md` is frequently mid-edit by another session.)
- **Don't reverse a coordination decision mid-flight.** If you asked a session to add or remove a symbol, confirm they haven't already acted before you change your mind — a flip-flop that deletes something another session now imports breaks the build (red-main, 2026-07-30). Route architecture/consistency calls to the architecture session (below) rather than negotiating them ad hoc.
- **CHANGELOG:** append your entry on your own branch and resolve at merge; don't hand-edit it concurrently on shared `main`.
- **Awareness:** `git worktree list` + branch names show who's live.
- **Worktree gotcha — Prisma client skew:** the generated `@prisma/client` is regenerated to whatever schema last ran `prisma generate`, so a worktree pinned to an older migration can see *false-red* DB tests (`column … does not exist`) that aren't a real regression. Give each worktree its own `node_modules` (+ its own `prisma generate`); if you hit a phantom red, resync/regenerate to your schema before assuming a regression.
- **Shepherd** (the Korso coordination hub) was evaluated and **removed** (2026-07-29): its `SHEPHERD_TEAM_TOKEN` was interactive-shell-only, so MCP subprocesses never inherited it and it never actually coordinated us. Coordinate via worktrees + cross-session messages instead.
- **Environment gotchas:** GNU coreutils `timeout` isn't installed on this macOS — scripts using `timeout` fail with "command not found". Railway `--service jefe` (mislink, above).

## Architecture decisions

Architecture, design, refactor and cross-cutting **consistency** calls are owned by the **architecture session** (currently "Jefe chat 7 — architecture", 2026-07-29). Route them there via cross-session message rather than to the founder, so decisions stay coherent across sessions. The architecture owner escalates to the founder only what is genuinely his: product scope, irreversible / one-way-door changes, and safety-rail / merchant-write-guardrail questions. This binds current and future sessions. When the role passes to a successor session, update the holder named here and in `AGENTS.md`.
