#!/usr/bin/env bash
# Serialized push to main — THE way to land a change; replaces raw
# `git push origin HEAD:main`. Only ONE lane pushes at a time (a local merge-lock
# shared across every worktree via the common git dir), so there are no ref-lock
# races and no two lanes landing conflicting changes in the same instant. Every
# landing is recorded to a shared ledger so the fleet can see what went in and when.
#
#   bash scripts/merge.sh "what I'm landing"
#
# Design: the SLOW gate runs BEFORE the lock (in parallel across lanes); the lock's
# critical section is short (re-sync + fast re-verify + push), so the queue drains
# fast even with 15 lanes. Assumes all lanes share this machine's filesystem (true
# today); the durable cross-machine form is GitHub's merge queue — see
# docs/ops/fleet-coordination.md.
set -euo pipefail

note="${1:-}"
[ -n "$note" ] || { echo "usage: bash scripts/merge.sh \"what I'm landing\"" >&2; exit 2; }

root="$(git rev-parse --show-toplevel)"
common="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
lanes_dir="$common/lanes"; mkdir -p "$lanes_dir"
lock="$lanes_dir/merge-lock.d"
ledger="$lanes_dir/ledger.log"
lane="${JEFE_LANE:-$(basename "$root")}"
STALE_SECS=600
now() { date -u +%FT%TZ; }

# --- 1. Gate BEFORE the lock (the slow part; parallel-safe, no lock held) ---
echo "▶ fetch + rebase onto origin/main (pre-lock)"
git fetch origin main -q
git rebase origin/main
echo "▶ full preflight (pre-lock)"
bash "$root/scripts/preflight.sh"

# --- 2. Acquire the merge-lock (atomic mkdir; steal only if stale) ---
while ! mkdir "$lock" 2>/dev/null; do
  holder="$(cat "$lock/holder" 2>/dev/null || echo '?')"
  age=$(( $(date +%s) - $(stat -f %m "$lock" 2>/dev/null || date +%s) ))
  if [ "$age" -gt "$STALE_SECS" ]; then
    echo "⚠ merge-lock stale ${age}s (was: $holder) — stealing"; rm -rf "$lock"; continue
  fi
  echo "⏳ merge-lock held by: $holder — waiting (${age}s)…"; sleep 8
done
printf '%s | %s | since %s\n' "$lane" "$note" "$(now)" > "$lock/holder"
trap 'rm -rf "$lock"' EXIT
echo "🔒 merge-lock acquired by $lane"

# --- 3. Critical section: re-sync (main may have moved while queued), re-verify, push ---
git fetch origin main -q
if git merge-base --is-ancestor origin/main HEAD; then
  echo "  main unchanged since gate — pushing"
else
  base="$(git merge-base origin/main HEAD)"
  incoming="$(git diff --name-only "$base" origin/main | sort -u)"
  mine="$(git diff --name-only "$base" HEAD | sort -u)"
  git rebase origin/main
  if [ -n "$incoming" ] && [ -n "$mine" ] && [ -n "$(comm -12 <(echo "$incoming") <(echo "$mine"))" ]; then
    echo "  incoming commits touch my files → full re-preflight"; bash "$root/scripts/preflight.sh"
  else
    echo "  no file overlap with incoming → fast re-verify"
    ( cd "$root/apps/shopify" && bash "$root/scripts/env-check.sh" >/dev/null && npm run typecheck )
  fi
fi
echo "▶ push origin HEAD:main"
git push origin HEAD:main
landed="$(git rev-parse --short HEAD)"
printf '%s | %-22s | %s | %s\n' "$(now)" "$lane" "$landed" "$note" >> "$ledger"
echo "✅ landed $landed — $note   (lock released)"
