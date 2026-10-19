"use strict";
// Keir 3.0 wiring: lanes from admission, support ownership and handoff,
// queued acknowledgments, and the EffectGate shadow beside the broker.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createGateway } = require("../lib/operator/gateway");
const { createBroker } = require("../lib/operator/broker");
const { emptyLanes, pickForLanes, laneTimeoutMs, LANES } = require("../lib/operator/lanes");
const { createSupportOwner } = require("../lib/operator/supportowner");
const { createEffectShadow } = require("../lib/operator/effectshadow");

const dirs = [];
test.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const OWNER = "111111111111111111", STAFF = "222222222222222222", BOT = "333333333333333333", PLAYER = "888888888888888888";
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-wire-")); dirs.push(dir);
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: OWNER, staffIds: [STAFF], botId: BOT, guildId: "444444444444444444", scanChannels: ["555555555555555555"],
    taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, stateDir: dir, repositories: {},
    watched: () => true };
  return { dir, ledger, config };
}
const job = (id, fields) => ({ id, state: "queued", at: 1, role: "support", kind: "ticket", ...fields });

test("role lanes preserve reserved replies and owner capacity", () => {
  assert.equal(LANES.length, 11);
  const jobs = [
    ...Array.from({ length: 5 }, (_, i) => job(`t${i}`, { ticket: i + 1, at: i })),
    job("ask", { kind: "conversation", role: "player", at: 50 }),
    job("own", { kind: "command", role: "owner", at: 60 }),
    job("own2", { kind: "command", role: "owner", at: 61 }),
  ];
  const active = emptyLanes();
  active.investigation = { job: { id: "busy", kind: "ticket", role: "support", ticket: 99 } };
  const picks = pickForLanes([...jobs, { id: "busy", kind: "ticket", role: "support", ticket: 99, state: "running" }], active, { now: 100 });
  const lane = (id) => picks.find((p) => p.job.id === id)?.lane;
  assert.equal(lane("ask"), "conversation");
  assert.equal(lane("own"), "owner");
  // Dedicated investigations prefer tickets waiting for a first reply.
  // Coding capacity is not borrowed from its independent pool.
  assert.equal(lane("own2"), undefined);
  assert.deepEqual(picks.filter((p) => p.job.kind === "ticket").map((p) => p.lane).sort(), ["investigation2", "investigation3"]);
  assert.ok(picks.length + 1 <= 11);
  assert.equal(laneTimeoutMs("conversation2", 900000), 90000);
  assert.equal(laneTimeoutMs("coding", 900000), 900000);
});

test("a ticket another operator owns is held; a handed-off ticket runs", () => {
  const f = fixture();
  const owner = createSupportOwner({ ledger: f.ledger });
  owner.setOwner("codex", "test");
  const jobs = [job("t1530", { ticket: 1530 }), job("t1532", { ticket: 1532 }), job("own", { kind: "command", role: "owner" })];
  let picks = pickForLanes(jobs, emptyLanes(), { now: 10, supportDeferred: (j) => owner.deferred(j) });
  assert.deepEqual(picks.map((p) => p.job.id).sort(), ["own"]);
  owner.receive({ id: "h1", from: "codex", scope: "ticket 1530 healthcare output", asks: ["watch turns 172-173"], tickets: [1530] },
    { ensureTicketJob: (n) => jobs.find((j) => j.ticket === n) });
  picks = pickForLanes(jobs, emptyLanes(), { now: 10, supportDeferred: (j) => owner.deferred(j) });
  assert.deepEqual(picks.map((p) => p.job.id).sort(), ["own", "t1530"]);
});

test("a handoff is receipted at once, carries its full body, and is incorporated on activation", () => {
  const f = fixture();
  const owner = createSupportOwner({ ledger: f.ledger });
  owner.setOwner("codex", "test");
  const t = f.ledger.createJob("ticket:1530", { kind: "ticket", role: "support", ticket: 1530, channelId: "c1530", source: {} });
  t.state = "waiting";
  const body = "Production turn 171 clean; healthcare output still low. ".repeat(40);
  const { receipt } = owner.receive({ id: "h2", from: "codex", scope: "ticket 1530", asks: ["confirm turns 172 and 173"], tickets: [1530], body },
    { ensureTicketJob: () => t });
  assert.equal(receipt.state, "acknowledged");
  assert.equal(t.state, "queued");
  assert.ok(t.inbox.at(-1).content.includes(body));
  assert.equal(Object.keys(f.ledger.data.actions).length, 0); // a handoff never creates approval
  owner.incorporateFor(t);
  assert.equal(owner.handoff("h2").state, "incorporated");
  assert.equal(owner.receive({ id: "h2", from: "codex", scope: "x", asks: ["y"] }, { ensureTicketJob: () => t }).duplicate, true);
});

test("releasing support returns the whole desk to Keir and survives a restart", () => {
  const f = fixture();
  const owner = createSupportOwner({ ledger: f.ledger });
  owner.setOwner("codex", "test");
  owner.receive({ id: "h3", from: "codex", scope: "all remaining tickets", asks: ["take the desk"], tickets: [], releasesSupport: true }, { ensureTicketJob: () => null });
  const reborn = createSupportOwner({ ledger: createLedger(path.join(f.dir, "ledger.json")) });
  assert.equal(reborn.owner(), "keir");
  assert.equal(reborn.deferred({ ticket: 77 }), false);
});

test("a ledger with no support owner keeps 2.x behavior (Keir owns support)", () => {
  const f = fixture();
  assert.equal(createSupportOwner({ ledger: f.ledger }).deferred({ ticket: 1 }), false);
});

test("a queued request is acknowledged at once with its place; a free slot leaves the ack to the model", () => {
  const f = fixture(), g = createGateway(f);
  const ch = { id: "555555555555555555", name: "general", type: 0 };
  const msg = (content, id) => ({ id, author: { id: OWNER, username: "o" }, content, timestamp: new Date(1000).toISOString(), mentions: [{ id: BOT }], attachments: [] });
  g.ingest(ch, msg("Keir investigate the cabinet page", "666666666666666661"));
  const first = Object.values(f.ledger.data.jobs)[0];
  assert.equal(f.ledger.data.outbox[`ack:${first.id}`], undefined); // owner slot free: model acks
  assert.equal(first.needsAck, true);
  first.state = "running"; // owner slot now busy
  const busy = f.ledger.createJob("other", { kind: "command", role: "owner", source: {} }); busy.state = "running";
  const chan2 = { id: "555555555555555556", name: "dev", type: 0 };
  g.ingest(chan2, msg("Keir check the bond page too", "666666666666666662"));
  const second = Object.values(f.ledger.data.jobs).find((j) => j.source?.messageId === "666666666666666662");
  const ack = f.ledger.data.outbox[`ack:${second.id}`];
  assert.ok(ack, "a queued request is acknowledged immediately");
  assert.match(ack.content, /queued/);
  assert.doesNotMatch(ack.content, /picking this up now/);
});

test("the EffectGate shadow agrees with the broker on owner-directed and ticket requests", async () => {
  const f = fixture();
  const shadow = createEffectShadow({ ledger: f.ledger, config: f.config });
  const broker = createBroker({ ledger: f.ledger, config: f.config, mcp: { servers: () => [] }, discord: async () => [], sandbox: {}, effectShadow: shadow, now: () => 5000 });
  const ownerJob = f.ledger.createJob("owner-cmd", { kind: "command", role: "owner", actorId: OWNER, source: { authorId: OWNER, messageId: "m1" }, deadline: 9e15 });
  ownerJob.state = "running";
  await broker.tool(ownerJob, "request_action", { kind: "mcp_write", args: { server: "support", tool: "support_tracker_note", args: { n: 1 } }, reason: "note" });
  const staffJob = f.ledger.createJob("staff-cmd", { kind: "command", role: "support", actorId: STAFF, source: { authorId: STAFF, messageId: "m2" }, deadline: 9e15 });
  staffJob.state = "running";
  await broker.tool(staffJob, "request_action", { kind: "host_command", args: { argv: ["/usr/bin/true"] }, reason: "probe" });
  const s = shadow.summary();
  assert.equal(s.compared, 2);
  assert.equal(s.agreed, 2, JSON.stringify(s.disagreements));
  // the broker's own decisions are unchanged
  const states = Object.values(f.ledger.data.actions).map((a) => a.state).sort();
  assert.deepEqual(states, ["approved", "pending"]);
});

test("the shadow records a disagreement instead of changing the broker's decision", () => {
  const f = fixture();
  const shadow = createEffectShadow({ ledger: f.ledger, config: f.config });
  const j = { id: "j", kind: "ticket", ticket: 5, actorId: PLAYER, source: { authorId: PLAYER } };
  const row = shadow.compare(j, "heal", { spec: { env: "prod", touchesMoney: true } }, { state: "approved", digest: "d" });
  assert.equal(row.agree, false);
  assert.equal(row.gate, "needs-approval");
  assert.ok(f.ledger.data.audit.some((a) => a.kind === "effectgate_disagreement"));
});

test("a handoff supersedes every approval Keir held on that ticket from before", () => {
  const f = fixture();
  const owner = createSupportOwner({ ledger: f.ledger });
  owner.setOwner("codex", "test");
  const t = f.ledger.createJob("ticket:1529", { kind: "ticket", role: "support", ticket: 1529, channelId: "c", source: {} });
  t.state = "waiting";
  const cmd = f.ledger.createJob("cmd-1529", { kind: "command", role: "owner", ticket: 1529, source: {} });
  f.ledger.data.actions.old = { id: "old", jobId: t.id, kind: "github", state: "approved", args: { action: "promote" } };
  f.ledger.data.actions.ask = { id: "ask", jobId: cmd.id, kind: "github", state: "pending" };
  f.ledger.data.actions.other = { id: "other", jobId: "elsewhere", kind: "github", state: "approved" };
  f.ledger.data.decisions = { x: { id: "x", jobId: cmd.id, state: "pending" } };
  owner.receive({ id: "h9", from: "codex", scope: "1529", asks: ["take it"], tickets: [1529] }, { ensureTicketJob: () => t });
  assert.equal(f.ledger.data.actions.old.state, "superseded");
  assert.equal(f.ledger.data.actions.ask.state, "superseded");
  assert.equal(f.ledger.data.actions.other.state, "approved"); // other work untouched
  assert.equal(f.ledger.data.decisions.x.state, "withdrawn");
});

test("a ticket with no reply yet starts before follow-ups on answered tickets", () => {
  const jobs = [
    job("old1", { ticket: 1514, at: 1, lastPublishedAt: 5 }),
    job("old2", { ticket: 1522, at: 2, lastPublishedAt: 6 }),
    job("old3", { ticket: 1529, at: 3, lastPublishedAt: 7 }),
    job("new1", { ticket: 1532, at: 900 }),
    job("new2", { ticket: 1533, at: 901 }),
  ];
  const picks = pickForLanes(jobs, emptyLanes(), { now: 2000 });
  const started = picks.map((p) => p.job.id);
  assert.ok(started.includes("new1") && started.includes("new2"), started.join(","));
});

test("ticket bursts stay within investigation capacity, leaving coding and chat reserved", () => {
  const jobs = Array.from({ length: 6 }, (_, i) => job(`t${i}`, { ticket: i + 1, at: i }));
  const picks = pickForLanes(jobs, emptyLanes(), { now: 10 });
  assert.deepEqual(picks.map((p) => p.lane).sort(), ["investigation", "investigation2", "investigation3"]);
  // with coding work waiting, the coding lane stays for coding
  const withCoding = pickForLanes([...jobs, job("k", { kind: "coding", at: 0 })], emptyLanes(), { now: 10 });
  assert.equal(withCoding.find((p) => p.lane === "coding").job.id, "k");
});

test("an inherited ticket can read where its fix is; a player task cannot", async () => {
  const f = fixture();
  const calls = [];
  const exec = async (cmd, args) => { calls.push(args.join(" ")); return JSON.stringify({ status: args.join(" ").includes("turn-worker%2Fproduction") ? "diverged" : "behind" }); };
  const broker = createBroker({ ledger: f.ledger, config: f.config, mcp: { servers: () => [] }, discord: async () => [], sandbox: {}, exec, now: () => 5000 });
  const t = f.ledger.createJob("ticket:1532", { kind: "ticket", role: "support", ticket: 1532, source: {}, deadline: 9e15 });
  t.state = "running";
  const out = await broker.tool(t, "github", { action: "where", sha: "813986ca3f" });
  assert.equal(out.staging, true); assert.equal(out["turn-worker/sandbox"], true); assert.equal(out["turn-worker/production"], false);
  assert.equal(t.releaseEvidence["813986ca3f"].sandboxWorker, true);
  const p = f.ledger.createJob("player-q", { kind: "conversation", role: "player", source: {}, deadline: 9e15 });
  p.state = "running";
  await assert.rejects(broker.tool(p, "github", { action: "where", sha: "813986ca3f" }));
});

test("a handoff hands over the sender's PRs for that ticket; foreign URLs are ignored", () => {
  const f = fixture();
  const owner = createSupportOwner({ ledger: f.ledger });
  const t = f.ledger.createJob("ticket:1532", { kind: "ticket", role: "support", ticket: 1532, source: {} });
  owner.receive({ id: "hp", from: "codex", scope: "1532", asks: ["ship it"], tickets: [1532],
    pullRequests: ["https://github.com/lakesidegamedev/AHDGame/pull/4041", "https://github.com/Egg3901/AHDGame/pull/4042", "https://github.com/lakesidegamedev/AHDClient/pull/136", "https://github.com/Egg3901/AHDClient/pull/137", "https://evil.example/pull/1"] }, { ensureTicketJob: () => t });
  assert.deepEqual(t.pullRequests, ["https://github.com/lakesidegamedev/AHDGame/pull/4041", "https://github.com/Egg3901/AHDGame/pull/4042", "https://github.com/lakesidegamedev/AHDClient/pull/136", "https://github.com/Egg3901/AHDClient/pull/137"]);
});

test("a desktop ticket can watch a game PR by naming the repository", async () => {
  const f = fixture();
  const broker = createBroker({ ledger: f.ledger, config: f.config, mcp: { servers: () => [] }, discord: async () => [], sandbox: {}, exec: async () => "null", now: () => 5000 });
  const t = f.ledger.createJob("ticket:1514", { kind: "ticket", role: "support", ticket: 1514, repository: "AHDClient", source: {}, deadline: 9e15 });
  t.state = "running";
  await broker.tool(t, "github", { action: "watch", number: 4046, repository: "AHDGame" });
  assert.equal(t.ciWatch[4046].repository, "lakesidegamedev/AHDGame");
  await broker.tool(t, "github", { action: "watch", number: 136 });
  assert.equal(t.ciWatch[136].repository, "lakesidegamedev/AHDClient");
  await assert.rejects(broker.tool(t, "github", { action: "watch", number: 1, repository: "Other" }), /AHDGame or AHDClient/);
});

test("one ticket can be held for another agent while Keir keeps the desk", () => {
  const f = fixture();
  const owner = createSupportOwner({ ledger: f.ledger });
  owner.setTicketOwner(1522, "other-agent", "owner");
  assert.equal(owner.deferred({ ticket: 1522 }), true);
  assert.equal(owner.deferred({ ticket: 1530 }), false);
  const jobs = [job("t1522", { ticket: 1522 }), job("t1530", { ticket: 1530 })];
  assert.deepEqual(pickForLanes(jobs, emptyLanes(), { now: 10, supportDeferred: (j) => owner.deferred(j) }).map((p) => p.job.id), ["t1530"]);
  // returning the whole desk to Keir keeps the explicit hold
  owner.setOwner("keir", "test");
  assert.equal(owner.deferred({ ticket: 1522 }), true);
  owner.setTicketOwner(1522, "keir", "owner");
  assert.equal(owner.deferred({ ticket: 1522 }), false);
  assert.throws(() => owner.setTicketOwner("x", "a"), /ticket number/);
});

test("the owner can put one ticket on a chosen model from its next activation", () => {
  const f = fixture();
  const owner = createSupportOwner({ ledger: f.ledger });
  const t = f.ledger.createJob("ticket:1537", { kind: "ticket", role: "support", ticket: 1537, source: {} });
  t.provider = { lane: "worker", runner: "codex", model: "gpt-6.1-sol", effort: "medium" }; t.effortPin = "medium";
  const r = owner.assignModel(1537, "muse:muse-wonder-full-1.0@medium", "owner");
  assert.equal(r.job, t.id);
  assert.deepEqual([t.provider.lane, t.provider.runner, t.provider.model, t.provider.effort], ["worker", "muse", "muse-wonder-full-1.0", "medium"]);
  assert.equal(t.effortPin, undefined);
  assert.throws(() => owner.assignModel(1537, "gpt-6.1-sol"), /runner:model/);
  assert.throws(() => owner.assignModel(1537, "rogue:x"), /runner one of/);
  assert.throws(() => owner.assignModel(9999, "muse:muse-wonder-full-1.0"), /no job/);
});

// Owner, 2026-10-14: one clean progress card per ticket instead of repeated
// "still testing" posts (ticket 1536).
test("the status card posts once, edits in place, needs receipts and survives deletion", async () => {
  const f = fixture();
  f.config.guildId = "444444444444444444";
  const calls = [];
  let nextId = 900000000000000001, deleted = false;
  const discord = async (method, route, body) => {
    calls.push({ method, route, body });
    if (method === "GET" && route.includes("/messages")) return [];
    if (method === "GET" && route.startsWith("/channels/")) return { id: "777777777777777777", guild_id: f.config.guildId, name: "ticket-bug-someone-1514" };
    if (method === "GET" && route.includes("/guilds/")) return [{ id: "777777777777777777", name: "ticket-bug-someone-1514" }];
    if (method === "GET") return [];
    if (method === "PATCH" && deleted) { deleted = false; throw new Error("Discord PATCH 404 Unknown Message"); }
    if (method === "POST") return { id: String(nextId++) };
    return {};
  };
  const mcp = { servers: () => [], call: async () => ({ ok: true }) };
  const broker = createBroker({ ledger: f.ledger, config: f.config, mcp, discord, sandbox: {}, now: () => Date.now() });
  const t = f.ledger.createJob("ticket:1514", { kind: "ticket", role: "support", ticket: 1514, channelId: "777777777777777777", source: {}, deadline: 9e15 });
  t.state = "running"; t.evidence = [];
  // release stages need receipts
  await assert.rejects(broker.tool(t, "status_card", { items: [{ name: "Corporation page", stage: "main" }] }), /needs github where/);
  t.releaseEvidence = { abc1234567: { development: true, staging: true, main: true } };
  const first = await broker.tool(t, "status_card", { items: [{ name: "Corporation page and party slates", stage: "main" }, { name: "House election results", stage: "found" }] });
  assert.equal(first.posted, true);
  const post = calls.find((c) => c.method === "POST");
  assert.match(post.body.embeds[0].title, /Ticket 1514/);
  assert.equal(post.body.embeds[0].fields.length, 2);
  const second = await broker.tool(t, "status_card", { items: [{ name: "Corporation page and party slates", stage: "main" }, { name: "House election results", stage: "written" }] });
  assert.equal(second.updated, true);
  assert.equal(calls.filter((c) => c.method === "POST").length, 1, "edited, not reposted");
  // technical words never reach the player-facing card
  await assert.rejects(broker.tool(t, "status_card", { items: [{ name: "PR 4046 merge", stage: "found" }] }), /technical/);
  // a deleted card is posted again
  deleted = true;
  await broker.tool(t, "status_card", { items: [{ name: "House election results", stage: "written" }] });
  assert.equal(calls.filter((c) => c.method === "POST").length, 2);
  // a CI wait refreshes the card instead of posting text
  t.state = "waiting"; f.ledger.data.statusCards[1514].at = Date.now() - 11 * 60000;
  const posts = calls.filter((c) => c.method === "POST").length;
  assert.equal(await broker.waitingUpdate(t, { number: 4060, repository: "lakesidegamedev/AHDGame", base: "main", running: 1 }), true);
  assert.equal(calls.filter((c) => c.method === "POST").length, posts);
  assert.match(calls.at(-1).body.embeds[0].description, /Release checks for the main server are running/);
});

// Review 2026-10-19: a card edit sends no notification, so players heard a
// fix was live 6 to 28 hours late. The first live stage sends one reply.
test("a fix reaching the main server sends the player one live reply", async () => {
  const f = fixture();
  f.config.guildId = "444444444444444444";
  const discord = async (method, route) => {
    if (method === "GET" && route.includes("/messages")) return [];
    if (method === "GET" && route.startsWith("/channels/")) return { id: "777777777777777777", guild_id: f.config.guildId, name: "ticket-bug-someone-1629" };
    if (method === "GET" && route.includes("/guilds/")) return [{ id: "777777777777777777", name: "ticket-bug-someone-1629" }];
    if (method === "GET") return [];
    if (method === "POST") return { id: "900000000000000001" };
    return {};
  };
  const updates = [];
  const mcp = { servers: () => [], call: async (server, tool, args) => { if (tool === "support_public_update") updates.push(args); return { ok: true, delivery: { posted: true } }; } };
  const broker = createBroker({ ledger: f.ledger, config: f.config, mcp, discord, sandbox: {}, now: () => Date.now() });
  const t = f.ledger.createJob("ticket:1629", { kind: "ticket", role: "support", ticket: 1629, channelId: "777777777777777777", source: {}, deadline: 9e15 });
  t.state = "running"; t.evidence = [];
  t.releaseEvidence = { abc1234567: { development: true, staging: true, main: true } };
  await broker.tool(t, "status_card", { items: [{ name: "Wages for staff a plant does not have", stage: "sandbox" }] });
  assert.equal(updates.filter((u) => u.deliver && u.update_kind === "production").length, 0, "no reply before live");
  await broker.tool(t, "status_card", { items: [{ name: "Wages for staff a plant does not have", stage: "main" }] });
  const live = updates.filter((u) => u.deliver && u.update_kind === "production");
  assert.equal(live.length, 1);
  assert.equal(live[0].delivery_mode, "reply"); assert.equal(live[0].update_kind, "production");
  assert.match(live[0].message, /now live on the main server: Wages for staff a plant does not have\./);
  // confirmed later, or the card re-sent, never repeats the reply
  // "confirmed" needs a turn after the fix and a game read after that turn
  await assert.rejects(broker.tool(t, "status_card", { items: [{ name: "Wages for staff a plant does not have", stage: "confirmed" }] }), /watch_turn/);
  t.turnChecks = [Date.now() - 1000]; t.lastGameReadAt = Date.now();
  await broker.tool(t, "status_card", { items: [{ name: "Wages for staff a plant does not have", stage: "confirmed" }] });
  await broker.tool(t, "status_card", { items: [{ name: "Wages for staff a plant does not have", stage: "main" }] });
  assert.equal(updates.filter((u) => u.deliver && u.update_kind === "production").length, 1);
});

// Owner, 2026-10-14 (ticket 1539): a card buried under later messages is
// bumped on a real update, and edited in place while it is still the latest.
test("the status card is bumped below newer messages only when it has a real update", async () => {
  const f = fixture();
  f.config.guildId = "444444444444444444";
  const calls = [];
  let nextId = 1000, latest = null;
  const discord = async (method, route, body) => {
    calls.push({ method, route, body });
    if (method === "GET" && route.includes("/messages")) return /limit=1$/.test(route) && latest ? [{ id: latest }] : [];
    if (method === "GET" && route.startsWith("/channels/")) return { id: "777777777777777777", guild_id: f.config.guildId, name: "ticket-bug-someone-1539" };
    if (method === "GET" && route.includes("/guilds/")) return [{ id: "777777777777777777", name: "ticket-bug-someone-1539" }];
    if (method === "GET") return [];
    if (method === "POST") return { id: String(nextId++) };
    return {};
  };
  const mcp = { servers: () => [], call: async () => ({ ok: true }) };
  const broker = createBroker({ ledger: f.ledger, config: f.config, mcp, discord, sandbox: {}, now: () => Date.now() });
  const t = f.ledger.createJob("ticket:1539", { kind: "ticket", role: "support", ticket: 1539, channelId: "777777777777777777", source: {}, deadline: 9e15 });
  t.state = "running"; t.evidence = [];
  // "Cause found" before any investigation is refused (ticket 1553).
  await assert.rejects(broker.tool(t, "status_card", { items: [{ name: "Metrics not moving", stage: "found" }] }), /needs the cause investigated/);
  t.investigatedReads = 3;
  const first = await broker.tool(t, "status_card", { items: [{ name: "Metrics not moving", stage: "found" }] });
  const cardId = f.ledger.data.statusCards[1539].messageId;
  assert.equal(first.posted, true);
  // still the latest message: a real update edits in place
  latest = cardId;
  await broker.tool(t, "status_card", { items: [{ name: "Metrics not moving", stage: "written" }] });
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 0);
  // buried under a newer message, but nothing changed: no bump, no repost
  latest = "999999999999999999";
  const same = await broker.tool(t, "status_card", { items: [{ name: "Metrics not moving", stage: "written" }] });
  assert.equal(same.bumped, false);
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 0);
  // buried and genuinely updated: old card removed, card reposted as the newest message
  const bumped = await broker.tool(t, "status_card", { items: [{ name: "Metrics not moving", stage: "written", note: "Being tested now" }] });
  assert.equal(bumped.bumped, true);
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 1);
  assert.equal(calls.find((c) => c.method === "DELETE").route, `/channels/777777777777777777/messages/${cardId}`);
  assert.equal(calls.filter((c) => c.method === "POST").length, 2);
  assert.notEqual(f.ledger.data.statusCards[1539].messageId, cardId);
});

test("the admin status card respects ticket holds and staff claims", async () => {
  const f = fixture();
  f.config.guildId = "444444444444444444";
  const owner = createSupportOwner({ ledger: f.ledger });
  f.config.supportDeferred = (j) => owner.deferred(j);
  const broker = createBroker({ ledger: f.ledger, config: f.config, mcp: { servers: () => [], call: async () => ({}) }, discord: async () => ({}), sandbox: {}, now: () => Date.now() });
  f.ledger.createJob("ticket:1522", { kind: "ticket", role: "support", ticket: 1522, channelId: "c1522", source: {} });
  owner.setTicketOwner(1522, "other-agent", "owner");
  await assert.rejects(broker.adminStatusCard(1522, { items: [{ name: "Fix", stage: "found" }] }), /another coordinator/);
});

// 2026-10-14: a Muse 429 "Subscription quota exhausted" blocked ticket 1514.
test("a provider quota limit parks the task until the stated reset, then it resumes", () => {
  const { retryReadFailure } = require("../lib/operator/recovery");
  const now = Date.parse("2026-10-14T01:05:19Z");
  const j = { effects: {}, state: "running" };
  const msg = "model request failed: muse exited 1 ... agent loop failed: model failed: API error 429 [request_id=x]: Subscription quota exhausted. Your usage window resets at 2026-10-14T01:11:54Z. (rate_limit_error)";
  assert.equal(retryReadFailure(j, new Error(msg), now), true);
  assert.equal(j.state, "waiting");
  assert.equal(j.wakeAt, Date.parse("2026-10-14T01:12:54Z"));
  // no reset given: fifteen minutes; never longer than two hours
  const k = { effects: {}, state: "running" };
  retryReadFailure(k, new Error("rate_limit_error: quota exhausted"), now);
  assert.equal(k.wakeAt, now + 15 * 60000);
  const far = { effects: {}, state: "running" };
  retryReadFailure(far, new Error("Subscription quota exhausted. resets at 2026-10-15T01:00:00Z"), now);
  assert.equal(far.wakeAt, now + 2 * 3600000);
  // an uncertain external write is never parked silently
  const w = { effects: { x: { state: "started" } }, state: "running" };
  assert.equal(retryReadFailure(w, new Error(msg), now), false);
});

// Ticket 1537, 2026-10-14: a pending promotion request left on a finished
// task stood in as "already asked" and blocked every staging promotion.
test("a request still pending on a finished task is withdrawn at startup", () => {
  const f = fixture();
  const done = f.ledger.createJob("old", { kind: "command", role: "owner", source: {} }); done.state = "done";
  const live = f.ledger.createJob("live", { kind: "ticket", role: "support", source: {} }); live.state = "waiting";
  f.ledger.data.actions.dead = { id: "dead", jobId: done.id, kind: "github", state: "pending", args: { action: "promote", to: "staging" } };
  f.ledger.data.actions.ok = { id: "ok", jobId: live.id, kind: "github", state: "pending", args: { action: "promote", to: "staging" } };
  f.ledger.recover();
  assert.equal(f.ledger.data.actions.dead.state, "withdrawn");
  assert.equal(f.ledger.data.actions.ok.state, "pending");
});

test("an investigator gets a real investigation lane while coding is occupied", () => {
  const coder = { id: "busy-coder", kind: "coding", state: "running" };
  const parent = { id: "waiting-parent", kind: "ticket", ticket: 77, state: "queued", at: 1, lastPublishedAt: 1 };
  const child = { id: "read-child", kind: "coding", investigation: true, codingParent: parent.id, state: "queued", at: 2 };
  const active = emptyLanes(); active.coding = { job: coder };
  const picks = pickForLanes([coder, parent, child], active, { now: 100 });
  assert.equal(picks.length, 1);
  assert.equal(picks[0].job.id, child.id);
  assert.match(picks[0].lane, /^investigation/);
});

test("an early investigation card does not claim a cause or a fix is already being written", () => {
  const card = require("../lib/operator/statuscard");
  const body = card.render({ ticket: 1558, items: [{ name: "Illinois technology profit drop", stage: "found", note: "Checking input costs and prices" }] });
  const text = JSON.stringify(body.embeds);
  assert.doesNotMatch(text, /Cause found|Fix being written/i);
  assert.match(text, /Investigating/);
  assert.match(text, /Checking cause and next step/);
});

test("a not-a-bug item can be marked answered: it needs the investigation, renders done and does not hold a waiting finish", async () => {
  const card = require("../lib/operator/statuscard");
  assert.equal(card.stageAllowed("answered", {}).ok, false);
  assert.equal(card.stageAllowed("answered", { investigated: { done: true } }).ok, true);
  const body = card.render({ ticket: 1558, items: [{ name: "Steelworks made nothing", stage: "answered", note: "The coal deal ended; sign a new one" }] });
  const text = JSON.stringify(body.embeds);
  assert.match(text, /Answered · no fix needed/);
  assert.doesNotMatch(text, /Investigating|▱/);
  assert.equal(body.embeds[0].color, 0x22c55e);
  assert.equal(card.rowState({ stage: "answered" }), "done");
});

test("new handoff evidence invalidates an old closing grace without replaying that reset", () => {
  const f = fixture();
  const owner = createSupportOwner({ ledger: f.ledger, now: () => 5000 });
  const t = f.ledger.createJob("ticket:1558", { kind: "ticket", role: "support", ticket: 1558, channelId: "c1558", source: {} });
  t.state = "waiting"; t.lastPublishedAt = 1000; t.resolutionReadyAt = 1000;
  t.waitingFor = { kind: "player_reply", since: 1000, deadline: 999999 };
  const handoff = { id: "new-pnl-evidence", from: "shadow", scope: "1558 actual P&L contradicts answer", asks: ["Continue unresolved causal investigation"], tickets: [1558] };
  owner.receive(handoff, { ensureTicketJob: () => t });
  assert.equal(t.resolutionReadyAt, undefined);
  assert.equal(t.waitingFor, undefined);
  assert.equal(t.lastPublishedAt, 1000, "retain actual delivery receipt");
  assert.equal(t.state, "queued");
  assert.ok(f.ledger.data.audit.some(a => a.kind === "ticket_reopened_by_handoff" && a.job === t.id && a.previousAnswerAt === 1000));
  t.resolutionReadyAt = 7000;
  assert.equal(owner.receive(handoff, { ensureTicketJob: () => t }).duplicate, true);
  assert.equal(t.resolutionReadyAt, 7000, "retrying an old handoff cannot reset a later answer");
});

test("an admin handoff can retain a closure hold without stopping investigation", () => {
  const f = fixture(), owner = createSupportOwner({ ledger: f.ledger });
  const j = job("held", { ticket: 1615 });
  owner.receive({ id: "hold-1615", from: "codex", scope: "Unmet player goal", asks: ["Investigate without closing"], tickets: [1615], holdClosure: true }, { ensureTicketJob: () => j });
  assert.equal(j.ownerClosureHold.handoffId, "hold-1615");
  assert.equal(j.state, "queued");
  owner.receive({ id: "release-1615", from: "codex", scope: "Release closure hold", asks: ["Reassess after a verified answer"], tickets: [1615], holdClosure: false }, { ensureTicketJob: () => j });
  assert.equal(j.ownerClosureHold, undefined);
});

test("withdrawing old questions in an explicit handoff clears their stale admission hold", () => {
 const f = fixture(), owner = createSupportOwner({ ledger: f.ledger });
 const j = job("decision-held", { ticket: 1615, ownerDecisionPending: true, state: "blocked" });
 f.ledger.data.jobs[j.id] = j;
 (f.ledger.data.decisions ||= {}).d = { id: "d", jobId: j.id, state: "pending" };
 owner.receive({ id: "clarify-existing", from: "codex", scope: "Respect existing decision", asks: ["Continue within prior ruling"], tickets: [1615] }, { ensureTicketJob: () => j });
 assert.equal(f.ledger.data.decisions.d.state, "withdrawn"); assert.ok(!j.ownerDecisionPending); assert.equal(j.state, "queued");
});
