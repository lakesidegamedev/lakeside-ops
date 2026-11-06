#!/usr/bin/env bash
# Install or check Keir's systemd units and env files on the host.
#   deploy/install.sh --check   report unit drift and missing env keys, change nothing
#   deploy/install.sh           install units, reload systemd, restart services already running
# Code comes from the pinned release (deploy/release.sh), not this checkout.
# Env files are never written: create them from deploy/*.env.example by hand.
set -euo pipefail
cd "$(dirname "$0")"
mode=${1:-install}; status=0
units=(keir-operator.service keir-summon.service keir-inbox.service keir-shadow.service keir-shadow.timer keir-watchkeeper.service keir-watchkeeper.timer keir-guardian.service keir-guardian.timer)
for u in "${units[@]}"; do
  if ! cmp -s "$u" "/etc/systemd/system/$u"; then echo "drift: $u differs from /etc/systemd/system/$u"; status=1; fi
done
for example in *.env.example; do
  target="/etc/${example%.example}"
  if [[ ! -f "$target" ]]; then
    [[ "$example" == keir-sentry.env.example ]] && { echo "optional: $target absent (sentry tool disabled)"; continue; }
    [[ "$example" == keir-guardian.env.example ]] && continue
    echo "missing: $target (create from deploy/$example, mode 0600)"; status=1; continue
  fi
  for key in $(grep -oE '^[A-Z_]+=' "$example" | tr -d =); do
    grep -q "^$key=" "$target" || { echo "missing key: $key in $target"; status=1; }
  done
  [[ "$(stat -c %a "$target")" == 600 ]] || { echo "permissions: $target should be 0600"; status=1; }
done
if [[ "$mode" == --check ]]; then [[ $status == 0 ]] && echo "ok: units and env files match"; exit $status; fi
[[ -e /opt/keir/current/operator.js ]] || { echo "no release at /opt/keir/current; run deploy/release.sh <ref> first"; exit 1; }
for u in "${units[@]}"; do install -m 0644 "$u" "/etc/systemd/system/$u"; done
systemctl daemon-reload
systemctl enable --now keir-shadow.timer
if [[ -f /etc/keir-watchkeeper.env ]]; then systemctl enable --now keir-watchkeeper.timer; fi
# The guardian never starts a stopped unit, so enabling it is safe while Keir is stopped.
systemctl enable --now keir-guardian.timer
# Restart only what is already running. A stopped service stays stopped:
# installing never starts Keir, so a pause by stopping the unit survives.
for s in keir-operator keir-summon keir-inbox; do
  if systemctl is-active --quiet "$s"; then systemctl restart "$s"; echo "restarted $s"; else echo "left stopped: $s"; fi
done
./release.sh --status
