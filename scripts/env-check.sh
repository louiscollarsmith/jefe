#!/usr/bin/env bash
# Environment precheck — the FIRST thing the gate runs, so a broken *setup* fails
# with "your environment is broken, here's the one-line fix" INSTEAD of a
# misleading error that looks like broken *code*.
#
# Why this exists (2026-08-12, founder-mandated): 15 lanes share one tree, and the
# shared substrate keeps failing in ways that induce a PLAUSIBLE WRONG FIX —
#   • an empty/symlinked node_modules makes `npx prisma` fetch Prisma 7, which
#     rejects the correct 6.x schema with a P1012 that reads exactly like a broken
#     schema.prisma — and "fixing" the schema breaks everyone;
#   • the same missing install makes tsc resolve stale/absent types → phantom
#     errors in files nobody touched.
# Both cost hours and one took main red. This script names the cause instead.
#
# HARD-fails only on unambiguous "your setup is broken" conditions. Node-version
# drift is a WARNING (rarely causes misleading errors; nvm use is the fix).
#
# Run standalone any time you doubt your environment:  bash scripts/env-check.sh
set -uo pipefail  # deliberately NOT -e: collect every failure, then print all fixes

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root/apps/shopify"
fail=0

# 1. Node version vs the pin (.nvmrc / CI). WARN only — drift rarely misleads.
pinned="$(tr -dc '0-9' < "$repo_root/.nvmrc" 2>/dev/null)"
major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo '?')"
if [ -n "$pinned" ] && [ "$major" != "$pinned" ]; then
  echo "⚠ Node $major, but .nvmrc pins $pinned (CI runs $pinned). A green gate here proves"
  echo "  slightly less than CI. fix: nvm use  (or install Node $pinned)"
fi

# 2. node_modules present + populated (catches empty dir AND dead symlink). HARD.
if [ ! -x node_modules/.bin/tsc ] || [ ! -x node_modules/.bin/prisma ]; then
  echo "✗ apps/shopify/node_modules is missing or incomplete (no .bin/tsc or .bin/prisma)."
  echo "  This is why you might see a P1012 'datasource url' error or type errors in"
  echo "  files you never touched — the SCHEMA AND CODE ARE FINE, the install is not."
  echo "  fix: cd apps/shopify && rm -f node_modules && npm ci"
  fail=1
fi

# 3. Installed Prisma matches the 6.x schema (the P1012 trap). HARD.
if [ -e node_modules/prisma/package.json ]; then
  pmajor="$(node -p "require('./node_modules/prisma/package.json').version.split('.')[0]" 2>/dev/null || echo '?')"
  if [ "$pmajor" != "6" ] && [ "$pmajor" != "?" ]; then
    echo "✗ Prisma ${pmajor}.x is installed, but the schema is 6.x — Prisma 7 rejects it"
    echo "  with a P1012 that looks like a broken schema.prisma. THE SCHEMA IS CORRECT."
    echo "  fix: cd apps/shopify && rm -rf node_modules && npm ci"
    fail=1
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "⛔ ENVIRONMENT broken — the failures above are your SETUP, not your change."
  echo "   Do NOT edit schema.prisma or type-annotate around these to make them go away."
  exit 1
fi
echo "✓ env ok — node $major, node_modules present, prisma 6.x"
