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
const { createRuntime } = require("../lib/slim/runtime");
const { renderCard } = require("../lib/slim/ownercopy");
const { createSlimMcp } = require("../lib/slim/mcp");
const { readAgentToken } = require("../lib/operator/token");
const { createKillSwitch } = require("../lib/operator/killswitch");
const intake = require("../lib/slim/intake");
const { createOwnerDm, parseAnswer } = require("../lib/slim/owner-dm");
const S = require("../lib/slim/state");
const { createFastWatch, createLimiter, createResponseClock } = require("../lib/slim/fastwatch");
const { createPresence } = require("../lib/operator/presence");

const cfg = slimConfig();
if (cfg.mode !== "live") { console.error(`keir-slim-serve: KEIR_SLIM_MODE is ${cfg.mode}; it only runs live. Nothing started.`); process.exit(2); }
const log = (...a) => console.log(new Date().toISOString(), ...a);

const killSwitch = createKillSwitch({ file: cfg.killSwitchFile });
const mcp = createSlimMcp({ configFile: cfg.mcpConfig, readToken: readAgentToken(cfg.agentEnvFile), gate: (what) => killSwitch.assertClear(what) });
const ownerDm = createOwnerDm({ token: process.env.DISCORD_BOT_TOKEN, channel: cfg.ownerDmChannel, ownerIds: cfg.ownerIds, stateFile: path.join(cfg.stateDir, "owner-dm.json") });
// Discord, as Keir's bot: typing indicator and the fast "did a person write" reads.
async function discord(method, route, body) {
  const r = await fetch(`https://discord.com/api/v10${route}`, { method, headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`discord ${method} ${route.split("?")[0]} ${r.status}`);
  return r.status === 204 ? null : r.json();
}
const presence = createPresence({ discord, allowed: () => !killSwitch.state().engaged });
const typing = new Map(); // ticket -> { end, timer }
function startTyping(ticket, channelId) {
  if (!channelId || typing.has(ticket)) return false;
  const end = presence.begin(channelId);
  // A wake normally ends it; never type for more than 4 minutes without one.
  const timer = setTimeout(() => stopTyping(ticket), 4 * 60000);
  typing.set(ticket, { end, timer });
  return true;
}
function stopTyping(ticket) {
  const t = typing.get(ticket);
  if (!t) return;
  clearTimeout(t.timer); t.end(); typing.delete(ticket);
}
const clock = createResponseClock({ append: (line) => fs.appendFileSync(path.join(cfg.stateDir, "response-times.jsonl"), JSON.stringify(line) + "\n", { mode: 0o600 }) });

const rt = createRuntime({
  mode: "live", mcp, log: (m) => log(m),
  notifyOwner: async (req) => ownerDm.sendCard({ ...req, card: renderCard(req) }),
  onEffect: (ticket, e) => { if (e.kind === "post" || e.kind === "resolve") { stopTyping(ticket); clock.posted(ticket, e.at); } },
  onWake: (r) => {
    stopTyping(r.ticket);
    if (clock.pending(r.ticket).length && !r.effects.some((e) => e.kind === "post" || e.kind === "resolve")) clock.wakeEnded(r.ticket);
    const line = { at: new Date().toISOString(), ticket: r.ticket, minutes: r.minutes, finished: r.finished, error: r.error, timedOut: r.timedOut, posts: r.effects.filter((e) => e.kind === "post").length, effects: r.effects.map((e) => e.kind), ruleHits: r.ruleHits.map((h) => h.rule), calls: r.calls.length };
    fs.appendFileSync(path.join(cfg.stateDir, "wakes.jsonl"), JSON.stringify(line) + "\n", { mode: 0o600 });
    log(`ticket ${r.ticket} wake: ${JSON.stringify(line)}`);
  },
});

// At most N wakes at once; owner and staff messages jump the queue.
const limiter = createLimiter(cfg.maxConcurrentWakes);
const limited = (fn, opts) => limiter.run(fn, opts);
const urgentOf = (events) => (events || []).some((e) => e.role === "owner" || e.role === "staff" || e.role === "approval");
// One slot per ticket: new messages join its queued wake, or one follow-up wake if it is running.
const queue = require("../lib/slim/fastwatch").createTicketQueue({ limiter, urgentOf, run: (n, events, opts) => rt.host.deliver(n, events, opts), log: (m) => log(m) });
const deliver = (n, events, opts) => queue.deliver(n, events, opts);

const intakeState = intake.createIntakeState(path.join(cfg.stateDir, "intake.json"));
let first = !Object.keys(intakeState.data.tickets).length;
let lastTurn = null;
let polling = false;

async function tick() {
  if (polling) return;
  polling = true;
  const beat = { at: new Date().toISOString(), mode: cfg.mode, killSwitch: killSwitch.state().engaged, ...limiter.stats(), typing: [...typing.keys()], errors: [] };
  try {
    // 1 intake
    try {
      const items = await intake.poll({ mcp, cfg, state: intakeState, first });
      first = false;
      for (const it of items) {
        if (it.names?.length) rt.host.setPlayerNames(it.ticket, it.names);
        if (it.category) { const s0 = rt.store.load(it.ticket); if (s0.category !== it.category) { s0.category = it.category; rt.store.save(s0); } }
        if (it.takeover && it.lastHumanAt) { const s = rt.store.load(it.ticket); s.lastHumanAt = it.lastHumanAt; rt.store.save(s); }
        // A brand-new ticket: typing at once and the clock from when it opened.
        if (it.isNew && it.channelId && !rt.store.load(it.ticket).paused) {
          startTyping(it.ticket, it.channelId);
          if (it.openedAt) clock.message(it.ticket, { messageId: `opened-${it.ticket}`, at: it.openedAt, typingAt: new Date().toISOString() });
        }
        log(`ticket ${it.ticket}: ${it.events.length} event(s)${it.takeover ? " (takeover)" : it.isNew ? ` (new, typing ${it.openedAt ? Date.now() - Date.parse(it.openedAt) : "?"} ms after it opened)` : ""}`);
        deliver(it.ticket, it.events, { intro: it.intro });
      }
      beat.openTickets = Object.entries(intakeState.data.tickets).filter(([, t]) => t.open).map(([n]) => Number(n));
      // Fast pickup watches every open ticket channel Keir may answer in, plus the owner's DM.
      for (const [n, t] of Object.entries(intakeState.data.tickets)) {
        if (t.open && t.channelId && !rt.store.load(n).paused) fast.watch(t.channelId, { ticket: Number(n) });
        else if (t.channelId) fast.unwatch(t.channelId);
      }
      if (cfg.ownerDmChannel) fast.watch(cfg.ownerDmChannel, { dm: true });
    } catch (e) { beat.errors.push(`intake: ${e.message}`); }
    // 2 owner answers
    try {
      const approvalOf = (t, id) => rt.store.load(t).approvals.find((x) => x.id === id) || null;
      for (const a of await ownerDm.answers(approvalOf)) {
        const approval = approvalOf(a.ticket, a.approvalId);
        if (!approval || approval.status !== "pending") continue;
        const ans = a.answer || parseAnswer(a.content, approval);
        log(`ticket ${a.ticket}: owner ${a.clicked ? "clicked" : "answered"} ${a.approvalId}: ${ans.status}`);
        startTyping(a.ticket, intakeState.data.tickets[a.ticket]?.channelId);
        limited(() => rt.host.answer(a.ticket, a.approvalId, ans), { urgent: true }).catch((e) => log(`answer failed: ${e.message}`));
        if (!a.clicked) await ownerDm.acknowledge(a.messageId);
      }
      // Cards answered another way (the CLI, the ticket channel) stop being polled.
      for (const n of rt.store.list()) for (const x of rt.store.load(n).approvals) if (x.status !== "pending") ownerDm.closeCard(x.id);
    } catch (e) { beat.errors.push(`owner answers: ${e.message}`); }
    // 3 fixes going live: wake the ticket the moment its watched fix is on the game
    try {
      await require("../lib/slim/deploy").checkLiveWatches({ store: rt.store, repo: cfg.gameRepo, releasesFile: cfg.deployReleasesFile, deliver, log: (m) => log(m) });
    } catch (e) { beat.errors.push(`live watch: ${e.message}`); }
    // 4 reminders and held messages
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
    Object.assign(beat, limiter.stats());
    fs.writeFileSync(path.join(cfg.stateDir, "heartbeat.json"), JSON.stringify(beat), { mode: 0o600 });
    if (beat.errors.length) log(`poll errors: ${beat.errors.join("; ")}`);
    polling = false;
  }
}

// Fast pickup: a person's new message starts typing now and runs intake now, not at the next slow poll.
let soon = [];
function tickSoon() {
  for (const t of soon) clearTimeout(t);
  // The message reaches the ticket history a few seconds after Discord; look again until it is there.
  soon = [2500, 5000, 9000, 15000, 25000].map((ms) => setTimeout(() => tick().catch(() => {}), ms));
}
const fast = createFastWatch({
  discord, botId: null, log: (m) => log(m),
  onHuman: async (h) => {
    if (h.dm) { if (cfg.ownerIds.includes(String(h.authorId))) tickSoon(); return; }
    const st = rt.store.load(h.ticket);
    if (st.paused || st.closed || killSwitch.state().engaged) return;
    const started = startTyping(h.ticket, h.channelId);
    clock.message(h.ticket, { messageId: h.messageId, at: h.at, typingAt: new Date().toISOString() });
    log(`ticket ${h.ticket}: new message ${h.messageId}${started ? ", typing" : ""} (${Date.now() - Date.parse(h.at)} ms after it was sent)`);
    tickSoon();
  },
});

// Public channels: one decision at a time, never taking a ticket's slot.
let publicWatch = null;
async function startPublic() {
  if (!cfg.publicMentions) { log("public mentions: off"); return; }
  const pub = require("../lib/slim/public");
  const guildId = cfg.guildId || (await discord("GET", "/users/@me/guilds"))?.[0]?.id;
  const me = await discord("GET", "/users/@me");
  if (!guildId || !me?.id) { log("public mentions: no guild or bot id; off"); return; }
  const audit = pub.createPublicLog(path.join(cfg.stateDir, "public-mentions.jsonl"));
  const post = (m, text) => { killSwitch.assertClear("A public reply"); return discord("POST", `/channels/${m.channelId}/messages`, { content: text.slice(0, 1900), message_reference: { message_id: m.messageId, fail_if_not_exists: false }, allowed_mentions: { parse: [], replied_user: true } }); };
  const judge = require("../lib/slim/public-judge").createPublicJudge({ cfg, sessions: rt.sessions, toolServer: rt.toolServer, adapters: rt.adaptersFor(0), post, discord, log: (x) => log(x) });
  const responder = pub.createPublicResponder({ stateFile: path.join(cfg.stateDir, "public-state.json"), log: audit, judge, post, mayAct: () => cfg.mode === "live" && !killSwitch.state().engaged });
  const one = createLimiter(1);
  publicWatch = pub.createPublicWatcher({ discord, guildId, botId: me.id, log: (x) => log(x), onMention: async (m) => { log(`public mention in #${m.channelName} (${m.messageId})`); one.run(() => responder.handle(m)).catch((e) => log(`public mention: ${e.message}`)); } });
  setInterval(() => publicWatch.tick().catch(() => {}), cfg.publicPollMs);
  log(`public mentions: on (guild ${guildId}, every ${cfg.publicPollMs} ms)`);
}

(async () => {
  fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  const dm = await ownerDm.check().catch((e) => ({ ok: false, reason: e.message }));
  log(`keir-slim live: model ${cfg.model}@${cfg.effort}, poll ${cfg.pollMs} ms, max ${cfg.maxConcurrentWakes} wakes, owner DM ${dm.ok ? "reachable" : `NOT reachable (${dm.reason})`}, kill switch ${killSwitch.state().engaged ? "ENGAGED" : "clear"}`);
  if (!dm.ok) { console.error("Approval cards cannot reach the owner; refusing to start."); process.exit(3); }
  await tick();
  setInterval(tick, cfg.pollMs);
  startPublic().catch((e) => log(`public mentions failed to start: ${e.message}`));
  setInterval(() => fast.tick().catch((e) => log(`fast watch: ${e.message}`)), cfg.fastPollMs);
  // New tickets: a cheap list read every 8 seconds; one appearing runs intake at once.
  setInterval(() => intake.newTickets({ mcp, state: intakeState }).then(async (ns) => {
    if (!ns.length) return;
    log(`new ticket(s) ${ns.map((t) => t.number).join(", ")}`);
    // Typing and the clock start now, from one quick read; the full intake follows.
    for (const t of ns) {
      if (typing.has(t.number) || rt.store.load(t.number).paused) continue;
      try {
        const channelId = (await mcp.call("support", "support_get", { kind: "ticket", number: t.number }, false))?.conversation?.channelId;
        if (channelId && startTyping(t.number, channelId) && t.createdAt) {
          clock.message(t.number, { messageId: `opened-${t.number}`, at: t.createdAt, typingAt: new Date().toISOString() });
          log(`ticket ${t.number}: new, typing ${Date.now() - Date.parse(t.createdAt)} ms after it opened`);
        }
      } catch (e) { log(`ticket ${t.number}: early typing failed: ${e.message}`); }
    }
    tickSoon();
  }).catch(() => {}), 2 * cfg.fastPollMs);
})();

for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { log(`${sig}: stopping; running wakes are cut off`); process.exit(0); });
