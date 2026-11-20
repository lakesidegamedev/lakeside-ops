#!/usr/bin/env bash
# Keir runs from an immutable release, never from the source checkout, so
# merging to main changes nothing on the host until someone cuts a release.
#   deploy/release.sh <git-ref> [--stage] [--hotfix "<reason>"]
#                                 build /opt/keir/releases/<sha12> from a commit on
#                                 origin/main, run its tests, tag vX.Y.Z, publish the GitHub
#                                 release from CHANGELOG.md, point /opt/keir/current at it.
#                                 Weekly train (5.1): refused unless the last train is 6+
#                                 days old and the commit has soaked 24h on main; --hotfix
#                                 bypasses with a reason, logged in $root/releases.jsonl.
#                                 --replay-gate (optional, off by default): once the build and its
#                                 tests pass, run the k10 replay set once on the live release (only
#                                 when its baseline is missing or stale) and once on this build, and
#                                 refuse if any scenario that passed on live now fails. Costs real
#                                 model runs, so it is never implied by --stage or --hotfix.
#   deploy/release.sh --rollback  point current back at the previous release
#   deploy/release.sh --status    show current, previous and what each unit is running
# It never starts, stops or restarts a service. A flip takes effect for a
# service on its next restart; --status shows which ones are behind.
# KEIR_RELEASE_ROOT overrides /opt/keir (tests).
# --stage builds and tests only; it never tags, publishes or switches current.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
root=${KEIR_RELEASE_ROOT:-/opt/keir}
units=(keir-operator keir-summon keir-inbox)

target() { [[ -L "$root/$1" ]] && readlink -f "$root/$1" || true; } # resolved link, or empty

flip() { # atomically repoint a symlink
  ln -sfn "$2" "$root/$1.new" && mv -Tf "$root/$1.new" "$root/$1"
}

status() {
  local cur prev
  cur=$(target current); prev=$(target previous)
  echo "current:  ${cur:-none} $( [[ -n $cur ]] && cat "$cur/RELEASE" 2>/dev/null)"
  echo "previous: ${prev:-none}"
  command -v systemctl >/dev/null || return 0
  for u in "${units[@]}"; do
    local pid cwd
    pid=$(systemctl show "$u" -p MainPID --value 2>/dev/null || echo 0)
    if [[ -z $pid || $pid == 0 ]]; then echo "$u: not running ($(systemctl is-enabled "$u" 2>/dev/null; true))"; continue; fi
    cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null || echo unknown)
    [[ $cwd == "$cur" ]] && echo "$u: running current" || echo "$u: running $cwd (restart to pick up current)"
  done
}

case "${1:-}" in
  --status) status; exit 0 ;;
  --rollback)
    prev=$(target previous)
    [[ -n $prev && -d $prev ]] || { echo "no previous release to roll back to" >&2; exit 1; }
    cur=$(target current)
    flip current "$prev"; flip previous "$cur"
    echo "current -> $prev (was $cur). Restart the affected units to apply."; status; exit 0 ;;
  ""|-*) sed -n '2,12p' "$0" >&2; exit 2 ;;
esac

ref=$1; shift
hotfix=""; is_hotfix=0; stage_only=0; replay_gate=0
while (( $# )); do
  case "$1" in
    --stage) stage_only=1; shift ;;
    --replay-gate) replay_gate=1; shift ;;
    --hotfix) is_hotfix=1; hotfix=${2:?hotfix needs a reason}; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
git -C "$repo" fetch -q origin main
sha=$(git -C "$repo" rev-parse --verify "$ref^{commit}")
git -C "$repo" merge-base --is-ancestor "$sha" origin/main \
  || { echo "refusing: $sha is not on origin/main; release reviewed, merged code only" >&2; exit 1; }
dir="$root/releases/${sha:0:12}"
# Release train gate (no gate when this release is already current).
train_log="$root/releases.jsonl"
if (( ! stage_only )) && [[ $(target current) != "$dir" ]]; then
  committed=$(git -C "$repo" show -s --format=%ct "$sha")
  if (( is_hotfix )); then verdict=$(node "$repo/lib/operator/train.js" "$train_log" "$committed" "$hotfix") || { echo "refusing: $verdict" >&2; exit 1; }
  else verdict=$(node "$repo/lib/operator/train.js" "$train_log" "$committed") || { echo "refusing: $verdict" >&2; exit 1; }; fi
fi
if [[ ! -d $dir ]]; then
  build="$dir.building"; rm -rf "$build"
  prefix=$(git -C "$repo" rev-parse --show-prefix)
  tmp="$build"
  # Keep the monorepo test layout while qualifying the actual packaged runtime.
  # Bench fixtures are test dependencies and do not ship in the agent release.
  [[ $prefix != apps/agent/ ]] || tmp="$build/apps/agent"
  mkdir -p "$tmp"
  tree=$sha
  [[ -z $prefix ]] || tree="$sha:${prefix%/}"
  git -C "$(git -C "$repo" rev-parse --show-toplevel)" archive "$tree" | tar -x -C "$tmp"
  if [[ $prefix == apps/agent/ ]] && git -C "$repo" cat-file -e "$sha:apps/cli/headless/runtime.js" 2>/dev/null; then
    mkdir -p "$build/apps/cli" "$tmp/cli-runtime/bin"
    git -C "$(git -C "$repo" rev-parse --show-toplevel)" archive "$sha:apps/cli" | tar -x -C "$build/apps/cli"
    git -C "$(git -C "$repo" rev-parse --show-toplevel)" archive "$sha:apps/cli" headless bin/activation.cjs provider-routes.js | tar -x -C "$tmp/cli-runtime"
  fi
  # Validate owner approval pushes against the web writer from the same commit.
  # Only the agent directory is promoted into the immutable runtime.
  attention=apps/web/keir-supervisor/attention.js
  if [[ $prefix == apps/agent/ ]] && git -C "$repo" cat-file -e "$sha:$attention" 2>/dev/null; then
    git -C "$(git -C "$repo" rev-parse --show-toplevel)" archive "$sha" "$attention" | tar -x -C "$build"
  fi
  (cd "$tmp" && npm ci --silent --no-audit --no-fund)
  (cd "$tmp" && npm test >/dev/null 2>&1) || { echo "refusing: tests fail in the built release ($tmp kept for inspection)" >&2; exit 1; }
  version=$(node -p "require('$tmp/package.json').version")
  # Repo maturity (owner, 2026-10-14): one version everywhere, and a tag per release.
  rust_version=$(sed -n 's/^version = "\(.*\)"$/\1/p' "$tmp/rust/Cargo.toml" 2>/dev/null | head -1)
  [[ -z $rust_version || $rust_version == "$version" ]] || { echo "refusing: package.json is $version but rust/Cargo.toml is $rust_version" >&2; exit 1; }
  printf '%s %s\n' "$sha" "$version" > "$tmp/RELEASE"
  remote=$(git -C "$repo" remote get-url origin)
  component=$(git -C "$repo" rev-parse --show-prefix)
  node -e 'const [file,repository,commit,component]=process.argv.slice(1);require("fs").writeFileSync(file,JSON.stringify({repository,commit,component:component.replace(/\/$/,"")},null,2)+"\n")' "$tmp/SOURCE.json" "$remote" "$sha" "$component"
  mv "$tmp" "$dir" && chmod -R a-w "$dir"
  [[ $tmp == "$build" ]] || rm -rf "$build"
fi
# Optional replay gate (--replay-gate). The replay harness lives in the source checkout; the
# release trees under test are passed to it with KEIR_REPLAY_AGENT. One run per scenario.
replay_pending=""
if (( replay_gate )) && [[ $(target current) != "$dir" ]]; then
  top=$(git -C "$repo" rev-parse --show-toplevel)
  gate_js="$dir/bin/keir-replay-gate.js"
  baseline="$root/replay-baseline.json"
  out="$root/replay/$(date -u +%Y%m%dT%H%M%S)"; mkdir -p "$out"
  live=$(target current)
  run_set() { # <agent-tree> <out-dir>
    KEIR_REPLAY_AGENT="$1" KEIR_REPLAY_LABEL="$(basename "$2")" node "$top/apps/cli/bench/replay/run.cjs" --set k10 --scenario all --repeat 1 --concurrency 2 --out "$2" >"$2.log" 2>&1 || true
  }
  if [[ -n $live && -f $live/RELEASE ]]; then
    live_sha=$(awk '{print $1}' "$live/RELEASE")
    if [[ $(node "$gate_js" sha "$baseline") != "$live_sha" ]]; then
      echo "replay gate: baselining the live release ${live_sha:0:12}"
      run_set "$live" "$out/live"
      node "$gate_js" summarize "$out/live" "$live_sha" > "$baseline"
    fi
    echo "replay gate: running the k10 set on ${sha:0:12}"
    run_set "$dir" "$out/candidate"
    node "$gate_js" summarize "$out/candidate" "$sha" > "$out/candidate-summary.json"
    node "$gate_js" compare "$baseline" "$out/candidate-summary.json" \
      || { echo "refusing: replay gate failed (transcripts in $out/candidate)" >&2; exit 1; }
    replay_pending="$out/candidate-summary.json"
  else
    echo "replay gate: no live release to compare with, skipping" >&2
  fi
fi
if (( stage_only )); then echo "staged and tested: $dir (current unchanged)"; exit 0; fi
version=$(awk '{print $2}' "$dir/RELEASE")
tag="v$version"
[[ -z $(git -C "$repo" rev-parse --show-prefix) ]] || tag="keir-v$version"
if git -C "$repo" rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  [[ $(git -C "$repo" rev-parse "$tag^{commit}") == "$sha" ]] || { echo "refusing: $tag already identifies another commit" >&2; exit 1; }
else
  git -C "$repo" tag -a "$tag" "$sha" -m "Keir $version"
fi
# A prior interrupted push may leave only the local tag. Always publish it,
# and fail before activation if the remote cannot accept the exact release.
git -C "$repo" push -q origin "refs/tags/$tag"
echo "tagged $tag at ${sha:0:12}"
# Every tag is a GitHub release whose notes are its CHANGELOG section. Best
# effort: a GitHub outage never blocks a release, and a rerun fills the gap.
if command -v gh >/dev/null && ! (cd "$repo" && gh release view "$tag" >/dev/null 2>&1); then
  notes=$(mktemp)
  if node "$dir/bin/release-notes.js" "$version" "$dir/CHANGELOG.md" > "$notes"; then
    (cd "$repo" && gh release create "$tag" --verify-tag --title "Keir $version" --notes-file "$notes" >/dev/null) && echo "published release $tag" || echo "warning: GitHub release $tag not published" >&2
  else
    echo "warning: CHANGELOG.md has no $version section; no GitHub release" >&2
  fi
  rm -f "$notes"
fi
old=$(target current)
if [[ $old == "$dir" ]]; then echo "already current: $dir"; status; exit 0; fi
[[ -n $old ]] && flip previous "$old"
flip current "$dir"
# The gated build is the new baseline for the next release.
[[ -z $replay_pending ]] || cp "$replay_pending" "$root/replay-baseline.json"
node -e 'const [f,sha,version,v]=process.argv.slice(1);const x=JSON.parse(v);require("fs").appendFileSync(f,JSON.stringify({at:Date.now(),sha,version,kind:x.kind,reason:x.reason})+"\n")' "$train_log" "$sha" "$version" "$verdict"
echo "current -> $dir. Nothing was restarted."
status
