#!/usr/bin/env bash
# Keir weekly builder (NOT installed or enabled by the release; the lead enables the timer).
# Takes the top 5 ranked capability gaps, writes a brief, launches ONE headless Claude
# worker through the shared external-agent launcher in a fresh worktree to build or
# allowlist them as a pull request, and posts a one-line digest to the board.
#   keir-builder.sh [--dry-run]
set -euo pipefail

APP=${KEIR_APP_DIR:-/opt/keir/current}
STATE=${KEIR_OPERATOR_STATE_DIR:-/var/lib/keir-operator}
OUT=${KEIR_BUILDER_OUT:-/root/misc/archive/$(date -u +%F)-keir-builder}
LAUNCHER=${KEIR_BUILDER_LAUNCHER:-/root/bin/provider-agent-run.sh}
MODEL=${KEIR_BUILDER_MODEL:-claude-sonnet-5-5}
dry=false; [ "${1:-}" = "--dry-run" ] && dry=true

exec 9>/run/lock/keir-builder.lock
flock -n 9 || { echo "another builder run is active"; exit 0; }

mkdir -p "$OUT"
plan_file="$OUT/plan.json"
node "$APP/bin/keir-builder-plan.js" --ledger "$STATE/ledger.json" --top 5 > "$plan_file"
if [ "$(cat "$plan_file")" = "null" ]; then echo "no ranked gaps, nothing to build"; exit 0; fi

field() { node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=p[process.argv[2]];process.stdout.write(v==null?"":String(v))' "$plan_file" "$1"; }
repo=$(field repoPath); digest=$(field digest); card=$(field cardId)
node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));require("fs").writeFileSync(process.argv[2],p.prompt)' "$plan_file" "$OUT/prompt.md"

if [ "$dry" = true ]; then echo "dry run: $digest"; echo "repo: $repo"; echo "brief: $OUT/prompt.md"; exit 0; fi

# A fresh worktree below the repository, on a new branch from the default branch.
stamp=$(date -u +%Y%m%d-%H%M)
branch="keir-builder/$stamp"
worktree="$repo/worktrees/keir-builder-$stamp"
default=$(git -C "$repo" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || echo main)
git -C "$repo" fetch -q origin "$default"
git -C "$repo" worktree add -q -b "$branch" "$worktree" "origin/$default"

# The launcher enforces provider identity, memory floor and concurrency; it exits non-zero when refused.
status=ok
"$LAUNCHER" claude "$repo" "$worktree" "$OUT/prompt.md" "$MODEL" "$OUT/worker.log" || status="worker exited $?"

line="$digest. Worker: $status. Worktree $worktree, log $OUT/worker.log."
echo "$line"
if [ -n "$card" ]; then
  body=$(node -e 'process.stdout.write(JSON.stringify({id:Number(process.argv[1]),event:"progress",actor:"keir",summary:process.argv[2].slice(0,3900)}))' "$card" "$line")
  /root/bin/mcpcall.sh ops-knowledge work_report "$body" >/dev/null || echo "digest not posted to card $card" >&2
fi
