"use strict";
// Keir 11.1 evidence presentation: capture, constrained projection, one chart
// per ticket answer, report and tracker pages, and their end conditions.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createLedger } = require("../lib/operator/store");
const ev = require("../lib/operator/evidencepages");
const series = require("../lib/operator/evidence-series");
const takeover = require("../lib/operator/supporttakeover");

const TICKET_CH = "777777777777777777", PUBLIC_CH = "555555555555555555", Q = "666666666666666666";
const T0 = Date.parse("2026-11-20T10:00:00Z");
const dirs = [];
test.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-evidence-")); dirs.push(dir);
  const file = path.join(dir, "ledger.json");
  const ledger = createLedger(file);
  const config = { stateDir: dir, evidencePagesDir: path.join(dir, "pages"), evidencePublicBase: "https://lakesidegames.net", guildId: "444444444444444444", ownerId: "111111111111111111", staffIds: [] };
  // What production support_get returns for a ticket (apps/web/mcp/support-server.js ticketShape): no Discord or user ids.
  const tickets = {};
  const readTicket = async (n) => { f.ticketReads = (f.ticketReads || 0) + 1; return tickets[n] === undefined ? supportTicket(n) : tickets[n]; };
  const f = { dir, file, ledger, config, tickets, readTicket };
  return f;
}
const OPENED = "2026-11-20T09:00:00.000Z";
const supportTicket = (n, over = {}) => ({ kind: "ticket", number: n, title: "Fixture", category: "bug", status: "open", createdAt: OPENED,
  reporter: { username: "fixture-user", characterName: "Fixture Person", profileUrl: "https://ahousedividedgame.com/character/7" },
  conversation: { channelId: TICKET_CH }, ...over });
function ticketJob(f, n = 123, fields = {}) {
  const j = f.ledger.createJob(`ticket:${n}`, { kind: "ticket", role: "support", ticket: n, channelId: TICKET_CH, deadline: T0 + 86400000,
    source: { channelId: TICKET_CH, channelName: `ticket-bug-fixture-${n}`, messageId: Q, authorId: "888888888888888888", at: new Date(T0).toISOString() }, ...fields });
  j.state = "running"; j.startedAt = T0;
  f.ledger.data.channels[TICKET_CH] = { name: `ticket-bug-fixture-${n}` };
  return j;
}
function publicJob(f, fields = {}) {
  const j = f.ledger.createJob(`ping:${Math.random()}`, { kind: "conversation", role: "support", channelId: PUBLIC_CH, replyChannel: PUBLIC_CH, deadline: T0 + 86400000,
    source: { channelId: PUBLIC_CH, channelName: "general", messageId: Q, at: new Date(T0).toISOString() }, ...fields });
  j.state = "running"; j.startedAt = T0;
  return j;
}
const { WORLD, market, operating, snapshotMarket } = require("./fixtures/evidence-game");
const read = (f, job, tool, env, at = T0 + 1000, args = { commodity: "steel" }) => ev.observe(f.ledger, job, "read_tool", { server: "gamestate", tool, args }, env, at);
const pageDir = (f, id) => path.join(f.config.evidencePagesDir, id);

test("only the three gamestate reads are captured, identifiers and contact details are stripped, and capture never throws", () => {
  const f = fixture(), j = ticketJob(f);
  assert.equal(ev.observe(f.ledger, j, "read_tool", { server: "support", tool: "market_history", args: {} }, market(), T0), null);
  assert.equal(ev.observe(f.ledger, j, "read_tool", { server: "gamestate", tool: "trace_corp", args: {} }, market(), T0), null);
  assert.equal(ev.observe(f.ledger, j, "read_tool", { server: "gamestate", tool: "market_history", args: {} }, { error: "boom" }, T0), null);
  assert.equal(ev.observe(f.ledger, j, "read_tool", { server: "gamestate", tool: "market_history", args: {} }, { text: "not json" }, T0), null);
  assert.equal(ev.observe(f.ledger, null, "read_tool", { server: "gamestate", tool: "market_history", args: {} }, market(), T0), null);
  const id = read(f, j, "reporter_operating_results", { text: JSON.stringify(operating()) }, T0, { reporter: { ticket: 123 } });
  assert.match(id, /^ev_[a-f0-9]{12}$/);
  const o = f.ledger.data.evidencePages.observations[id];
  assert.equal(o.visibility, "reporter"); assert.equal(o.ticket, 123);
  assert.ok(o.envelope.rows.every((r) => !("corporationId" in r) && !("ownerEmail" in r)));
  // The same read twice is one observation.
  assert.equal(read(f, j, "reporter_operating_results", operating(), T0 + 5, { reporter: { ticket: 123 } }), id);
});

test("simple chat stays simple: no captured read means no chart, page or update", async () => {
  const f = fixture(), j = ticketJob(f);
  assert.deepEqual(ev.available(f.ledger, j), []);
  await assert.rejects(ev.present({ readTicket: f.readTicket, ledger: f.ledger, config: f.config, job: j, input: {}, now: T0 + 2000 }), /No game read to present/);
  assert.equal(Object.keys(f.ledger.data.outbox).length, 0);
});

test("the model cannot supply links, HTML or arbitrary ids", async () => {
  const f = fixture(), j = ticketJob(f); read(f, j, "market_history", market());
  await assert.rejects(ev.present({ readTicket: f.readTicket, ledger: f.ledger, config: f.config, job: j, input: { observation: "../../etc/passwd" }, now: T0 + 2000 }), /observation must be/);
  await assert.rejects(ev.present({ readTicket: f.readTicket, ledger: f.ledger, config: f.config, job: j, input: { caption: "see https://evil.example" }, now: T0 + 2000 }), /no links/);
  await assert.rejects(ev.present({ readTicket: f.readTicket, ledger: f.ledger, config: f.config, job: j, input: { caption: "<img src=x>" }, now: T0 + 2000 }), /no links, HTML/);
  await assert.rejects(ev.present({ readTicket: f.readTicket, ledger: f.ledger, config: f.config, job: j, input: { track: "yes" }, now: T0 + 2000 }), /track must be/);
  assert.throws(() => ev.linkFor({ evidencePublicBase: "javascript:alert(1)" }, "a".repeat(32)), /plain https origin/);
});

test("a ticket answer gets one staged chart; repeats, replays and restarts never stage or post it twice", async () => {
  const f = fixture(), j = ticketJob(f); read(f, j, "market_history", market());
  const r = await ev.present({ readTicket: f.readTicket, ledger: f.ledger, config: f.config, job: j, input: { observation: "latest", caption: "Steel offered, demanded and sold, by turn." }, now: T0 + 2000 });
  assert.equal(r.chart, "staged"); assert.equal(r.report, "linked"); assert.equal(r.visibility, "ticket", "a page opened from a ticket is private even for market data");
  assert.equal(Object.keys(f.ledger.data.outbox).length, 0, "present never posts on its own");
  const p = f.ledger.data.evidencePages.presentations[r.presentation];
  assert.ok(/\/artifacts\/chart-[a-f0-9]{12}-[a-f0-9]{12}\.png$/.test(p.staged.file), "matches the outbox chart allowlist");
  assert.ok(fs.statSync(p.staged.file).size > 10000);
  assert.equal(p.staged.answerTo, Q); assert.equal(p.staged.channel, TICKET_CH);
  assert.equal(p.staged.line, `Full table: https://lakesidegames.net/support/evidence/${r.presentation} (sign in at lakesidegames.net with the account linked to your Discord)`);
  // Written before the link exists: meta, one snapshot, the chart.
  for (const n of ["meta.json", "snap-0001.json", "chart.png"]) assert.ok(fs.existsSync(path.join(pageDir(f, r.presentation), n)), n);
  const meta = JSON.parse(fs.readFileSync(path.join(pageDir(f, r.presentation), "meta.json"), "utf8"));
  assert.equal(meta.ticket, 123); assert.equal(meta.kind, "report"); assert.equal(meta.visibility, "ticket");
  assert.deepEqual(meta.audience, { v: 1, kind: "ticket_reporter", ticket: 123, ticketCreatedAt: OPENED, character: "7", source: "support_get" });
  // Same evidence again in this activation, and after a restart: nothing new.
  const again = await ev.present({ readTicket: f.readTicket, ledger: f.ledger, config: f.config, job: j, input: {}, now: T0 + 3000 });
  assert.equal(again.chart, "already_shown"); assert.equal(again.presentation, r.presentation);
  const restarted = createLedger(f.file);
  const third = await ev.present({ readTicket: f.readTicket, ledger: restarted, config: f.config, job: restarted.data.jobs[j.id], input: {}, now: T0 + 4000 });
  assert.equal(third.chart, "already_shown");
  assert.equal(Object.keys(restarted.data.evidencePages.presentations).length, 1);
  // A wider window of the same question, or a pinned end turn, is the same evidence.
  read(f, j, "market_history", market(0, 20), T0 + 5000, { commodity: "steel", turns: 20, toTurn: 136 });
  assert.equal((await ev.present({ readTicket: f.readTicket, ledger: f.ledger, config: f.config, job: j, input: {}, now: T0 + 6000 })).chart, "already_shown");
});

test("the answer claims its staged chart once; send-time checks and release leave the answer as plain text", async () => {
  const f = fixture(), j = ticketJob(f); read(f, j, "market_history", market());
  const r = await ev.present({ readTicket: f.readTicket, ledger: f.ledger, config: f.config, job: j, input: {}, now: T0 + 2000 });
  // Another channel, another activation or no key gets nothing.
  assert.equal(ev.claim(f.ledger, j, { channel: PUBLIC_CH, key: "answer-1", at: T0 + 3000 }), null);
  assert.equal(ev.claim(f.ledger, { ...j, startedAt: T0 + 1 }, { channel: TICKET_CH, key: "answer-1", at: T0 + 3000 }), null);
  assert.equal(ev.claim(f.ledger, j, { channel: TICKET_CH, at: T0 + 3000 }), null);
  const c = ev.claim(f.ledger, j, { channel: TICKET_CH, key: "answer-1", at: T0 + 3000 });
  assert.equal(c.presentation, r.presentation); assert.equal(c.channel, TICKET_CH); assert.equal(c.answerTo, Q);
  assert.equal(c.files.length, 1); assert.equal(c.files[0].chart, true); assert.equal(c.files[0].name, "ahd-evidence-chart.png");
  // The same answer retried (or after a restart) gets the same claim; a second answer gets nothing.
  assert.equal(ev.claim(createLedger(f.file), createLedger(f.file).data.jobs[j.id], { channel: TICKET_CH, key: "answer-1", at: T0 + 3500 }).presentation, r.presentation);
  assert.equal(ev.claim(f.ledger, j, { channel: TICKET_CH, key: "answer-2", at: T0 + 3500 }), null);
  assert.deepEqual(ev.verify(f.ledger, r.presentation, { job: j, key: "answer-2", at: T0 + 3600 }), { ok: false, reason: "not claimed by this answer" });
  assert.deepEqual(ev.verify(f.ledger, r.presentation, { job: j, key: "answer-1", at: T0 + 3600 }), { ok: true });
  // A finished task still sends the chart with the answer it just gave.
  j.state = "done";
  assert.deepEqual(ev.verify(f.ledger, r.presentation, { job: j, key: "answer-1", at: T0 + 3600 }), { ok: true });
  // A takeover between claim and send blocks it.
  f.ledger.data.supportOwner = { tickets: { 123: "staff-member" } };
  assert.deepEqual(ev.verify(f.ledger, r.presentation, { job: j, key: "answer-1", at: T0 + 3600 }), { ok: false, reason: "takeover" });
  assert.equal(ev.release(f.ledger, r.presentation, "takeover"), true);
  assert.equal(ev.release(f.ledger, r.presentation, "again"), false);
  delete f.ledger.data.supportOwner;
  assert.equal(ev.claim(f.ledger, j, { channel: TICKET_CH, key: "answer-1", at: T0 + 4000 }), null, "a released chart is never sent later");
  // Delivery receipts are recorded once.
  const g = fixture(), k = ticketJob(g); read(g, k, "market_history", market());
  const r2 = await ev.present({ readTicket: g.readTicket, ledger: g.ledger, config: g.config, job: k, input: {}, now: T0 + 2000 });
  ev.claim(g.ledger, k, { channel: TICKET_CH, key: "a", at: T0 + 2500 });
  assert.equal(ev.delivered(g.ledger, r2.presentation, { messageId: "900000000000000001", attachmentId: "900000000000000002", at: T0 + 2600 }), true);
  assert.equal(ev.delivered(g.ledger, r2.presentation, { messageId: "x" }), false);
  assert.deepEqual(ev.verify(g.ledger, r2.presentation, { job: k, key: "a", at: T0 + 2700 }), { ok: false, reason: "already delivered" });
  assert.equal(g.ledger.data.evidencePages.presentations[r2.presentation].staged.messageId, "900000000000000001");
  // A chart nobody answered with goes stale and is never sent.
  const h = fixture(), m = ticketJob(h); read(h, m, "market_history", market());
  await ev.present({ readTicket: h.readTicket, ledger: h.ledger, config: h.config, job: m, input: {}, now: T0 + 2000 });
  assert.equal(ev.claim(h.ledger, m, { channel: TICKET_CH, key: "late", at: T0 + 2000 + ev.ANSWER_WAIT_MS + 1 }), null);
});

test("reporter evidence stays in its own ticket: no public channel, no other ticket, no other task for a player", async () => {
  const f = fixture(), pub = publicJob(f);
  read(f, pub, "reporter_operating_results", operating(), T0 + 1000, { reporter: { ticket: 5 } });
  await assert.rejects(ev.present({ readTicket: f.readTicket, ledger: f.ledger, config: f.config, job: pub, input: {}, now: T0 + 2000 }), /private/);
  const a = ticketJob(f, 123);
  const obs = read(f, a, "reporter_operating_results", operating(), T0 + 1000, { reporter: { ticket: 123 } });
  const other = f.ledger.createJob("ticket:124", { kind: "ticket", role: "support", ticket: 124, channelId: "999999999999999999", source: { channelId: "999999999999999999", channelName: "ticket-bug-x-124" } });
  other.state = "running";
  await assert.rejects(ev.present({ readTicket: f.readTicket, ledger: f.ledger, config: f.config, job: other, input: { observation: obs }, now: T0 + 2000 }), /another ticket/);
  const player = f.ledger.createJob("player:1", { kind: "conversation", role: "player", ticket: 123, channelId: TICKET_CH, replyChannel: TICKET_CH, source: { channelId: TICKET_CH, channelName: "ticket-bug-fixture-123", messageId: Q } });
  player.state = "running";
  await assert.rejects(ev.present({ readTicket: f.readTicket, ledger: f.ledger, config: f.config, job: player, input: { observation: obs }, now: T0 + 2000 }), /not read in this conversation/);
  // In its own ticket it is shown, and its page needs sign-in.
  const r = await ev.present({ readTicket: f.readTicket, ledger: f.ledger, config: f.config, job: a, input: { observation: obs }, now: T0 + 2000 });
  assert.equal(r.visibility, "ticket");
  const meta = JSON.parse(fs.readFileSync(path.join(pageDir(f, r.presentation), "meta.json"), "utf8"));
  assert.equal(meta.ticket, 123); assert.equal(meta.visibility, "ticket");
  assert.match(f.ledger.data.evidencePages.presentations[r.presentation].staged.line, /sign in at lakesidegames\.net/);
  assert.equal(ev.claim(f.ledger, a, { channel: PUBLIC_CH, key: "x", at: T0 + 2500 }), null, "never claimable for another channel");
  const snap = JSON.parse(fs.readFileSync(path.join(pageDir(f, r.presentation), "snap-0001.json"), "utf8"));
  assert.ok(!JSON.stringify(snap).includes("c0ffee") && !JSON.stringify(snap).includes("example.invalid"), "no private ids on the page");
});

test("takeover drops a queued chart and ends the tracker; nothing is written after", async () => {
  const f = fixture(), j = ticketJob(f); read(f, j, "market_history", market());
  const r = await ev.present({ readTicket: f.readTicket, ledger: f.ledger, config: f.config, job: j, input: { track: true }, now: T0 + 2000 });
  assert.match(r.tracker, /^live_until 2026-11-21T10:00:02/);
  f.ledger.data.supportOwner = { owner: "keir", tickets: {} };
  takeover.record(f.ledger, 123, "staff-member", "222222222222222222", {}, T0 + 3000);
  f.ledger.data.supportOwner = { ...(f.ledger.data.supportOwner || {}), tickets: { 123: "staff-member" } };
  assert.equal(ev.claim(f.ledger, j, { channel: TICKET_CH, key: "answer", at: T0 + 4000 }), null);
  assert.equal(f.ledger.data.evidencePages.presentations[r.presentation].staged.released, "takeover");
  read(f, j, "market_history", market(1), T0 + 5000);
  const p = f.ledger.data.evidencePages.presentations[r.presentation];
  assert.equal(p.endReason, "takeover"); assert.equal(p.snapshots, 1);
  const dir = pageDir(f, r.presentation);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "archived.json"), "utf8")).reason, "takeover");
  assert.ok(!fs.existsSync(path.join(dir, "snap-0002.json")));
  assert.equal(ev.createStore(f.config.evidencePagesDir).snapshot(r.presentation, 2, { rowsHash: "x" }), "archived");
  assert.equal(ev.createStore(f.config.evidencePagesDir).archive(r.presentation, { reason: "again" }), false, "archive is write-once");
});

test("a tracker records only changed reads on its page, never posts, and ends at 24 hours across a restart", async () => {
  const f = fixture(), j = ticketJob(f); read(f, j, "market_history", market());
  const r = await ev.present({ readTicket: f.readTicket, ledger: f.ledger, config: f.config, job: j, input: { track: true }, now: T0 + 2000 });
  const posts = Object.keys(f.ledger.data.outbox).length;
  read(f, j, "market_history", market(), T0 + 3000);
  assert.equal(f.ledger.data.evidencePages.presentations[r.presentation].snapshots, 1, "unchanged read adds nothing");
  read(f, j, "market_history", market(1), T0 + 3600000, { commodity: "steel", turns: 14 });
  assert.equal(f.ledger.data.evidencePages.presentations[r.presentation].snapshots, 2);
  assert.ok(fs.existsSync(path.join(pageDir(f, r.presentation), "snap-0002.json")));
  assert.equal(Object.keys(f.ledger.data.outbox).length, posts, "no unsolicited update");
  // A different question on the same ticket does not touch it.
  read(f, j, "market_history", market(2, 14, "coal"), T0 + 3700000, { commodity: "coal" });
  assert.equal(f.ledger.data.evidencePages.presentations[r.presentation].snapshots, 2);
  // Restart, then the clock passes 24 h with no further reads.
  f.ledger.save();
  const restarted = createLedger(f.file);
  assert.equal(ev.sweep(restarted, T0 + 2000 + ev.TRACK_MS - 1), 0);
  assert.equal(ev.sweep(restarted, T0 + 2000 + ev.TRACK_MS), 1);
  const p = restarted.data.evidencePages.presentations[r.presentation];
  assert.equal(p.endReason, "expired");
  const again = createLedger(f.file);
  assert.equal(again.data.evidencePages.presentations[r.presentation].endReason, "expired", "archive state is durable");
  ev.observe(again, again.data.jobs[j.id], "read_tool", { server: "gamestate", tool: "market_history", args: { commodity: "steel" } }, market(3), T0 + ev.TRACK_MS + 5000);
  assert.ok(!fs.existsSync(path.join(pageDir(f, r.presentation), "snap-0003.json")), "archived pages are immutable");
  const meta = JSON.parse(fs.readFileSync(path.join(pageDir(f, r.presentation), "meta.json"), "utf8"));
  assert.equal(meta.kind, "tracker"); assert.equal(meta.expiresAt, new Date(T0 + 2000 + ev.TRACK_MS).toISOString());
});

test("stop, ticket close, owner pause and Keir stop end live trackers", async () => {
  for (const [end, reason] of [
    [(f) => ev.stop(f.ledger, { ticket: 123 }, T0 + 5000), "stopped_by_request"],
    [(f, j) => { j.state = "done"; ev.sweep(f.ledger, T0 + 5000); }, "ticket_closed"],
    [(f) => { f.ledger.data.ticketPauses = { 123: { ticket: 123 } }; ev.sweep(f.ledger, T0 + 5000); }, "paused"],
    [(f) => { f.ledger.data.control = { stopped: true }; ev.sweep(f.ledger, T0 + 5000); }, "keir_stopped"],
  ]) {
    const f = fixture(), j = ticketJob(f); read(f, j, "market_history", market());
    const r = await ev.present({ readTicket: f.readTicket, ledger: f.ledger, config: f.config, job: j, input: { track: true }, now: T0 + 2000 });
    end(f, j);
    assert.equal(f.ledger.data.evidencePages.presentations[r.presentation].endReason, reason);
    assert.equal(JSON.parse(fs.readFileSync(path.join(pageDir(f, r.presentation), "archived.json"), "utf8")).reason, reason);
  }
  // Trackers need a live ticket, and never start under a takeover.
  const f = fixture(), j = ticketJob(f); read(f, j, "market_history", market());
  f.ledger.data.supportOwner = { tickets: { 123: "staff-member" } };
  await assert.rejects(ev.present({ readTicket: f.readTicket, ledger: f.ledger, config: f.config, job: j, input: { track: true }, now: T0 + 2000 }), /owned by staff-member/);
  const g = fixture(), c = publicJob(g); read(g, c, "market_history", market());
  await assert.rejects(ev.present({ readTicket: g.readTicket, ledger: g.ledger, config: g.config, job: c, input: { track: true }, now: T0 + 2000 }), /Trackers belong to a ticket/);
});

test("projection never fills gaps, never mixes units, and refuses a single turn as a trend", () => {
  const adapt = (tool, raw, at) => { const r = series.adapt(tool, raw, { at }); assert.equal(r.ok, true, r.reason); return r.envelope; };
  const gdp = (rows) => ({ schemaVersion: 1, tool: "market_history", metric: "gdp_level", unit: "local-currency millions", scope: { country: "US", region: null, level: "national", currency: "USD" }, world: WORLD(),
    asOfTurn: rows.at(-1).turn, rows, summary: null, sources: [], gaps: [] });
  const p = ev.project(adapt("market_history", gdp([{ turn: 1, year: 2027, value: 10 }, { turn: 2, year: 2027, value: null }, { turn: 3, year: 2027, value: 12 }])));
  assert.deepEqual([...new Set(p.chart.data.map((r) => r.series))], ["GDP level"], "the year column is never a series");
  assert.equal(p.chart.data.find((r) => r.turn === 2).value, null, "a null stays a gap, never 0");
  assert.equal(p.table.columnMeta.value.unit, "USD millions");
  const one = ev.project(adapt("market_history", gdp([{ turn: 1, year: 2027, value: 5 }])));
  assert.equal(one.chart, null); assert.equal(one.why, "fewer than two turns");
  const op = ev.project(adapt("reporter_operating_results", operating()));
  assert.deepEqual([...new Set(op.chart.data.map((r) => r.series))].sort(), ["Operating profit", "Revenue"]);
  assert.ok(op.table.columns.every((c) => !/Id$/.test(c)), "no identifiers in the table");
});

test("commodity_market is one dated public table: presentable, never chartable on a tracker, never tracked", async () => {
  const f = fixture(), j = ticketJob(f);
  const id = ev.observe(f.ledger, j, "read_tool", { server: "gamestate", tool: "commodity_market", args: { country: "US" } }, { content: [{ type: "text", text: JSON.stringify(snapshotMarket()) }] }, T0 + 1000);
  assert.match(id, /^ev_/);
  const o = f.ledger.data.evidencePages.observations[id];
  assert.equal(o.visibility, "public"); assert.equal(o.envelope.world, null, "no world id is invented"); assert.equal(o.envelope.trackable, false);
  assert.equal(ev.available(f.ledger, j)[0].trackable, false);
  await assert.rejects(ev.present({ ledger: f.ledger, config: f.config, job: j, input: { observation: id, track: true }, now: T0 + 2000 }), /single-turn snapshot and cannot be tracked/);
  assert.equal(Object.keys(f.ledger.data.evidencePages.presentations).length, 0, "a refused tracker leaves no record");
  const r = await ev.present({ readTicket: f.readTicket, ledger: f.ledger, config: f.config, job: j, input: { observation: id }, now: T0 + 2000 });
  assert.equal(r.chart, "not_chartable"); assert.equal(r.report, "linked"); assert.equal(r.tracker, "off");
  const snap = JSON.parse(fs.readFileSync(path.join(pageDir(f, r.presentation), "snap-0001.json"), "utf8"));
  assert.equal(snap.capturedAt, "2026-11-20"); assert.match(snap.title, /settled turn 79/);
  assert.equal(snap.columnMeta.unit.label, "Unit"); assert.ok(snap.caveats.some((c) => /does not show any company.s profitability/.test(c)));
});

// Run the real operator delivery loop (as approval-delivery.test.js does).
async function flush(f, { fail = false } = {}) {
  const sent = [], errors = [];
  const source = fs.readFileSync(path.join(__dirname, "../operator.js"), "utf8");
  const start = source.indexOf("async function flushOutbox() {"), end = source.indexOf("\n// Moderation tickets", start);
  const real = { evidencepages: ev, evidencedelivery: require("../lib/operator/evidencedelivery"), supporttakeover: takeover, toolmarkup: require("../lib/operator/toolmarkup"), conversationturn: require("../lib/operator/conversationturn") };
  const context = { ledger: f.ledger, config: f.config, killSwitch: { state: () => ({ engaged: false }) }, delivering: false, RESUME_HORIZON_MS: 86400000, JOB_TERMINAL: [],
    require: (p) => real[Object.keys(real).find((k) => p.endsWith(k))], renderDecision: () => "", isAppJob: () => false, ensureDm: async () => "dm", ownerText: (s) => s,
    redactSecrets: require("../lib/text").redactSecrets, chunkMessage: (s) => [s], splitReply: (s) => [s], snowflake: (s) => /^\d{16,20}$/.test(String(s || "")), replyGapMs: 0,
    discord: async (method, route, body, files) => {
      if (method === "GET") return { id: route.split("/").pop(), guild_id: f.config.guildId };
      if (fail) throw new Error("Discord 500");
      sent.push({ route, body, files }); return { id: "900000000000000001", timestamp: new Date().toISOString() };
    },
    conversation: { record() {} }, decisions: { delivered() {} }, answerFeedback: { components: () => null, delivered: async () => {} }, events: { append() {} }, taskIdOf: () => null, appChannel: {}, log: (e) => errors.push(e) };
  vm.runInNewContext(source.slice(start, end) + "\nthis.flush=flushOutbox;", context);
  await context.flush();
  return { sent, errors };
}

test("an answer carrying a claimed chart goes out as ONE message with the attachment, threaded and idempotent", async () => {
  // Public ping path: the answer's channel outbox entry carries the claimed files.
  const f = fixture(), c = publicJob(f); read(f, c, "market_history", market());
  const r = await ev.present({ readTicket: f.readTicket, ledger: f.ledger, config: f.config, job: c, input: {}, now: Date.now() });
  c.startedAt = f.ledger.data.evidencePages.presentations[r.presentation].staged.activation;
  const key = `channel-reply:${c.id}:answer`;
  const staged = ev.claim(f.ledger, c, { channel: PUBLIC_CH, key, at: Date.now() });
  f.ledger.notify(key, `channel:${c.id}`, `Filled demand stayed below listed demand all fortnight.\n${staged.line}`, { files: staged.files, chart: true, evidence: staged.presentation, answerTo: staged.answerTo });
  let out = await flush(f, { fail: true });
  const entry = f.ledger.data.outbox[key];
  assert.equal(entry.attempts, 1); assert.ok(!entry.deliveredAt);
  entry.retryAt = 0;
  out = await flush(f);
  assert.deepEqual(out.errors, []);
  assert.equal(out.sent.length, 1, "answer and chart in one message");
  const [{ route, body, files }] = out.sent;
  assert.equal(route, `/channels/${PUBLIC_CH}/messages`);
  assert.equal(body.nonce, `${entry.id}-0`, "a retry reuses the nonce, so Discord drops a duplicate"); assert.equal(body.enforce_nonce, true);
  assert.equal(JSON.stringify(body.attachments), JSON.stringify([{ id: 0, filename: "ahd-evidence-chart.png" }]));
  assert.equal(body.message_reference.message_id, Q);
  assert.equal(JSON.stringify(body.allowed_mentions), JSON.stringify({ parse: [] }));
  assert.match(body.content, /^Filled demand stayed below listed demand all fortnight\.\nFull table: https:\/\/lakesidegames\.net\/support\/evidence\/[a-f0-9]{32}$/);
  assert.equal(files[0].path, staged.files[0].path);
  assert.ok(entry.deliveredAt);
  out = await flush(f);
  assert.equal(out.sent.length, 0, "delivered once");
});

test("the broker captures a received read and presents it through present_evidence", async () => {
  const f = fixture();
  const { createBroker } = require("../lib/operator/broker");
  const env = market();
  const mcp = { servers: () => ["gamestate", "support"], list: async () => [], identity: () => ({}), call: async (server, tool) => server === "gamestate" && tool === "market_history" ? env : { ok: true } };
  const broker = createBroker({ ledger: f.ledger, config: { ...f.config, botId: "333333333333333333", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, repositories: {} },
    mcp, discord: async () => [], sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => T0 + 1000 });
  const j = f.ledger.createJob("owner-in-ticket", { kind: "command", role: "owner", actorId: f.config.ownerId, ticket: 123, channelId: TICKET_CH, replyChannel: TICKET_CH, deadline: T0 + 86400000,
    source: { channelId: TICKET_CH, channelName: "ticket-bug-fixture-123", messageId: Q, authorId: f.config.ownerId } });
  j.state = "running"; j.startedAt = T0;
  f.ledger.data.channels[TICKET_CH] = { name: "ticket-bug-fixture-123" };
  await broker.tool(j, "read_tool", { server: "gamestate", tool: "market_history", args: { commodity: "steel" } });
  assert.equal(ev.available(f.ledger, j).length, 1);
  const r = await broker.tool(j, "present_evidence", { observation: "latest" });
  assert.equal(r.chart, "staged");
  assert.equal(Object.keys(f.ledger.data.outbox).length, 0);
  assert.equal(ev.claim(f.ledger, j, { channel: TICKET_CH, key: "reply", at: T0 + 1500 }).presentation, r.presentation);
});

test("real game envelopes: the world object keys the series to one epoch, gap messages are kept, codes and collections are not", () => {
  const f = fixture(), j = ticketJob(f);
  const env = { ...market(), world: { worldEpochId: "epoch-a", telemetryWorldId: "preset:Fixture-1", startedAt: null, currentTurn: 131 },
    sources: [{ collection: "commodityFlows", fields: ["price"], basis: "settled market flows" }], gaps: [{ code: "no_national_growth_history", message: "This country stores no national growth history.", turns: [] }] };
  const id = read(f, j, "market_history", env);
  const o = f.ledger.data.evidencePages.observations[id];
  assert.equal(o.envelope.world, "epoch-a");
  assert.deepEqual(o.envelope.gaps, ["This country stores no national growth history. [no_national_growth_history]"]);
  assert.match(o.envelope.sources[0], /basis: settled market flows/);
  const next = read(f, j, "market_history", { ...env, world: { ...env.world, currentTurn: 132 } }, T0 + 2000);
  assert.equal(f.ledger.data.evidencePages.observations[next].fingerprint, o.fingerprint, "currentTurn does not split a series");
  const other = read(f, j, "market_history", { ...env, world: { ...env.world, worldEpochId: "epoch-b" } }, T0 + 3000);
  assert.notEqual(f.ledger.data.evidencePages.observations[other].fingerprint, o.fingerprint, "a new world is a new series");
  // The monitor's archive helper.
  return ev.present({ readTicket: f.readTicket, ledger: f.ledger, config: f.config, job: j, input: { observation: id, track: true }, now: T0 + 4000 }).then((r) => {
    const p = f.ledger.data.evidencePages.presentations[r.presentation];
    assert.equal(ev.archive(f.ledger, p, "world_reset", T0 + 5000), true);
    assert.equal(ev.archive(f.ledger, p, "again", T0 + 6000), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(pageDir(f, r.presentation), "archived.json"), "utf8")).reason, "world_reset");
  });
});

// --- Keir 11.1 privacy and archive revision ---------------------------------------

const metaOf = (f, id) => JSON.parse(fs.readFileSync(path.join(pageDir(f, id), "meta.json"), "utf8"));
const present = (f, job, input = {}, now = T0 + 2000, extra = {}) => ev.present({ readTicket: f.readTicket, ledger: f.ledger, config: f.config, job, input, now, ...extra });

test("every tracker opened on a ticket is ticket-private and pinned to the support service's reporter, never the actor", async () => {
  const f = fixture(), j = ticketJob(f, 123, { actorId: "999999999999999999" }); read(f, j, "market_history", market());
  const r = await present(f, j, { track: true });
  assert.equal(r.visibility, "ticket"); assert.match(r.tracker, /^live_until /);
  const meta = metaOf(f, r.presentation);
  assert.equal(meta.kind, "tracker"); assert.equal(meta.visibility, "ticket"); assert.equal(meta.ticket, 123);
  assert.deepEqual(meta.audience, { v: 1, kind: "ticket_reporter", ticket: 123, ticketCreatedAt: OPENED, character: "7", source: "support_get" });
  assert.ok(!JSON.stringify(meta).includes("999999999999999999") && !JSON.stringify(meta).includes("888888888888888888"), "no actor or message author in the pin");
  assert.equal(f.ticketReads, 1);
});

test("no verifiable reporter: no page, no link, no tracker; the inline chart or a plain answer remains", async () => {
  for (const [label, row, cached] of [
    ["no profile link", supportTicket(123, { reporter: "Display Name" }), null],
    ["profile on another host", supportTicket(123, { reporter: { profileUrl: "https://evil.example/character/7" } }), null],
    ["profile with an ObjectId", supportTicket(123, { reporter: { profileUrl: "https://ahousedividedgame.com/character/64b7f0c2a1b2c3d4e5f60718" } }), null],
    ["no creation time", supportTicket(123, { createdAt: null }), null],
    ["another ticket's row", supportTicket(124), null],
    ["staff investigation", supportTicket(123, { category: "investigation" }), null],
    ["support service error", { isError: true, content: [{ type: "text", text: "Error: down" }] }, null],
    ["reporter differs from the task's reporter", supportTicket(123), { id: "8" }],
  ]) {
    const f = fixture(), j = ticketJob(f, 123, cached ? { reporterCharacter: cached } : {}); read(f, j, "market_history", market());
    f.tickets[123] = row;
    const r = await present(f, j, { track: true });
    assert.equal(r.chart, "staged", label); assert.equal(r.tracker, "unavailable", label); assert.equal(r.report, "unavailable", label);
    assert.match(r.instruction, /do not promise updates/, label);
    const p = f.ledger.data.evidencePages.presentations[r.presentation];
    assert.equal(p.staged.line, null, `${label}: no link`); assert.equal(p.track, false); assert.equal(p.page, false);
    assert.ok(!fs.existsSync(pageDir(f, r.presentation)), `${label}: nothing on disk`);
  }
  // A thrown read is the same, and with nothing chartable the model answers in words.
  const g = fixture(), k = ticketJob(g); read(g, k, "market_history", market(0, 1));
  await assert.rejects(ev.present({ readTicket: async () => { throw new Error("timeout"); }, ledger: g.ledger, config: g.config, job: k, input: {}, now: T0 + 2000 }), /Answer in words/);
  await assert.rejects(ev.present({ ledger: g.ledger, config: g.config, job: k, input: {}, now: T0 + 2000 }), /Answer in words/, "no ticket reader at all fails closed");
});

test("reporter evidence about another character fails closed", async () => {
  const f = fixture(), j = ticketJob(f);
  const obs = read(f, j, "reporter_operating_results", operating(), T0 + 1000, { ticket: 123, character: "9" });
  await assert.rejects(present(f, j, { observation: obs, track: true }), /not about the ticket's reporter/);
  assert.equal(Object.keys(f.ledger.data.evidencePages.presentations).length, 0);
  const own = read(f, j, "reporter_operating_results", operating(5), T0 + 1500, { ticket: 123, character: "7" });
  assert.equal((await present(f, j, { observation: own, track: true })).visibility, "ticket");
});

test("only a public ping's one-off market report is a public page, and its files name no ticket, reporter, task or channel", async () => {
  const f = fixture(), c = publicJob(f); read(f, c, "market_history", market());
  const r = await present(f, c, {});
  assert.equal(r.visibility, "public_aggregate"); assert.equal(f.ticketReads || 0, 0, "no ticket read for a public ping");
  const meta = metaOf(f, r.presentation);
  assert.deepEqual(Object.keys(meta).sort(), ["createdAt", "expiresAt", "id", "kind", "metric", "product", "ticket", "title", "tool", "unit", "unitLabel", "version", "visibility", "world"]);
  assert.equal(meta.ticket, null); assert.equal(meta.kind, "report"); assert.equal(meta.expiresAt, null);
  const files = fs.readdirSync(pageDir(f, r.presentation)).map((n) => fs.readFileSync(path.join(pageDir(f, r.presentation), n)).toString("latin1")).join("\n");
  for (const secret of [c.id, PUBLIC_CH, Q]) assert.ok(!files.includes(secret), `public files carry no ${secret}`);
  assert.equal(f.ledger.data.evidencePages.presentations[r.presentation].staged.line, `Full table: https://lakesidegames.net/support/evidence/${r.presentation}`);
});

test("pages stay off, with no link ever produced, until EVIDENCE_PUBLIC_BASE is configured", async () => {
  for (const base of [undefined, "", "http://lakesidegames.net", "https://lakesidegames.net/path", "javascript:alert(1)"]) {
    const f = fixture(), j = ticketJob(f); read(f, j, "market_history", market());
    f.config.evidencePublicBase = base;
    assert.equal(ev.pagesBase(f.config), null, String(base));
    assert.throws(() => ev.linkFor(f.config, "a".repeat(32)), /pages are off/);
    const r = await present(f, j, { track: true });
    assert.equal(r.chart, "staged"); assert.equal(r.tracker, "unavailable"); assert.equal(r.report, "unavailable");
    assert.equal(f.ledger.data.evidencePages.presentations[r.presentation].staged.line, null);
    assert.ok(!fs.existsSync(f.config.evidencePagesDir) || !fs.readdirSync(f.config.evidencePagesDir).length, "no page written");
    assert.equal(f.ticketReads || 0, 0, "no ticket read when pages are off");
  }
  // The operator ships with no default origin.
  assert.match(fs.readFileSync(path.join(__dirname, "../operator.js"), "utf8"), /evidencePublicBase: env\.EVIDENCE_PUBLIC_BASE \|\| ""/);
});

test("a private page's link is never posted outside its own ticket channel", async () => {
  const f = fixture();
  const STAFF_CH = "121212121212121212";
  f.ledger.data.channels[STAFF_CH] = { name: "staff-room" };
  const j = f.ledger.createJob("owner-elsewhere", { kind: "command", role: "owner", ticket: 123, channelId: STAFF_CH, replyChannel: STAFF_CH, deadline: T0 + 86400000,
    source: { channelId: STAFF_CH, channelName: "staff-room", messageId: Q } });
  j.state = "running"; j.startedAt = T0;
  read(f, j, "market_history", market());
  const r = await present(f, j, {});
  const p = f.ledger.data.evidencePages.presentations[r.presentation];
  assert.equal(p.visibility, "ticket"); assert.equal(p.page, true); assert.equal(p.staged.line, null);
  assert.ok(ev.claim(f.ledger, j, { channel: STAFF_CH, key: "k", at: T0 + 2500 }), "public data may still be charted where staff asked");
});

test("a disk failure never marks a tracker archived; it stays ended, retries, and completes once the disk recovers", async () => {
  const f = fixture(), j = ticketJob(f); read(f, j, "market_history", market());
  const r = await present(f, j, { track: true });
  const dir = pageDir(f, r.presentation), aside = `${dir}.aside`;
  // The page directory becomes unwritable: a file where the directory was.
  fs.renameSync(dir, aside); fs.writeFileSync(dir, "not a directory");
  assert.equal(ev.stop(f.ledger, { ticket: 123 }, T0 + 5000), 0);
  let p = f.ledger.data.evidencePages.presentations[r.presentation];
  assert.equal(p.archivedAt, undefined, "not marked archived while the record failed");
  assert.equal(p.endReason, "stopped_by_request"); assert.equal(p.archivePending, true); assert.ok(p.archiveError);
  assert.equal(ev.endReason(f.ledger.data, p, T0 + 6000, []), "stopped_by_request", "still ended for the monitor");
  assert.equal(ev.sweep(f.ledger, T0 + 5500), 0, "the sweep retry fails while the disk is still broken");
  assert.equal(p.archivedAt, undefined);
  // The end survives a restart, and nothing is appended while pending.
  const restarted = createLedger(f.file);
  p = restarted.data.evidencePages.presentations[r.presentation];
  assert.equal(p.archivePending, true); assert.equal(p.archivedAt, undefined);
  fs.rmSync(dir); fs.renameSync(aside, dir);
  // The next sweep (or the next read of the same scope) completes it, and never appends.
  ev.observe(restarted, restarted.data.jobs[j.id], "read_tool", { server: "gamestate", tool: "market_history", args: { commodity: "steel" } }, market(1), T0 + 7000);
  p = restarted.data.evidencePages.presentations[r.presentation];
  assert.ok(!fs.existsSync(path.join(dir, "snap-0002.json")), "an ended tracker takes no appends");
  assert.equal(p.archivedAt, T0 + 5000, "archived at the time it ended"); assert.equal(p.archivePending, undefined);
  assert.equal(ev.sweep(restarted, T0 + 8000), 0, "nothing left to retry");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "archived.json"), "utf8")), { at: new Date(T0 + 5000).toISOString(), reason: "stopped_by_request", snapshots: 1 });
  assert.equal(ev.archive(restarted, p, "again", T0 + 9000), false);
});

test("no append after the absolute deadline, even when a restored ledger thinks the tracker is live", async () => {
  const f = fixture(), j = ticketJob(f); read(f, j, "market_history", market());
  const r = await present(f, j, { track: true });
  const p = f.ledger.data.evidencePages.presentations[r.presentation];
  p.expiresAt = T0 + 10 * ev.TRACK_MS;                       // a stale or damaged ledger
  const late = T0 + 2000 + ev.TRACK_MS;                      // exactly the deadline in meta.json
  read(f, j, "market_history", market(1), late);
  assert.ok(!fs.existsSync(path.join(pageDir(f, r.presentation), "snap-0002.json")), "the disk deadline holds");
  assert.equal(p.archivedAt, late); assert.equal(p.endReason, "expired");
  // A late snapshot stamped before the deadline but written after it is refused too.
  const store = ev.createStore(f.config.evidencePagesDir);
  const g = fixture(), k = ticketJob(g, 123, {}); read(g, k, "market_history", market());
  const r2 = await present(g, k, { track: true });
  const s2 = ev.createStore(g.config.evidencePagesDir);
  assert.equal(s2.snapshot(r2.presentation, 2, { n: 2, at: new Date(T0 + 3000).toISOString(), rowsHash: "x", rows: [] }, { at: T0 + 2000 + ev.TRACK_MS + 1 }), "expired");
  assert.equal(s2.snapshot(r2.presentation, 2, { n: 2, at: "not a date", rowsHash: "x", rows: [] }, { at: T0 + 3000 }), "expired", "an undated snapshot fails closed");
  assert.equal(store.archived(r.presentation).reason, "expired");
});

test("snapshots are never rewritten: a ledger behind the disk catches up instead of overwriting", async () => {
  const f = fixture(), j = ticketJob(f); read(f, j, "market_history", market());
  const r = await present(f, j, { track: true });
  read(f, j, "market_history", market(1), T0 + 3000);
  const dir = pageDir(f, r.presentation), second = fs.readFileSync(path.join(dir, "snap-0002.json"));
  const p = f.ledger.data.evidencePages.presentations[r.presentation];
  p.snapshots = 1; p.lastRowsHash = "stale";                 // restored from before snapshot 2
  read(f, j, "market_history", market(2), T0 + 4000);
  assert.ok(fs.readFileSync(path.join(dir, "snap-0002.json")).equals(second), "snapshot 2 untouched");
  assert.ok(fs.existsSync(path.join(dir, "snap-0003.json"))); assert.equal(p.snapshots, 3);
  const store = ev.createStore(f.config.evidencePagesDir);
  assert.equal(store.snapshot(r.presentation, 2, { n: 2, at: new Date(T0 + 5000).toISOString(), rowsHash: "different", rows: [] }, { at: T0 + 5000 }), "conflict");
  assert.equal(store.snapshot(r.presentation, 6, { n: 6, at: new Date(T0 + 5000).toISOString(), rowsHash: "gap", rows: [] }, { at: T0 + 5000 }), "conflict", "no gaps");
  assert.ok(fs.readFileSync(path.join(dir, "snap-0002.json")).equals(second));
  // No temp files are left behind, and a report never takes a second snapshot.
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
  const g = fixture(), c = publicJob(g); read(g, c, "market_history", market());
  const rep = await present(g, c, {});
  assert.equal(ev.createStore(g.config.evidencePagesDir).snapshot(rep.presentation, 2, { n: 2, at: new Date(T0 + 3000).toISOString(), rowsHash: "x", rows: [] }, { at: T0 + 3000 }), "closed");
  // The archive record counts the snapshots on disk, not the ledger's idea of them.
  p.snapshots = 1;
  ev.stop(f.ledger, { ticket: 123 }, T0 + 6000);
  assert.equal(store.archived(r.presentation).snapshots, 3);
  assert.equal(store.archive(r.presentation, { at: "x", reason: "again" }), false, "archived.json is write-once");
  assert.equal(store.archived(r.presentation).reason, "stopped_by_request");
});

test("archived.json on disk ends a tracker the ledger still thinks is live", async () => {
  const f = fixture(), j = ticketJob(f); read(f, j, "market_history", market());
  const r = await present(f, j, { track: true });
  ev.createStore(f.config.evidencePagesDir).archive(r.presentation, { at: new Date(T0 + 4000).toISOString(), reason: "takeover" });
  assert.equal(ev.sweep(f.ledger, T0 + 5000), 1);
  const p = f.ledger.data.evidencePages.presentations[r.presentation];
  assert.equal(p.endReason, "takeover"); assert.equal(p.archivedAt, T0 + 4000);
});
