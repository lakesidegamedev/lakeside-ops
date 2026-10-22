"use strict";

// ─── HOST SECURITY POSTURE ────────────────────────────────────────────────
// Reads the security *facts* that `lakeside-security-probe` writes on each VPS
// (/var/lib/lakeside-security/latest.json, refreshed by a systemd timer every
// 15 min) and turns them into operator-facing findings.
//
// Separation of concerns, deliberately:
//   hosts  -> collect facts, no opinions, no network access
//   here   -> decide what is a problem, how bad, and what to do about it
//
// That means a rule change ships by deploying the console, with no production
// host edits and no new SSH surface.
//
// Collection is cached (60s) so the page and the JSON API can poll cheaply.
// A host that cannot be reached keeps its last known snapshot and is reported
// as a monitoring blind spot rather than silently disappearing.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const PROBE_STATE = process.env.SECURITY_PROBE_STATE || "/var/lib/lakeside-security";
const CACHE_MS = 60_000;
const REMOTE_TIMEOUT_MS = 25_000;
const STALE_MS = 45 * 60_000; // 3 missed 15-minute probes
const STALE_HARD_MS = 6 * 60 * 60_000; // withholding a snapshot entirely

// Both VPS hosts. `ssh` is an alias from /root/.ssh/config; the console runs as
// root and uses the interlink key. `local` reads the file directly.
const HOSTS = Object.freeze([
  { id: "eu", label: "EU", name: "contabo-vps18", ssh: null },
  { id: "us", label: "US", name: "contabo-vps12-us", ssh: "lakeside-us" },
]);

const EXPECTED_INBOUND = new Set(["22/tcp", "80/tcp", "443/tcp", "443/udp"]);

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const SEVERITY_WEIGHT = { critical: 25, high: 10, medium: 4, low: 1, info: 0 };

let cache = { at: 0, value: null };
let cachePromise = null;

function readLocalSnapshot() {
  try {
    const raw = fs.readFileSync(path.join(PROBE_STATE, "latest.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
    return null;
  } catch {
    return null;
  }
}

async function readRemoteSnapshot(host) {
  const { stdout } = await execFileAsync(
    "ssh",
    [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=8",
      "-o", "StrictHostKeyChecking=yes",
      host.ssh,
      "sudo", "-n", "cat", path.join(PROBE_STATE, "latest.json"),
    ],
    { timeout: REMOTE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
  );
  if (!stdout || !stdout.trim()) throw new Error("empty probe output");
  return JSON.parse(stdout);
}

function ageMs(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Date.now() - t;
}

async function collectHost(host, previous) {
  const started = Date.now();
  try {
    const facts = host.ssh ? await readRemoteSnapshot(host) : readLocalSnapshot();
    if (!facts) throw new Error("no probe data — is lakeside-security-probe.timer running?");
    const age = ageMs(facts.collectedAt);
    return {
      id: host.id,
      label: host.label,
      name: facts.host || host.name,
      ok: true,
      error: null,
      collectedAt: facts.collectedAt || null,
      ageMs: age,
      stale: age != null && age > STALE_MS,
      fetchMs: Date.now() - started,
      facts,
    };
  } catch (error) {
    const message = String((error && error.message) || error).split("\n")[0].slice(0, 300);
    const fallback = previous && previous.ok ? previous : null;
    const fallbackAge = fallback ? ageMs(fallback.collectedAt) : null;
    // Only keep a stale snapshot as context for a few hours; beyond that it is
    // more honest to show nothing than to show a six-hour-old "all clear".
    const usable = fallback && fallbackAge != null && fallbackAge < STALE_HARD_MS ? fallback : null;
    return {
      id: host.id,
      label: host.label,
      name: host.name,
      ok: false,
      error: message,
      collectedAt: usable ? usable.collectedAt : null,
      ageMs: fallbackAge,
      stale: true,
      fetchMs: Date.now() - started,
      facts: usable ? usable.facts : null,
    };
  }
}

// ─── findings ─────────────────────────────────────────────────────────────
// Each rule gets the facts object and returns zero or more findings. `id` must
// be stable — it is what alert de-duplication keys on.

function finding(host, rule, severity, title, detail, remedy) {
  return { id: `${host.id}:${rule}`, rule, host: host.id, hostLabel: host.label, severity, title, detail, remedy };
}

const RULES = [
  function firewall(host, f) {
    const out = [];
    const fw = f.firewall || {};
    if (!fw.active) {
      out.push(
        finding(
          host, "firewall-inactive", "critical",
          "Host firewall is not active",
          "Every listening service is reachable from the public internet, including internal MCP endpoints.",
          "ufw --force enable (confirm 22/80/443 are allowed first)",
        ),
      );
      return out;
    }
    if (fw.defaultIncoming !== "deny") {
      out.push(
        finding(host, "firewall-default-allow", "high",
          "Firewall default inbound policy is not deny",
          `Incoming default is "${fw.defaultIncoming}", so unlisted ports are exposed.`,
          "ufw default deny incoming && ufw reload",
        ),
      );
    }
    const allowed = new Set((fw.allowedInbound || []).map((a) => a.port));
    const unexpected = [...allowed].filter((p) => !EXPECTED_INBOUND.has(p));
    if (unexpected.length) {
      out.push(
        finding(host, "firewall-unexpected-open", "medium",
          `Firewall admits ${unexpected.length} port(s) beyond the documented set`,
          `Allowed: ${[...allowed].join(", ")}. Documented set: ${[...EXPECTED_INBOUND].join(", ")}.`,
          "Close any port that is not required by a public site: ufw delete allow <port>",
        ),
      );
    }
    return out;
  },

  function fail2ban(host, f) {
    const out = [];
    const f2b = f.fail2ban || {};
    if (!f2b.running) {
      out.push(
        finding(host, "fail2ban-down", "high",
          "fail2ban is not running",
          "Nothing is throttling credential stuffing against SSH, which on these hosts means thousands of attempts per day.",
          "systemctl enable --now fail2ban && fail2ban-client status",
        ),
      );
      return out;
    }
    if (!(f2b.jails || []).includes("sshd")) {
      out.push(
        finding(host, "fail2ban-no-sshd-jail", "high",
          "fail2ban is running but the sshd jail is missing",
          `Active jails: ${(f2b.jails || []).join(", ") || "none"}.`,
          "Enable [sshd] in /etc/fail2ban/jail.d/",
        ),
      );
    }
    if (!(f2b.jails || []).includes("recidive")) {
      out.push(
        finding(host, "fail2ban-no-recidive", "low",
          "No recidive jail, so repeat offenders are only banned for one window",
          "Distributed brute force rotates source IPs; recidive raises the ban to four weeks after three re-offences.",
          "Enable [recidive] in /etc/fail2ban/jail.d/20-lakeside-hardening.conf",
        ),
      );
    }
    return out;
  },

  function ssh(host, f) {
    const out = [];
    const ssh = f.ssh || {};
    const rootLogin = String(ssh.permitRootLogin || "").toLowerCase();
    if (rootLogin === "yes") {
      out.push(
        finding(host, "ssh-root-password", "critical",
          "SSH allows root login with a password",
          "A single leaked password is full control of the host.",
          "Set PermitRootLogin prohibit-password and reload sshd",
        ),
      );
    }
    if (String(ssh.passwordAuthentication || "").toLowerCase() !== "no") {
      out.push(
        finding(host, "ssh-password-auth", "critical",
          "SSH password authentication is enabled",
          "The host takes thousands of password attempts per day; key-only auth removes that entire attack surface.",
          "Set PasswordAuthentication no and reload sshd",
        ),
      );
    }
    if (String(ssh.x11Forwarding || "").toLowerCase() === "yes") {
      out.push(
        finding(host, "ssh-x11-forwarding", "low",
          "SSH X11 forwarding is enabled",
          "X11 forwarding exposes the local display server to the remote session.",
          "Set X11Forwarding no and reload sshd",
        ),
      );
    }
    if (String(ssh.agentForwarding || "").toLowerCase() === "yes") {
      out.push(
        finding(host, "ssh-agent-forwarding", "low",
          "SSH agent forwarding is enabled",
          "A forwarded agent socket is a usable credential for anyone who gains code execution on the host.",
          "Set AllowAgentForwarding no and reload sshd",
        ),
      );
    }
    const tries = Number(ssh.maxAuthTries);
    if (Number.isFinite(tries) && tries > 4) {
      out.push(
        finding(host, "ssh-max-auth-tries", "low",
          `SSH allows ${tries} authentication attempts per connection`,
          "Fewer attempts per connection makes blind guessing more expensive.",
          "Set MaxAuthTries 4 and reload sshd",
        ),
      );
    }
    return out;
  },

  function audit(host, f) {
    const out = [];
    const a = f.auditd || {};
    if (!a.active) {
      out.push(
        finding(host, "auditd-down", "high",
          "auditd is not running",
          "There is no kernel-level trail of who changed identities, sudo policy, SSH trust or systemd units.",
          "systemctl enable --now auditd && augenrules --load",
        ),
      );
      return out;
    }
    if (Number(a.rules || 0) < 10) {
      out.push(
        finding(host, "auditd-few-rules", "medium",
          "auditd has an empty or near-empty ruleset",
          `Only ${a.rules || 0} rules loaded; the baseline expects at least 20.`,
          "Install /etc/audit/rules.d/99-lakeside.rules and run augenrules --load",
        ),
      );
    }
    if (Number(a.lost || 0) > 0) {
      out.push(
        finding(host, "auditd-lost-events", "medium",
          `${a.lost} audit events have been dropped`,
          "The audit backlog overflowed, so the trail has gaps.",
          "Raise backlog_limit in /etc/audit/auditd.conf or reduce rule volume",
        ),
      );
    }
    return out;
  },

  function updates(host, f) {
    const out = [];
    const u = f.updates || {};
    const pending = Number(u.securityPending || 0);
    if (pending > 0) {
      out.push(
        finding(host, "updates-security-pending", pending > 20 ? "high" : "medium",
          `${pending} security update(s) pending`,
          u.unattendedActive
            ? "unattended-upgrades is running but has not cleared the security pocket — check its log."
            : "unattended-upgrades is not active, so nothing is applying them.",
          "sudo unattended-upgrade -v",
        ),
      );
    }
    if (u.rebootRequired) {
      out.push(
        finding(host, "updates-reboot-required", "low",
          "A reboot is required to finish applying updates",
          "Typically a kernel or libc update is staged but not live.",
          "Schedule a maintenance reboot",
        ),
      );
    }
    if (u.unattendedEnabled === false) {
      out.push(
        finding(host, "updates-auto-disabled", "medium",
          "Automatic security updates are disabled",
          "Security patches will only land when someone runs them by hand.",
          "systemctl enable --now unattended-upgrades",
        ),
      );
    }
    return out;
  },

  function accounts(host, f) {
    const out = [];
    const a = f.accounts || {};
    const uid0 = (a.uid0 || []).filter((n) => n !== "root");
    if (uid0.length) {
      out.push(
        finding(host, "accounts-extra-uid0", "critical",
          `Additional UID 0 account(s): ${uid0.join(", ")}`,
          "Any UID 0 account is equivalent to root and is a common persistence mechanism.",
          "Investigate and remove/renumber the account",
        ),
      );
    }
    if ((a.emptyPassword || []).length) {
      out.push(
        finding(host, "accounts-empty-password", "critical",
          `Account(s) with an empty password: ${a.emptyPassword.join(", ")}`,
          "The account authenticates with no credential at all.",
          "Lock the account or set a password immediately",
        ),
      );
    }
    const nopasswd = Number(a.nopasswdSudoEntries || 0);
    if (nopasswd > 3) {
      out.push(
        finding(host, "accounts-nopasswd-sudo", "medium",
          `${nopasswd} passwordless sudo grants`,
          "Passwordless sudo means code execution as that user is immediately root, with no second factor.",
          "Review /etc/sudoers.d and scope grants to specific commands",
        ),
      );
    }
    return out;
  },

  function exposure(host, f) {
    const out = [];
    const ex = f.exposure || {};
    const fw = f.firewall || {};
    const allowed = new Set((fw.allowedInbound || []).map((p) => String(p.port).split("/")[0]));
    const bound = (ex.publicListeners || []).filter((l) => l.port !== 22);
    const notFirewalled = bound.filter((l) => !allowed.has(String(l.port)));
    if (fw.active && notFirewalled.length) {
      out.push(
        finding(host, "exposure-binds-all-interfaces", "info",
          `${notFirewalled.length} service(s) bind all interfaces but are blocked by the firewall`,
          `Ports ${notFirewalled.map((l) => l.port).join(", ")} listen on 0.0.0.0 while ufw denies them. Correct today, but one firewall mistake exposes them.`,
          "Bind internal services to 127.0.0.1 where the application allows it",
        ),
      );
    }
    const docker = ex.docker || {};
    if ((docker.published || []).length) {
      out.push(
        finding(host, "docker-published-public", "high",
          `${docker.published.length} container port(s) published on 0.0.0.0`,
          `Docker bypasses ufw for published ports, so these are reachable even when the host firewall says deny: ${(docker.published || []).map((p) => p.name).join(", ")}.`,
          "Publish as 127.0.0.1:<port>:<port> and front it with Caddy",
        ),
      );
    }
    if (Number(docker.privileged || 0) > 0) {
      out.push(
        finding(host, "docker-privileged", "high",
          `${docker.privileged} privileged container(s) running`,
          "A privileged container is effectively root on the host.",
          "Remove --privileged and grant only the capabilities required",
        ),
      );
    }
    return out;
  },

  function integrity(host, f) {
    const out = [];
    const i = f.integrity || {};
    const perms = i.perms || {};
    if ((i.worldWritableEtc || []).length) {
      out.push(
        finding(host, "integrity-world-writable-etc", "medium",
          `${i.worldWritableEtc.length} world-writable file(s) under /etc`,
          i.worldWritableEtc.slice(0, 5).join(", "),
          "chmod o-w on each, then find the process writing them",
        ),
      );
    }
    if (perms["/etc/shadow"] && perms["/etc/shadow"] !== "640") {
      out.push(
        finding(host, "integrity-shadow-perms", "medium",
          `/etc/shadow mode is ${perms["/etc/shadow"]}, expected 640`,
          "A readable shadow file is offline-crackable password material.",
          "chmod 640 /etc/shadow && chown root:shadow /etc/shadow",
        ),
      );
    }
    if (perms["/root/.ssh"] && perms["/root/.ssh"] !== "700") {
      out.push(
        finding(host, "integrity-ssh-home-perms", "medium",
          `/root/.ssh mode is ${perms["/root/.ssh"]}, expected 700`,
          "Loose permissions on the trust store weaken the guarantee that only root holds the keys.",
          "chmod 700 /root/.ssh",
        ),
      );
    }
    return out;
  },

  function authVolume(host, f) {
    const out = [];
    const a = f.auth || {};
    const failed = Number(a.sshFailed24h || 0);
    if (failed >= 5000) {
      out.push(
        finding(host, "auth-brute-force-high", "medium",
          `${failed.toLocaleString()} failed SSH authentications in 24h`,
          `${a.uniqueSourceIps || 0} source addresses. Bans are in place; this is background noise, but a sustained jump means a targeted attempt.`,
          "Review fail2ban status and consider restricting 22 to known networks",
        ),
      );
    } else if (failed >= 1000) {
      out.push(
        finding(host, "auth-brute-force-elevated", "info",
          `${failed.toLocaleString()} failed SSH authentications in 24h`,
          `${a.uniqueSourceIps || 0} source addresses, all handled by fail2ban.`,
          "No action; watch for a step change",
        ),
      );
    }
    return out;
  },

  function services(host, f) {
    const failed = (f.services || {}).failedUnits || [];
    if (!failed.length) return [];
    return [
      finding(host, "services-failed-units", "low",
        `${failed.length} failed systemd unit(s)`,
        failed.slice(0, 6).join(", "),
        "systemctl status <unit> — a failed unit can be an outage or a security control that silently stopped",
      ),
    ];
  },
];

// Monitoring-health findings live outside RULES because they are about the
// collector itself, not the host facts.
function monitoringFindings(record) {
  const out = [];
  if (!record.ok) {
    out.push(
      finding(
        { id: record.id, label: record.label },
        "probe-unreachable", "high",
        `Security probe on the ${record.label} host is unreachable`,
        record.error || "No data returned.",
        "Check the interlink and `systemctl status lakeside-security-probe.timer` on that host",
      ),
    );
    return out;
  }
  if (record.stale) {
    const mins = record.ageMs == null ? "?" : Math.round(record.ageMs / 60000);
    out.push(
      finding(
        { id: record.id, label: record.label },
        "probe-stale", "medium",
        `Security probe on the ${record.label} host is ${mins} min old`,
        "Expected every 15 minutes. A silent probe is a monitoring outage, not a clean bill of health.",
        "systemctl list-timers lakeside-security-probe.timer; journalctl -u lakeside-security-probe",
      ),
    );
  }
  return out;
}

function evaluate(records) {
  const findings = [];
  for (const record of records) {
    findings.push(...monitoringFindings(record));
    if (!record.facts) continue;
    for (const rule of RULES) {
      try {
        findings.push(...rule({ id: record.id, label: record.label }, record.facts));
      } catch (error) {
        findings.push(
          finding({ id: record.id, label: record.label }, "rule-error", "info",
            `Security rule "${rule.name}" failed`, String(error.message || error),
            "This is a console bug, not a host problem"),
        );
      }
    }
  }
  findings.sort(
    (a, b) =>
      (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) ||
      a.host.localeCompare(b.host) ||
      a.title.localeCompare(b.title),
  );
  return findings;
}

function summarize(records, findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  let penalty = 0;
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] || 0) + 1;
    penalty += SEVERITY_WEIGHT[f.severity] || 0;
  }
  const reachable = records.filter((r) => r.ok).length;
  const score = Math.max(0, 100 - penalty);
  const posture =
    counts.critical > 0 ? "critical" : counts.high > 0 ? "at-risk" : counts.medium > 0 ? "watch" : "good";
  return {
    score,
    posture,
    counts,
    hostsReachable: reachable,
    hostsTotal: records.length,
  };
}

function hostView(record) {
  const f = record.facts || {};
  return {
    id: record.id,
    label: record.label,
    name: record.name,
    ok: record.ok,
    error: record.error,
    collectedAt: record.collectedAt,
    ageMs: record.ageMs,
    stale: record.stale,
    fetchMs: record.fetchMs,
    firewall: f.firewall
      ? { active: f.firewall.active, defaultIncoming: f.firewall.defaultIncoming, allowedInbound: f.firewall.allowedInbound }
      : null,
    fail2ban: f.fail2ban
      ? {
          running: f.fail2ban.running,
          jails: f.fail2ban.jails,
          currentlyBanned: f.fail2ban.currentlyBanned,
          totalBanned: f.fail2ban.totalBanned,
          perJail: f.fail2ban.perJail,
        }
      : null,
    auditd: f.auditd || null,
    updates: f.updates || null,
    ssh: f.ssh
      ? {
          permitRootLogin: f.ssh.permitRootLogin,
          passwordAuthentication: f.ssh.passwordAuthentication,
          x11Forwarding: f.ssh.x11Forwarding,
          agentForwarding: f.ssh.agentForwarding,
          maxAuthTries: f.ssh.maxAuthTries,
          authorizedKeys: f.ssh.authorizedKeys,
        }
      : null,
    auth: f.auth || null,
    exposure: f.exposure || null,
    accounts: f.accounts || null,
    integrity: f.integrity || null,
    services: f.services || null,
    os: f.os || null,
    kernel: f.kernel || null,
    uptimeSeconds: f.uptimeSeconds ?? null,
  };
}

async function build({ force = false, previous = null } = {}) {
  const now = Date.now();
  if (!force && cache.value && now - cache.at < CACHE_MS) return cache.value;

  const priorById = new Map((previous || (cache.value && cache.value.hosts) || []).map((h) => [h.id, h]));
  const records = await Promise.all(HOSTS.map((host) => collectHost(host, priorById.get(host.id))));
  const findings = evaluate(records);
  const summary = summarize(records, findings);
  const value = {
    generatedAt: new Date().toISOString(),
    schema: 1,
    summary,
    hosts: records.map(hostView),
    findings,
    monitoring: {
      expectedIntervalMinutes: 15,
      staleAfterMinutes: Math.round(STALE_MS / 60000),
      hostsReporting: records.filter((r) => r.ok && !r.stale).length,
      hostsTotal: records.length,
    },
  };
  cache = { at: now, value };
  return value;
}

async function snapshot({ force = false } = {}) {
  if (cachePromise) return cachePromise;
  cachePromise = build({ force })
    .catch((error) => {
      // Never leave the caller without a shape. A total collection failure is
      // itself a finding-shaped event.
      return {
        generatedAt: new Date().toISOString(),
        schema: 1,
        summary: { score: 0, posture: "critical", counts: { critical: 1, high: 0, medium: 0, low: 0, info: 0 }, hostsReachable: 0, hostsTotal: HOSTS.length },
        hosts: HOSTS.map((h) => ({
          id: h.id, label: h.label, name: h.name, ok: false, error: String(error.message || error),
          collectedAt: null, ageMs: null, stale: true, fetchMs: 0,
        })),
        findings: [
          {
            id: "console:collector-failed", rule: "collector-failed", host: "console", hostLabel: "Console",
            severity: "critical", title: "Security collector failed", detail: String(error.message || error),
            remedy: "Check the console logs and SSH access to the US host",
          },
        ],
        monitoring: { expectedIntervalMinutes: 15, staleAfterMinutes: 45, hostsReporting: 0, hostsTotal: HOSTS.length },
      };
    })
    .finally(() => {
      cachePromise = null;
    });
  return cachePromise;
}

// Run the probe now on every host, then rebuild. Used by the page's "Re-probe"
// button so an operator can confirm a fix without waiting for the timer.
async function reprobe() {
  const results = [];
  for (const host of HOSTS) {
    try {
      if (host.ssh) {
        await execFileAsync(
          "ssh",
          ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host.ssh, "sudo", "-n", "systemctl", "start", "lakeside-security-probe.service"],
          { timeout: REMOTE_TIMEOUT_MS },
        );
      } else {
        await execFileAsync("systemctl", ["start", "lakeside-security-probe.service"], { timeout: REMOTE_TIMEOUT_MS });
      }
      results.push({ host: host.id, ok: true });
    } catch (error) {
      results.push({ host: host.id, ok: false, error: String(error.message || error).split("\n")[0] });
    }
  }
  cache = { at: 0, value: null };
  const value = await build({ force: true });
  return { results, snapshot: value };
}

function resetCache() {
  cache = { at: 0, value: null };
  cachePromise = null;
}

module.exports = {
  HOSTS,
  EXPECTED_INBOUND,
  RULES,
  evaluate,
  summarize,
  snapshot,
  reprobe,
  resetCache,
  // exposed for tests
  __internal: { ageMs, hostView },
};
