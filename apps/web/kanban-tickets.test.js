// Kanban cards follow their support tickets: live status on cards, the
// reconcile pass, and "assigned" meaning a live session.
// Run: node --test kanban-tickets.test.js
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openKanban } = require("./kanban-store");
const { createTicketStatusReader, runTicketReconcile, decorateItem } = require("./kanban-tickets");
const { registerKanbanTools } = require("./mcp/kanban-tools");

const HOUR = 3_600_000;
let clock;
let k;
let tickets;
let reader;
let dbPath;

// A stand-in for the tickets collection: find({ ticketNumber: { $in } }).
function fakeTickets(records) {
  const state = { records, down: false, queries: 0 };
  state.getDb = async () => {
    if (state.down) throw new Error("connect ECONNREFUSED");
    return {
      collection: (name) => {
        assert.equal(name, "tickets");
        return {
          find: (q) => ({
            toArray: async () => {
              if (state.down) throw new Error("connect ECONNREFUSED");
              state.queries += 1;
              return state.records.filter((r) => q.ticketNumber.$in.includes(r.ticketNumber)).map((r) => structuredClone(r));
            },
          }),
        };
      },
    };
  };
  return state;
}

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-tickets-test-"));
  dbPath = path.join(dir, "kanban.db");
  clock = new Date("2026-11-17T10:00:00Z");
  k = openKanban(dbPath, { now: () => clock });
  k.upsertProduct({ slug: "a-house-divided", name: "A House Divided", aliases: ["ahd"] });
  tickets = fakeTickets([
    { ticketNumber: 1852, title: "Sector Tech does nothing because its already at 30% cap.", status: "open", statusHistory: [] },
    { ticketNumber: 1853, title: "Another report", status: "open", statusHistory: [] },
  ]);
  reader = createTicketStatusReader({ getDb: tickets.getDb, now: () => clock.getTime(), ttlMs: 60_000 });
}
const later = (ms) => { clock = new Date(clock.getTime() + ms); };
function closeTicket(n, at, { status = "resolved", message = "Fixed. The free technology no longer counts against the cap." } = {}) {
  const t = tickets.records.find((r) => r.ticketNumber === n);
  t.status = status;
  t.statusHistory.push({ status, at });
  if (status === "resolved") { t.resolvedAt = at; t.resolution = { message }; } else t.closedAt = at;
}
function reopenTicket(n, at) {
  const t = tickets.records.find((r) => r.ticketNumber === n);
  t.status = "open";
  t.statusHistory.push({ status: "reopened", at }, { status: "open", at });
}
function tools() {
  const registered = {};
  registerKanbanTools({ tool: (name, _d, _s, fn) => { registered[name] = fn; } }, {
    auth: { name: "test", scopes: { write: true } },
    jsonResult: (o) => ({ ok: true, o }),
    errorResult: (m) => ({ ok: false, m }),
    store: () => k,
    ticketStatus: reader,
  });
  return registered;
}
const TITLE = "Tech tree R&D prices are unreachable at real R&D income (ticket 1852)";

describe("ticket 1852, end to end", () => {
  beforeEach(fresh);

  it("Keir's developer handoff stays open as a follow-up when the player's ticket closes", async () => {
    // Review B1: Keir answers the player, closes the ticket, and files this
    // card because work remains. Closing it with the ticket loses the work.
    const t = tools();
    const card = (await t.kanban_add({ product: "ahd", title: TITLE, detail: "R&D prices sit far above real R&D income.\n\nRaised by Keir from ticket 1852.", kind: "task", lane: "next", assigned_to: "keir", actor: "keir" })).o;
    assert.deepEqual(card.tickets, [1852]);
    assert.equal(card.ticket_role, "follow_up");
    assert.equal(card.closes_with_ticket, false);
    later(11 * HOUR);
    closeTicket(1852, clock.toISOString());
    later(4 * 24 * HOUR);
    const got = (await t.kanban_get({ id: card.id })).o;
    assert.match(got.ticket_warning, /^Ticket 1852 was closed on 17 Nov\. This card is leftover follow-up work, not the ticket\./);
    const out = await runTicketReconcile({ store: k, reader });
    assert.deepEqual(out.counts, { follow_up: 1 });
    const after = k.get(card.id);
    assert.equal(after.lane, "next", "not completed");
    assert.equal(after.title, `Follow-up from closed ticket 1852: ${TITLE}`);
    assert.equal(after.assigned_to, null, "the quiet assignee is removed");
    assert.equal((await runTicketReconcile({ store: k, reader })).changed, 0);
  });

  it("a card the caller filed as the ticket's own work is completed with a note when the ticket closes", async () => {
    const t = tools();
    const card = (await t.kanban_add({ product: "ahd", title: TITLE, ticket: 1852, ticket_role: "own", start: true, actor: "claude:s1" })).o;
    assert.deepEqual(card.tickets, [1852]);
    assert.equal(card.ticket_role, "own");
    assert.equal(card.closes_with_ticket, true);
    assert.equal(card.ticket_status[0].status, "Open");
    assert.equal(card.ticket_warning, undefined);

    later(11 * HOUR); // 17 Nov 21:00
    closeTicket(1852, clock.toISOString());
    later(4 * 24 * HOUR); // 21 Nov

    const before = (await t.kanban_get({ id: card.id })).o;
    assert.equal(Object.keys(before)[0], "ticket_warning");
    assert.match(before.ticket_warning, /^Ticket 1852 was closed on 17 Nov\. /);
    assert.equal(before.ticket_status[0].status, "Closed");
    assert.equal(before.ticket_closed_card_open, true);

    const out = await runTicketReconcile({ store: k, reader });
    assert.deepEqual(out.counts, { completed: 1 });
    const after = k.get(card.id);
    assert.equal(after.lane, "done");
    const ev = after.events.find((e) => e.event_type === "source_closed");
    assert.match(ev.summary, /Ticket 1852 was closed on 17 Nov \(Fixed\. The free technology/);
    assert.match(before.ticket_warning, /filed as the ticket's own status or question.*The reconcile pass will close it/);
    assert.match(ev.summary, /ticket's own work, so it closes with it/);
    assert.equal(ev.actor, "source-sync");
    assert.equal((await t.kanban_get({ id: card.id })).o.ticket_warning, undefined, "a done card carries no warning");
  });

  it("a follow-up stays open, relabelled, with the dead assignee cleared, and kanban_get leads with the warning", async () => {
    const t = tools();
    const card = (await t.kanban_add({ product: "ahd", title: TITLE, ticket: 1852, ticket_role: "follow_up", start: true, actor: "claude:s1" })).o;
    assert.equal(card.ticket_role, "follow_up");
    assert.equal(card.ticket_link, "explicit");
    await t.work_report({ id: card.id, event: "progress", summary: "Research balance remains open under ticket 1852", actor: "claude:s1" });
    later(11 * HOUR);
    closeTicket(1852, clock.toISOString());
    later(4 * 24 * HOUR);

    const got = (await t.kanban_get({ id: card.id })).o;
    assert.equal(Object.keys(got)[0], "ticket_warning");
    assert.equal(got.ticket_warning.split(" Its assignee")[0], "Ticket 1852 was closed on 17 Nov. This card is leftover follow-up work, not the ticket.");
    assert.equal(got.ticket_label, "Follow-up from closed ticket 1852");
    assert.equal(got.activity, "no recent activity");
    assert.match(got.activity_warning, /claude:s1 has reported nothing for 4 days/);

    const out = await runTicketReconcile({ store: k, reader });
    assert.deepEqual(out.counts, { follow_up: 1 });
    const after = k.get(card.id);
    assert.equal(after.lane, "next");
    assert.equal(after.assigned_to, null);
    assert.equal(after.title, `Follow-up from closed ticket 1852: ${TITLE}`);
    const ev = after.events.find((e) => e.event_type === "source_follow_up");
    assert.match(ev.summary, /stays open as follow-up work/);
    assert.match(ev.summary, /claude:s1 unassigned/);
    assert.match(ev.summary, /Title was: "Tech tree/);
  });
});

describe("reconcile pass", () => {
  beforeEach(fresh);

  it("running twice changes nothing the second time, and is quiet", async () => {
    k.add({ product: "ahd", title: TITLE, start: true }, { actor: "claude" });
    k.add({ product: "ahd", title: "Follow-up from closed ticket 1852: research balance", lane: "next", assigned_to: "codex" }, { actor: "claude" });
    closeTicket(1852, clock.toISOString());
    const first = await runTicketReconcile({ store: k, reader });
    assert.equal(first.changed, 1);
    const events = k.db.prepare("SELECT COUNT(*) AS n FROM kanban_events").get().n;
    const second = await runTicketReconcile({ store: k, reader });
    assert.equal(second.changed, 0);
    assert.deepEqual(second.changes, []);
    assert.equal(k.db.prepare("SELECT COUNT(*) AS n FROM kanban_events").get().n, events);
  });

  it("does nothing to ticket cards when the ticket service is unreachable", async () => {
    const card = k.add({ product: "ahd", title: TITLE, start: true }, { actor: "claude" });
    closeTicket(1852, clock.toISOString());
    tickets.down = true;
    const out = await runTicketReconcile({ store: k, reader });
    assert.equal(out.changed, 0);
    assert.match(out.ticket_error, /ticket service unreachable/);
    assert.equal(k.get(card.id).lane, "now");
    const got = await decorateItem(k.get(card.id), reader);
    assert.equal(got.ticket_status[0].status, "unknown");
    assert.match(got.ticket_status[0].summary, /ticket status unknown/);
    assert.equal(got.ticket_warning, undefined);
  });

  it("a dry run reports the change and changes nothing", async () => {
    const card = k.add({ product: "ahd", title: TITLE, ticket: 1852, ticket_role: "own", start: true }, { actor: "claude" });
    closeTicket(1852, clock.toISOString());
    const rows = () => JSON.stringify([k.db.prepare("SELECT * FROM kanban_items").all(), k.db.prepare("SELECT * FROM kanban_events").all()]);
    const before = rows();
    const out = await runTicketReconcile({ store: k, reader, dryRun: true });
    assert.equal(out.dry_run, true);
    assert.deepEqual(out.changes.map((c) => [c.id, c.action, c.lane]), [[card.id, "completed", "done"]]);
    assert.equal(rows(), before);
    assert.equal((await runTicketReconcile({ store: k, reader })).changed, 1, "the real run then makes the change");
  });

  it("an own card naming several tickets closes only when all are closed", async () => {
    const card = k.add({ product: "ahd", title: "Cap and price fixes (tickets 1852 and 1853)", ticket_role: "own", start: true }, { actor: "claude" });
    assert.deepEqual(card.tickets, [1852, 1853]);
    closeTicket(1852, clock.toISOString());
    assert.equal((await runTicketReconcile({ store: k, reader })).changed, 0);
    const got = await decorateItem(k.get(card.id), reader);
    assert.match(got.ticket_warning, /Ticket 1852 was closed .* Ticket 1853 is still open or unknown\./);
    assert.deepEqual(got.ticket_status.map((s) => s.status), ["Closed", "Open"]);
    later(HOUR);
    closeTicket(1853, clock.toISOString(), { status: "closed" });
    const out = await runTicketReconcile({ store: k, reader });
    assert.deepEqual(out.counts, { completed: 1 });
    assert.equal(k.get(card.id).lane, "done");
  });

  it("a merged ticket closes its card and says where it went", async () => {
    const card = k.add({ product: "ahd", title: TITLE, start: true }, { actor: "claude" });
    Object.assign(tickets.records[0], { status: "closed", mergedInto: 1853, mergedAt: clock.toISOString(), closedAt: clock.toISOString() });
    const got = await decorateItem(k.get(card.id), reader);
    assert.equal(got.ticket_status[0].status, "Closed, merged into 1853");
    assert.match(got.ticket_warning, /merged into ticket 1853/);
  });

  it("a reopened ticket notes every card it closed and reopens only the most recent", async () => {
    const older = k.add({ product: "ahd", title: TITLE, ticket_role: "own", start: true }, { actor: "claude" });
    later(HOUR);
    const newer = k.add({ product: "ahd", title: "Second look at the tech cap (ticket 1852)", ticket_role: "own", force: true, lane: "next", assigned_to: "codex" }, { actor: "claude" });
    later(HOUR);
    closeTicket(1852, clock.toISOString());
    assert.equal((await runTicketReconcile({ store: k, reader })).changed, 2);
    later(24 * HOUR);
    reopenTicket(1852, clock.toISOString());
    const out = await runTicketReconcile({ store: k, reader });
    assert.deepEqual(out.counts, { reopened: 1, noted: 1 });
    assert.equal(k.get(newer.id).lane, "inbox");
    assert.equal(k.get(newer.id).assigned_to, null);
    assert.equal(k.get(older.id).lane, "done");
    assert.match(k.get(older.id).events[0].summary, /Ticket 1852 was reopened\. This card stays closed; card #\d+ was reopened instead/);
    assert.equal((await runTicketReconcile({ store: k, reader })).changed, 0, "the reopening is noted once");
    // Closing again closes the reopened card again.
    later(HOUR);
    closeTicket(1852, clock.toISOString());
    const again = await runTicketReconcile({ store: k, reader });
    assert.deepEqual(again.counts, { completed: 1 });
    assert.equal(k.get(newer.id).lane, "done");
  });

  it("a card relabelled by hand is not relabelled again", async () => {
    const title = "Follow-up from closed ticket 1852: research balance stays open";
    const live = k.add({ product: "ahd", title, start: true }, { actor: "codex" });
    assert.equal(live.ticket_role, "follow_up");
    closeTicket(1852, clock.toISOString());
    assert.equal((await runTicketReconcile({ store: k, reader })).changed, 0, "live assignee, already labelled: nothing to do");
    assert.equal(k.get(live.id).title, title);
    // The hand sweep relabels an existing own card by editing its title.
    const own = k.add({ product: "ahd", title: "Unreachable R&D prices (ticket 1852)", ticket_role: "own", force: true, lane: "backlog" }, { actor: "claude" });
    assert.equal(own.ticket_role, "own");
    k.update(own.id, { title: `Follow-up from closed ticket 1852: ${own.title}` }, { actor: "sweep" });
    assert.equal(k.get(own.id).ticket_role, "follow_up");
    assert.equal((await runTicketReconcile({ store: k, reader })).changed, 0);
    assert.equal(k.get(own.id).lane, "backlog");
    // When the live assignee goes quiet, only the assignee is cleared.
    later(25 * HOUR);
    const out = await runTicketReconcile({ store: k, reader });
    const change = out.changes.find((c) => c.id === live.id);
    assert.equal(change.action, "follow_up");
    assert.equal(change.new_title, undefined);
    assert.equal(k.get(live.id).title, title);
    assert.equal(k.get(live.id).assigned_to, null);
  });

  it("an own card with work reported after the ticket closed is kept as a follow-up", async () => {
    const card = k.add({ product: "ahd", title: TITLE, start: true }, { actor: "codex:tech" });
    later(HOUR);
    closeTicket(1852, clock.toISOString());
    later(HOUR);
    k.report({ id: card.id, event: "progress", summary: "Research balance remains open", actor: "codex:tech" });
    const got = await decorateItem(k.get(card.id), reader);
    assert.match(got.ticket_warning, /leftover follow-up work, not the ticket/);
    const out = await runTicketReconcile({ store: k, reader });
    assert.deepEqual(out.counts, { follow_up: 1 });
    const after = k.get(card.id);
    assert.equal(after.lane, "now", "a live session keeps it");
    assert.equal(after.assigned_to, "codex:tech");
    assert.equal(after.ticket_role, "follow_up");
    assert.match(after.title, /^Follow-up from closed ticket 1852: /);
  });

  it("capability requests, ideas and projects linked from their words are follow-ups", async () => {
    const cap = k.add({ product: "ahd", title: "Lore tool: read one era only", detail: "Raised by Keir from ticket 1852.", kind: "capability", lane: "backlog" }, { actor: "keir" });
    const idea = k.add({ product: "ahd", title: "Rethink the tech cap (ticket 1852)", class: "idea", lane: "backlog", force: true }, { actor: "keir" });
    assert.equal(cap.ticket_role, "follow_up");
    assert.equal(idea.ticket_role, "follow_up");
    closeTicket(1852, clock.toISOString());
    await runTicketReconcile({ store: k, reader });
    assert.equal(k.get(cap.id).lane, "backlog");
    assert.equal(k.get(idea.id).lane, "backlog");
  });

  it("GitHub-linked cards and cards filed after the ticket closed are follow-ups", async () => {
    closeTicket(1852, clock.toISOString());
    later(HOUR);
    const late = k.add({ product: "ahd", title: "Leftover R&D pricing (ticket 1852)", lane: "backlog" }, { actor: "claude" });
    const gh = k.add({ product: "ahd", title: "R&D pricing cap (ticket 1852)", force: true, lane: "backlog", github: "lakesidegamedev/AHDGame#9001" }, { actor: "claude" });
    const out = await runTicketReconcile({ store: k, reader });
    assert.equal(k.get(late.id).lane, "backlog");
    assert.match(k.get(late.id).title, /^Follow-up from closed ticket 1852: /);
    assert.equal(k.get(gh.id).lane, "backlog");
    assert.equal(k.get(gh.id).title, "R&D pricing cap (ticket 1852)", "a GitHub card's title belongs to its issue");
    assert.equal(out.changes.length, 1);
    assert.match((await decorateItem(k.get(gh.id), reader)).ticket_warning, /leftover follow-up work, not the ticket/);
  });

  it("is bounded per run", async () => {
    for (let i = 0; i < 5; i++) k.add({ product: "ahd", title: `Part ${i} of the fix (ticket 1852)`, force: true, lane: "backlog" }, { actor: "claude" });
    closeTicket(1852, clock.toISOString());
    const first = await runTicketReconcile({ store: k, reader, limit: 2 });
    assert.equal(first.changed, 2);
    assert.equal(first.deferred, 3);
    assert.equal((await runTicketReconcile({ store: k, reader, limit: 10 })).changed, 3);
  });

  it("leaves a card alone when its ticket number is not in the records", async () => {
    const card = k.add({ product: "ahd", title: "Odd thing (ticket 99999)", lane: "backlog" }, { actor: "claude" });
    const out = await runTicketReconcile({ store: k, reader });
    assert.deepEqual(out.skipped_unknown_tickets, [99999]);
    assert.equal(k.get(card.id).lane, "backlog");
  });
});

describe("ticket links on cards", () => {
  beforeEach(fresh);

  it("backfills existing cards conservatively when the store opens", () => {
    const stamp = clock.toISOString();
    const insert = k.db.prepare("INSERT INTO kanban_items (product, title, detail, lane, created_at, updated_at) VALUES ('a-house-divided', ?, ?, 'backlog', ?, ?)");
    const a = Number(insert.run(TITLE, "", stamp, stamp).lastInsertRowid);
    const b = Number(insert.run("Merge PR #7025 before turn 412", "Similar to ticket 1700.", stamp, stamp).lastInsertRowid);
    const c = Number(insert.run("Tech cap rework", "Raised by Keir from ticket 1852. See also ticket 1700.", stamp, stamp).lastInsertRowid);
    const d = Number(insert.run("Follow-up from closed ticket 1852: balance", "", stamp, stamp).lastInsertRowid);
    k.close();
    k = openKanban(dbPath, { now: () => clock });
    assert.deepEqual([k.get(a).tickets, k.get(a).ticket_role, k.get(a).ticket_link, k.get(a).closes_with_ticket], [[1852], "follow_up", "inferred", false]);
    assert.deepEqual(k.get(b).tickets, []);
    assert.equal(k.get(b).ticket_role, null);
    assert.deepEqual(k.get(c).tickets, [1852]);
    assert.equal(k.get(d).ticket_role, "follow_up");
  });

  it("only an own form or an explicit ticket_role own closes with the ticket", async () => {
    const status = k.add({ product: "ahd", title: "Ticket 1852: no confirmed answer for the player", detail: "Ticket 1852 reached the end of its task without an answer.\n\nRaised by Keir from ticket 1852.", lane: "next", assigned_to: "keir" }, { actor: "keir" });
    const question = k.add({ product: "ahd", title: "Which tech cap should apply? (ticket 1852)", detail: "Raised by Keir from ticket 1852.", lane: "backlog", force: true }, { actor: "keir" });
    const explicit = k.add({ product: "ahd", title: "Tech cap fix", ticket: 1852, lane: "backlog", force: true }, { actor: "claude" });
    const told = k.add({ product: "ahd", title: "Answer the player on the cap", ticket: 1852, ticket_role: "own", lane: "backlog", force: true }, { actor: "claude" });
    assert.deepEqual([status, question, explicit, told].map((c) => [c.ticket_role, c.closes_with_ticket]),
      [["own", true], ["follow_up", false], ["follow_up", false], ["own", true]]);
    // A caller's role survives a later title edit.
    k.update(told.id, { title: "Answer the player on the tech cap" }, { actor: "claude" });
    assert.equal(k.get(told.id).closes_with_ticket, true);
    closeTicket(1852, clock.toISOString());
    later(HOUR);
    const out = await runTicketReconcile({ store: k, reader });
    assert.deepEqual(out.counts, { completed: 2, follow_up: 2 });
    assert.deepEqual([status, question, explicit, told].map((c) => k.get(c.id).lane), ["done", "backlog", "backlog", "done"]);
  });

  it("a card linked as own by the previous version is re-read once as a follow-up", () => {
    const stamp = clock.toISOString();
    const insert = k.db.prepare("INSERT INTO kanban_items (product, title, detail, lane, created_at, updated_at, ticket_refs, ticket_role, ticket_link) VALUES ('a-house-divided', ?, '', 'backlog', ?, ?, '[1852]', 'own', 'inferred')");
    const handoff = Number(insert.run(TITLE, stamp, stamp).lastInsertRowid);
    const status = Number(insert.run("Ticket 1852: no confirmed answer for the player", stamp, stamp).lastInsertRowid);
    k.db.exec("ALTER TABLE kanban_items DROP COLUMN ticket_role_by");
    k.close();
    k = openKanban(dbPath, { now: () => clock });
    assert.deepEqual([k.get(handoff).ticket_role, k.get(handoff).closes_with_ticket], ["follow_up", false]);
    assert.deepEqual([k.get(status).ticket_role, k.get(status).closes_with_ticket], ["own", true]);
  });

  it("work_report can attach a ticket; an explicit link survives title edits", async () => {
    const card = k.add({ product: "ahd", title: "Tech cap rework", lane: "backlog" }, { actor: "claude" });
    assert.deepEqual(card.tickets, []);
    const r = k.report({ id: card.id, event: "progress", summary: "Linked", ticket: 1852, ticket_role: "follow_up", actor: "claude" });
    assert.deepEqual([r.item.tickets, r.item.ticket_role, r.item.ticket_link], [[1852], "follow_up", "explicit"]);
    assert.match(r.item.events[0].summary, /follow-up from ticket 1852/);
    k.update(card.id, { title: "Tech cap rework, part two" }, { actor: "claude" });
    assert.deepEqual(k.get(card.id).tickets, [1852]);
    k.update(card.id, { tickets: [] }, { actor: "claude" });
    assert.deepEqual(k.get(card.id).tickets, []);
    assert.throws(() => k.update(card.id, { ticket_role: "sometimes" }), /ticket_role must be one of/);
  });

  it("shows a cached status with its age when the ticket service drops", async () => {
    const card = k.add({ product: "ahd", title: TITLE, lane: "backlog" }, { actor: "claude" });
    const first = await decorateItem(k.get(card.id), reader);
    assert.equal(first.ticket_status[0].status, "Open");
    assert.equal(first.ticket_status[0].age_seconds, 0);
    assert.equal(first.ticket_status[0].note, undefined);
    later(30_000);
    const cached = await decorateItem(k.get(card.id), reader);
    assert.equal(cached.ticket_status[0].age_seconds, 30, "inside the cache window");
    assert.equal(tickets.queries, 1, "one batched read, reused");
    tickets.down = true;
    later(5 * 60_000);
    const stale = await decorateItem(k.get(card.id), reader);
    assert.equal(stale.ticket_status[0].status, "Open");
    assert.equal(stale.ticket_status[0].age_seconds, 330);
    assert.match(stale.ticket_status[0].note, /last read 6 minutes ago; the ticket service could not be read just now/);
    assert.match(stale.ticket_status[0].summary, /Ticket 1852: Open \(last read 6 minutes ago/);
    later(7 * HOUR);
    const gone = await decorateItem(k.get(card.id), reader);
    assert.equal(gone.ticket_status[0].status, "unknown", "too old to show");
  });

  it("list and brief carry the ticket status and warning", async () => {
    const t = tools();
    k.add({ product: "ahd", title: TITLE, start: true }, { actor: "claude" });
    closeTicket(1852, clock.toISOString());
    const list = (await t.kanban_list({})).o;
    assert.match(list.items[0].ticket_warning, /^Ticket 1852 was closed/);
    const brief = (await t.kanban_brief({ limit: 10 })).o;
    assert.match(brief.now[0].ticket_warning, /^Ticket 1852 was closed/);
    assert.deepEqual(brief.now[0].tickets, [`Ticket 1852: Closed on 17 Nov`]);
    const dry = (await t.kanban_reconcile({ dry_run: true })).o;
    assert.equal(dry.dry_run, true);
    assert.equal(dry.changes.length, 1);
  });
});

describe("assigned means a live session", () => {
  beforeEach(fresh);

  it("a Now card with no progress for 24 hours shows no recent activity and goes back to Next", async () => {
    const card = k.add({ product: "ahd", title: "Globe shader", start: true }, { actor: "claude:s9" });
    later(23 * HOUR);
    assert.equal(k.get(card.id).activity, null);
    assert.equal(k.get(card.id).stale, false);
    later(2 * HOUR);
    const got = k.get(card.id);
    assert.equal(got.activity, "no recent activity");
    assert.equal(got.stale, true);
    assert.match(got.stale_reason, /no recent activity: claude:s9 has reported nothing for 25 hours/);
    assert.equal(got.last_activity_at, "2026-11-17T10:00:00.000Z");
    assert.deepEqual(k.list({ stale: true }).items.map((i) => i.id), [card.id]);
    assert.equal(k.brief({}).counts.stale, 1);
    const out = await runTicketReconcile({ store: k, reader });
    assert.deepEqual(out.counts, { released: 1 });
    const after = k.get(card.id);
    assert.equal(after.lane, "next");
    assert.equal(after.assigned_to, null);
    assert.match(after.events[0].summary, /No recent activity: claude:s9 has reported nothing for 25 hours\. Moved from Now to Next and unassigned/);
  });

  it("progress keeps a card live, and the release also runs while tickets are unreachable", async () => {
    const card = k.add({ product: "ahd", title: "Globe shader", start: true }, { actor: "claude" });
    later(20 * HOUR);
    k.report({ id: card.id, event: "progress", summary: "Halfway", actor: "claude" });
    later(20 * HOUR);
    assert.equal(k.get(card.id).activity, null);
    tickets.down = true;
    later(5 * HOUR);
    const out = await runTicketReconcile({ store: k, reader });
    assert.deepEqual(out.counts, { released: 1 });
  });

  it("monitors are never released", async () => {
    const card = k.add({ product: "ahd", title: "Ticket watcher", kind: "monitor", start: true }, { actor: "keir" });
    later(48 * HOUR);
    assert.equal(k.get(card.id).activity, null);
    assert.equal((await runTicketReconcile({ store: k, reader })).changed, 0);
  });
});

describe("example output for the report", () => {
  beforeEach(fresh);
  it("prints what kanban_get returns for a follow-up card whose ticket closed", async () => {
    const t = tools();
    const card = (await t.kanban_add({ product: "ahd", title: TITLE, ticket: 1852, ticket_role: "follow_up", start: true, actor: "claude:s1" })).o;
    later(11 * HOUR);
    closeTicket(1852, clock.toISOString());
    later(4 * 24 * HOUR);
    const got = (await t.kanban_get({ id: card.id })).o;
    if (process.env.PRINT_KANBAN_EXAMPLE) console.log(JSON.stringify(got, null, 2));
    assert.equal(Object.keys(got)[0], "ticket_warning");
  });
});
