"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSurge } = require("../lib/operator/surge");

const T0 = Date.parse("2026-10-14T06:00:00Z");
function fixture({ verdicts = {}, severe = 0.9, members = {}, reactions = {} } = {}) {
  let clock = T0;
  const audit = [];
  const data = { jobs: {}, seen: {}, channels: {}, audit };
  const ledger = { data, save() {}, audit: (kind, x) => audit.push({ kind, ...x }) };
  const job = (id, ticket, text, at = T0 - 600000) => {
    const j = { id, kind: "ticket", ticket, state: "running", at: new Date(at).toISOString(), channelId: `c${ticket}`, source: { content: text } };
    data.jobs[id] = j; data.seen[`ticket:${ticket}`] = id; return j;
  };
  const calls = [];
  const mcp = { call: async (server, tool, args) => {
    calls.push([tool, args]);
    if (tool === "support_get") return { number: args.number, title: `Turns are not processing (#${args.number})`, status: "open", category: "bug" };
    if (tool === "support_create_ticket") return { ticketNumber: 1600 };
    if (tool === "support_merge") return { ok: true, steps: ["linked"] };
    return {};
  } };
  const posts = [];
  const discord = async (method, route, body) => {
    posts.push([method, route, body]);
    if (method === "POST" && /\/messages$/.test(route)) return { id: "m1" };
    const r = /reactions\/([^?/]+)\?/.exec(route);
    if (method === "GET" && r) return reactions[decodeURIComponent(r[1])] || [];
    const m = /members\/(\d+)$/.exec(route);
    if (method === "GET" && m) return members[m[1]] || { roles: [] };
    return {};
  };
  const ask = async ({ questions }) => ({ answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: k === "severe" ? severe : k === "same" ? 0.9 : verdicts[k] ?? 0.1 }])) });
  const config = { incidentChannel: "modbot", incidentPingRoles: ["mod", "dev"], incidentApproverRoles: ["mod", "dev"], botId: "bot", ownerId: "owner", guildId: "g" };
  const surge = createSurge({ ledger, mcp, discord, config, now: () => clock, ask });
  return { surge, data, audit, calls, posts, job, tick: (ms) => { clock += ms; } };
}

test("a related ticket that is not severe merges into the older ticket", async () => {
  const f = fixture({ verdicts: { t1601: 0.95 } });
  f.job("a", 1601, "My market orders vanish");
  const b = f.job("b", 1602, "Market orders disappeared after I placed them", T0);
  const r = await f.surge.checkTicket(b);
  assert.deepEqual(r, { merged: true, target: 1601 });
  assert.equal(b.state, "done");
  const merge = f.calls.find((c) => c[0] === "support_merge");
  assert.deepEqual([merge[1].source_number, merge[1].target_number, merge[1].require_incident], [1602, 1601, false]);
});

test("unrelated tickets are left alone", async () => {
  const f = fixture();
  f.job("a", 1601, "My market orders vanish");
  const b = f.job("b", 1602, "Election results look wrong", T0);
  assert.equal(await f.surge.checkTicket(b), null);
  assert.ok(!f.calls.some((c) => c[0] === "support_merge"));
});

test("three severe related tickets become a staff proposal that pings mods and devs, and opens on a moderator's tick", async () => {
  const f = fixture({ verdicts: { t1601: 0.95, t1602: 0.92 }, members: { 111: { roles: ["mod"] } } });
  f.job("a", 1601, "Turns stopped"); f.job("b", 1602, "No turn for two hours");
  const c = f.job("c", 1603, "The game is not processing turns", T0);
  const r = await f.surge.checkTicket(c);
  assert.ok(r.proposal);
  const post = f.posts.find((p) => p[0] === "POST");
  assert.equal(post[1], "/channels/modbot/messages");
  assert.match(post[2].content, /^<@&mod> <@&dev> Keir proposes an incident: \*\*Turns are not processing \(#1601\)\*\*/);
  assert.deepEqual(post[2].allowed_mentions, { roles: ["mod", "dev"] });
  // A player's tick does not count; a moderator's does.
  f.posts.length = 0;
  const g = fixture({ verdicts: {}, members: { 111: { roles: ["mod"] } }, reactions: { "✅": [{ id: "111" }] } });
  g.data.incidentProposals = { [r.proposal]: { ...f.data.incidentProposals[r.proposal] } };
  for (const j of Object.values(f.data.jobs)) { g.data.jobs[j.id] = j; g.data.seen[`ticket:${j.ticket}`] = j.id; }
  await g.surge.tick();
  const p = g.data.incidentProposals[r.proposal];
  assert.equal(p.state, "opened"); assert.equal(p.incident, 1600); assert.equal(p.openedBy, "111");
  assert.equal(g.calls.find((x) => x[0] === "support_create_ticket")[1].category, "incident");
  assert.equal(g.calls.filter((x) => x[0] === "support_merge" && x[1].require_incident).length, 3);
});

test("a severe proposal nobody answers opens itself after ten minutes; a decline merges into the oldest instead", async () => {
  const f = fixture({ verdicts: { t1601: 0.95, t1602: 0.92 } });
  f.job("a", 1601, "Turns stopped"); f.job("b", 1602, "No turn for two hours");
  const r = await f.surge.checkTicket(f.job("c", 1603, "Turns broken", T0));
  await f.surge.tick();
  assert.equal(f.data.incidentProposals[r.proposal].state, "proposed");
  f.tick(10 * 60000);
  await f.surge.tick();
  assert.equal(f.data.incidentProposals[r.proposal].openedBy, "keir");

  const g = fixture({ verdicts: { t1601: 0.95, t1602: 0.92 }, members: { 222: { roles: ["dev"] } }, reactions: { "❌": [{ id: "222" }] } });
  g.job("a", 1601, "Turns stopped"); g.job("b", 1602, "No turn for two hours");
  const r2 = await g.surge.checkTicket(g.job("c", 1603, "Turns broken", T0));
  await g.surge.tick();
  assert.equal(g.data.incidentProposals[r2.proposal].state, "declined");
  assert.deepEqual(g.calls.filter((x) => x[0] === "support_merge").map((x) => [x[1].source_number, x[1].target_number]), [[1602, 1601], [1603, 1601]]);
});

test("a fourth related ticket joins a pending proposal instead of starting another", async () => {
  const f = fixture({ verdicts: { t1601: 0.95, t1602: 0.92, t1603: 0.9 } });
  f.job("a", 1601, "Turns stopped"); f.job("b", 1602, "No turn");
  const r = await f.surge.checkTicket(f.job("c", 1603, "Turns broken", T0));
  const r2 = await f.surge.checkTicket(f.job("d", 1604, "Still no turns", T0));
  assert.equal(r2.proposal, r.proposal);
  assert.deepEqual(f.data.incidentProposals[r.proposal].tickets, [1601, 1602, 1603, 1604]);
});

test("a chatter spike from four players becomes a proposal that never opens itself", async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) f.data.jobs[`k${i}`] = { id: `k${i}`, kind: "candidate", state: "queued", at: new Date(T0 - 60000).toISOString(), source: { authorId: `p${i}`, content: "login is broken for me" } };
  const p = await f.surge.chatterTick();
  assert.equal(p.source, "chatter"); assert.equal(p.severe, false);
  f.tick(60 * 60000); await f.surge.tick();
  assert.equal(f.data.incidentProposals[p.id].state, "proposed");
  assert.equal(await f.surge.chatterTick(), null, "the same reports do not propose twice");
});

test("watch proposals stay proposals without a staff answer and do not collide", async () => {
  const f = fixture();
  const a = await f.surge.propose({ title: "Failed turn", severe: true, source: "watch", fingerprint: "turn:1" });
  const b = await f.surge.propose({ title: "Nonfinite money", severe: true, source: "watch", fingerprint: "money:1" });
  assert.notEqual(a.id, b.id);
  assert.equal((await f.surge.propose({ title: "Failed turn", severe: true, source: "watch", fingerprint: "turn:1" })).id, a.id);
  f.tick(11 * 60000); await f.surge.tick();
  assert.equal(a.state, "proposed");
  assert.equal(f.calls.filter(([name]) => name === "support_create_ticket").length, 0);
});

// Keir 11.3 release review M1: Keir opens a failed turn's incident in code; a staff proposal for the same turn must not
// become a second incident, and must still open one when Keir has none.
function turnProposal(incidentForTurn) {
  const f = fixture({ members: { 111: { roles: ["mod"] } }, reactions: { "✅": [{ id: "111" }] } });
  const created = () => f.calls.filter((c) => c[0] === "support_create_ticket").length;
  return { f, created, surge: createSurge({ ledger: { data: f.data, save() {}, audit: (k, x) => f.audit.push({ kind: k, ...x }) }, mcp: { call: async (s, tool, args) => { f.calls.push([tool, args]); return tool === "support_create_ticket" ? { ticketNumber: 1881 } : {}; } },
    discord: async (m, route) => { f.posts.push([m, route]); if (m === "POST") return { id: "m1" }; if (/reactions\/%E2%9C%85/.test(route)) return [{ id: "111" }]; if (/members\/111/.test(route)) return { roles: ["mod"] }; return []; },
    config: { incidentChannel: "modbot", incidentPingRoles: ["mod"], incidentApproverRoles: ["mod"], turnIncidents: { incidentForTurn } }, now: () => T0, ask: async () => null }) };
}

test("a staff-approved watch proposal for a turn that already has Keir's incident is withdrawn, not opened twice", async () => {
  const t = turnProposal((turn) => (turn === 108 ? 1880 : null));
  await t.surge.propose({ title: "Turn 108 failed", summary: "x", severe: true, source: "watch", fingerprint: "turn:108:failed" });
  await t.surge.tick();
  assert.equal(t.created(), 0);
  const p = Object.values(t.f.data.incidentProposals)[0];
  assert.equal(p.state, "covered"); assert.equal(p.incident, 1880);
  assert.ok(t.f.posts.some(([m, route]) => m === "PATCH" && /messages\/m1$/.test(route)), "the proposal message is edited to name Keir's incident");
  await t.surge.open(p, "111");
  assert.equal(t.created(), 0, "opening it directly does not create one either");
});

test("a staff-approved watch proposal still opens the incident when Keir has none for that turn", async () => {
  const t = turnProposal(() => null);
  await t.surge.propose({ title: "Turn 108 failed", summary: "x", severe: true, source: "watch", fingerprint: "turn:108:failed" });
  await t.surge.tick();
  assert.equal(t.created(), 1);
  assert.equal(Object.values(t.f.data.incidentProposals)[0].state, "opened");
});

test("the watch tick runs the turn incident check before the watch can propose an incident to staff", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "operator.js"), "utf8");
  const body = src.slice(src.indexOf("async function watchTick()"), src.indexOf("tickers.every(\"watch\""));
  const check = body.indexOf("turnIncidents.check("), tick = body.indexOf("watch.tick(");
  assert.ok(check > 0 && tick > 0 && check < tick);
});
