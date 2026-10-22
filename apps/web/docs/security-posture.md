# Host security posture and monitoring

Two VPS hosts carry the Lakeside surface:

| Host | Name | Role |
| --- | --- | --- |
| EU | `contabo-vps18` (`167.86.68.67`) | Ops console, MCP fleet, game sim, Caddy front door |
| US | `contabo-vps12-us` (`13.140.231.229`) | Production game (`ahd-prod-web`, `ahd-prod-worker`), Mongo, accounts |

Both are hardened the same way and both report into the console at `/security`.

## How it fits together

```
/etc/lakeside-security probe           systemd timer, 15 min
  /usr/local/bin/lakeside-security-probe  ──► /var/lib/lakeside-security/latest.json
                                                    │  (facts only, no judgements)
        EU: read directly ─────────────────────────┤
        US: ssh lakeside-us sudo cat ──────────────┘
                                                    ▼
                              apps/web/security-service.js   (rules → findings)
                                                    │
                        ┌───────────────────────────┼──────────────────────────┐
                        ▼                           ▼                          ▼
                  /security page            /api/security                Discord alert
                  (pull, 30s poll)          (JSON, 60s cache)          (new critical/high only)
```

The probe collects **facts**; the console decides what is a **finding**. Rules
change by deploying the console, never by editing a production host.

## What is enforced on each host

Applied by `deploy/security/harden-host.sh` (idempotent, safe to re-run):

| Control | Setting | Why |
| --- | --- | --- |
| Host firewall | `ufw`, default deny inbound, only 22/80/443 tcp + 443/udp | Nothing else is reachable from the internet |
| fail2ban | `sshd` (aggressive, 3 tries, 1h) + `recidive` (4 weeks) | ~1k–8k credential-stuffing attempts/day |
| SSH | key-only, `prohibit-password`, no X11/agent forwarding, `MaxAuthTries 4` | Removes password guessing entirely |
| auditd | identity/sudo/ssh/systemd/cron/module/mount watchers | Kernel-level trail of privilege and trust changes |
| sysctl | `suid_dumpable=0`, `send_redirects=0`, `kptr_restrict=2`, symlink/hardlink protection | Standard kernel hardening |
| Updates | `unattended-upgrades` for the security pocket | Patches land without a human |

Deliberately **not** changed: `rp_filter` stays at the Ubuntu default of 2
(loose). Both hosts run 7–8 Docker bridge networks and strict reverse-path
filtering breaks multi-homed container traffic.

### Port policy

Public inbound is exactly `22/tcp`, `80/tcp`, `443/tcp`, `443/udp`. Caddy
terminates TLS and proxies to loopback. Before this change the EU box also
accepted inbound on `3400` (sim API), `8090` (a basicauth admin vhost whose
backend had been dead) and `19732` (worldsim MCP) — all three are now denied by
the firewall and flagged by an `exposure-binds-all-interfaces` finding until
they are also bound to `127.0.0.1`.

Service containers must publish as `127.0.0.1:<port>:<port>`. Docker's published
ports bypass `ufw` entirely, which is why `docker-published-public` is a
high-severity finding rather than a note.

## Reading /security

- **Score** — starts at 100, minus 25 per critical, 10 per high, 4 per medium,
  1 per low. Posture bands: `good` (no medium+), `watch`, `at-risk`, `critical`.
- **Per-host card** — firewall, fail2ban jails and bans, auditd rules, pending
  security updates, SSH auth mode, 24h SSH auth volume, container shape.
- **Findings** — severity, host, what it means, and the exact fix command.
- **Re-probe** — runs the probe on both hosts now instead of waiting for the
  timer. Same-origin POST, admin-only.

A host that stops reporting is itself a finding (`probe-stale` after 45 min,
`probe-unreachable` on SSH failure). A silent probe must never read as healthy.

## Alerting

`security-alert.js` runs in the console every 5 minutes and posts to Discord for
**new** `critical` and `high` findings only, then posts a recovery line when they
clear. State is on disk (`/var/lib/lakeside-ops-dashboard/security-alerts.json`)
so restarts and deploys do not re-alert an open issue.

Routing: `DISCORD_SECURITY_WEBHOOK_URL`, falling back to
`DISCORD_OPS_WEBHOOK_URL`. With no webhook configured, alerting is a no-op and
the page still shows everything.

## Operating it

```bash
# probe now, on one host
sudo systemctl start lakeside-security-probe.service
sudo cat /var/lib/lakeside-security/latest.json | jq .summary

# timer health
systemctl list-timers lakeside-security-probe.timer
journalctl -u lakeside-security-probe -n 50

# fail2ban
sudo fail2ban-client status sshd
sudo fail2ban-client status recidive
sudo fail2ban-client set sshd unbanip 203.0.113.7

# firewall
sudo ufw status numbered

# audit trail
sudo ausearch -k privilege -ts today
sudo aureport --auth --summary
```

### Emergency: restore reachability

If a firewall change locks the box out, reboot is **not** required:

```bash
sudo ufw disable          # via provider console if SSH is gone
sudo systemctl stop lakeside-security-probe.timer
```

The hardening scripts arm an 8-minute `systemd-run` rollback while they run, so
a self-inflicted lockout during a change heals on its own unless the change is
confirmed.

## Changing a rule

1. Edit `RULES` in `apps/web/security-service.js`.
2. Add a case to `security-routes.test.js` (finding rules are unit-tested
   without touching a host).
3. `npm test`.
4. Deploy: `/root/bin/lakeside-ops-web-release build origin/main && … activate`.

## Known gaps (intentional, tracked)

- `agent` has passwordless sudo on the US box because the automation runs as
  `agent`. That is reported as `accounts-nopasswd-sudo` (medium) whenever the
  grant count exceeds three, and should be scoped further.
- Both hosts still have a root login shell. Root login over SSH is key-only.
- No file-integrity baseline (AIDE) is installed. auditd covers trust-store and
  config drift; full binary-integrity comparison is a separate project.
- `auditd` rules are mutable (`-e 2` is not set) so rules can evolve without a
  production reboot. Revisit once the ruleset is stable.
