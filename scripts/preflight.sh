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
echo "▶ test";            npm test
echo "▶ build";           npm run build
echo "✅ preflight green — safe to: git push origin HEAD:main"
