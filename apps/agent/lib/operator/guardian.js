"use strict";
// Keir 8.4 guardian: the watchdog that does not depend on the thing it watches. It runs as its own
// one-shot unit every minute (keir-guardian.timer), so a hung or crashed operator cannot take it down.
//
// What it does, per monitored unit:
//   - stopped on purpose (ActiveState=inactive): LEFT ALONE. The owner stopping Keir stays stopped.
//   - failed (crashed past systemd's own restart limit): restart, with backoff.
//   - active but unhealthy for hangGraceMs (health endpoint unreachable, 503, stale tickers, outbox
//     stuck): restart, with backoff.
//   - after maxRestarts in windowMs: STOP restarting and alert the owner (direct Discord DM, because the
//     operator's own outbox may be the thing that is broken). One alert per episode, repeated every
//     alertRepeatMs while it stays down. The restart count resets only after the unit stays healthy.
//
// This file is pure decisions. bin/keir-guardian.js does the I/O (systemctl, HTTP, Discord).
const MIN = 60000, HOUR = 3600000;
const DEFAULTS = Object.freeze({ hangGraceMs: 5 * MIN, maxRestarts: 3, windowMs: HOUR, baseBackoffMs: MIN, maxBackoffMs: 15 * MIN, healthyResetMs: 30 * MIN, alertRepeatMs: 6 * HOUR });

// obs: { unit, activeState, healthOk (true|false|null when the unit has no probe), healthDetail }
// state: this unit's persisted record { restarts: [at], unhealthySince, healthySince, gaveUpAt, lastAlertAt }
function decideUnit(obs, state, now, cfg = DEFAULTS) {
  const s = state, restarts = (s.restarts || []).filter((at) => now - at < cfg.windowMs);
  s.restarts = restarts;
  if (obs.activeState === "inactive" || obs.activeState === "deactivating") { delete s.unhealthySince; delete s.gaveUpAt; delete s.lastAlertAt; s.restarts = []; return { action: "none", status: "stopped", reason: "stopped on purpose; left alone" }; }
  if (obs.activeState === "activating" || obs.activeState === "reloading") return { action: "none", status: "starting", reason: "systemd is starting it" };
  let reason = null;
  if (obs.activeState === "failed") reason = "unit failed";
  else if (obs.activeState !== "active") reason = `unexpected state ${obs.activeState}`;
  else if (obs.healthOk === false) {
    s.unhealthySince ||= now;
    if (now - s.unhealthySince >= cfg.hangGraceMs) reason = `unhealthy for ${Math.round((now - s.unhealthySince) / MIN)} min: ${String(obs.healthDetail || "no detail").slice(0, 200)}`;
    else return { action: "none", status: "degraded", reason: `unhealthy ${Math.round((now - s.unhealthySince) / MIN)} min, inside the ${Math.round(cfg.hangGraceMs / MIN)} min grace` };
  } else {
    delete s.unhealthySince;
    s.healthySince ||= now;
    if (now - s.healthySince >= cfg.healthyResetMs) { s.restarts = []; delete s.gaveUpAt; delete s.lastAlertAt; }
    return { action: "none", status: "healthy", reason: "healthy" };
  }
  delete s.healthySince;
  // Once it has given up it stays given up until the unit has been healthy for a while or the owner stops or restarts it.
  if (s.gaveUpAt || restarts.length >= cfg.maxRestarts) {
    const first = !s.gaveUpAt;
    s.gaveUpAt ||= now;
    const alert = first || now - (s.lastAlertAt || 0) >= cfg.alertRepeatMs;
    if (alert) s.lastAlertAt = now;
    return { action: alert ? "give_up_alert" : "give_up", status: "down", reason: `${reason}; ${restarts.length} restart${restarts.length === 1 ? "" : "s"} in the last ${Math.round(cfg.windowMs / MIN)} min, not restarting again` };
  }
  const backoff = Math.min(cfg.maxBackoffMs, cfg.baseBackoffMs * 2 ** restarts.length);
  const last = restarts.at(-1);
  if (last && now - last < backoff) return { action: "none", status: "backoff", reason: `${reason}; next restart allowed in ${Math.ceil((backoff - (now - last)) / MIN)} min` };
  restarts.push(now);
  return { action: "restart", status: "restarting", reason };
}

// Health body from the operator's /health, judged. `staleTickers` and `outbox` come from the 8.4 /health.
function judgeOperatorHealth(res, { stuckOutboxMs = 15 * MIN } = {}) {
  if (!res || res.error) return { ok: false, detail: res?.error || "no response" };
  if (res.status !== 200) return { ok: false, detail: `health returned ${res.status}${res.body?.heartbeatAgeMs != null ? `, heartbeat ${Math.round(res.body.heartbeatAgeMs / 1000)} s old` : ""}` };
  const b = res.body || {};
  if (Array.isArray(b.staleTickers) && b.staleTickers.length) return { ok: false, detail: `stale periodic jobs: ${b.staleTickers.map((t) => t.name).slice(0, 5).join(", ")}` };
  if (b.outbox && b.outbox.oldestDeliverableMs > stuckOutboxMs) return { ok: false, detail: `outbox stuck: oldest deliverable message is ${Math.round(b.outbox.oldestDeliverableMs / MIN)} min old` };
  return { ok: true, detail: "ok" };
}

const OWNER_ALERT = (unit, reason) => `Keir guardian: ${unit} is down and I have stopped restarting it. ${reason}. Check it on the box; the guardian will remind you every 6 hours. To keep Keir quiet meanwhile: node /opt/keir/current/bin/keir-killswitch.js on "reason".`;
module.exports = { DEFAULTS, decideUnit, judgeOperatorHealth, OWNER_ALERT };
