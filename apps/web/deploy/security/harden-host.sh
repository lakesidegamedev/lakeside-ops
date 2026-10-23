#!/usr/bin/env bash
# Lakeside host hardening — idempotent apply for an Ubuntu VPS.
#
#   sudo ./harden-host.sh                 # apply everything, verify, report
#   sudo ./harden-host.sh --dry-run       # print what would change
#   sudo ./harden-host.sh --no-firewall   # everything except the ufw cutover
#
# Safe to re-run. Every step is checked before it is applied, so a second run is
# a no-op. The firewall step arms an 8-minute automatic rollback via systemd-run
# before touching anything, and cancels it only after SSH, 80 and 443 are proven
# reachable from the host itself.
#
# Not managed here: OS release upgrades, reboots, user/account decisions.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY=0
DO_FIREWALL=1
ROLLBACK_UNIT="lakeside-ufw-rollback"

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --no-firewall) DO_FIREWALL=0 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 64 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 64; }

CHANGED=0
SKIPPED=0
say()  { printf '%s\n' "$*"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
run()  {
  if [[ $DRY -eq 1 ]]; then printf '   would run: %s\n' "$*"; SKIPPED=$((SKIPPED+1));
  else "$@"; CHANGED=$((CHANGED+1)); fi
}
# install file only when content differs (keeps mtimes stable, avoids churn)
install_if_changed() {
  local src=$1 dst=$2 mode=${3:-0644}
  if [[ -f "$dst" ]] && cmp -s "$src" "$dst"; then
    printf '   unchanged: %s\n' "$dst"; SKIPPED=$((SKIPPED+1)); return 0
  fi
  run install -m "$mode" "$src" "$dst"
}

step "packages"
export DEBIAN_FRONTEND=noninteractive
MISSING=()
for pkg in ufw fail2ban python3-systemd auditd unattended-upgrades; do
  dpkg -s "$pkg" >/dev/null 2>&1 || MISSING+=("$pkg")
done
if ((${#MISSING[@]})); then
  run apt-get update -qq
  run apt-get install -y -qq "${MISSING[@]}"
else
  say "   already installed"
fi

step "ssh"
install_if_changed "$HERE/99-lakeside-hardening.conf" /etc/ssh/sshd_config.d/99-lakeside-hardening.conf 0644
if [[ $DRY -eq 0 ]]; then
  sshd -t || { echo "sshd config invalid; not reloading" >&2; exit 1; }
  systemctl reload ssh
  say "   effective: $(sshd -T | awk '/^(permitrootlogin|passwordauthentication|x11forwarding|allowagentforwarding|maxauthtries) /{printf "%s=%s ",$1,$2}')"
fi

step "sysctl"
install_if_changed "$HERE/60-lakeside-hardening.conf" /etc/sysctl.d/60-lakeside-hardening.conf 0644
run sysctl --system

step "fail2ban"
install_if_changed "$HERE/zz-lakeside-hardening.conf" /etc/fail2ban/jail.d/zz-lakeside-hardening.conf 0644
# fail2ban reads jail.d in lexical order and later files win, so this sorts last
# on purpose. We do not delete the distro's defaults-debian.conf: its journalmatch
# is wrong on some images (it names sshd.service), and ours overrides it because
# it is read afterwards.
run rm -f /etc/fail2ban/jail.d/20-lakeside-hardening.conf
if [[ $DRY -eq 0 ]]; then
  fail2ban-client --test >/dev/null
  systemctl enable --now fail2ban
  systemctl restart fail2ban
  sleep 2
  say "   jails: $(fail2ban-client status | awk -F: '/Jail list/{gsub(/^[ \t]+/,"",$2); print $2}')"
fi

step "auditd"
install_if_changed "$HERE/99-lakeside.rules" /etc/audit/rules.d/99-lakeside.rules 0640
if [[ $DRY -eq 0 ]]; then
  # Per-host authorised_keys watches, regenerated so a moved home does not rot.
  sed -i '/## SSH authorized_keys trust (generated per host)/,$d' /etc/audit/rules.d/99-lakeside.rules
  {
    echo ""
    echo "## SSH authorized_keys trust (generated per host)"
    for d in /root/.ssh /home/*/.ssh; do [[ -d "$d" ]] && echo "-w $d -p wa -k sshkeys"; done
  } >> /etc/audit/rules.d/99-lakeside.rules

  if ! grep -q '\[lakeside-hardening\]' /etc/audit/auditd.conf; then
    cp /etc/audit/auditd.conf "/etc/audit/auditd.conf.bak-$(date +%s)"
    cat >> /etc/audit/auditd.conf <<'EOF'

# [lakeside-hardening] never suspend auditing on disk pressure; log instead
max_log_file = 200
num_logs = 10
space_left = 2048
space_left_action = SYSLOG
admin_space_left = 1024
admin_space_left_action = SYSLOG
disk_full_action = SYSLOG
disk_error_action = SYSLOG
EOF
    CHANGED=$((CHANGED+1))
  fi
  augenrules --load >/dev/null 2>&1 || true
  systemctl enable --now auditd
  say "   rules loaded: $(auditctl -l | wc -l)"
fi

step "security probe"
run install -m 0755 "$HERE/lakeside-security-probe" /usr/local/bin/lakeside-security-probe
install_if_changed "$HERE/lakeside-security-probe.service" /etc/systemd/system/lakeside-security-probe.service 0644
install_if_changed "$HERE/lakeside-security-probe.timer" /etc/systemd/system/lakeside-security-probe.timer 0644
run systemctl daemon-reload
run systemctl enable --now lakeside-security-probe.timer
run systemctl start lakeside-security-probe.service

if [[ $DO_FIREWALL -eq 1 ]]; then
  step "firewall"
  # Docker inserts its own FORWARD rules; a DROP forward policy would break
  # container egress the moment ufw comes up.
  if grep -q '^DEFAULT_FORWARD_POLICY="DROP"' /etc/default/ufw 2>/dev/null; then
    run sed -i 's/^DEFAULT_FORWARD_POLICY="DROP"/DEFAULT_FORWARD_POLICY="ACCEPT"/' /etc/default/ufw
  fi
  if ! ufw status 2>/dev/null | grep -q "Status: active"; then
    if [[ $DRY -eq 0 ]]; then
      say "   arming 8-minute rollback"
      systemd-run --on-active=8min --unit="$ROLLBACK_UNIT" \
        --description="roll back ufw cutover" /usr/sbin/ufw --force disable >/dev/null 2>&1 || true
    fi
    run ufw --force reset
    run ufw default deny incoming
    run ufw default allow outgoing
    run ufw default allow routed
    run ufw allow 22/tcp comment SSH
    run ufw allow 80/tcp comment 'HTTP (Caddy)'
    run ufw allow 443/tcp comment 'HTTPS (Caddy)'
    run ufw allow 443/udp comment 'HTTP/3 QUIC (Caddy)'
    run ufw --force enable
    if [[ $DRY -eq 0 ]]; then
      # Prove the paths an operator needs before cancelling the rollback.
      ok=1
      for p in 22 80 443; do
        timeout 5 bash -c "echo > /dev/tcp/127.0.0.1/$p" 2>/dev/null || { echo "   port $p not listening locally" >&2; ok=0; }
      done
      if [[ $ok -eq 1 ]]; then
        systemctl stop "$ROLLBACK_UNIT.timer" 2>/dev/null || true
        systemctl reset-failed "$ROLLBACK_UNIT.timer" 2>/dev/null || true
        say "   rollback cancelled; firewall confirmed"
      else
        say "   local checks passed=false; leaving the 8-minute rollback armed" >&2
      fi
    fi
  else
    say "   already active; ensuring required allows"
    for spec in "22/tcp:SSH" "80/tcp:HTTP (Caddy)" "443/tcp:HTTPS (Caddy)" "443/udp:HTTP/3 QUIC (Caddy)"; do
      port=${spec%%:*}; label=${spec#*:}
      ufw status 2>/dev/null | grep -qE "^${port}( \(v6\))?[[:space:]]+ALLOW" || run ufw allow "$port" comment "$label"
    done
  fi
fi

step "summary"
say "   changes applied: $CHANGED   already correct: $SKIPPED"
if [[ $DRY -eq 1 ]]; then
  say "   (dry run — nothing was modified)"
  exit 0
fi
say ""
say "   firewall : $(ufw status | head -1 | sed 's/Status: //')"
say "   fail2ban : $(systemctl is-active fail2ban) / $(systemctl is-enabled fail2ban 2>/dev/null || echo absent)"
say "   auditd   : $(systemctl is-active auditd) / $(systemctl is-enabled auditd 2>/dev/null || echo absent)"
say "   probe    : $(systemctl is-active lakeside-security-probe.timer 2>/dev/null || echo absent)"
pending=$(apt-get -s upgrade 2>/dev/null | grep '^Inst .*security' | wc -l)
say "   security updates pending: $pending"
say ""
say "   Run the console (/security) to see both hosts judged against the rules."
