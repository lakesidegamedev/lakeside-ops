#!/usr/bin/env node
"use strict";
// The slim Keir service. Needs KEIR_SLIM_MODE=live; refuses to start otherwise.
// Every poll (KEIR_SLIM_POLL_MS, 20 s):
//   - new messages on open tickets become session events (lib/slim/intake.js)
//   - the owner's answers to approval cards are recorded and woken
//   - due reminders (minutes, or after the next game turn) wake their ticket
//   - messages held by a pause or the kill switch are delivered once clear
// At most KEIR_SLIM_MAX_WAKES sessions run at once. A heartbeat is written to
// <state>/heartbeat.json every poll.
// Stop everything: node bin/keir-slim.js stop "reason" (or systemctl stop keir-slim).

const fs = require("node:fs");
const path = require("node:path");
const { slimConfig } = require("../lib/slim/config");
const { createRuntime, approvalCard } = require("../lib/slim/runtime");
const { createSlimMcp } = require("../lib/slim/mcp");
const { readAgentToken } = require("../lib/operator/token");
const { createKillSwitch } = require("../lib/operator/killswitch");
const intake = require("../lib/slim/intake");
const { createOwnerDm, parseAnswer } = require("../lib/slim/owner-dm");
const S = require("../lib/slim/state");

const cfg = slimConfig();
if (cfg.mode !== "live") { console.error(`keir-slim-serve: KEIR_SLIM_MODE is ${cfg.mode}; it only runs live. Nothing started.`); process.exit(2); }
const log = (...a) => console.log(new Date().toISOString(), ...a);

const killSwitch = createKillSwitch({ file: cfg.killSwitchFile });
const mcp = createSlimMcp({ configFile: cfg.mcpConfig, readToken: readAgentToken(cfg.agentEnvFile), gate: (what) => killSwitch.assertClear(what) });
const ownerDm = createOwnerDm({ token: process.env.DISCORD_BOT_TOKEN, channel: cfg.ownerDmChannel, ownerIds: cfg.ownerIds, stateFile: path.join(cfg.stateDir, "owner-dm.json") });
const rt = createRuntime({
  mode: "live", mcp, log: (m) => log(m),
  notifyOwner: async (req) => ownerDm.sendCard({ ...req, text: approvalCard(req) }),
  onWake: (r) => {
    const line = { at: new Date().toISOString(), ticket: r.ticket, minutes: r.minutes, finished: r.finished, error: r.error, timedOut: r.timedOut, posts: r.effects.filter((e) => e.kind === "post").length, effects: r.effects.map((e) => e.kind), ruleHits: r.ruleHits.map((h) => h.rule), calls: r.calls.length };
    fs.appendFileSync(path.join(cfg.stateDir, "wakes.jsonl"), JSON.stringify(line) + "\n", { mode: 0o600 });
    log(`ticket ${r.ticket} wake: ${JSON.stringify(line)}`);
  },
});

// A small limiter: at most N wakes at once across tickets.
let running = 0; const waiting = [];
const limited = (fn) => new Promise((resolve, reject) => {
  const go = () => { running++; fn().then(resolve, reject).finally(() => { running--; waiting.shift()?.(); }); };
  running < cfg.maxConcurrentWakes ? go() : waiting.push(go);
});
const deliver = (n, events, opts) => limited(() => rt.host.deliver(n, events, opts)).catch((e) => log(`ticket ${n} deliver failed: ${e.message}`));

const intakeState = intake.createIntakeState(path.join(cfg.stateDir, "intake.json"));
let first = !Object.keys(intakeState.data.tickets).length;
let lastTurn = null;
let polling = false;

async function tick() {
  if (polling) return;
  polling = true;
  const beat = { at: new Date().toISOString(), mode: cfg.mode, killSwitch: killSwitch.state().engaged, running, waiting: waiting.length, errors: [] };
  try {
    // 1 intake
    try {
      const items = await intake.poll({ mcp, cfg, state: intakeState, first });
      first = false;
      for (const it of items) {
        if (it.names?.length) rt.host.setPlayerNames(it.ticket, it.names);
        if (it.takeover && it.lastHumanAt) { const s = rt.store.load(it.ticket); s.lastHumanAt = it.lastHumanAt; rt.store.save(s); }
        log(`ticket ${it.ticket}: ${it.events.length} event(s)${it.takeover ? " (takeover)" : ""}`);
        deliver(it.ticket, it.events, { intro: it.intro });
      }
      beat.openTickets = Object.entries(intakeState.data.tickets).filter(([, t]) => t.open).map(([n]) => Number(n));
    } catch (e) { beat.errors.push(`intake: ${e.message}`); }
    // 2 owner answers
    try {
      for (const a of await ownerDm.answers()) {
        const st = rt.store.load(a.ticket);
        const approval = st.approvals.find((x) => x.id === a.approvalId);
        if (!approval || approval.status !== "pending") continue;
        const ans = parseAnswer(a.content, approval);
        log(`ticket ${a.ticket}: owner answered ${a.approvalId}: ${ans.status}`);
        limited(() => rt.host.answer(a.ticket, a.approvalId, ans)).catch((e) => log(`answer failed: ${e.message}`));
        await ownerDm.acknowledge(a.messageId);
      }
    } catch (e) { beat.errors.push(`owner answers: ${e.message}`); }
    // 3 reminders and held messages
    try {
      let turn = null;
      try { turn = (await mcp.call("engine", "engine_health", {}, false)).turn ?? null; } catch { /* turn unknown this poll */ }
      const turned = turn != null && lastTurn != null && turn !== lastTurn;
      if (turn != null) lastTurn = turn;
      for (const n of rt.store.list()) {
        const s = rt.store.load(n);
        if (s.closed || s.paused) continue;
        const r = s.reminder;
        const due = r && ((r.minutes && Date.now() >= Date.parse(r.setAt) + r.minutes * 60000) || (!r.minutes && turned));
        const pendingFile = path.join(cfg.stateDir, "pending", `ticket-${n}.json`);
        const held = fs.existsSync(pendingFile) && JSON.parse(fs.readFileSync(pendingFile, "utf8") || "[]").length > 0;
        if (due) deliver(n, [{ role: "reminder", at: new Date().toISOString(), text: `${r.reason}${turned ? ` (turn ${turn} has run)` : ""}` }]);
        else if (held && !killSwitch.state().engaged) deliver(n, []);
      }
    } catch (e) { beat.errors.push(`reminders: ${e.message}`); }
  } finally {
    beat.running = running; beat.waiting = waiting.length;
    fs.writeFileSync(path.join(cfg.stateDir, "heartbeat.json"), JSON.stringify(beat), { mode: 0o600 });
    if (beat.errors.length) log(`poll errors: ${beat.errors.join("; ")}`);
    polling = false;
  }
}

(async () => {
  fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  const dm = await ownerDm.check().catch((e) => ({ ok: false, reason: e.message }));
  log(`keir-slim live: model ${cfg.model}@${cfg.effort}, poll ${cfg.pollMs} ms, max ${cfg.maxConcurrentWakes} wakes, owner DM ${dm.ok ? "reachable" : `NOT reachable (${dm.reason})`}, kill switch ${killSwitch.state().engaged ? "ENGAGED" : "clear"}`);
  if (!dm.ok) { console.error("Approval cards cannot reach the owner; refusing to start."); process.exit(3); }
  await tick();
  setInterval(tick, cfg.pollMs);
})();

for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { log(`${sig}: stopping; running wakes are cut off`); process.exit(0); });
