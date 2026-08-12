#!/usr/bin/env bash
# Fleet awareness — see what every lane is doing, and what recently landed.
# Shared across all worktrees via the common git dir (not committed, local to the
# machine the fleet runs on). Each lane writes only its OWN board entry, so there
# is no contention.
#
#   bash scripts/lanes.sh working "refactor the analyst" app/lib/a.js app/lib/b.js
#         → declare my current focus + the files/subsystems I'm touching
#   bash scripts/lanes.sh board          → what every lane is working on right now
#   bash scripts/lanes.sh log [N]        → the last N landings (default 20)
#   bash scripts/lanes.sh touching <path> → which lanes have declared this file
#   bash scripts/lanes.sh idle           → clear my focus (done for now)
#
# Rule of thumb: run `lanes.sh board` before you start editing a shared/hot file,
# and `lanes.sh working …` when you start — so two lanes don't collide in the same
# file (the semantic-conflict case a merge-queue can't prevent, only awareness can).
set -euo pipefail

common="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
lanes_dir="$common/lanes"; board="$lanes_dir/board"; ledger="$lanes_dir/ledger.log"
mkdir -p "$board"
lane="${JEFE_LANE:-$(basename "$(git rev-parse --show-toplevel)")}"
now() { date -u +%FT%TZ; }

cmd="${1:-board}"
case "$cmd" in
  working)
    shift; note="${1:-}"; [ $# -gt 0 ] && shift || true
    printf '● %s\n    focus: %s\n    files: %s\n    since: %s\n' "$lane" "${note:-—}" "${*:-—}" "$(now)" > "$board/$lane"
    echo "📌 board updated for $lane" ;;
  idle)
    rm -f "$board/$lane"; echo "board cleared for $lane" ;;
  board)
    echo "═══ 🚦 FLEET LANE BOARD — $(now) ═══"
    if ls "$board"/* >/dev/null 2>&1; then for f in "$board"/*; do cat "$f"; echo; done
    else echo "(no lanes have declared focus — use: lanes.sh working \"…\")"; fi ;;
  touching)
    shift; path="${1:-}"; [ -n "$path" ] || { echo "usage: lanes.sh touching <path>" >&2; exit 2; }
    hit=0; if ls "$board"/* >/dev/null 2>&1; then
      for f in "$board"/*; do if grep -qF "$path" "$f"; then cat "$f"; echo; hit=1; fi; done; fi
    [ "$hit" = 1 ] || echo "(no lane has declared $path)" ;;
  log)
    n="${2:-20}"; echo "═══ recent landings (last $n) ═══"; tail -n "$n" "$ledger" 2>/dev/null || echo "(none yet)" ;;
  *)
    echo "usage: lanes.sh {working <note> [files…] | idle | board | touching <path> | log [N]}" >&2; exit 2 ;;
esac
