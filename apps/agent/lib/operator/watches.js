"use strict";
// Keir 3.0 F2, Proactive Sentry core. Standing watches turn external signals
// into read-only investigation findings. A watch can open work and report; it
// can never authorize an effect. Findings dedupe on (watch, subject) while
// open, so a flapping signal produces one investigation with a timeline,
// not a storm of duplicates. Signal adapters (turndiag, Sentry, GitHub,
// Railway, provider health) feed evaluate(); this module owns the policy.

const WATCHES = {
  "turn-stall": { severity: "high", breach: (s) => s.minutesWithoutTurn >= 45 },
  "turn-slow": { severity: "medium", breach: (s) => s.phaseMs >= 10 * 60000 },
  "error-spike": { severity: "high", breach: (s) => s.errorsLastHour >= 25 },
  "permanent-branch-red": { severity: "high", breach: (s) => s.red === true },
  "deploy-failed": { severity: "high", breach: (s) => s.status === "failed" },
  "provider-down": { severity: "medium", breach: (s) => s.consecutiveFailures >= 3 },
};

function createSentry(store, { now = () => Date.now() } = {}) {
  store.findings ||= {};
  const findings = store.findings;

  // signal: { watch, subject, ...measurements }. Returns the finding when a
  // threshold is breached (new or updated), or null when healthy.
  function evaluate(signal) {
    const def = WATCHES[signal?.watch];
    if (!def) throw new Error(`unknown watch: ${signal?.watch}`);
    if (!signal.subject) throw new Error("a signal needs a subject");
    const key = `${signal.watch}:${signal.subject}`;
    const open = findings[key]?.state === "open" ? findings[key] : null;
    if (!def.breach(signal)) {
      if (open) { open.state = "recovered"; open.recoveredAt = now(); }
      return null;
    }
    if (open) {
      open.observations.push({ at: now(), signal: { ...signal } });
      open.lastSeenAt = now();
      return { finding: open, created: false };
    }
    const finding = { key, watch: signal.watch, subject: signal.subject, severity: def.severity,
      state: "open", openedAt: now(), lastSeenAt: now(),
      workId: `sentry:${signal.watch}:${signal.subject}`,
      authority: "read-only-investigation",
      observations: [{ at: now(), signal: { ...signal } }] };
    findings[key] = finding;
    return { finding, created: true };
  }

  const open = () => Object.values(findings).filter((f) => f.state === "open")
    .sort((a, b) => a.openedAt - b.openedAt);
  return { evaluate, open };
}

module.exports = { WATCHES, createSentry };
