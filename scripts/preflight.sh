#!/usr/bin/env bash
# Preflight gate — the single ritual before EVERY push to origin/main, and again
# after any rebase/fetch that moves your base. Exits non-zero if the tree is not
# shippable, so `preflight && push` can never land red on the branch ~8 sessions share.
#
#   bash scripts/preflight.sh && git push origin HEAD:main
#
# Why this exists: on 2026-07-30 main went red twice from pushes that skipped the gate —
# once a rebase pulled a sibling's deletion of a symbol we imported (a JS missing-export
# passes typecheck AND build, failing only at runtime/test), once a "just config" scope
# edit tripped a cross-file consistency guard. Both are caught below. There are no
# "it's only docs/config" exceptions — guard tests assert config too.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root/apps/shopify"

echo "▶ prisma generate"; npx prisma generate >/dev/null
echo "▶ typecheck";       npm run typecheck
echo "▶ lint";            npm run lint

# --- DB-gated tests: run them locally instead of silently skipping. ---
# The ingestion / tenant / channels tests self-skip without DATABASE_URL, so a
# broken one (e.g. f7daa0e's backfill-worker regression) passed local preflight
# and only failed in CI — landing red on main across 6 commits on 2026-07-31.
# Detect a DB and RUN them; if none, warn LOUD. NON-BREAKING: never hard-fail on a
# missing DB here (a machine without docker isn't wedged) — a hard-fail is a later,
# coordinated step once every session has the local DB.
if [ -n "${DATABASE_URL:-}" ]; then
  echo "▶ db-tests           DATABASE_URL set → DB-gated tests will run"
elif command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^jefe-shopify-postgres$'; then
  export DATABASE_URL="postgresql://jefe:jefe@localhost:55432/jefe_dev?schema=public"
  echo "▶ db-tests           local Postgres (jefe-shopify-postgres) detected → DB-gated tests will run"
  npx prisma migrate deploy >/dev/null 2>&1 || echo "  ⚠️  prisma migrate deploy on the local DB failed — schema may be stale"
else
  echo ""
  echo "⚠️  ─────────────────────────────────────────────────────────────────"
  echo "⚠️  DB-gated tests will SKIP — no DATABASE_URL and no local Postgres."
  echo "⚠️  They RUN IN CI and are NOT covered by this preflight run. The"
  echo "⚠️  2026-07-31 red-main (f7daa0e, 6 commits) was exactly this blind spot."
  echo "⚠️  Cover them locally:  npm run db:up   (then re-run preflight)"
  echo "⚠️  ─────────────────────────────────────────────────────────────────"
  echo ""
fi

echo "▶ test";            npm test
echo "▶ build";           npm run build
echo "✅ preflight green — safe to: git push origin HEAD:main"
