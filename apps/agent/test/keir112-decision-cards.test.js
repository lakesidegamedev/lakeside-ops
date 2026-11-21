"use strict";
// Keir 11.2 item 6: a decision's kanban card closes with the decision. Fixtures from the 2026-11-21 audit: card 255495
// (ticket 1857, answered in the channel), 255529 (ticket 1859), 255576 (ticket 1869, closed by staff), and an
// inbox card on a ticket that was closed while its question was still open.
const test = require("node:test");
const assert = require("node:assert");
const { createDecisionCards } = require("../lib/operator/decisioncards");
const { createDecisions } = require("../lib/operator/decisions");
const sd = require("../lib/operator/standdown");

const OWNER = "100000000000000001", BOT = "100000000000000003";

function setup(cards, { tickets = {}, failGet = false } = {}) {
  const data = { jobs: {}, actions: {}, decisions: {}, outbox: {}, audit: [] };
  const ledger = { data, save() {}, audit(kind, x) { data.audit.push({ kind, ...x }); }, notify() {} };
  const calls = [];
  const mcp = { call: async (server, tool, input) => {
    calls.push({ tool, input });
    if (tool === "kanban_get") { if (failGet) throw new Error("ops-knowledge unreachable"); return cards[input.id]; }
    if (tool === "work_report") { if (input.event === "completed") cards[input.id].lane = "done"; return { ok: true }; }
    throw new Error(tool);
  } };
  let clock = Date.parse("2026-11-21T02:00:00Z");
  const dc = createDecisionCards({ ledger, mcp, config: { ownerId: OWNER, staffIds: [] }, now: () => clock, readTicket: async (n) => { if (!(n in tickets)) throw new Error("unreadable"); return { status: tickets[n] }; } });
  return { data, ledger, calls, dc, advance: (ms) => { clock += ms; } };
}
const inbox = (id) => ({ id, lane: "inbox", assigned_to: null });

test("a decision ended through Discord completes its card with the outcome (ticket 1857, card 255495)", async () => {
  const w = setup({ 255495: inbox(255495) });
  w.data.jobs.j = { id: "j", ticket: 1857, state: "waiting", raisedToDevelopers: [{ id: 255495, blocking: true }] };
  w.data.decisions.b2525ab8 = { id: "b2525ab8", jobId: "j", ticket: 1857, state: "pending", at: 1, decisionKey: "kanban:255495", question: "Ticket 1857: Ship the bond issue screen fix now?", options: [{ id: "1", label: "Ship PR 6865 now" }, { id: "2", label: "Wait for a developer review" }], sent: {} };
  sd.applyOwnerChannelAnswer(w.data, { ticket: 1857, ownerId: OWNER, authorId: OWNER, text: "Wait for a developer review", at: 2, botId: BOT });
  assert.equal(w.data.decisions.b2525ab8.state, "selected");
  await w.dc.tick();
  const done = w.calls.find((c) => c.tool === "work_report");
  assert.equal(done.input.id, 255495);
  assert.equal(done.input.event, "completed");
  assert.match(done.input.summary, /Decision closed\. Egg chose "Wait for a developer review" in the ticket\./);
  assert.ok(done.input.no_evidence_reason);
  assert.ok(w.data.decisions.b2525ab8.cardClosedAt);
  assert.ok(w.data.jobs.j.raisedToDevelopers[0].releasedAt, "the developer watch stops chasing it");
  await w.dc.tick();
  assert.equal(w.calls.filter((c) => c.tool === "work_report").length, 1, "closed once");
});

test("every ending closes the card: approved, withdrawn, expired, button choice", async () => {
  const cards = { 1: inbox(1), 2: inbox(2), 3: inbox(3), 4: inbox(4) };
  const w = setup(cards);
  const mk = (id, n, extra) => (w.data.decisions[id] = { id, jobId: "gone", state: "pending", decisionKey: `kanban:${n}`, question: `q${n}`, sent: {}, ...extra });
  mk("a", 1, { state: "approve", answeredBy: OWNER }); mk("b", 2, { state: "withdrawn", withdrawnReason: "Staff took over the ticket" });
  mk("c", 3, { state: "expired" }); mk("d", 4, { state: "selected", selectedOption: { label: "Keep it" }, answeredBy: OWNER });
  mk("e", 5, {}); // still pending: untouched
  w.data.decisions.f = { id: "f", jobId: "gone", state: "withdrawn", decisionKey: "kanban:Some title", sent: {} }; // no card id
  await w.dc.tick();
  const done = w.calls.filter((c) => c.tool === "work_report" && c.input.event === "completed").map((c) => c.input.id).sort();
  assert.deepEqual(done, [1, 2, 3, 4]);
  assert.ok(!w.calls.some((c) => c.input.id === 5));
});

test("a card someone else picked up is never completed; it gets one note", async () => {
  const w = setup({ 255520: { id: 255520, lane: "now", assigned_to: "codex:2027-sector-basis" } });
  w.data.decisions.x = { id: "x", jobId: "gone", state: "answered", answeredBy: OWNER, answer: "keep going", decisionKey: "kanban:255520", question: "Ticket 1860: q", sent: {} };
  await w.dc.tick(); await w.dc.tick();
  const reports = w.calls.filter((c) => c.tool === "work_report");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].input.event, "progress");
});

test("the kanban unreachable: nothing is guessed, and the retry backs off", async () => {
  const w = setup({}, { failGet: true });
  w.data.decisions.x = { id: "x", jobId: "gone", state: "withdrawn", decisionKey: "kanban:255401", question: "q", sent: {} };
  await w.dc.tick();
  assert.equal(w.data.decisions.x.cardClosedAt, undefined);
  const gets = w.calls.length;
  await w.dc.tick();
  assert.equal(w.calls.length, gets, "no retry before the backoff");
  w.advance(11 * 60000); await w.dc.tick();
  assert.equal(w.calls.length, gets + 1);
});

test("startup sweep: an open question on a closed or resolved ticket is withdrawn, its card closed and its DM edited", async () => {
  const w = setup({ 255541: inbox(255541), 255573: inbox(255573) }, { tickets: { 1864: "closed", 1868: "open" } });
  w.data.jobs.j1864 = { id: "j1864", ticket: 1864, state: "waiting" };
  w.data.jobs.j1868 = { id: "j1868", ticket: 1868, state: "waiting" };
  w.data.jobs.j1869 = { id: "j1869", ticket: 1869, state: "waiting", channelClosed: true };
  w.data.decisions.x64 = { id: "x64", jobId: "j1864", ticket: 1864, state: "pending", at: 1, decisionKey: "kanban:255541", question: "Ticket 1864: approve?", sent: { [OWNER]: { channelId: "dm", messageId: "m64" } } };
  w.data.decisions.x68 = { id: "x68", jobId: "j1868", ticket: 1868, state: "pending", at: 1, decisionKey: "kanban:255573", question: "Ticket 1868: q?", sent: {} };
  w.data.decisions.x69 = { id: "x69", jobId: "j1869", ticket: 1869, state: "pending", at: 1, decisionKey: "kanban:255576", question: "Ticket 1869: q?", sent: {} };
  const r = await w.dc.sweepClosedTickets();
  assert.equal(r.withdrawn, 2);
  assert.equal(w.data.decisions.x68.state, "pending", "open ticket keeps its question");
  const edits = [];
  await createDecisions({ ledger: w.ledger, config: { ownerId: OWNER, staffIds: [] }, discord: async (m, route, body) => { edits.push({ m, route, body }); return {}; } }).tick();
  assert.match(edits.find((e) => e.route.endsWith("/m64")).body.content, /The ticket was closed\./);
  w.data.jobs.j1869.state = "waiting";
  await w.dc.tick();
  assert.ok(w.data.decisions.x64.cardClosedAt);
});
