"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMonitor, reporterIdOf, envelopeOf } = require("../lib/operator/evidencemonitor");
const hasPages = fs.existsSync(path.join(__dirname, "../lib/operator/evidencepages.js"));
const pages = hasPages ? require("../lib/operator/evidencepages") : null;
const T0 = Date.parse("2026-11-20T10:00:00Z"), H = 3600000, CH = "1572041800976171180";
const WORLD = { worldEpochId: "epoch-a", telemetryWorldId: "preset:Test-1", startedAt: "2026-11-01T00:00:00Z", currentTurn: 3 };

const CREATED = "2026-11-20T09:00:00.000Z", PROFILE = (n) => `https://ahousedividedgame.com/character/${n}`;
// Raw gamestate envelopes in the real contract shape (schemaVersion 1), synthetic values only.
function envelope(tool, upTo, world = WORLD, extra = {}) {
  const from = Math.max(1, upTo - 3), rows = [];
  for (let t = from; t <= upTo; t++) {
    if (tool === "market_history") rows.push({ turn: t, price: 100 + t });
    else if (tool === "reporter_operating_results") rows.push({ turn: t, siteId: "site-a", siteName: "Test Mill", sectorType: "steel", revenue: 1000 + t, operatingProfit: 10 * t, source: "market_receipt" });
    else rows.push({ turn: t, nextGrantTurn: t + 4, turnsCovered: 4, complete: true, opening: 10 + t, closing: 5 + t });
  }
  const shape = tool === "market_history" ? { metric: "commodity_price", unit: "anchor currency per tonne", scope: { commodity: "steel", country: "US" } }
    : tool === "reporter_operating_results" ? { metric: "site_operating_results", unit: "anchor currency per turn", scope: { basis: "settled receipts" } }
      : { metric: "action_point_reconciliation", unit: "action points", scope: {} };
  return { schemaVersion: 1, tool, ...shape, world: { ...world, currentTurn: upTo }, asOfTurn: upTo, rows, summary: null, sources: [], gaps: [], ...extra };
}
function ticketRow(over = {}) { return { number: 77, status: "open", createdAt: CREATED, closedAt: null, resolvedAt: null, conversation: { channelId: CH }, reporter: { profileUrl: PROFILE(42), characterName: "Ada" }, ...over }; }
const asReporter = (n) => ({ reporter: { profileUrl: PROFILE(n) } });

// A ledger with one tracker opened on ticket 77, as present_evidence would leave it.
function setup({ tool = "market_history", args = { metric: "commodity_price", commodity: "steel", country: "US", turns: 12 }, count = 1, at = T0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evmon-"));
  const data = { jobs: { job1: { id: "job1", ticket: 77, kind: "ticket", role: "owner", channelId: CH, state: "waiting" } }, seen: { "ticket:77": "job1" },
    channels: { [CH]: { name: "ticket-ada-77" } }, supportOwner: {}, outbox: {} };
  const audits = [];
  const ledger = { data, save() {}, audit: (k, v) => audits.push([k, v]), notify() { throw new Error("monitor must never notify"); }, id: () => "x" };
  const ids = [];
  for (let i = 0; i < count; i++) {
    const a = { ...args, ...(i ? { commodity: `steel${i}` } : {}) };
    const id = pages.observe(ledger, data.jobs.job1, "read_tool", { server: "gamestate", tool, args: a }, envelope(tool, 3), at);
    const obs = data.evidencePages.observations[id];
    const pid = (i + 1).toString(16).padStart(32, "0");
    const store = pages.createStore(dir);
    store.create({ id: pid, version: 2, kind: "tracker", createdAt: new Date(at).toISOString(), expiresAt: new Date(at + 24 * H).toISOString(), visibility: "ticket", ticket: 77,
      audience: { v: 1, kind: "ticket_reporter", ticket: 77, ticketCreatedAt: CREATED, character: "42", source: "support_get" } }, null);
    assert.equal(store.snapshot(pid, 1, { n: 1, at: new Date(at).toISOString(), rowsHash: obs.rowsHash }, { at }), "written");
    data.evidencePages.presentations[pid] = { id: pid, key: `77:${obs.fingerprint}`, fingerprint: obs.fingerprint, jobId: "job1", ticket: 77, tool, visibility: "ticket",
      createdAt: at, expiresAt: at + 24 * H, track: true, dir, observations: [id], snapshots: 1, lastRowsHash: obs.rowsHash, chart: false, page: true, channel: CH };
    ids.push(pid);
  }
  return { ledger, data, audits, dir, ids, p: data.evidencePages.presentations[ids[0]] };
}
function harness(ctx, { turn = 4, asOf = turn, world = WORLD, ticket = ticketRow(), onRead } = {}) {
  const h = { clock: T0 + 30 * 60000, turn, asOf, world, ticket, reads: [], tickets: 0, turns: 0, fail: null, onRead };
  h.monitor = createMonitor({ ledger: ctx.ledger, config: {}, now: () => h.clock,
    read: async (tool, args) => { h.reads.push({ tool, args }); if (h.onRead) await h.onRead(h, tool, args); if (h.fail) throw new Error(h.fail); return envelope(tool, h.asOf, h.world); },
    currentTurn: async () => { h.turns++; return h.turn; },
    readTicket: async () => { h.tickets++; return typeof h.ticket === "function" ? h.ticket() : h.ticket; } });
  return h;
}
const snaps = (ctx, id = ctx.ids[0]) => fs.readdirSync(path.join(ctx.dir, id)).filter((f) => /^snap-\d+\.json$/.test(f));
const archived = (ctx, id = ctx.ids[0]) => ctx.data.evidencePages.presentations[id].endReason || null;
const skip = hasPages ? {} : { skip: "evidencepages.js not present in this tree" };

test("a newly settled turn appends one snapshot and nothing else", skip, async () => {
  const ctx = setup(), h = harness(ctx);
  const jobsBefore = JSON.stringify(ctx.data.jobs);
  const r = await h.monitor.tick();
  assert.equal(r.appended, 1);
  assert.equal(snaps(ctx).length, 2);
  assert.equal(ctx.p.snapshots, 2);
  assert.equal(JSON.stringify(ctx.data.jobs), jobsBefore, "no job is touched, created or revived");
  assert.equal(h.reads.length, 1);
});

test("the same turn is not read or appended again, across ticks and a restart", skip, async () => {
  const ctx = setup(), h = harness(ctx);
  await h.monitor.tick();
  h.clock += 2 * 60000; await h.monitor.tick();
  h.clock += 2 * 60000; await h.monitor.tick();
  assert.equal(h.reads.length, 1, "turn has not moved: gate answers without a read");
  const h2 = harness(ctx, { turn: 4 }); h2.clock = h.clock + 5 * 60000;           // restart: new monitor, same persisted ledger
  await h2.monitor.tick();
  assert.equal(h2.reads.length, 0);
  assert.equal(snaps(ctx).length, 2);
  // Persisted state lost for one tracker (crash before save): the page module still dedupes.
  delete ctx.data.evidenceMonitor;
  const h3 = harness(ctx, { turn: 4 }); h3.clock = h2.clock + 5 * 60000;
  await h3.monitor.tick();
  assert.equal(snaps(ctx).length, 2, "duplicate observation adds no snapshot");
});

test("the next turn appends again", skip, async () => {
  const ctx = setup(), h = harness(ctx);
  await h.monitor.tick();
  h.clock += 5 * 60000; h.turn = 5; h.asOf = 5;
  await h.monitor.tick();
  assert.equal(snaps(ctx).length, 3);
});

test("a turn that has not settled retries on a schedule, then waits for the next turn", skip, async () => {
  const ctx = setup(), h = harness(ctx, { turn: 4, asOf: 3 });
  await h.monitor.tick();
  assert.equal(h.reads.length, 1);
  h.clock += 10000; await h.monitor.tick();
  assert.equal(h.reads.length, 1, "settle retry is paced, not every tick");
  for (let i = 0; i < 12; i++) { h.clock += 11 * 60000; await h.monitor.tick(); }
  assert.ok(h.reads.length <= 8, `bounded settle retries, got ${h.reads.length}`);
  assert.equal(snaps(ctx).length, 1);
  h.asOf = 4; h.clock += 11 * 60000; h.turn = 5; await h.monitor.tick();
  assert.equal(snaps(ctx).length, 2);
});

test("takeover, pause, stop and closed ticket archive silently before any read", skip, async () => {
  for (const [name, mutate, reason] of [
    ["takeover", (d) => { d.supportOwner = { tickets: { 77: "staff" } }; }, "takeover"],
    ["ticket pause", (d) => { d.ticketPauses = { 77: { by: "o" } }; }, "paused"],
    ["channel pause", (d) => { d.channels[CH].keirPaused = { by: "o" }; }, "paused"],
    ["keir stopped", (d) => { d.control = { stopped: true }; }, "keir_stopped"],
    ["job closed", (d) => { d.jobs.job1.state = "done"; d.jobs.job1.closedAt = T0 + 1; }, "ticket_closed"],
  ]) {
    const ctx = setup(), h = harness(ctx);
    mutate(ctx.data);
    await h.monitor.tick();
    assert.equal(h.reads.length, 0, `${name}: no read`);
    assert.equal(archived(ctx), reason, name);
    assert.ok(fs.existsSync(path.join(ctx.dir, ctx.ids[0], "archived.json")), `${name}: page archived`);
  }
});

test("takeover that lands during the read archives and appends nothing", skip, async () => {
  const ctx = setup(), h = harness(ctx, { onRead: (hh) => { ctx.data.supportOwner = { tickets: { 77: "staff" } }; } });
  await h.monitor.tick();
  assert.equal(archived(ctx), "takeover");
  assert.equal(snaps(ctx).length, 1);
});

test("the live ticket row ends a tracker: resolved, merged, wrong number, other channel, closed channel", skip, async () => {
  for (const [name, row, reason] of [
    ["resolved", ticketRow({ status: "resolved" }), "ticket_closed"],
    ["merged", ticketRow({ mergedInto: 5 }), "ticket_closed"],
    ["closed channel", ticketRow({ conversation: { channelId: CH, channelClosed: true } }), "ticket_closed"],
    ["other number", ticketRow({ number: 78 }), "ticket_mismatch"],
    ["moved channel", ticketRow({ conversation: { channelId: "1999999999999999999" } }), "channel_changed"],
  ]) {
    const ctx = setup(), h = harness(ctx, { ticket: row });
    await h.monitor.tick();
    assert.equal(h.reads.length, 0, name);
    assert.equal(archived(ctx), reason, name);
  }
});

test("the ticket closing during the read archives and appends nothing", skip, async () => {
  const ctx = setup(), h = harness(ctx);
  h.ticket = () => (h.reads.length ? ticketRow({ status: "closed" }) : ticketRow());
  await h.monitor.tick();
  assert.equal(archived(ctx), "ticket_closed");
  assert.equal(snaps(ctx).length, 1);
});

test("hard 24 h from creation, even when the stored expiry was pushed out", skip, async () => {
  const ctx = setup(), h = harness(ctx);
  ctx.p.expiresAt = T0 + 90 * H;
  h.clock = T0 + 24 * H + 1000;
  await h.monitor.tick();
  assert.equal(h.reads.length, 0);
  assert.equal(archived(ctx), "expired");
});

test("kill switch archives every tracker without reads", skip, async () => {
  const ctx = setup({ count: 2 });
  const h = harness(ctx);
  const m = createMonitor({ ledger: ctx.ledger, now: () => h.clock, held: () => true, read: async () => { throw new Error("no"); }, readTicket: async () => ticketRow() });
  await m.tick();
  assert.equal(archived(ctx, ctx.ids[0]), "kill_switch");
  assert.equal(archived(ctx, ctx.ids[1]), "kill_switch");
});

test("read arguments are rebuilt: saved junk, toTurn and foreign ticket never go out", skip, async () => {
  const ctx = setup({ args: { metric: "commodity_price", commodity: "steel", country: "US", turns: 60, toTurn: 2, limit: 500, evil: "x", collection: "users", filter: { $where: "1" } } });
  const h = harness(ctx);
  await h.monitor.tick();
  assert.deepEqual(h.reads[0], { tool: "market_history", args: { metric: "commodity_price", turns: 24, country: "US", commodity: "steel" } });
});

test("a bad saved scope archives instead of being sent", skip, async () => {
  const ctx = setup({ args: { metric: "catalog" } });
  const h = harness(ctx);
  await h.monitor.tick();
  assert.equal(h.reads.length, 0);
  assert.equal(archived(ctx), "scope_unreadable");
  const ctx2 = setup({ args: { metric: "commodity_price", commodity: "steel; drop" } });
  await harness(ctx2).monitor.tick();
  assert.equal(archived(ctx2), "scope_unreadable");
});

test("reporter tools use the live ticket's reporter, never a saved character", skip, async () => {
  const ctx = setup({ tool: "reporter_operating_results", args: { ticket: 77, character: "42", turns: 3, toTurn: 2 } });
  const h = harness(ctx);
  await h.monitor.tick();
  assert.deepEqual(h.reads[0], { tool: "reporter_operating_results", args: { ticket: 77, character: "42", turns: 6 } });
  const swapped = setup({ tool: "reporter_operating_results", args: { ticket: 77, character: "42" } });
  const h2 = harness(swapped, { ticket: ticketRow(asReporter(99)) });
  await h2.monitor.tick();
  assert.equal(h2.reads.length, 0);
  assert.equal(archived(swapped), "reporter_changed");
  const none = setup({ tool: "reporter_action_points", args: { ticket: 77, character: "42" } });
  const h3 = harness(none, { ticket: ticketRow({ reporter: { profileUrl: null } }) });
  await h3.monitor.tick();
  assert.equal(archived(none), "reporter_unverifiable");
  const wrongTicket = setup({ tool: "reporter_action_points", args: { ticket: 12, character: "42" } });
  await harness(wrongTicket).monitor.tick();
  assert.equal(archived(wrongTicket), "ticket_mismatch");
});

test("the reporter changing during the read archives and appends nothing", skip, async () => {
  const ctx = setup({ tool: "reporter_operating_results", args: { ticket: 77, character: "42" } });
  const h = harness(ctx);
  h.ticket = () => (h.reads.length ? ticketRow(asReporter(7)) : ticketRow());
  await h.monitor.tick();
  assert.equal(archived(ctx), "reporter_changed");
  assert.equal(snaps(ctx).length, 1);
});

test("a different world archives the original series and appends nothing", skip, async () => {
  const ctx = setup(), h = harness(ctx);
  await h.monitor.tick();                                                    // baseline world recorded, turn 4 appended
  assert.equal(snaps(ctx).length, 2);
  h.clock += 5 * 60000; h.turn = 5; h.asOf = 5; h.world = { ...WORLD, worldEpochId: "epoch-b" };
  await h.monitor.tick();
  assert.equal(archived(ctx), "world_reset");
  assert.equal(snaps(ctx).length, 2, "the original series is kept, nothing from the new world joins it");
  assert.equal(ctx.p.snapshots, 2);
});

test("a world that started after the tracker, or turns that run backwards, is a reset", skip, async () => {
  const a = setup(), ha = harness(a, { world: { ...WORLD, startedAt: "2026-11-20T10:20:00Z" } });
  await ha.monitor.tick();
  assert.equal(archived(a), "world_reset");
  assert.equal(snaps(a).length, 1);
  const b = setup(), hb = harness(b, { turn: 2, asOf: 2 });
  await hb.monitor.tick();
  assert.equal(archived(b), "world_reset", "turn 2 after a baseline of turn 3");
  assert.equal(snaps(b).length, 1);
});

test("market, operating and action-point trackers each write a real second snapshot through the typed projector", skip, async () => {
  for (const tool of ["market_history", "reporter_operating_results", "reporter_action_points"]) {
    const args = tool === "market_history" ? undefined : { ticket: 77, character: "42" };
    const ctx = setup({ tool, ...(args ? { args } : {}) }), h = harness(ctx);
    const r = await h.monitor.tick();
    assert.equal(r.appended, 1, tool);
    assert.equal(snaps(ctx).length, 2, tool);
    const snap = JSON.parse(fs.readFileSync(path.join(ctx.dir, ctx.ids[0], "snap-0002.json"), "utf8"));
    assert.equal(snap.asOfTurn, 4, tool);
    assert.equal(snap.tool, tool);
    assert.ok(snap.rows.length >= 1, tool);
    assert.equal(archived(ctx), null, tool);
    h.clock += 5 * 60000; h.turn = 5; h.asOf = 5;
    assert.equal((await h.monitor.tick()).appended, 1, tool);
    assert.equal(snaps(ctx).length, 3, tool);
  }
});

test("market tracker: the ticket reassigned to another reporter before the read means no read and no append", skip, async () => {
  const ctx = setup(), h = harness(ctx, { ticket: ticketRow(asReporter(99)) });
  await h.monitor.tick();
  assert.equal(h.reads.length, 0);
  assert.equal(archived(ctx), "reporter_changed");
  assert.equal(snaps(ctx).length, 1);
  h.clock += 5 * 60000; h.turn = 5; h.asOf = 5; await h.monitor.tick();
  assert.equal(h.reads.length, 0, "an archived tracker is never read again");
  assert.equal(h.tickets, 1);
});

test("market tracker: the ticket reassigned during the read appends nothing", skip, async () => {
  const ctx = setup(), h = harness(ctx);
  h.ticket = () => (h.reads.length ? ticketRow(asReporter(99)) : ticketRow());
  await h.monitor.tick();
  assert.equal(h.reads.length, 1);
  assert.equal(archived(ctx), "reporter_changed");
  assert.equal(snaps(ctx).length, 1);
  assert.equal(ctx.p.snapshots, 1);
});

test("market tracker: a reassignment to an unlinked reporter, or a recreated ticket number, also ends it", skip, async () => {
  const a = setup(), ha = harness(a, { ticket: ticketRow({ reporter: { profileUrl: null } }) });
  await ha.monitor.tick();
  assert.equal(archived(a), "reporter_unverifiable");
  assert.equal(ha.reads.length, 0);
  const b = setup(), hb = harness(b, { ticket: ticketRow({ createdAt: "2026-11-20T09:30:00.000Z" }) });
  await hb.monitor.tick();
  assert.equal(archived(b), "ticket_recreated");
  assert.equal(hb.reads.length, 0);
  const c = setup(), hc = harness(c);
  hc.ticket = () => (hc.reads.length ? ticketRow({ createdAt: "2026-11-21T00:00:00.000Z" }) : ticketRow());
  await hc.monitor.tick();
  assert.equal(archived(c), "ticket_recreated");
  assert.equal(snaps(c).length, 1);
});

test("a tracker without a pinned audience in its page meta is never read", skip, async () => {
  const ctx = setup(), h = harness(ctx);
  const f = path.join(ctx.dir, ctx.ids[0], "meta.json");
  const meta = JSON.parse(fs.readFileSync(f, "utf8")); delete meta.audience; fs.writeFileSync(f, JSON.stringify(meta));
  await h.monitor.tick();
  assert.equal(h.reads.length, 0);
  assert.equal(archived(ctx), "audience_unpinned");
});

test("failures back off, are bounded, and end the tracker", skip, async () => {
  const ctx = setup(), h = harness(ctx);
  h.fail = "gamestate down";
  await h.monitor.tick();
  assert.equal(h.reads.length, 1);
  h.clock += 10000; await h.monitor.tick();
  assert.equal(h.reads.length, 1, "backed off");
  for (let i = 0; i < 40; i++) { h.clock += 31 * 60000; await h.monitor.tick(); if (archived(ctx)) break; }
  assert.equal(archived(ctx), "monitor_failed");
  assert.equal(h.reads.length, 8);
  const r = await h.monitor.tick();
  assert.equal(h.reads.length, 8, "ended trackers are never read again");
  assert.equal(r.checked, 0);
});

test("work per tick is bounded and one turn lookup is shared", skip, async () => {
  const ctx = setup({ count: 5 }), h = harness(ctx);
  const r = await h.monitor.tick();
  assert.equal(r.checked, 3);
  assert.equal(h.turns, 1);
  h.clock += 61000; await h.monitor.tick();
  assert.equal(h.reads.length, 5);
});

test("without a turn signal reads are paced and back off when nothing changes", skip, async () => {
  const ctx = setup(), h = harness(ctx);
  const m = createMonitor({ ledger: ctx.ledger, now: () => h.clock, currentTurn: async () => { throw new Error("overview down"); },
    read: async (tool, args) => { h.reads.push({ tool, args }); return envelope(tool, 3); }, readTicket: async () => ticketRow() });
  h.clock = T0 + 5 * 60000; await m.tick();
  assert.equal(h.reads.length, 0, "paced: ten minutes minimum");
  h.clock = T0 + 11 * 60000; await m.tick();
  assert.equal(h.reads.length, 1);
  h.clock += 15 * 60000; await m.tick();
  assert.equal(h.reads.length, 1, "unchanged poll doubled the pace");
});

test("a tracker is never created by the monitor, and a non-tracker is ignored", skip, async () => {
  const ctx = setup(), h = harness(ctx);
  ctx.p.track = false;
  await h.monitor.tick();
  assert.equal(h.reads.length, 0);
  assert.equal(Object.keys(ctx.data.evidencePages.presentations).length, 1);
});

test("helpers", () => {
  assert.equal(reporterIdOf({ reporter: { profileUrl: PROFILE(123) } }), "123");
  assert.equal(reporterIdOf({ reporter: { profileUrl: "https://a.test/character/123" } }), null, "only the game profile host counts");
  assert.equal(reporterIdOf({ reporter: { profileUrl: PROFILE("abc") } }), null);
  assert.equal(envelopeOf({ isError: true, rows: [] }), null);
  assert.ok(envelopeOf({ content: [{ type: "text", text: JSON.stringify({ rows: [1] }) }] }));
});
