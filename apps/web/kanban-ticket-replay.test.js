// Replays the reconcile pass over the real board of 21 Nov 2026 (the 612
// cards before the hand sweep) with the real ticket states, and checks it
// against what the sweep decided card by card. The sweep is the ground truth:
// the pass may close fewer cards than the sweep did, never one it kept.
// Run: node --test kanban-ticket-replay.test.js
// PRINT_REPLAY=1 prints the numbers.
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openKanban } = require("./kanban-store");
const { createTicketStatusReader, runReconcile } = require("./kanban-tickets");

const fixture = require("./kanban-ticket-replay-fixture.json");
// The seven cards the review found the first version would close although
// the sweep kept them as real follow-up work.
const WRONG_BEFORE = [254910, 255104, 255117, 255262, 255437, 254622, 255429];

function loadBoard(at) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-replay-"));
  const file = path.join(dir, "kanban.db");
  let k = openKanban(file, { now: () => at });
  for (const slug of new Set(fixture.cards.map((c) => c.product))) k.upsertProduct({ slug, name: slug });
  const insert = k.db.prepare(`INSERT INTO kanban_items (id, product, title, detail, lane, kind, class, assigned_to, created_at, updated_at, last_progress_at, github_repo, github_number, github_state)
    VALUES (@id, @product, @title, @detail, @lane, @kind, @class, @assigned_to, @created_at, @updated_at, @last_progress_at, @github_repo, @github_number, @github_state)`);
  k.db.transaction(() => {
    for (const c of fixture.cards) insert.run({ ...c, github_number: c.github_repo ? c.id : null, github_state: c.github_repo ? "open" : null });
  })();
  // Reopen so the backfill reads every card's link from its words, as on the live board.
  k.close();
  k = openKanban(file, { now: () => at });
  return k;
}

function ticketReader(at) {
  const records = fixture.tickets.map((t) => ({ ...t, ticketNumber: t.number }));
  return createTicketStatusReader({
    now: () => at.getTime(),
    getDb: async () => ({ collection: () => ({ find: (q) => ({ toArray: async () => records.filter((r) => q.ticketNumber.$in.includes(r.ticketNumber)).map((r) => structuredClone(r)) }) }) }),
  });
}

describe("replay over the 21 Nov board", () => {
  const at = new Date("2026-11-21T16:00:00Z");
  const sweep = new Map(fixture.cards.map((c) => [c.id, c.sweep]));
  let k;
  let first;
  let second;
  before(async () => {
    k = loadBoard(at);
    const reader = ticketReader(at);
    first = await runReconcile({ store: k, reader, limit: 500 });
    // A merged ticket moves its cards to the target first; the next run
    // follows the target. Two runs reach the steady state.
    second = await runReconcile({ store: k, reader, limit: 500 });
  });

  it("links the same cards the review counted, without the background aside", () => {
    const linked = fixture.cards.filter((c) => k.get(c.id).tickets.length);
    assert.ok(linked.length >= 60, `${linked.length} linked`);
    assert.deepEqual(k.get(255124).tickets, [1792], "ticket 1391 was only background");
    assert.equal(fixture.cards.filter((c) => k.get(c.id).closes_with_ticket).length, 2, "only the two own-form cards close with their ticket");
  });

  it("completes no card the sweep kept or relabelled as real work", () => {
    const completed = [...first.changes, ...second.changes].filter((c) => c.action === "completed").map((c) => c.id);
    const wrong = completed.filter((id) => sweep.get(id) && sweep.get(id).outcome !== "closed");
    assert.deepEqual(wrong, []);
    for (const id of WRONG_BEFORE) assert.notEqual(k.get(id).lane, "done", `card ${id} stays open`);
  });

  it("every completion it makes was also closed by the sweep", () => {
    const completed = [...first.changes, ...second.changes].filter((c) => c.action === "completed");
    assert.ok(completed.length > 0, "the pass still closes what is purely the ticket's");
    for (const c of completed) assert.equal(sweep.get(c.id).outcome, "closed", `card ${c.id}`);
    assert.deepEqual(completed.map((c) => c.id).sort(), [255323, 255382]);
  });

  it("relabels the kept follow-ups, moves the merged ticket's card, and reaches a steady state", async () => {
    for (const id of [254910, 255104, 255117, 255437, 254622, 255428])
      assert.match(k.get(id).title, /^Follow-up from closed ticket \d+: /, `card ${id}`);
    const moved = first.changes.find((c) => c.id === 254665);
    assert.equal(moved.action, "moved");
    assert.deepEqual(k.get(254665).tickets, [1600]);
    assert.match(k.get(254665).title, /^Follow-up from closed ticket 1600: /, "the second run follows the target ticket");
    const third = await runReconcile({ store: k, reader: ticketReader(at), limit: 500 });
    assert.equal(third.changed, 0);
  });

  it("reports the numbers", () => {
    const changes = [...first.changes, ...second.changes];
    const ids = (action, source = "ticket") => new Set(changes.filter((c) => c.action === action && (source === null || c.source === source)).map((c) => c.id));
    const completed = ids("completed");
    const relabelled = ids("follow_up");
    const moved = ids("moved");
    const released = ids("released", null);
    const linked = fixture.cards.filter((c) => k.get(c.id).tickets.length);
    const sweepClosedLinked = linked.filter((c) => c.sweep.outcome === "closed").length;
    const numbers = {
      board_cards: fixture.board_cards, ticket_linked: linked.length, completed: completed.size, relabelled_follow_up: relabelled.size,
      moved_to_merge_target: moved.size, released_from_now: released.size,
      left_open: linked.filter((c) => k.get(c.id).lane !== "done").length,
      wrong_closures: [...completed].filter((id) => sweep.get(id).outcome !== "closed").length,
      sweep_closed_linked: sweepClosedLinked,
      sweep_closures_left_open: linked.filter((c) => c.sweep.outcome === "closed" && k.get(c.id).lane !== "done").length,
    };
    if (process.env.PRINT_REPLAY) console.log(JSON.stringify(numbers, null, 2));
    assert.equal(numbers.wrong_closures, 0);
  });
});
